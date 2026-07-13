import type { ModelSettings } from '../model-settings'
import type { ExplanationGenerationPort, LanguageModelPort } from '../ports'
import {
  buildFutureLoadMessages,
  FUTURE_LOAD_PROMPT_VERSION,
} from '../prompts/future-load.v2'
import type { ExplanationGenerationRequest, ExplanationGenerationResult } from '../types'
import { factBundleHash } from './fact-bundle'
import { validateExplanationProse } from './validate-prose'

export type SynthesizeExplanationOptions = {
  readonly languageModel: LanguageModelPort
  readonly modelSettings: ModelSettings
  readonly modelContentDigest: string
  readonly timeoutMs?: number
  /** Injectable clock for tests. */
  readonly now?: () => Date
}

export function createExplanationGenerationPort(
  options: SynthesizeExplanationOptions,
): ExplanationGenerationPort {
  const now = options.now ?? (() => new Date())

  return {
    async synthesize(
      request: ExplanationGenerationRequest,
    ): Promise<ExplanationGenerationResult> {
      const bundle = request.factBundle

      if (bundle.decision.invalidated) {
        return {
          status: 'unavailable',
          reason: 'invalidated-decision',
          detail: 'Decision is no longer active; structured invalidation copy only.',
        }
      }

      if (request.promptVersion !== FUTURE_LOAD_PROMPT_VERSION) {
        return {
          status: 'unavailable',
          reason: 'config-error',
          detail: `Unsupported promptVersion: ${request.promptVersion}`,
        }
      }

      const settings = options.modelSettings
      // Per-request budget wins (interactive History may pass a higher timeout than
      // pack defaults used when composing the generator).
      const timeoutMs =
        request.timeoutMs ?? options.timeoutMs ?? settings.limits.timeoutMs
      const messages = buildFutureLoadMessages(bundle)
      const hash = factBundleHash(bundle)

      const completion = await options.languageModel.complete({
        messages,
        sampling: {
          temperature: settings.sampling.temperature,
          topP: settings.sampling.topP,
          topK: settings.sampling.topK,
          minP: settings.sampling.minP,
          presencePenalty: settings.sampling.presencePenalty,
          repetitionPenalty: settings.sampling.repetitionPenalty,
          maxTokens: settings.sampling.maxTokens,
        },
        timeoutMs,
        servedModelName: settings.runtime.servedModelName,
        enableThinking: settings.chat.enableThinking,
        modelId: settings.modelId,
        modelContentDigest: options.modelContentDigest,
      })

      if (completion.status === 'unavailable') {
        return {
          status: 'unavailable',
          reason: completion.reason,
          detail: completion.detail,
        }
      }

      const validation = validateExplanationProse(completion.text, bundle)
      if (!validation.ok) {
        return {
          status: 'unavailable',
          reason: 'validation-failed',
          detail: validation.detail,
        }
      }

      return {
        status: 'available',
        prose: completion.text.trim(),
        modelId: completion.modelId,
        modelContentDigest: completion.modelContentDigest,
        runtimeId: completion.runtimeId,
        promptVersion: request.promptVersion,
        factBundleHash: hash,
        generatedAt: now().toISOString(),
      }
    },
  }
}
