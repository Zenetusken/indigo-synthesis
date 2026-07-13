export { createDisabledLanguageModel } from './adapters/disabled'
export { createFakeLanguageModel } from './adapters/fake'
export {
  assertLoopbackEndpoint,
  createOpenAiCompatibleLoopbackLanguageModel,
  NonLoopbackEndpointError,
} from './adapters/openai-compatible-loopback'
export {
  GOLDEN_BASELINE_CASES,
  LLM_BASELINE_VERSION,
} from './baseline/golden-cases'
export {
  buildMeasurementSnapshot,
  formatMeasurementSummary,
  type LlmMeasurementSnapshot,
} from './baseline/metrics'
export {
  formatLiveProbeReport,
  type LiveLatencyStats,
  type LiveProbeReport,
  percentileMs,
  runLiveProbe,
} from './baseline/run-live-probe'
export {
  formatOfflineBaselineReport,
  type OfflineBaselineReport,
  runOfflineBaseline,
} from './baseline/run-offline-baseline'
export {
  composeLlmStack,
  getLlmComposition,
  type LlmComposition,
  resetLlmCompositionForTests,
} from './composition'
export {
  getLlmConfig,
  InvalidLlmConfigurationError,
  type LlmRuntimeConfig,
  parseLlmConfig,
  resetLlmConfigForTests,
} from './config'
export {
  buildFutureLoadFactBundle,
  FactBundleBuildError,
  type PersistedFutureLoadDecision,
} from './explanation/build-fact-bundle'
export type { ExplanationFactBundle } from './explanation/fact-bundle'
export {
  canonicalJsonStringify,
  explanationCacheKey,
  factBundleHash,
} from './explanation/fact-bundle'
export { createExplanationGenerationPort } from './explanation/synthesize'
export { validateExplanationProse } from './explanation/validate-prose'
export {
  loadModelRegistry,
  ModelRegistryError,
  requireModelSettings,
} from './model-registry'
export type { ModelSettings } from './model-settings'
export { InvalidModelSettingsError, parseModelSettings } from './model-settings'
export type {
  ExplanationGenerationPort,
  LanguageModelPort,
} from './ports'
export { FUTURE_LOAD_PROMPT_VERSION } from './prompts/future-load.v1'
export {
  formatLlmPreflightReport,
  type LlmPreflightReport,
  runLlmPreflight,
} from './runtime/preflight'
export type {
  ExplanationGenerationRequest,
  ExplanationGenerationResult,
  LanguageModelCompleteRequest,
  LanguageModelCompleteResult,
  LlmMode,
  LlmUnavailableReason,
  SamplingParams,
} from './types'
