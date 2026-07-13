import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadModelRegistry, ModelRegistryError } from './model-registry'
import {
  InvalidModelSettingsError,
  MODEL_SETTINGS_LOOPBACK_ENDPOINT_PATTERN,
  MODEL_SETTINGS_WEIGHTS_PATH_PATTERN,
  parseModelSettings,
} from './model-settings'

const samplePack = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'llm/models/qwen3.5-9b-q4_k_m/settings.json'),
    'utf8',
  ),
) as unknown
const modelSettingsJsonSchema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'llm/schema/model-settings.schema.json'), 'utf8'),
) as {
  properties: {
    artifacts: { properties: { weightsRelativePath: { pattern: string } } }
    runtime: { properties: { defaultEndpoint: { pattern: string } } }
  }
}

describe('model settings', () => {
  it('parses the committed Qwen Q4 pack', () => {
    const settings = parseModelSettings(samplePack)
    expect(settings.modelId).toBe('qwen3.5-9b-q4_k_m')
    expect(settings.sampling.temperature).toBe(0.3)
    expect(settings.chat.enableThinking).toBe(false)
    expect(settings.runtime.adapter).toBe('openai-compatible-loopback')
  })

  it('rejects path traversal in weightsRelativePath', () => {
    expect(() =>
      parseModelSettings({
        ...(samplePack as object),
        artifacts: {
          weightsRelativePath: '../escape.gguf',
          expectedSha256: 'a'.repeat(64),
          approxSizeBytes: 1,
        },
      }),
    ).toThrow(InvalidModelSettingsError)
  })

  it.each([
    ['qwen/model.gguf', true],
    ['qwen.gguf', true],
    ['../escape.gguf', false],
    ['qwen/../escape.gguf', false],
    ['/absolute/model.gguf', false],
    ['qwen\\model.gguf', false],
    ['', false],
  ] as const)('keeps JSON Schema and runtime weights-path policy aligned for %s', (weightsRelativePath, accepted) => {
    const schemaPattern =
      modelSettingsJsonSchema.properties.artifacts.properties.weightsRelativePath.pattern
    expect(schemaPattern).toBe(MODEL_SETTINGS_WEIGHTS_PATH_PATTERN)
    expect(new RegExp(schemaPattern).test(weightsRelativePath)).toBe(accepted)

    const parse = () =>
      parseModelSettings({
        ...(samplePack as object),
        artifacts: {
          ...(samplePack as { artifacts: object }).artifacts,
          weightsRelativePath,
        },
      })
    if (accepted) expect(parse).not.toThrow()
    else expect(parse).toThrow(InvalidModelSettingsError)
  })

  it('rejects unknown adapter values', () => {
    expect(() =>
      parseModelSettings({
        ...(samplePack as object),
        runtime: {
          ...(samplePack as { runtime: object }).runtime,
          adapter: 'cloud-openai',
        },
      }),
    ).toThrow(InvalidModelSettingsError)
  })

  it('rejects non-loopback model-pack endpoints', () => {
    expect(() =>
      parseModelSettings({
        ...(samplePack as object),
        runtime: {
          ...(samplePack as { runtime: object }).runtime,
          defaultEndpoint: 'https://models.example/v1',
        },
      }),
    ).toThrow(/defaultEndpoint must use HTTP\(S\) on a loopback host/)
  })

  it.each([
    ['http://127.0.0.1:8080/v1', true],
    ['https://localhost/v1', true],
    ['http://[::1]:8080/v1', true],
    ['http://localhost', true],
    ['https://models.example/v1', false],
    ['http://127.0.0.1.example/v1', false],
    ['ftp://127.0.0.1/model', false],
    ['HTTP://LOCALHOST/v1', false],
    ['http://user:pass@localhost/v1', false],
    ['http://localhost?x=1', false],
    ['http://localhost:0/v1', false],
    ['http://localhost:65535/v1', true],
    ['http://localhost:65536/v1', false],
    ['not-a-url', false],
  ] as const)('keeps JSON Schema and runtime endpoint policy aligned for %s', (defaultEndpoint, accepted) => {
    const schemaPattern =
      modelSettingsJsonSchema.properties.runtime.properties.defaultEndpoint.pattern
    expect(schemaPattern).toBe(MODEL_SETTINGS_LOOPBACK_ENDPOINT_PATTERN)
    const pattern = new RegExp(schemaPattern)
    expect(pattern.test(defaultEndpoint)).toBe(accepted)

    const parse = () =>
      parseModelSettings({
        ...(samplePack as object),
        runtime: {
          ...(samplePack as { runtime: object }).runtime,
          defaultEndpoint,
        },
      })
    if (accepted) expect(parse).not.toThrow()
    else expect(parse).toThrow(InvalidModelSettingsError)
  })
})

describe('model registry', () => {
  it('loads only model packs with committed artifact identity', () => {
    const registry = loadModelRegistry(resolve(process.cwd(), 'llm/models'))
    expect([...registry.keys()]).toEqual(['qwen3.5-9b-q4_k_m'])
  })

  it('fails when the models directory is missing', () => {
    expect(() => loadModelRegistry(resolve(process.cwd(), 'llm/models-missing'))).toThrow(
      ModelRegistryError,
    )
  })
})
