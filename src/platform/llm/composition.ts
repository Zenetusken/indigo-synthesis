import { createDisabledLanguageModel } from './adapters/disabled'
import { createOpenAiCompatibleLoopbackLanguageModel } from './adapters/openai-compatible-loopback'
import { getLlmConfig, type LlmRuntimeConfig } from './config'
import { createExplanationGenerationPort } from './explanation/synthesize'
import {
  loadModelRegistry,
  type ModelRegistry,
  requireModelSettings,
} from './model-registry'
import type { ModelSettings } from './model-settings'
import type { ExplanationGenerationPort, LanguageModelPort } from './ports'
import type { VerifiedRuntimeIdentity } from './runtime/attestation'

export type LlmComposition = {
  readonly config: LlmRuntimeConfig
  readonly registry: ModelRegistry | null
  readonly activeSettings: ModelSettings | null
  readonly languageModel: LanguageModelPort
  readonly explanationGenerator: ExplanationGenerationPort | null
  readonly verifiedRuntimeIdentity: VerifiedRuntimeIdentity | null
}

export type ConfiguredModelPack = {
  readonly registry: ModelRegistry
  readonly settings: ModelSettings
  readonly modelContentDigest: string
}

export function resolveConfiguredModelPack(
  config: LlmRuntimeConfig,
): ConfiguredModelPack {
  const registry = loadModelRegistry(config.modelsDir)
  const modelId = config.modelId
  if (!modelId) {
    throw new Error('INDIGO_LLM_MODEL_ID is required when INDIGO_LLM_MODE=local')
  }
  const settings = requireModelSettings(registry, modelId)
  const modelContentDigest = settings.artifacts.expectedSha256
  if (config.modelSha256Override && config.modelSha256Override !== modelContentDigest) {
    throw new Error('INDIGO_LLM_MODEL_SHA256 must equal the committed model-pack digest')
  }
  return { registry, settings, modelContentDigest }
}

/**
 * Composes the active language-model stack from environment configuration.
 * Default mode is disabled and never requires a model process.
 */
export function composeLlmStack(
  config: LlmRuntimeConfig = getLlmConfig(),
  verifiedRuntimeIdentity?: VerifiedRuntimeIdentity,
): LlmComposition {
  if (config.mode === 'disabled') {
    const languageModel = createDisabledLanguageModel()
    return {
      config,
      registry: null,
      activeSettings: null,
      languageModel,
      explanationGenerator: null,
      verifiedRuntimeIdentity: null,
    }
  }

  const {
    registry,
    settings: activeSettings,
    modelContentDigest,
  } = resolveConfiguredModelPack(config)
  if (!verifiedRuntimeIdentity) {
    throw new Error('A verified runtime identity is required for local inference')
  }
  if (
    verifiedRuntimeIdentity.modelId !== activeSettings.modelId ||
    verifiedRuntimeIdentity.servedModelName !== activeSettings.runtime.servedModelName ||
    verifiedRuntimeIdentity.modelContentDigest !== modelContentDigest
  ) {
    throw new Error('Verified runtime identity does not match the configured model pack')
  }
  const endpoint = config.endpointOverride ?? activeSettings.runtime.defaultEndpoint
  const timeoutMs = config.timeoutMsOverride ?? activeSettings.limits.timeoutMs

  let languageModel: LanguageModelPort
  switch (activeSettings.runtime.adapter) {
    case 'disabled':
      languageModel = createDisabledLanguageModel()
      break
    case 'openai-compatible-loopback':
      languageModel = createOpenAiCompatibleLoopbackLanguageModel({
        endpoint,
        runtimeId: verifiedRuntimeIdentity.runtimeId,
      })
      break
    default: {
      const _exhaustive: never = activeSettings.runtime.adapter
      throw new Error(`Unsupported adapter: ${String(_exhaustive)}`)
    }
  }

  const explanationGenerator = createExplanationGenerationPort({
    languageModel,
    modelSettings: activeSettings,
    modelContentDigest,
    timeoutMs,
  })

  return {
    config,
    registry,
    activeSettings,
    languageModel,
    explanationGenerator,
    verifiedRuntimeIdentity,
  }
}

let cachedComposition: LlmComposition | undefined

export function getLlmComposition(): LlmComposition {
  cachedComposition ??= composeLlmStack()
  return cachedComposition
}

export function resetLlmCompositionForTests(): void {
  cachedComposition = undefined
}
