import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { assertLoopbackEndpoint } from '../adapters/openai-compatible-loopback'
import { getLlmConfig, type LlmRuntimeConfig } from '../config'
import { loadModelRegistry } from '../model-registry'
import type { ModelSettings } from '../model-settings'
import { type VerifiedRuntimeIdentity, verifyRuntimeAttestation } from './attestation'

const execFileAsync = promisify(execFile)

export type GpuStatus =
  | {
      readonly state: 'ready'
      readonly name: string | null
      readonly driverVersion: string | null
      readonly memoryTotalMiB: number | null
      readonly memoryFreeMiB: number | null
    }
  | {
      readonly state: 'mismatch' | 'unavailable' | 'error'
      readonly detail: string
      readonly loadedKernelVersion: string | null
      readonly userspaceLibraryVersion: string | null
    }

export type MemoryStatus = {
  readonly memAvailableBytes: number
  readonly memTotalBytes: number
  readonly swapUsedBytes: number
  readonly sufficientForApproxModelBytes: boolean
  readonly detail: string
}

export type WeightsStatus = {
  readonly path: string
  readonly present: boolean
  readonly sizeBytes: number | null
  readonly detail: string
}

export type EndpointStatus = {
  readonly endpoint: string
  readonly reachable: boolean
  readonly models: readonly string[]
  readonly detail: string
}

export type RuntimeEvidenceStatus =
  | {
      readonly state: 'verified'
      readonly detail: string
      readonly identity: VerifiedRuntimeIdentity
      readonly gpuMemoryMiB: number
    }
  | {
      readonly state: 'unverified'
      readonly detail: string
      readonly identity: null
      readonly gpuMemoryMiB: null
    }

export type LlmPreflightReport = {
  readonly checkedAt: string
  readonly mode: LlmRuntimeConfig['mode']
  readonly modelId: string | null
  readonly requireGpu: boolean
  readonly pack: ModelSettings | null
  readonly memory: MemoryStatus
  readonly gpu: GpuStatus
  readonly weights: WeightsStatus | null
  readonly endpoint: EndpointStatus
  readonly runtimeEvidence: RuntimeEvidenceStatus
  readonly verifiedRuntimeIdentity: VerifiedRuntimeIdentity | null
  /** True only when the product may enable local inference under current policy. */
  readonly readyForLocalInference: boolean
  readonly blockers: readonly string[]
  readonly recommendations: readonly string[]
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
  readonly propsEndpoint: string
}

function readMeminfo(): { available: number; total: number; swapUsed: number } {
  const raw = readFileSync('/proc/meminfo', 'utf8')
  const get = (key: string): number => {
    const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))
    return match ? Number(match[1]) * 1024 : 0
  }
  const total = get('MemTotal')
  const available = get('MemAvailable')
  const swapTotal = get('SwapTotal')
  const swapFree = get('SwapFree')
  return { available, total, swapUsed: Math.max(0, swapTotal - swapFree) }
}

function readLoadedNvidiaVersion(): string | null {
  try {
    return readFileSync('/sys/module/nvidia/version', 'utf8').trim() || null
  } catch {
    return null
  }
}

