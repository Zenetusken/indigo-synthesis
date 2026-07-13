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

  it('treats an exactly empty mode as the disabled default', () => {
    expect(
      parseLlmConfig({
        INDIGO_LLM_MODE: '',
        INDIGO_LLM_MODEL_ID: '',
        INDIGO_LLM_ENDPOINT: 'https://models.example/v1',
      }),
    ).toMatchObject({
      mode: 'disabled',
      modelId: null,
      endpointOverride: null,
    })
    expect(() => parseLlmConfig({ INDIGO_LLM_MODE: ' ' })).toThrow(
      InvalidLlmConfigurationError,
    )
  })

  it('treats disabled mode as an isolation boundary from unused runtime settings', () => {
    expect(
      parseLlmConfig({
        INDIGO_LLM_MODE: 'disabled',
        INDIGO_LLM_MODEL_ID: '',
        INDIGO_LLM_ENDPOINT: 'http://198.51.100.10:9999/v1',
        INDIGO_LLM_TIMEOUT_MS: 'not-a-timeout',
        INDIGO_LLM_MODEL_SHA256: 'not-a-digest',
        INDIGO_LLM_REQUIRE_GPU: 'not-a-boolean',
      }),
    ).toMatchObject({
      mode: 'disabled',
      modelId: null,
      endpointOverride: null,
      timeoutMsOverride: null,
      modelSha256Override: null,
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

  it('rejects alternate loopback endpoints before runtime preflight', () => {
    for (const endpoint of [
      'http://localhost:8080/v1',
      'http://127.0.0.1:8081/v1',
      'http://127.0.0.1:8080/v1/',
    ]) {
      expect(() =>
        parseLlmConfig({
          INDIGO_LLM_MODE: 'local',
          INDIGO_LLM_MODEL_ID: 'qwen3.5-9b-q4_k_m',
          INDIGO_LLM_ENDPOINT: endpoint,
        }),
      ).toThrow(/requires http:\/\/127\.0\.0\.1:8080\/v1/)
    }
  })

  it('pins the supported local timeout to the interactive product deadline', () => {
    expect(
      parseLlmConfig({
        INDIGO_LLM_MODE: 'local',
        INDIGO_LLM_MODEL_ID: 'qwen3.5-9b-q4_k_m',
        INDIGO_LLM_TIMEOUT_MS: '3000',
      }).timeoutMsOverride,
    ).toBe(3000)

    for (const timeout of ['2999', '3001', '600000']) {
      expect(() =>
        parseLlmConfig({
          INDIGO_LLM_MODE: 'local',
          INDIGO_LLM_MODEL_ID: 'qwen3.5-9b-q4_k_m',
          INDIGO_LLM_TIMEOUT_MS: timeout,
        }),
      ).toThrow(/requires 3000/)
    }
  })

  it('rejects an alternate model-settings registry in supported local mode', () => {
    expect(() =>
      parseLlmConfig({
        INDIGO_LLM_MODE: 'local',
        INDIGO_LLM_MODEL_ID: 'qwen3.5-9b-q4_k_m',
        INDIGO_LLM_MODELS_DIR: '/tmp/unreviewed-model-registry',
      }),
    ).toThrow(/committed llm\/models registry/)
  })

  it('rejects an alternate weights directory in supported local mode', () => {
    expect(() =>
      parseLlmConfig({
        INDIGO_LLM_MODE: 'local',
        INDIGO_LLM_MODEL_ID: 'qwen3.5-9b-q4_k_m',
        INDIGO_LLM_WEIGHTS_DIR: '/tmp/unreviewed-model-weights',
      }),
    ).toThrow(/committed llm\/weights artifact directory/)
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
