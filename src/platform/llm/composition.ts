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

export type LlmComposition = {
  readonly config: LlmRuntimeConfig
  readonly registry: ModelRegistry | null
  readonly activeSettings: ModelSettings | null
  readonly languageModel: LanguageModelPort
  readonly explanationGenerator: ExplanationGenerationPort | null
}

function resolveModelContentDigest(
  settings: ModelSettings,
  config: LlmRuntimeConfig,
): string {
  return config.modelSha256Override ?? settings.artifacts.expectedSha256 ?? 'unverified'
}

/**
 * Composes the active language-model stack from environment configuration.
 * Default mode is disabled and never requires a model process.
 */
export function composeLlmStack(
  config: LlmRuntimeConfig = getLlmConfig(),
): LlmComposition {
  if (config.mode === 'disabled') {
    const languageModel = createDisabledLanguageModel()
    return {
      config,
      registry: null,
      activeSettings: null,
      languageModel,
      explanationGenerator: null,
    }
  }

  const registry = loadModelRegistry(config.modelsDir)
  const modelId = config.modelId
  if (!modelId) {
    throw new Error('INDIGO_LLM_MODEL_ID is required when INDIGO_LLM_MODE=local')
  }

  const activeSettings = requireModelSettings(registry, modelId)
  const modelContentDigest = resolveModelContentDigest(activeSettings, config)
  const endpoint = config.endpointOverride ?? activeSettings.runtime.defaultEndpoint
  const timeoutMs = config.timeoutMsOverride ?? activeSettings.limits.timeoutMs

  let languageModel: LanguageModelPort
  switch (activeSettings.runtime.adapter) {
    case 'disabled':
      languageModel = createDisabledLanguageModel()
      break
    case 'openai-compatible-loopback':
      languageModel = createOpenAiCompatibleLoopbackLanguageModel({ endpoint })
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
