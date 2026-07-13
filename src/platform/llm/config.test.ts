import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeLlmStack } from './composition'
import { InvalidLlmConfigurationError, parseLlmConfig } from './config'

const verifiedRuntimeIdentity = {
  modelId: 'qwen3.5-9b-q4_k_m',
  modelContentDigest: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
  servedModelName: 'qwen3.5-9b-q4_k_m',
  runtimeId: 'llama.cpp@test',
  runtimeAttestationDigest: 'a'.repeat(64),
} as const

describe('parseLlmConfig', () => {
  it('defaults to disabled without requiring a model id', () => {
    expect(parseLlmConfig({})).toMatchObject({
      mode: 'disabled',
      modelId: null,
      requireGpu: true,
    })
  })

  it('defaults requireGpu true and accepts false for diagnosis only', () => {
    expect(
      parseLlmConfig({
        INDIGO_LLM_MODE: 'local',
        INDIGO_LLM_MODEL_ID: 'qwen3.5-9b-q4_k_m',
      }).requireGpu,
    ).toBe(true)
    expect(
      parseLlmConfig({
        INDIGO_LLM_MODE: 'local',
        INDIGO_LLM_MODEL_ID: 'qwen3.5-9b-q4_k_m',
        INDIGO_LLM_REQUIRE_GPU: 'false',
      }).requireGpu,
    ).toBe(false)
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
      verifiedRuntimeIdentity,
    )
    expect(stack.activeSettings?.modelId).toBe('qwen3.5-9b-q4_k_m')
    expect(stack.explanationGenerator).not.toBeNull()
  })

  it('rejects a model id without a committed verified pack', () => {
    expect(() =>
      composeLlmStack(
        parseLlmConfig(
          {
            INDIGO_LLM_MODE: 'local',
            INDIGO_LLM_MODEL_ID: 'qwen3.5-9b-q5_k_m',
            INDIGO_LLM_MODELS_DIR: resolve(process.cwd(), 'llm/models'),
            INDIGO_LLM_ENDPOINT: 'http://127.0.0.1:8080/v1',
          },
          process.cwd(),
        ),
        verifiedRuntimeIdentity,
      ),
    ).toThrow('Unknown modelId')
  })

  it('rejects an environment digest that disagrees with the committed pack', () => {
    expect(() =>
      composeLlmStack(
        parseLlmConfig(
          {
            INDIGO_LLM_MODE: 'local',
            INDIGO_LLM_MODEL_ID: 'qwen3.5-9b-q4_k_m',
            INDIGO_LLM_MODEL_SHA256: 'b'.repeat(64),
          },
          process.cwd(),
        ),
        verifiedRuntimeIdentity,
      ),
    ).toThrow('must equal the committed model-pack digest')
  })
})