async function probeGpu(): Promise<GpuStatus> {
  const loadedKernelVersion = readLoadedNvidiaVersion()
  try {
    const { stdout, stderr } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=name,driver_version,memory.total,memory.free',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 5_000 },
    )
    const line = stdout.trim().split('\n')[0]
    if (!line) {
      return {
        state: 'error',
        detail: stderr.trim() || 'nvidia-smi returned no GPU rows',
        loadedKernelVersion,
        userspaceLibraryVersion: null,
      }
    }
    const [name, driverVersion, total, free] = line.split(',').map((s) => s.trim())
    return {
      state: 'ready',
      name: name || null,
      driverVersion: driverVersion || null,
      memoryTotalMiB: total ? Number(total) : null,
      memoryFreeMiB: free ? Number(free) : null,
    }
  } catch (error) {
    const err = error as {
      message?: string
      stderr?: string | Buffer
      stdout?: string | Buffer
    }
    const combined = [
      err.message ?? '',
      typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString('utf8') ?? ''),
      typeof err.stdout === 'string' ? err.stdout : (err.stdout?.toString('utf8') ?? ''),
    ].join('\n')
    if (/Driver\/library version mismatch|NVML/i.test(combined)) {
      return {
        state: 'mismatch',
        detail:
          'NVIDIA kernel module and userspace libraries disagree. Reboot so the loaded module matches installed nvidia-utils/DKMS (CUDA offload blocked until then).',
        loadedKernelVersion,
        userspaceLibraryVersion:
          'installed package line ~580.173 (nvidia-utils-580); confirm after reboot with nvidia-smi',
      }
    }
    if (/not found|ENOENT/i.test(combined)) {
      return {
        state: 'unavailable',
        detail: 'nvidia-smi not available on PATH',
        loadedKernelVersion,
        userspaceLibraryVersion: null,
      }
    }
    // Kernel still loaded but probe failed — treat as mismatch when versions known
    if (loadedKernelVersion && /Command failed|nvidia-smi/i.test(combined)) {
      return {
        state: 'mismatch',
        detail: `nvidia-smi failed while module ${loadedKernelVersion} is loaded. Usually userspace/driver mismatch — reboot to reload NVIDIA modules. (${combined.slice(0, 200).replace(/\s+/g, ' ')})`,
        loadedKernelVersion,
        userspaceLibraryVersion: null,
      }
    }
    return {
      state: 'error',
      detail: combined.slice(0, 500).replace(/\s+/g, ' '),
      loadedKernelVersion,
      userspaceLibraryVersion: null,
    }
  }
}

export async function probeEndpoint(
  endpoint: string,
  options?: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number },
): Promise<EndpointStatus> {
  try {
    assertLoopbackEndpoint(endpoint)
  } catch (error) {
    return {
      endpoint,
      reachable: false,
      models: [],
      detail: error instanceof Error ? error.message : 'Endpoint must be loopback',
    }
  }

  const base = endpoint.replace(/\/$/, '')
  const modelsUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 2_000)
  let responseReceived = false
  try {
    const response = await (options?.fetchImpl ?? fetch)(modelsUrl, {
      redirect: 'error',
      signal: controller.signal,
    })
    responseReceived = true
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      return {
        endpoint,
        reachable: false,
        models: [],
        detail: `Redirects are not permitted from ${modelsUrl}`,
      }
    }
    if (!response.ok) {
      return {
        endpoint,
        reachable: false,
        models: [],
        detail: `HTTP ${response.status} from ${modelsUrl}`,
      }
    }
    const body = (await response.json()) as unknown
    if (
      typeof body !== 'object' ||
      body === null ||
      !('data' in body) ||
      !Array.isArray(body.data)
    ) {
      return {
        endpoint,
        reachable: false,
        models: [],
        detail: `Malformed JSON body from ${modelsUrl}`,
      }
    }
    const models = body.data
      .map((row: unknown) =>
        typeof row === 'object' &&
        row !== null &&
        'id' in row &&
        typeof row.id === 'string'
          ? row.id
          : null,
      )
      .filter((id: string | null): id is string => id !== null && id.length > 0)
    return {
      endpoint,
      reachable: true,
      models,
      detail: models.length
        ? `OpenAI-compatible server lists ${models.length} model id(s)`
        : 'Server reachable but /models is empty (load a model)',
    }
  } catch (error) {
    return {
      endpoint,
      reachable: false,
      models: [],
      detail:
        error instanceof Error && error.name === 'AbortError'
          ? `Endpoint timed out while reading ${modelsUrl}`
          : responseReceived
            ? `Malformed response body from ${modelsUrl}`
            : error instanceof Error
              ? error.message
              : 'Endpoint unreachable',
    }
  } finally {
    clearTimeout(timer)
  }
}

export function endpointModelReadinessBlocker(
  endpoint: EndpointStatus,
  servedModelName: string | null,
): string | null {
  if (!endpoint.reachable) return `Inference endpoint unreachable: ${endpoint.endpoint}`
  if (endpoint.models.length === 0) {
    return `Inference endpoint lists no models: ${endpoint.endpoint}`
  }
  if (servedModelName && !endpoint.models.includes(servedModelName)) {
    return `Inference endpoint does not list exact served model "${servedModelName}".`
  }
  return null
}

