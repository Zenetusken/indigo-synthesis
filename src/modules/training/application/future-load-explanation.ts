import {
  createPostgresFutureLoadExplanationCache,
  type FutureLoadExplanationCachePort,
} from '@/modules/training/application/future-load-explanation-cache'
import { getFutureLoadFactBundlesForSession } from '@/modules/training/application/future-load-fact-bundle'
import {
  composeLlmStack,
  explanationCacheKey,
  FUTURE_LOAD_PROMPT_VERSION,
  getLlmConfig,
  type LlmComposition,
  type LlmPreflightReport,
  type LlmRuntimeConfig,
  runLlmPreflight,
} from '@/platform/llm'

export type FutureLoadExplanationUnavailableReason =
  | 'llm-disabled'
  | 'llm-not-ready'
  | 'decision-not-found'
  | 'fact-bundle-failed'
  | 'decision-invalidated'
  | 'synthesis-failed'

export type FutureLoadExplanationResult =
  | {
      readonly status: 'available'
      readonly prose: string
      readonly modelId: string
      readonly modelContentDigest: string
      readonly promptVersion: string
      readonly factBundleHash: string
      readonly durationMs: number
      readonly inferred: true
      /** True when prose was served from PostgreSQL cache without calling the model. */
      readonly fromCache: boolean
      /** Original synthesize wall time when known (cache row or this miss). */
      readonly generateDurationMs: number
    }
  | {
      readonly status: 'unavailable'
      readonly reason: FutureLoadExplanationUnavailableReason
      readonly detail: string | null
      readonly durationMs: number
    }

export type ExplainFutureLoadDecisionDeps = {
  readonly getBundles?: typeof getFutureLoadFactBundlesForSession
  readonly getConfig?: () => LlmRuntimeConfig
  readonly compose?: (config: LlmRuntimeConfig) => LlmComposition
  readonly preflight?: (config: LlmRuntimeConfig) => Promise<LlmPreflightReport>
  readonly cache?: FutureLoadExplanationCachePort | null
  /** Interactive budget for History (ms). Defaults to config override or 8000. */
  readonly interactiveTimeoutMs?: number
}

const defaultInteractiveTimeoutMs = 8_000

/**
 * On-demand plain-language explanation for one stored future-load decision.
 * Never invents a decision; codes path remains authoritative when this is unavailable.
 * Successful validation-passing prose may be cached by contract cache key.
 */
