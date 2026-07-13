import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import {
  parseProcessStartTimeTicks,
  type RuntimeAttestationVerification,
  runtimeAttestationSchema,
  verifyRuntimeAttestation,
} from '../../src/platform/llm/runtime/attestation'

type ArtifactLock = {
  readonly sha256: string
  readonly installedFilename: string
}

type RuntimeLock = {
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
}

const execFileAsync = promisify(execFile)

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function required(value: string | undefined, option: string): string {
  if (!value) throw new Error(`Missing required --${option}`)
  return value
}

async function processHasIdentity(pid: number, startTimeTicks: string) {
  try {
    const processStat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return parseProcessStartTimeTicks(processStat) === startTimeTicks
  } catch {
    return false
  }
}

function requireVerified(
  result: RuntimeAttestationVerification,
): Extract<RuntimeAttestationVerification, { state: 'verified' }> {
  if (result.state === 'invalid') {
    throw new Error(`Refusing runtime shutdown: ${result.detail}`)
  }
  return result
}

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    attestation: { type: 'string' },
    'listener-pid': { type: 'string' },
  },
  strict: true,
})

const root = resolve(values.root ?? process.cwd())
const listenerPid = Number(required(values['listener-pid'], 'listener-pid'))
if (!Number.isSafeInteger(listenerPid) || listenerPid <= 0) {
  throw new Error('--listener-pid must be a positive decimal integer')
}

const artifactLock = await readJson<ArtifactLock>(
  resolve(root, 'llm/models/qwen3.5-9b-q4_k_m/artifact.lock.json'),
)
const runtimeLock = await readJson<RuntimeLock>(
  resolve(root, 'llm/runtime/llama-cpp.lock.json'),
)
const verifyOptions = {
  path: resolve(values.attestation ?? resolve(root, 'tmp/llm-runtime-attestation.json')),
  endpoint: 'http://127.0.0.1:8080/v1',
  modelId: 'qwen3.5-9b-q4_k_m',
  servedModelName: 'qwen3.5-9b-q4_k_m',
  expectedModelSha256: artifactLock.sha256,
  expectedWeightsPath: resolve(root, 'llm/weights', artifactLock.installedFilename),
  expectedRuntimeCommit: runtimeLock.commit,
  expectedRuntimeRepository: runtimeLock.repository,
  expectedRuntimeVersion: runtimeLock.version,
  expectedRuntimeSha256: runtimeLock.serverBinarySha256,
  expectedRuntimeSizeBytes: runtimeLock.serverBinarySizeBytes,
  expectedContextTokens: 4096,
  expectedRuntimeLibraries: runtimeLock.runtimeLibraries,
} as const

const attestationShape = runtimeAttestationSchema.safeParse(
  JSON.parse(await readFile(verifyOptions.path, 'utf8')),
)
if (!attestationShape.success) {
  throw new Error('Refusing runtime shutdown: attestation has an invalid shape')
}
if (attestationShape.data.pid !== listenerPid) {
  throw new Error(
    `Refusing runtime shutdown: listener PID ${listenerPid} is not attested PID ${attestationShape.data.pid}`,
  )
}

const initial = requireVerified(await verifyRuntimeAttestation(verifyOptions))

// Re-run the complete check immediately before opening the pidfd. This revalidates
// PID/start time, exact argv and exact listener ownership after all setup work.
const finalVerification = requireVerified(await verifyRuntimeAttestation(verifyOptions))
if (
  finalVerification.attestation.pid !== initial.attestation.pid ||
  finalVerification.attestation.processStartTimeTicks !==
    initial.attestation.processStartTimeTicks
) {
  throw new Error('Refusing runtime shutdown: attested process identity changed')
}

await execFileAsync('python3', [
  resolve(root, 'scripts/llm/pidfd-signal.py'),
  String(finalVerification.attestation.pid),
  finalVerification.attestation.processStartTimeTicks,
])

const deadline = Date.now() + 10_000
while (
  Date.now() < deadline &&
  (await processHasIdentity(
    finalVerification.attestation.pid,
    finalVerification.attestation.processStartTimeTicks,
  ))
) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
}
if (
  await processHasIdentity(
    finalVerification.attestation.pid,
    finalVerification.attestation.processStartTimeTicks,
  )
) {
  throw new Error(
    `Attested runtime PID ${finalVerification.attestation.pid} did not stop`,
  )
}

console.log(
  `Stopped exact attested runtime PID ${finalVerification.attestation.pid} start=${finalVerification.attestation.processStartTimeTicks}`,
)
