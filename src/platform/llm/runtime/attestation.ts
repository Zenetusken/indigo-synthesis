import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

export const RUNTIME_ATTESTATION_SCHEMA_VERSION = 1 as const

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

const fileIdentitySchema = z
  .object({
    realpath: z.string().min(1),
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
    sizeBytes: z.number().int().positive(),
    mtimeMs: z.number().int().nonnegative(),
    sha256: sha256Schema,
  })
  .strict()

const runtimeLibraryIdentitySchema = fileIdentitySchema.extend({
  filename: z.string().regex(/^lib(?:llama|ggml|mtmd)[a-z0-9._-]*\.so(?:\.[0-9.]+)?$/),
})

const runtimeAttestationPayloadSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_ATTESTATION_SCHEMA_VERSION),
    createdAt: z.string().datetime({ offset: true }),
    pid: z.number().int().positive(),
    processStartTimeTicks: z.string().regex(/^\d+$/),
    endpoint: z.string().url(),
    modelId: z.string().min(1),
    servedModelName: z.string().min(1),
    gpuLayers: z.literal(-2),
    runtime: fileIdentitySchema.extend({
      repository: z.string().url(),
      commit: z.string().regex(/^[a-f0-9]{40}$/),
      version: z.string().min(1),
      libraries: z.array(runtimeLibraryIdentitySchema).min(1),
    }),
    weights: fileIdentitySchema,
  })
  .strict()

export const runtimeAttestationSchema = runtimeAttestationPayloadSchema
  .extend({ attestationDigest: sha256Schema })
  .strict()

export type RuntimeAttestationPayload = z.infer<typeof runtimeAttestationPayloadSchema>
export type RuntimeAttestation = z.infer<typeof runtimeAttestationSchema>

export type VerifiedRuntimeIdentity = {
  readonly modelId: string
  readonly modelContentDigest: string
  readonly servedModelName: string
  readonly runtimeId: string
  readonly runtimeAttestationDigest: string
}

export type RuntimeAttestationVerification =
  | {
      readonly state: 'verified'
      readonly attestation: RuntimeAttestation
      readonly identity: VerifiedRuntimeIdentity
    }
  | {
      readonly state: 'invalid'
      readonly detail: string
    }

export type VerifyRuntimeAttestationOptions = {
  readonly path: string
  readonly endpoint: string
  readonly modelId: string
  readonly servedModelName: string
  readonly expectedModelSha256: string
  readonly expectedWeightsPath: string
  readonly expectedRuntimeCommit: string
  readonly expectedRuntimeRepository: string
  readonly expectedRuntimeVersion: string
  readonly expectedRuntimeSha256: string
  readonly expectedRuntimeSizeBytes: number
  readonly expectedRuntimeLibraries: readonly {
    readonly filename: string
    readonly sha256: string
    readonly sizeBytes: number
  }[]
}

function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Cannot canonicalize non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonStringify(entry)).join(',')}]`
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonStringify(entry)}`)
      .join(',')}}`
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}`)
}

export function runtimeAttestationDigest(payload: RuntimeAttestationPayload): string {
  return createHash('sha256')
    .update(canonicalJsonStringify(payload), 'utf8')
    .digest('hex')
}

export function createRuntimeAttestation(
  payload: RuntimeAttestationPayload,
): RuntimeAttestation {
  const parsed = runtimeAttestationPayloadSchema.parse(payload)
  return {
    ...parsed,
    attestationDigest: runtimeAttestationDigest(parsed),
  }
}

export function parseProcessStartTimeTicks(statLine: string): string {
  const commandEnd = statLine.lastIndexOf(')')
  if (commandEnd < 0) throw new Error('Malformed /proc process stat')
  const fieldsAfterCommand = statLine
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)
  const startTime = fieldsAfterCommand[19]
  if (!startTime || !/^\d+$/.test(startTime)) {
    throw new Error('Missing process start time in /proc process stat')
  }
  return startTime
}

function normalizedEndpoint(value: string): string {
  const url = new URL(value)
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/$/, '') || '/'
  return url.toString()
}

function sameIntegerStatValue(actual: bigint, expected: string): boolean {
  return actual.toString(10) === expected
}

function commandOption(
  command: readonly string[],
  ...names: readonly string[]
): string | null {
  const index = command.findIndex((value) => names.includes(value))
  return index >= 0 ? (command[index + 1] ?? null) : null
}

async function verifyFileIdentity(
  label: string,
  expectedPath: string,
  identity: z.infer<typeof fileIdentitySchema>,
): Promise<string | null> {
  const expectedRealpath = await realpath(expectedPath)
  if (expectedRealpath !== identity.realpath) {
    return `${label} realpath changed since launch`
  }
  const metadata = await stat(expectedRealpath, { bigint: true })
  if (!sameIntegerStatValue(metadata.dev, identity.device)) {
    return `${label} device changed since launch`
  }
  if (!sameIntegerStatValue(metadata.ino, identity.inode)) {
    return `${label} inode changed since launch`
  }
  if (Number(metadata.size) !== identity.sizeBytes) {
    return `${label} size changed since launch`
  }
  if (Number(metadata.mtimeMs) !== identity.mtimeMs) {
    return `${label} modification time changed since launch`
  }
  return null
}

/**
 * Verifies a launcher-produced runtime identity without re-hashing multi-gigabyte
 * weights on every request. File identity, process identity and the committed digest
 * make stale or accidentally substituted runtimes fail closed. A malicious process
 * running as the same OS user is outside this local attestation's threat model.
 */
