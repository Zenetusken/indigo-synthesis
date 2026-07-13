import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRuntimeAttestation,
  mappedFilePaths,
  parseProcessStartTimeTicks,
  type RuntimeAttestationPayload,
  runtimeAttestationDigest,
  runtimeCommandMatchesPolicy,
  type VerifyRuntimeAttestationOptions,
  verifyRuntimeAttestation,
} from './attestation'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

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

function optionsFor(
  path: string,
  value: RuntimeAttestationPayload,
): VerifyRuntimeAttestationOptions {
  return {
    path,
    endpoint: value.endpoint,
    modelId: value.modelId,
    servedModelName: value.servedModelName,
    expectedModelSha256: value.weights.sha256,
    expectedWeightsPath: value.weights.realpath,
    expectedRuntimeCommit: value.runtime.commit,
    expectedRuntimeRepository: value.runtime.repository,
    expectedRuntimeVersion: value.runtime.version,
    expectedRuntimeSha256: value.runtime.sha256,
    expectedRuntimeSizeBytes: value.runtime.sizeBytes,
    expectedContextTokens: 4096,
    expectedRuntimeLibraries: value.runtime.libraries.map((library) => ({
      filename: library.filename,
      sha256: library.sha256,
      sizeBytes: library.sizeBytes,
    })),
  }
}

