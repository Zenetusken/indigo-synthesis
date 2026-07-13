import {
  createPostgresFutureLoadExplanationCache,
  type FutureLoadExplanationCachePort,
} from '@/modules/training/application/future-load-explanation-cache'
import {
  type AsyncSingleFlight,
  createBoundedAsyncSingleFlight,
  SingleFlightCapacityError,
} from '@/modules/training/application/future-load-explanation-singleflight'
import { getFutureLoadFactBundlesForSession } from '@/modules/training/application/future-load-fact-bundle'
import {
  composeLlmStack,
  EXPLANATION_VALIDATOR_VERSION,
  explanationCacheKey,
  FUTURE_LOAD_PROMPT_VERSION,
  getLlmConfig,
  type LlmComposition,
  type LlmPreflightReport,
  type LlmRuntimeConfig,
  resolveConfiguredModelPack,
  runLlmPreflight,
  SUPPORTED_LOCAL_LLM_TIMEOUT_MS,
  type VerifiedRuntimeIdentity,
  validateExplanationProse,
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
  readonly compose?: (
    config: LlmRuntimeConfig,
    verifiedRuntimeIdentity?: VerifiedRuntimeIdentity,
  ) => LlmComposition
  readonly preflight?: (config: LlmRuntimeConfig) => Promise<LlmPreflightReport>
  readonly cache?: FutureLoadExplanationCachePort
  readonly singleFlight?: AsyncSingleFlight
  /** Interactive budget for History (ms). Defaults to config override or 3000. */
  readonly interactiveTimeoutMs?: number
}

