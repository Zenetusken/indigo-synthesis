import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import {
  createRuntimeAttestation,
  parseProcessStartTimeTicks,
  type RuntimeAttestationPayload,
} from '../../src/platform/llm/runtime/attestation'

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

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(path)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('error', reject)
    input.on('end', resolvePromise)
  })
  return hash.digest('hex')
}

async function fileIdentity(path: string, sha256: string) {
  const canonicalPath = await realpath(path)
  const metadata = await stat(canonicalPath, { bigint: true })
  if (!metadata.isFile()) throw new Error(`${canonicalPath} is not a regular file`)
  return {
    realpath: canonicalPath,
    device: metadata.dev.toString(10),
    inode: metadata.ino.toString(10),
    sizeBytes: Number(metadata.size),
    mtimeMs: Number(metadata.mtimeMs),
    sha256,
  }
}

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
const gpuLayers = gpuLayersInput === 'all' ? -2 : Number(gpuLayersInput)
if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('--pid must be positive')
if (gpuLayers !== -2) {
  throw new Error('--gpu-layers must be all for product readiness')
}

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

const weightsMetadata = await stat(weights)
if (weightsMetadata.size !== artifactLock.sizeBytes) {
  throw new Error(
    `Weights size ${weightsMetadata.size} does not match lock ${artifactLock.sizeBytes}`,
  )
}

const [weightsSha256, binarySha256, processStat] = await Promise.all([
  sha256File(weights),
  sha256File(binary),
  readFile(`/proc/${pid}/stat`, 'utf8'),
])
const binaryMetadata = await stat(binary)
if (
  binarySha256 !== runtimeLock.serverBinarySha256 ||
  binaryMetadata.size !== runtimeLock.serverBinarySizeBytes
) {
  throw new Error(
    'llama-server binary digest or size does not match the pinned runtime lock',
  )
}
if (weightsSha256 !== artifactLock.sha256) {
  throw new Error(
    `Weights SHA-256 ${weightsSha256} does not match lock ${artifactLock.sha256}`,
  )
}

const configuredDigest = process.env.INDIGO_LLM_MODEL_SHA256
if (configuredDigest && configuredDigest !== artifactLock.sha256) {
  throw new Error('INDIGO_LLM_MODEL_SHA256 disagrees with the committed artifact lock')
}

const [runtimeIdentity, weightsIdentity] = await Promise.all([
  fileIdentity(binary, binarySha256),
  fileIdentity(weights, weightsSha256),
])
const runtimeDirectory = dirname(runtimeIdentity.realpath)
const runtimeLibraries = await Promise.all(
  runtimeLock.runtimeLibraries.map(async (lockedLibrary) => {
    const path = join(runtimeDirectory, lockedLibrary.filename)
    const sha256 = await sha256File(path)
    const identity = await fileIdentity(path, sha256)
    if (
      sha256 !== lockedLibrary.sha256 ||
      identity.sizeBytes !== lockedLibrary.sizeBytes
    ) {
      throw new Error(
        `Runtime library ${lockedLibrary.filename} does not match the pinned runtime lock`,
      )
    }
    return { filename: lockedLibrary.filename, ...identity }
  }),
)

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