async function writeAttestation(
  value: RuntimeAttestationPayload,
  mode = 0o600,
): Promise<{ path: string; options: VerifyRuntimeAttestationOptions }> {
  const directory = await mkdtemp(join(tmpdir(), 'indigo-attestation-test-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'attestation.json')
  await writeFile(path, `${JSON.stringify(createRuntimeAttestation(value))}\n`, { mode })
  await chmod(path, mode)
  return { path, options: optionsFor(path, value) }
}

async function fileIdentity(path: string, sha256: string) {
  const resolved = await realpath(path)
  const metadata = await stat(resolved, { bigint: true })
  return {
    realpath: resolved,
    device: metadata.dev.toString(10),
    inode: metadata.ino.toString(10),
    sizeBytes: Number(metadata.size),
    mtimeMs: Number(metadata.mtimeMs),
    sha256,
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

  it('parses mapped paths exactly rather than accepting substring lookalikes', () => {
    const paths = mappedFilePaths(
      [
        '7f-8f r-xp 00000000 08:01 11 /opt/libllama.so.0.0.1.backup',
        '8f-9f r--p 00000000 08:01 12 /opt/libggml.so.0.9',
      ].join('\n'),
    )

    expect(paths.has('/opt/libllama.so.0.0.1')).toBe(false)
    expect(paths.has('/opt/libllama.so.0.0.1.backup')).toBe(true)
  })

  it('rejects unsafe permissions before trusting attestation content', async () => {
    const written = await writeAttestation(payload(), 0o644)
    await expect(verifyRuntimeAttestation(written.options)).resolves.toEqual({
      state: 'invalid',
      detail: 'Runtime attestation permissions must be 0600',
    })
  })

  it('rejects a modified attestation digest', async () => {
    const written = await writeAttestation(payload())
    const parsed = JSON.parse(await readFile(written.path, 'utf8')) as Record<
      string,
      unknown
    >
    parsed.attestationDigest = 'f'.repeat(64)
    await writeFile(written.path, JSON.stringify(parsed), { mode: 0o600 })

    await expect(verifyRuntimeAttestation(written.options)).resolves.toEqual({
      state: 'invalid',
      detail: 'Runtime attestation digest does not match',
    })
  })

  it('rejects runtime evidence that differs from the committed lock', async () => {
    const written = await writeAttestation(payload())
    const result = await verifyRuntimeAttestation({
      ...written.options,
      expectedRuntimeSha256: 'd'.repeat(64),
    })

    expect(result).toEqual({
      state: 'invalid',
      detail: 'Attested runtime is not the pinned runtime',
    })
  })

  it('rejects a stale process identity', async () => {
    const value = { ...payload(), pid: 2_147_483_647 }
    const written = await writeAttestation(value)

    await expect(verifyRuntimeAttestation(written.options)).resolves.toMatchObject({
      state: 'invalid',
      detail: expect.stringMatching(/ENOENT|no such file/i),
    })
  })

  it('rejects a live process whose arguments do not match the attested policy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'indigo-attestation-files-'))
    temporaryDirectories.push(directory)
    const weightsPath = join(directory, 'qwen.gguf')
    const libraryPath = join(directory, 'libllama.so.0.0.1')
    await writeFile(weightsPath, 'weights')
    await writeFile(libraryPath, 'library')
    const runtimePath = await realpath(process.execPath)
    const start = parseProcessStartTimeTicks(
      await readFile(`/proc/${process.pid}/stat`, 'utf8'),
    )
    const runtime = await fileIdentity(runtimePath, 'a'.repeat(64))
    const weights = await fileIdentity(weightsPath, 'b'.repeat(64))
    const library = await fileIdentity(libraryPath, 'c'.repeat(64))
    const value: RuntimeAttestationPayload = {
      ...payload(),
      pid: process.pid,
      processStartTimeTicks: start,
      runtime: {
        ...payload().runtime,
        ...runtime,
        libraries: [{ ...library, filename: 'libllama.so.0.0.1' }],
      },
      weights,
    }
    const written = await writeAttestation(value)

    await expect(verifyRuntimeAttestation(written.options)).resolves.toEqual({
      state: 'invalid',
      detail:
        'Running process arguments do not match the attested model, endpoint, GPU, and context policy',
    })
  })

  it('requires canonical GPU and context literals in the runtime command policy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'indigo-command-policy-'))
    temporaryDirectories.push(directory)
    const weightsPath = join(directory, 'qwen.gguf')
    await writeFile(weightsPath, 'weights')
    const weightsRealpath = await realpath(weightsPath)
    const policy = {
      weightsRealpath,
      servedModelName: 'qwen3.5-9b-q4_k_m',
      gpuLayers: -2,
      host: '127.0.0.1',
      port: '8080',
      contextTokens: 4096,
    } as const
    const command = [
      'llama-server',
      '--model',
      weightsPath,
      '--alias',
      policy.servedModelName,
      '--n-gpu-layers',
      'all',
      '--host',
      policy.host,
      '--port',
      policy.port,
      '-c',
      '4096',
    ]

    await expect(runtimeCommandMatchesPolicy(command, policy)).resolves.toBe(true)
    await expect(
      runtimeCommandMatchesPolicy([...command.slice(0, -1), '8192'], policy),
    ).resolves.toBe(false)
    await expect(
      runtimeCommandMatchesPolicy([...command, '--ctx-size', '8192'], policy),
    ).resolves.toBe(false)
    for (const contextLookalike of ['04096', '+4096', '4096.0', '4.096e3']) {
      await expect(
        runtimeCommandMatchesPolicy([...command.slice(0, -1), contextLookalike], policy),
      ).resolves.toBe(false)
    }
    const gpuLayersIndex = command.indexOf('all')
    for (const gpuLayersLookalike of ['-2', 'ALL', 'all ']) {
      const lookalikeCommand = [...command]
      lookalikeCommand[gpuLayersIndex] = gpuLayersLookalike
      await expect(runtimeCommandMatchesPolicy(lookalikeCommand, policy)).resolves.toBe(
        false,
      )
    }
  })

  it('matches a symlinked command path by canonical weights identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'indigo-command-symlink-'))
    temporaryDirectories.push(directory)
    const weightsPath = join(directory, 'qwen.gguf')
    const logicalWeightsPath = join(directory, 'mounted-qwen.gguf')
    await writeFile(weightsPath, 'weights')
    await symlink(weightsPath, logicalWeightsPath)

    await expect(
      runtimeCommandMatchesPolicy(
        [
          'llama-server',
          '--model',
          logicalWeightsPath,
          '--alias',
          'qwen3.5-9b-q4_k_m',
          '--n-gpu-layers',
          'all',
          '--host',
          '127.0.0.1',
          '--port',
          '8080',
          '-c',
          '4096',
        ],
        {
          weightsRealpath: await realpath(weightsPath),
          servedModelName: 'qwen3.5-9b-q4_k_m',
          gpuLayers: -2,
          host: '127.0.0.1',
          port: '8080',
          contextTokens: 4096,
        },
      ),
    ).resolves.toBe(true)
  })
})
