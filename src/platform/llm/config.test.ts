import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeLlmStack } from './composition'
import { InvalidLlmConfigurationError, parseLlmConfig } from './config'

describe('parseLlmConfig', () => {
  it('defaults to disabled without requiring a model id', () => {
    expect(parseLlmConfig({})).toMatchObject({
      mode: 'disabled',
      modelId: null,
    })
  })

  it('requires model id when local', () => {
    expect(() => parseLlmConfig({ INDIGO_LLM_MODE: 'local' })).toThrow(
      InvalidLlmConfigurationError,
    )
  })

  it('rejects non-loopback endpoints', () => {
    expect(() =>
      parseLlmConfig({
        INDIGO_LLM_MODE: 'local',
        INDIGO_LLM_MODEL_ID: 'qwen3.5-9b-q4_k_m',
        INDIGO_LLM_ENDPOINT: 'http://example.com/v1',
      }),
    ).toThrow(InvalidLlmConfigurationError)
  })
})

describe('composeLlmStack', () => {
  it('composes a disabled stack by default', async () => {
    const stack = composeLlmStack(parseLlmConfig({}, process.cwd()))
    expect(stack.explanationGenerator).toBeNull()
    await expect(
      stack.languageModel.complete({
        messages: [{ role: 'user', content: 'x' }],
        sampling: {
          temperature: 0.3,
          topP: 0.8,
          topK: 20,
          minP: 0,
          presencePenalty: 0,
          repetitionPenalty: 1,
          maxTokens: 16,
        },
        timeoutMs: 100,
        servedModelName: 'n/a',
        enableThinking: false,
        modelId: 'n/a',
        modelContentDigest: 'unverified',
      }),
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'disabled' })
  })

  it('loads the Qwen pack when local mode is configured', () => {
    const stack = composeLlmStack(
      parseLlmConfig(
        {
          INDIGO_LLM_MODE: 'local',
          INDIGO_LLM_MODEL_ID: 'qwen3.5-9b-q4_k_m',
          INDIGO_LLM_MODELS_DIR: resolve(process.cwd(), 'llm/models'),
          INDIGO_LLM_ENDPOINT: 'http://127.0.0.1:8080/v1',
        },
        process.cwd(),
      ),
    )
    expect(stack.activeSettings?.modelId).toBe('qwen3.5-9b-q4_k_m')
    expect(stack.explanationGenerator).not.toBeNull()
  })

  it('hot-swaps to the Q5 pack by model id only', () => {
    const stack = composeLlmStack(
      parseLlmConfig(
        {
          INDIGO_LLM_MODE: 'local',
          INDIGO_LLM_MODEL_ID: 'qwen3.5-9b-q5_k_m',
          INDIGO_LLM_MODELS_DIR: resolve(process.cwd(), 'llm/models'),
          INDIGO_LLM_ENDPOINT: 'http://127.0.0.1:8080/v1',
        },
        process.cwd(),
      ),
    )
    expect(stack.activeSettings?.modelId).toBe('qwen3.5-9b-q5_k_m')
    expect(stack.activeSettings?.quantization).toBe('Q5_K_M')
  })
})
