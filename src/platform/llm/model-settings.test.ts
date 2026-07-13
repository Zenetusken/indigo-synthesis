import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadModelRegistry, ModelRegistryError } from './model-registry'
import { InvalidModelSettingsError, parseModelSettings } from './model-settings'

const samplePack = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'llm/models/qwen3.5-9b-q4_k_m/settings.json'),
    'utf8',
  ),
) as unknown

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
