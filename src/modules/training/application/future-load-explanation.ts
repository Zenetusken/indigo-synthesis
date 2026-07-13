import { getFutureLoadFactBundlesForSession } from '@/modules/training/application/future-load-fact-bundle'
import {
  composeLlmStack,
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
  /** Interactive budget for History (ms). Defaults to config override or 8000. */
  readonly interactiveTimeoutMs?: number
}

const defaultInteractiveTimeoutMs = 8_000

/**
 * On-demand plain-language explanation for one stored future-load decision.
 * Never invents a decision; codes path remains authoritative when this is unavailable.
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

  const stack = compose(config)
  if (!stack.explanationGenerator) {
    return {
      status: 'unavailable',
      reason: 'llm-not-ready',
      detail: 'Explanation generator is not composed for the current configuration.',
      durationMs: elapsed(),
    }
  }

  const timeoutMs =
    input.deps?.interactiveTimeoutMs ??
    config.timeoutMsOverride ??
    defaultInteractiveTimeoutMs

  const synthesis = await stack.explanationGenerator.synthesize({
    factBundle: item.factBundle,
    promptVersion: FUTURE_LOAD_PROMPT_VERSION,
    timeoutMs,
  })

  if (synthesis.status !== 'available') {
    return {
      status: 'unavailable',
      reason: 'synthesis-failed',
      detail: `${synthesis.reason}${synthesis.detail ? `: ${synthesis.detail}` : ''}`,
      durationMs: elapsed(),
    }
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
  }
}
