import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { getLlmConfig, type LlmRuntimeConfig } from '../config'
import { loadModelRegistry } from '../model-registry'
import type { ModelSettings } from '../model-settings'

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

export type LlmPreflightReport = {
  readonly checkedAt: string
  readonly mode: LlmRuntimeConfig['mode']
  readonly modelId: string | null
  readonly pack: ModelSettings | null
  readonly memory: MemoryStatus
  readonly gpu: GpuStatus
  readonly weights: WeightsStatus | null
  readonly endpoint: EndpointStatus
  readonly readyForLocalInference: boolean
  readonly blockers: readonly string[]
  readonly recommendations: readonly string[]
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

async function probeEndpoint(endpoint: string): Promise<EndpointStatus> {
  const base = endpoint.replace(/\/$/, '')
  const modelsUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    const response = await fetch(modelsUrl, { signal: controller.signal })
    clearTimeout(timer)
    if (!response.ok) {
      return {
        endpoint,
        reachable: false,
        models: [],
        detail: `HTTP ${response.status} from ${modelsUrl}`,
      }
    }
    const body = (await response.json()) as {
      data?: readonly { id?: string }[]
    }
    const models = (body.data ?? [])
      .map((row) => row.id)
      .filter((id): id is string => typeof id === 'string')
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
      detail: error instanceof Error ? error.message : 'Endpoint unreachable',
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
    config.endpointOverride ?? pack?.runtime.defaultEndpoint ?? 'http://127.0.0.1:1234/v1'
  const endpoint = await probeEndpoint(endpointUrl)

  const blockers: string[] = []
  const recommendations: string[] = []

  if (config.mode === 'disabled') {
    recommendations.push(
      'INDIGO_LLM_MODE=disabled (product default). Set local when ready to probe.',
    )
  }
  if (!memory.sufficientForApproxModelBytes) {
    blockers.push('Insufficient MemAvailable for the configured model size + headroom')
    recommendations.push('Close browsers/IDE tabs or free swap before loading a 9B GGUF')
  }
  if (gpu.state === 'mismatch') {
    blockers.push('GPU driver/library version mismatch — CUDA inference blocked')
    recommendations.push(
      'Reboot to load the installed NVIDIA module (DKMS 580.173) replacing the still-loaded 580.159 kernel module',
    )
  } else if (gpu.state === 'ready') {
    recommendations.push(
      'GPU ready — prefer CUDA-backed llama-server / LM Studio CUDA runtime',
    )
  } else {
    recommendations.push('GPU not ready — CPU-only inference is possible but slower')
  }
  if (weights && !weights.present) {
    recommendations.push(
      `Place pack weights at ${weights.path} or load the equivalent model in LM Studio`,
    )
  }
  if (!endpoint.reachable) {
    blockers.push(`Inference endpoint unreachable: ${endpoint.endpoint}`)
    recommendations.push(
      'Run: pnpm llm:serve  (starts LM Studio loopback server) or llama-server',
    )
  } else if (endpoint.models.length === 0) {
    recommendations.push('Server is up but no models loaded — run: pnpm llm:load')
  }

  const servedName = pack?.runtime.servedModelName
  if (
    endpoint.reachable &&
    servedName &&
    endpoint.models.length > 0 &&
    !endpoint.models.some(
      (id) =>
        id === servedName ||
        id.includes(servedName) ||
        id.toLowerCase().includes('qwen3.5-9b') ||
        id.toLowerCase().includes('qwen2.5-7b'),
    )
  ) {
    recommendations.push(
      `Loaded models do not match pack servedModelName "${servedName}". Load the pack model or point INDIGO_LLM_MODEL_ID / served name at a loaded id.`,
    )
  }

  // GPU mismatch blocks CUDA only; CPU local inference is fine when the endpoint is up.
  const hardBlockers = blockers.filter((b) => !b.startsWith('GPU driver'))
  const readyForLocalInference =
    hardBlockers.length === 0 &&
    endpoint.reachable &&
    memory.sufficientForApproxModelBytes

  return {
    checkedAt: new Date().toISOString(),
    mode: config.mode,
    modelId: config.modelId,
    pack,
    memory,
    gpu,
    weights,
    endpoint,
    readyForLocalInference,
    blockers,
    recommendations,
  }
}

export function formatLlmPreflightReport(report: LlmPreflightReport): string {
  const lines = [
    'LLM runtime preflight',
    `  checkedAt=${report.checkedAt}`,
    `  mode=${report.mode} modelId=${report.modelId ?? '(none)'}`,
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
