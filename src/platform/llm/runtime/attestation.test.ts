import { describe, expect, it } from 'vitest'
import {
  createRuntimeAttestation,
  parseProcessStartTimeTicks,
  type RuntimeAttestationPayload,
  runtimeAttestationDigest,
} from './attestation'

function payload(): RuntimeAttestationPayload {
  return {
    schemaVersion: 1,
    createdAt: '2026-07-12T12:00:00.000Z',
    pid: 123,
    processStartTimeTicks: '987654',
    endpoint: 'http://127.0.0.1:8080/v1',
    modelId: 'qwen3.5-9b-q4_k_m',
    servedModelName: 'qwen3.5-9b-q4_k_m',
    gpuLayers: -2,
    runtime: {
      repository: 'https://github.com/ggml-org/llama.cpp.git',
      commit: '99f3dc32296f825fec94f202da1e9fede1e78cf9',
      version: '1 (99f3dc3)',
      libraries: [
        {
          filename: 'libllama.so.0.0.1',
          realpath: '/opt/libllama.so.0.0.1',
          device: '9',
          inode: '10',
          sizeBytes: 11,
          mtimeMs: 12,
          sha256: 'c'.repeat(64),
        },
      ],
      realpath: '/opt/llama-server',
      device: '1',
      inode: '2',
      sizeBytes: 3,
      mtimeMs: 4,
      sha256: 'a'.repeat(64),
    },
    weights: {
      realpath: '/models/qwen.gguf',
      device: '5',
      inode: '6',
      sizeBytes: 7,
      mtimeMs: 8,
      sha256: 'b'.repeat(64),
    },
  }
}

describe('runtime attestation', () => {
  it('creates a deterministic digest over the payload only', () => {
    const attestation = createRuntimeAttestation(payload())

    expect(attestation.attestationDigest).toBe(runtimeAttestationDigest(payload()))
    expect(attestation.attestationDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('parses a process start time even when the command contains spaces or parentheses', () => {
    const suffix = ['S', ...Array.from({ length: 18 }, () => '0'), '424242', '0'].join(
      ' ',
    )

    expect(parseProcessStartTimeTicks(`321 (llama server) child) ${suffix}`)).toBe(
      '424242',
    )
  })

  it('rejects malformed process stat input', () => {
    expect(() => parseProcessStartTimeTicks('not-a-proc-stat')).toThrow(
      'Malformed /proc process stat',
    )
  })
})
