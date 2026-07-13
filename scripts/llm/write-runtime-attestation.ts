import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import {
  createRuntimeAttestation,
  parseProcessStartTimeTicks,
  type RuntimeAttestationPayload,
} from '../../src/platform/llm/runtime/attestation'
import { assertStableFileIdentity, hashStableFileIdentity } from './stable-file-identity'

type ArtifactLock = {
  readonly schemaVersion: 1
  readonly repository: string
  readonly revision: string
  readonly filename: string
  readonly installedFilename: string
  readonly sha256: string
  readonly sizeBytes: number
}

type RuntimeLock = {
  readonly schemaVersion: 1
  readonly repository: string
  readonly commit: string
  readonly version: string
  readonly serverBinarySha256: string
  readonly serverBinarySizeBytes: number
  readonly runtimeLibraries: readonly {
    readonly filename: string
    readonly sha256: string
    readonly sizeBytes: number
  }[]
  readonly cudaArchitectures: readonly number[]
  readonly serverBinary: string
  readonly propsEndpoint: string
}

const execFileAsync = promisify(execFile)

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function required(value: string | undefined, option: string): string {
  if (!value) throw new Error(`Missing required --${option}`)
  return value
}

const { values } = parseArgs({
  options: {
    pid: { type: 'string' },
    endpoint: { type: 'string' },
    'model-id': { type: 'string' },
    'served-name': { type: 'string' },
    'gpu-layers': { type: 'string' },
    binary: { type: 'string' },
    weights: { type: 'string' },
    output: { type: 'string' },
    root: { type: 'string' },
  },
  strict: true,
})

const root = resolve(values.root ?? process.cwd())
const artifactLock = await readJson<ArtifactLock>(
  resolve(root, 'llm/models/qwen3.5-9b-q4_k_m/artifact.lock.json'),
)
const runtimeLock = await readJson<RuntimeLock>(
  resolve(root, 'llm/runtime/llama-cpp.lock.json'),
)

const pid = Number(required(values.pid, 'pid'))
const gpuLayersInput = required(values['gpu-layers'], 'gpu-layers')
if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('--pid must be positive')
if (gpuLayersInput !== 'all') {
  throw new Error('--gpu-layers must be all for product readiness')
}
const gpuLayers = -2 as const

const binary = required(values.binary, 'binary')
const weights = required(values.weights, 'weights')
const output = resolve(required(values.output, 'output'))
const modelId = required(values['model-id'], 'model-id')
const servedModelName = required(values['served-name'], 'served-name')

if (artifactLock.schemaVersion !== 1 || runtimeLock.schemaVersion !== 1) {
  throw new Error('Unsupported LLM lock schema')
}

const versionProbe = await execFileAsync(binary, ['--version'], { timeout: 5_000 })
const versionEvidence = `${versionProbe.stdout}\n${versionProbe.stderr}`
if (
  !versionEvidence.includes(runtimeLock.version) ||
  !versionEvidence.includes(runtimeLock.commit.slice(0, 7))
) {
  throw new Error(
    `llama-server --version does not identify pinned runtime ${runtimeLock.version}`,
  )
}
if (modelId !== 'qwen3.5-9b-q4_k_m' || servedModelName !== modelId) {
  throw new Error('The supported launcher only attests the committed Q4 model pack')
}
if (basename(weights) !== artifactLock.installedFilename) {
  throw new Error(
    `Weights filename must be ${artifactLock.installedFilename}; got ${basename(weights)}`,
  )
}

const [weightsIdentity, runtimeIdentity, processStat] = await Promise.all([
  hashStableFileIdentity(weights, 'Model weights'),
  hashStableFileIdentity(binary, 'llama-server binary'),
  readFile(`/proc/${pid}/stat`, 'utf8'),
])
if (
  runtimeIdentity.sha256 !== runtimeLock.serverBinarySha256 ||
  runtimeIdentity.sizeBytes !== runtimeLock.serverBinarySizeBytes
) {
  throw new Error(
    'llama-server binary digest or size does not match the pinned runtime lock',
  )
}
if (
  weightsIdentity.sha256 !== artifactLock.sha256 ||
  weightsIdentity.sizeBytes !== artifactLock.sizeBytes
) {
  throw new Error(`Weights digest or size does not match the committed artifact lock`)
}

const configuredDigest = process.env.INDIGO_LLM_MODEL_SHA256
if (configuredDigest && configuredDigest !== artifactLock.sha256) {
  throw new Error('INDIGO_LLM_MODEL_SHA256 disagrees with the committed artifact lock')
}

const runtimeDirectory = dirname(runtimeIdentity.realpath)
const runtimeLibraries = await Promise.all(
  runtimeLock.runtimeLibraries.map(async (lockedLibrary) => {
    const path = join(runtimeDirectory, lockedLibrary.filename)
    const identity = await hashStableFileIdentity(
      path,
      `Runtime library ${lockedLibrary.filename}`,
    )
    if (
      identity.sha256 !== lockedLibrary.sha256 ||
      identity.sizeBytes !== lockedLibrary.sizeBytes
    ) {
      throw new Error(
        `Runtime library ${lockedLibrary.filename} does not match the pinned runtime lock`,
      )
    }
    return { filename: lockedLibrary.filename, ...identity }
  }),
)

// All expensive hashes are complete. Revalidate every launch path together so a
// replacement during a later file's hash cannot pair stale content with new stat data.
await Promise.all([
  assertStableFileIdentity(binary, runtimeIdentity, 'llama-server binary'),
  assertStableFileIdentity(weights, weightsIdentity, 'Model weights'),
  ...runtimeLibraries.map((library) =>
    assertStableFileIdentity(
      join(runtimeDirectory, library.filename),
      library,
      `Runtime library ${library.filename}`,
    ),
  ),
])

const payload: RuntimeAttestationPayload = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  pid,
  processStartTimeTicks: parseProcessStartTimeTicks(processStat),
  endpoint: required(values.endpoint, 'endpoint'),
  modelId,
  servedModelName,
  gpuLayers,
  runtime: {
    ...runtimeIdentity,
    repository: runtimeLock.repository,
    commit: runtimeLock.commit,
    version: runtimeLock.version,
    libraries: runtimeLibraries,
  },
  weights: weightsIdentity,
}
const attestation = createRuntimeAttestation(payload)

await mkdir(dirname(output), { recursive: true, mode: 0o700 })
const temporaryPath = `${output}.${process.pid}.${Date.now()}.tmp`
await writeFile(temporaryPath, `${JSON.stringify(attestation, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
  flag: 'wx',
})
await chmod(temporaryPath, 0o600)
await rename(temporaryPath, output)
console.log(`Runtime attestation: ${output}`)
console.log(`Attestation digest: ${attestation.attestationDigest}`)