function readRuntimeLock(cwd = process.cwd()): RuntimeLock {
  return JSON.parse(
    readFileSync(resolve(cwd, 'llm/runtime/llama-cpp.lock.json'), 'utf8'),
  ) as RuntimeLock
}

async function probeRuntimeGpuAllocation(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader,nounits'],
      { timeout: 5_000 },
    )
    for (const row of stdout.trim().split('\n')) {
      const [candidatePid, memory] = row.split(',').map((value) => value.trim())
      if (Number(candidatePid) === pid && Number(memory) > 0) return Number(memory)
    }
    return null
  } catch {
    return null
  }
}

async function probeRuntimeProps(
  endpoint: string,
  propsPath: string,
  identity: VerifiedRuntimeIdentity,
  attestedWeightsPath: string,
  runtimeCommit: string,
): Promise<string | null> {
  const endpointUrl = assertLoopbackEndpoint(endpoint)
  endpointUrl.pathname = propsPath
  endpointUrl.search = ''
  endpointUrl.hash = ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
  try {
    const response = await fetch(endpointUrl, {
      redirect: 'error',
      signal: controller.signal,
    })
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400) ||
      !response.ok
    ) {
      return `Pinned runtime props unavailable at ${endpointUrl}`
    }
    const body = (await response.json()) as unknown
    if (typeof body !== 'object' || body === null) {
      return 'Pinned runtime props returned a malformed body'
    }
    const props = body as Record<string, unknown>
    if (props.model_alias !== identity.servedModelName) {
      return 'Runtime props model alias does not match the attested model'
    }
    if (
      typeof props.model_path !== 'string' ||
      (await realpath(props.model_path)) !== attestedWeightsPath
    ) {
      return 'Runtime props model path does not match the attested weights'
    }
    if (
      typeof props.build_info !== 'string' ||
      !props.build_info.includes(runtimeCommit.slice(0, 7))
    ) {
      return 'Runtime props build identity does not match the pinned commit'
    }
    return null
  } catch (error) {
    return error instanceof Error && error.name === 'AbortError'
      ? `Pinned runtime props timed out at ${endpointUrl}`
      : 'Pinned runtime props could not be verified'
  } finally {
    clearTimeout(timer)
  }
}

async function probeRuntimeEvidence(
  config: LlmRuntimeConfig,
  pack: ModelSettings | null,
  endpoint: string,
): Promise<RuntimeEvidenceStatus> {
  if (!pack) {
    return {
      state: 'unverified',
      detail: 'No committed model pack is active',
      identity: null,
      gpuMemoryMiB: null,
    }
  }
  if (
    config.modelSha256Override &&
    config.modelSha256Override !== pack.artifacts.expectedSha256
  ) {
    return {
      state: 'unverified',
      detail: 'INDIGO_LLM_MODEL_SHA256 disagrees with the committed model digest',
      identity: null,
      gpuMemoryMiB: null,
    }
  }

  try {
    const runtimeLock = readRuntimeLock()
    const expectedWeightsPath = resolve(
      config.weightsDir,
      pack.artifacts.weightsRelativePath,
    )
    const verified = await verifyRuntimeAttestation({
      path: config.runtimeAttestationPath,
      endpoint,
      modelId: pack.modelId,
      servedModelName: pack.runtime.servedModelName,
      expectedModelSha256: pack.artifacts.expectedSha256,
      expectedWeightsPath,
      expectedRuntimeCommit: runtimeLock.commit,
      expectedRuntimeRepository: runtimeLock.repository,
      expectedRuntimeVersion: runtimeLock.version,
      expectedRuntimeSha256: runtimeLock.serverBinarySha256,
      expectedRuntimeSizeBytes: runtimeLock.serverBinarySizeBytes,
      expectedRuntimeLibraries: runtimeLock.runtimeLibraries,
    })
    if (verified.state === 'invalid') {
      return {
        state: 'unverified',
        detail: verified.detail,
        identity: null,
        gpuMemoryMiB: null,
      }
    }

    const propsError = await probeRuntimeProps(
      endpoint,
      runtimeLock.propsEndpoint,
      verified.identity,
      verified.attestation.weights.realpath,
      runtimeLock.commit,
    )
    if (propsError) {
      return {
        state: 'unverified',
        detail: propsError,
        identity: null,
        gpuMemoryMiB: null,
      }
    }
    const gpuMemoryMiB = await probeRuntimeGpuAllocation(verified.attestation.pid)
    if (gpuMemoryMiB === null) {
      return {
        state: 'unverified',
        detail: 'Attested runtime PID has no observed NVIDIA memory allocation',
        identity: null,
        gpuMemoryMiB: null,
      }
    }
    return {
      state: 'verified',
      detail: `Pinned runtime, weights and GPU allocation verified for PID ${verified.attestation.pid}`,
      identity: verified.identity,
      gpuMemoryMiB,
    }
  } catch (error) {
    return {
      state: 'unverified',
      detail:
        error instanceof Error
          ? error.message
          : 'Pinned runtime evidence could not be verified',
      identity: null,
      gpuMemoryMiB: null,
    }
  }
}