const defaultSingleFlight = createBoundedAsyncSingleFlight()

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
  const cache = input.deps?.cache ?? createPostgresFutureLoadExplanationCache()
  const singleFlight = input.deps?.singleFlight ?? defaultSingleFlight

  let bundlesResult: Awaited<ReturnType<typeof getFutureLoadFactBundlesForSession>>
  try {
    bundlesResult = await getBundles(input.userId, input.sessionId)
  } catch {
    return {
      status: 'unavailable',
      reason: 'fact-bundle-failed',
      detail: 'Stored facts could not be loaded for explanation.',
      durationMs: elapsed(),
    }
  }
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
    try {
      await cache.deleteBySessionId({ userId: input.userId, sessionId: input.sessionId })
    } catch {
      // The invalidation ledger is authoritative; physical cache cleanup is fail-soft.
    }
    return {
      status: 'unavailable',
      reason: 'decision-invalidated',
      detail:
        item.factBundle.decision.invalidationReason === 'post-completion-pain-report'
          ? 'A post-completion pain report was recorded. The original rule code remains visible as historical evidence, but the decision is no longer active.'
          : 'A post-completion training fact was corrected. The original rule code remains visible as historical evidence, but the decision is no longer active.',
      durationMs: elapsed(),
    }
  }

  let config: LlmRuntimeConfig
  try {
    config = getConfig()
  } catch {
    return {
      status: 'unavailable',
      reason: 'llm-not-ready',
      detail: 'Local model configuration is invalid; stored rule codes still apply.',
      durationMs: elapsed(),
    }
  }
  if (config.mode === 'disabled') {
    return {
      status: 'unavailable',
      reason: 'llm-disabled',
      detail:
        'Plain-language explanations are off on this instance (INDIGO_LLM_MODE=disabled).',
      durationMs: elapsed(),
    }
  }

  // Committed model identity is sufficient for a cache lookup. A miss requires a
  // fresh runtime attestation before a model adapter can be composed.
  let configuredPack: ReturnType<typeof resolveConfiguredModelPack>
  try {
    configuredPack = resolveConfiguredModelPack(config)
  } catch (error) {
    return {
      status: 'unavailable',
      reason: 'llm-not-ready',
      detail: error instanceof Error ? error.message : 'Model pack is not configured.',
      durationMs: elapsed(),
    }
  }
  const modelId = configuredPack.settings.modelId
  const modelContentDigest = configuredPack.modelContentDigest

  const cacheKey = explanationCacheKey({
    decisionId: input.decisionId,
    promptVersion: FUTURE_LOAD_PROMPT_VERSION,
    validatorVersion: EXPLANATION_VALIDATOR_VERSION,
    modelId,
    modelContentDigest,
    factBundleHash: item.factBundleHash,
  })

  try {
    return await singleFlight.run(cacheKey, async () => {
      {
        const cached = await cache.getIfActive({
          userId: input.userId,
          sessionId: input.sessionId,
          decisionId: input.decisionId,
          cacheKey,
        })
        if (cached.status === 'invalidated') {
          return invalidatedExplanationResult(elapsed(), cached.reason)
        }
        if (cached.status === 'state-unavailable') {
          return stateUnavailableResult(elapsed())
        }
        if (cached.status === 'hit') {
          const hit = cached.value
          const identityMatches =
            hit.modelId === modelId &&
            hit.modelContentDigest === modelContentDigest &&
            hit.servedModelName === configuredPack.settings.runtime.servedModelName &&
            hit.promptVersion === FUTURE_LOAD_PROMPT_VERSION &&
            hit.validatorVersion === EXPLANATION_VALIDATOR_VERSION &&
            hit.factBundleHash === item.factBundleHash
          const validation = validateExplanationProse(hit.prose, item.factBundle)
          if (identityMatches && validation.ok) {
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
          await cache.deleteByCacheKey(cacheKey)
        }
        // `cache-unavailable` is a safe miss: getIfActive already confirmed active state
        // while holding the reportPain advisory lock.
      }

      let readiness: LlmPreflightReport
      try {
        readiness = await preflight(config)
      } catch {
        return {
          status: 'unavailable',
          reason: 'llm-not-ready',
          detail:
            'Local model readiness could not be verified; stored rule codes still apply.',
          durationMs: elapsed(),
        }
      }
      if (!readiness.readyForLocalInference || !readiness.verifiedRuntimeIdentity) {
        return {
          status: 'unavailable',
          reason: 'llm-not-ready',
          detail:
            readiness.blockers[0] ??
            'Local model is not available right now; stored rule codes still apply.',
          durationMs: elapsed(),
        }
      }

      let stack: LlmComposition
      try {
        stack = compose(config, readiness.verifiedRuntimeIdentity)
      } catch (error) {
        return {
          status: 'unavailable',
          reason: 'llm-not-ready',
          detail:
            error instanceof Error
              ? error.message
              : 'Explanation generator is not composed for the verified runtime.',
          durationMs: elapsed(),
        }
      }
      if (!stack.explanationGenerator) {
        return {
          status: 'unavailable',
          reason: 'llm-not-ready',
          detail: 'Explanation generator is not composed for the verified runtime.',
          durationMs: elapsed(),
        }
      }

      const timeoutMs =
        input.deps?.interactiveTimeoutMs ??
        config.timeoutMsOverride ??
        SUPPORTED_LOCAL_LLM_TIMEOUT_MS

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

      {
        const publication = await cache.putIfActive({
          userId: input.userId,
          sessionId: input.sessionId,
          decisionId: input.decisionId,
          cacheKey,
          prose: synthesis.prose,
          modelId: synthesis.modelId,
          modelContentDigest: synthesis.modelContentDigest,
          servedModelName: readiness.verifiedRuntimeIdentity.servedModelName,
          runtimeId: synthesis.runtimeId,
          runtimeAttestationDigest:
            readiness.verifiedRuntimeIdentity.runtimeAttestationDigest,
          promptVersion: synthesis.promptVersion,
          validatorVersion: EXPLANATION_VALIDATOR_VERSION,
          factBundleHash: synthesis.factBundleHash,
          generateDurationMs,
        })
        if (publication.status === 'invalidated') {
          return invalidatedExplanationResult(elapsed(), publication.reason)
        }
        if (publication.status === 'state-unavailable') {
          return stateUnavailableResult(elapsed())
        }
        // `cache-unavailable` is no-cache success after a fresh locked active-state check.
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
    })
  } catch (error) {
    if (error instanceof SingleFlightCapacityError) {
      return {
        status: 'unavailable',
        reason: 'llm-not-ready',
        detail: 'Local explanation generation is busy; stored rule codes still apply.',
        durationMs: elapsed(),
      }
    }
    return {
      status: 'unavailable',
      reason: 'llm-not-ready',
      detail: 'Local explanation is unavailable; stored rule codes still apply.',
      durationMs: elapsed(),
    }
  }
}

function invalidatedExplanationResult(
  durationMs: number,
  reason: 'post-completion-pain-report' | 'training-fact-correction',
): FutureLoadExplanationResult {
  return {
    status: 'unavailable',
    reason: 'decision-invalidated',
    detail:
      reason === 'post-completion-pain-report'
        ? 'A post-completion pain report was recorded. The original rule code remains visible as historical evidence, but the decision is no longer active.'
        : 'A post-completion training fact was corrected. The original rule code remains visible as historical evidence, but the decision is no longer active.',
    durationMs,
  }
}

function stateUnavailableResult(durationMs: number): FutureLoadExplanationResult {
  return {
    status: 'unavailable',
    reason: 'llm-not-ready',
    detail: 'Decision state could not be confirmed; stored rule codes still apply.',
    durationMs,
  }
}