export async function explainFutureLoadDecision(input: {
  readonly userId: string
  readonly sessionId: string
  readonly decisionId: string
  readonly deps?: ExplainFutureLoadDecisionDeps
}): Promise<FutureLoadExplanationResult> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  const getBundles = input.deps?.getBundles ?? getFutureLoadFactBundlesForSession
  const getConfig = input.deps?.getConfig ?? getLlmConfig
  const compose = input.deps?.compose ?? composeLlmStack
  const preflight = input.deps?.preflight ?? runLlmPreflight
  const cache =
    input.deps?.cache === undefined
      ? createPostgresFutureLoadExplanationCache()
      : input.deps.cache

  const bundlesResult = await getBundles(input.userId, input.sessionId)
  if (bundlesResult.status !== 'available') {
    return {
      status: 'unavailable',
      reason: 'decision-not-found',
      detail: `Session future-load decisions unavailable (${bundlesResult.reason}).`,
      durationMs: elapsed(),
    }
  }

  const buildError = bundlesResult.buildErrors.find(
    (error) => error.decisionId === input.decisionId,
  )
  if (buildError) {
    return {
      status: 'unavailable',
      reason: 'fact-bundle-failed',
      detail: buildError.message,
      durationMs: elapsed(),
    }
  }

  const item = bundlesResult.bundles.find(
    (entry) => entry.decision.id === input.decisionId,
  )
  if (!item) {
    return {
      status: 'unavailable',
      reason: 'decision-not-found',
      detail: 'No future-load decision matches this identifier for the session.',
      durationMs: elapsed(),
    }
  }

  // Semantic invalidation (e.g. post-completion pain): never serve model or cache prose.
  if (item.factBundle.decision.invalidated) {
    if (cache) {
      await cache.deleteBySessionId(input.sessionId)
    }
    return {
      status: 'unavailable',
      reason: 'decision-invalidated',
      detail:
        item.factBundle.decision.invalidationReason === 'post-completion-pain-report'
          ? 'A post-completion pain report was recorded. Stored rule codes remain; plain-language paraphrases of the prior decision are not offered.'
          : 'This decision is no longer active for explanation. The rule codes above still apply.',
      durationMs: elapsed(),
    }
  }

  const config = getConfig()
  if (config.mode === 'disabled') {
    return {
      status: 'unavailable',
      reason: 'llm-disabled',
      detail:
        'Plain-language explanations are off on this instance (INDIGO_LLM_MODE=disabled).',
      durationMs: elapsed(),
    }
  }

  // Need model identity for cache key before preflight so hits skip GPU readiness.
  const stack = compose(config)
  const modelId = stack.activeSettings?.modelId ?? config.modelId
  const modelContentDigest =
    config.modelSha256Override ??
    stack.activeSettings?.artifacts.expectedSha256 ??
    'unverified'

  if (!modelId || !stack.explanationGenerator) {
    // Still require readiness when we cannot compose a generator.
    const readiness = await preflight(config)
    if (!readiness.readyForLocalInference) {
      return {
        status: 'unavailable',
        reason: 'llm-not-ready',
        detail:
          readiness.blockers[0] ??
          'Local model is not available right now; stored rule codes still apply.',
        durationMs: elapsed(),
      }
    }
    return {
      status: 'unavailable',
      reason: 'llm-not-ready',
      detail: 'Explanation generator is not composed for the current configuration.',
      durationMs: elapsed(),
    }
  }

  const cacheKey = explanationCacheKey({
    decisionId: input.decisionId,
    promptVersion: FUTURE_LOAD_PROMPT_VERSION,
    modelId,
    modelContentDigest,
    factBundleHash: item.factBundleHash,
  })

  if (cache) {
    const hit = await cache.getByCacheKey(cacheKey)
    if (hit) {
      return {
        status: 'available',
        prose: hit.prose,
        modelId: hit.modelId,
        modelContentDigest: hit.modelContentDigest,
        promptVersion: hit.promptVersion,
        factBundleHash: hit.factBundleHash,
        durationMs: elapsed(),
        inferred: true,
        fromCache: true,
        generateDurationMs: hit.generateDurationMs,
      }
    }
  }

  const readiness = await preflight(config)
  if (!readiness.readyForLocalInference) {
    return {
      status: 'unavailable',
      reason: 'llm-not-ready',
      detail:
        readiness.blockers[0] ??
        'Local model is not available right now; stored rule codes still apply.',
      durationMs: elapsed(),
    }
  }

  const timeoutMs =
    input.deps?.interactiveTimeoutMs ??
    config.timeoutMsOverride ??
    defaultInteractiveTimeoutMs

  const synthesisStarted = performance.now()
  const synthesis = await stack.explanationGenerator.synthesize({
    factBundle: item.factBundle,
    promptVersion: FUTURE_LOAD_PROMPT_VERSION,
    timeoutMs,
  })
  const generateDurationMs = Math.round(performance.now() - synthesisStarted)

  if (synthesis.status !== 'available') {
    return {
      status: 'unavailable',
      reason: 'synthesis-failed',
      detail: `${synthesis.reason}${synthesis.detail ? `: ${synthesis.detail}` : ''}`,
      durationMs: elapsed(),
    }
  }

  if (cache) {
    await cache.put({
      userId: input.userId,
      sessionId: input.sessionId,
      decisionId: input.decisionId,
      cacheKey,
      prose: synthesis.prose,
      modelId: synthesis.modelId,
      modelContentDigest: synthesis.modelContentDigest,
      promptVersion: synthesis.promptVersion,
      factBundleHash: synthesis.factBundleHash,
      generateDurationMs,
    })
  }

  return {
    status: 'available',
    prose: synthesis.prose,
    modelId: synthesis.modelId,
    modelContentDigest: synthesis.modelContentDigest,
    promptVersion: synthesis.promptVersion,
    factBundleHash: synthesis.factBundleHash,
    durationMs: elapsed(),
    inferred: true,
    fromCache: false,
    generateDurationMs,
  }
}