function probeWeights(
  config: LlmRuntimeConfig,
  pack: ModelSettings | null,
): WeightsStatus | null {
  if (!pack) return null
  const path = resolve(config.weightsDir, pack.artifacts.weightsRelativePath)
  if (!existsSync(path)) {
    return {
      path,
      present: false,
      sizeBytes: null,
      detail:
        'Weights file missing — download per llm/README.md or import into LM Studio',
    }
  }
  const sizeBytes = statSync(path).size
  return {
    path,
    present: true,
    sizeBytes,
    detail: `Weights present (${(sizeBytes / 1e9).toFixed(2)} GB)`,
  }
}

/**
 * Host preflight for the optional local LLM stack (RAM, GPU, weights, loopback server).
 * Does not start processes and never blocks core product boot.
 */
export async function runLlmPreflight(
  config: LlmRuntimeConfig = getLlmConfig(),
): Promise<LlmPreflightReport> {
  const mem = readMeminfo()
  let pack: ModelSettings | null = null
  if (config.modelId) {
    try {
      const registry = loadModelRegistry(config.modelsDir)
      pack = registry.get(config.modelId) ?? null
    } catch {
      pack = null
    }
  }

  const approxNeed = pack?.artifacts.approxSizeBytes ?? 6_000_000_000
  // Keep ~4 GiB headroom above model file size for KV/context and OS.
  const need = approxNeed + 4 * 1024 * 1024 * 1024
  const memory: MemoryStatus = {
    memAvailableBytes: mem.available,
    memTotalBytes: mem.total,
    swapUsedBytes: mem.swapUsed,
    sufficientForApproxModelBytes: mem.available >= need,
    detail: `${(mem.available / 1e9).toFixed(1)} GiB available / ${(mem.total / 1e9).toFixed(1)} GiB total; swap used ${(mem.swapUsed / 1e9).toFixed(1)} GiB`,
  }

  const gpu = await probeGpu()
  const weights = probeWeights(config, pack)
  const endpointUrl =
    config.endpointOverride ?? pack?.runtime.defaultEndpoint ?? 'http://127.0.0.1:8080/v1'
  const endpoint = await probeEndpoint(endpointUrl)
  const runtimeEvidence = await probeRuntimeEvidence(config, pack, endpointUrl)

  const blockers: string[] = []
  const recommendations: string[] = []
  const requireGpu = config.requireGpu

  if (config.mode === 'disabled') {
    recommendations.push(
      'INDIGO_LLM_MODE=disabled (product default). Set local when GPU preflight is ready.',
    )
  }
  if (!memory.sufficientForApproxModelBytes) {
    blockers.push('Insufficient MemAvailable for the configured model size + headroom')
    recommendations.push('Close browsers/IDE tabs or free swap before loading a 9B GGUF')
  }

  if (requireGpu) {
    if (gpu.state === 'ready') {
      recommendations.push(
        'GPU ready — local inference must offload all model layers (INDIGO_LLM_N_GPU_LAYERS=all)',
      )
    } else if (gpu.state === 'mismatch') {
      blockers.push(
        'GPU required but driver/library mismatch — reboot to reload NVIDIA modules',
      )
      recommendations.push(
        'Reboot, then: nvidia-smi && pnpm llm:build-cuda && pnpm llm:serve && pnpm llm:measure-gpu',
      )
    } else {
      blockers.push(`GPU required but not ready (${gpu.state})`)
      recommendations.push(
        'Fix NVIDIA stack until nvidia-smi succeeds; CPU inference is not permitted for the product LLM layer',
      )
    }
  } else if (gpu.state !== 'ready') {
    recommendations.push(
      'INDIGO_LLM_REQUIRE_GPU=false — CPU diagnosis only; not a production path',
    )
  }

  if (weights && !weights.present) {
    blockers.push(`Weights missing at ${weights.path}`)
    recommendations.push('Run: pnpm llm:download-qwen35')
  }
  if (config.mode === 'local' && runtimeEvidence.state !== 'verified') {
    blockers.push(`Runtime identity unverified: ${runtimeEvidence.detail}`)
    recommendations.push(
      'Start the committed CUDA runtime with pnpm llm:serve to create a fresh attestation.',
    )
  }
  const servedName = pack?.runtime.servedModelName ?? null
  const endpointBlocker = endpointModelReadinessBlocker(endpoint, servedName)
  if (endpointBlocker) {
    blockers.push(endpointBlocker)
    recommendations.push('Run: pnpm llm:serve  (GPU-only llama-server on loopback :8080)')
  }

  const readyForLocalInference =
    blockers.length === 0 &&
    endpoint.reachable &&
    runtimeEvidence.state === 'verified' &&
    memory.sufficientForApproxModelBytes &&
    requireGpu &&
    gpu.state === 'ready'

  return {
    checkedAt: new Date().toISOString(),
    mode: config.mode,
    modelId: config.modelId,
    requireGpu,
    pack,
    memory,
    gpu,
    weights,
    endpoint,
    runtimeEvidence,
    verifiedRuntimeIdentity: runtimeEvidence.identity,
    readyForLocalInference,
    blockers,
    recommendations,
  }
}