export async function verifyRuntimeAttestation(
  options: VerifyRuntimeAttestationOptions,
): Promise<RuntimeAttestationVerification> {
  try {
    const attestationFile = await lstat(options.path)
    if (!attestationFile.isFile()) {
      return { state: 'invalid', detail: 'Runtime attestation is not a regular file' }
    }
    if ((attestationFile.mode & 0o777) !== 0o600) {
      return { state: 'invalid', detail: 'Runtime attestation permissions must be 0600' }
    }
    if (
      typeof process.getuid === 'function' &&
      attestationFile.uid !== process.getuid()
    ) {
      return { state: 'invalid', detail: 'Runtime attestation owner does not match' }
    }

    const parsed = runtimeAttestationSchema.safeParse(
      JSON.parse(await readFile(options.path, 'utf8')),
    )
    if (!parsed.success) {
      return { state: 'invalid', detail: 'Runtime attestation has an invalid shape' }
    }
    const attestation = parsed.data
    const { attestationDigest, ...payload } = attestation
    if (runtimeAttestationDigest(payload) !== attestationDigest) {
      return { state: 'invalid', detail: 'Runtime attestation digest does not match' }
    }
    if (
      normalizedEndpoint(attestation.endpoint) !== normalizedEndpoint(options.endpoint)
    ) {
      return { state: 'invalid', detail: 'Runtime endpoint does not match attestation' }
    }
    if (
      attestation.modelId !== options.modelId ||
      attestation.servedModelName !== options.servedModelName
    ) {
      return { state: 'invalid', detail: 'Runtime model identity does not match' }
    }
    if (attestation.weights.sha256 !== options.expectedModelSha256) {
      return {
        state: 'invalid',
        detail: 'Attested model digest is not the committed digest',
      }
    }
    if (
      attestation.runtime.commit !== options.expectedRuntimeCommit ||
      attestation.runtime.repository !== options.expectedRuntimeRepository ||
      attestation.runtime.version !== options.expectedRuntimeVersion ||
      attestation.runtime.sha256 !== options.expectedRuntimeSha256 ||
      attestation.runtime.sizeBytes !== options.expectedRuntimeSizeBytes
    ) {
      return { state: 'invalid', detail: 'Attested runtime is not the pinned runtime' }
    }
    const expectedLibraries = new Map(
      options.expectedRuntimeLibraries.map((library) => [library.filename, library]),
    )
    if (
      attestation.runtime.libraries.length !== expectedLibraries.size ||
      attestation.runtime.libraries.some((library) => {
        const expected = expectedLibraries.get(library.filename)
        return (
          !expected ||
          library.sha256 !== expected.sha256 ||
          library.sizeBytes !== expected.sizeBytes
        )
      })
    ) {
      return {
        state: 'invalid',
        detail: 'Attested runtime libraries do not match the pinned runtime lock',
      }
    }

    const processStartTime = parseProcessStartTimeTicks(
      await readFile(`/proc/${attestation.pid}/stat`, 'utf8'),
    )
    if (processStartTime !== attestation.processStartTimeTicks) {
      return { state: 'invalid', detail: 'Attested runtime process identity is stale' }
    }
    const runningExecutable = await realpath(
      await readlink(`/proc/${attestation.pid}/exe`),
    )
    if (runningExecutable !== attestation.runtime.realpath) {
      return {
        state: 'invalid',
        detail: 'Running process is not the attested executable',
      }
    }
    const command = (await readFile(`/proc/${attestation.pid}/cmdline`))
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
    const commandWeights = commandOption(command, '--model', '-m')
    const commandAlias = commandOption(command, '--alias', '-a')
    const commandGpuLayers = commandOption(command, '--n-gpu-layers', '-ngl')
    const normalizedCommandGpuLayers =
      commandGpuLayers === 'all' ? -2 : Number(commandGpuLayers)
    if (
      !commandWeights ||
      (await realpath(commandWeights)) !== attestation.weights.realpath ||
      commandAlias !== attestation.servedModelName ||
      normalizedCommandGpuLayers !== attestation.gpuLayers
    ) {
      return {
        state: 'invalid',
        detail:
          'Running process arguments do not match the attested model and GPU policy',
      }
    }

    const runtimeFileError = await verifyFileIdentity(
      'Runtime binary',
      attestation.runtime.realpath,
      attestation.runtime,
    )
    if (runtimeFileError) return { state: 'invalid', detail: runtimeFileError }
    const processMaps = await readFile(`/proc/${attestation.pid}/maps`, 'utf8')
    for (const library of attestation.runtime.libraries) {
      const libraryError = await verifyFileIdentity(
        `Runtime library ${library.filename}`,
        library.realpath,
        library,
      )
      if (libraryError) return { state: 'invalid', detail: libraryError }
      if (!processMaps.includes(library.realpath)) {
        return {
          state: 'invalid',
          detail: `Running process has not mapped pinned library ${library.filename}`,
        }
      }
    }
    const weightsFileError = await verifyFileIdentity(
      'Model weights',
      resolve(options.expectedWeightsPath),
      attestation.weights,
    )
    if (weightsFileError) return { state: 'invalid', detail: weightsFileError }

    return {
      state: 'verified',
      attestation,
      identity: {
        modelId: attestation.modelId,
        modelContentDigest: attestation.weights.sha256,
        servedModelName: attestation.servedModelName,
        runtimeId: `llama.cpp@${attestation.runtime.commit}:pid:${attestation.pid}:start:${attestation.processStartTimeTicks}`,
        runtimeAttestationDigest: attestation.attestationDigest,
      },
    }
  } catch (error) {
    return {
      state: 'invalid',
      detail:
        error instanceof Error
          ? error.message
          : 'Runtime attestation verification failed',
    }
  }
}

export function defaultRuntimeAttestationPath(cwd = process.cwd()): string {
  return resolve(cwd, 'tmp/llm-runtime-attestation.json')
}