export function formatLlmPreflightReport(report: LlmPreflightReport): string {
  const lines = [
    'LLM runtime preflight',
    `  checkedAt=${report.checkedAt}`,
    `  mode=${report.mode} modelId=${report.modelId ?? '(none)'} requireGpu=${report.requireGpu}`,
    `  memory: ${report.memory.detail} sufficient=${report.memory.sufficientForApproxModelBytes}`,
    `  gpu: ${report.gpu.state}${
      report.gpu.state === 'ready'
        ? ` ${report.gpu.name} driver=${report.gpu.driverVersion} freeMiB=${report.gpu.memoryFreeMiB}`
        : ` — ${report.gpu.detail}`
    }`,
  ]
  if (report.gpu.state !== 'ready' && 'loadedKernelVersion' in report.gpu) {
    lines.push(
      `  gpu.loadedKernel=${report.gpu.loadedKernelVersion ?? 'n/a'} userspaceHint=${report.gpu.userspaceLibraryVersion ?? 'n/a'}`,
    )
  }
  if (report.weights) {
    lines.push(
      `  weights: present=${report.weights.present} path=${report.weights.path}`,
      `           ${report.weights.detail}`,
    )
  }
  lines.push(
    `  endpoint: reachable=${report.endpoint.reachable} ${report.endpoint.endpoint}`,
    `            ${report.endpoint.detail}`,
    `  runtime: ${report.runtimeEvidence.state} — ${report.runtimeEvidence.detail}`,
  )
  if (report.endpoint.models.length) {
    lines.push(`  models: ${report.endpoint.models.join(', ')}`)
  }
  lines.push(`  readyForLocalInference=${report.readyForLocalInference}`)
  if (report.blockers.length) {
    lines.push('  blockers:')
    for (const b of report.blockers) lines.push(`    - ${b}`)
  }
  if (report.recommendations.length) {
    lines.push('  recommendations:')
    for (const r of report.recommendations) lines.push(`    - ${r}`)
  }
  return lines.join('\n')
}
