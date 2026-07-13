import { resolve } from 'node:path'
import { createOpenAiCompatibleLoopbackLanguageModel } from '../adapters/openai-compatible-loopback'
import { createExplanationGenerationPort } from '../explanation/synthesize'
import { loadModelRegistry, requireModelSettings } from '../model-registry'
import { FUTURE_LOAD_PROMPT_VERSION } from '../prompts/future-load.v1'
import { GOLDEN_BASELINE_CASES } from './golden-cases'

export type LiveProbeCaseResult = {
  readonly caseId: string
  readonly status: 'available' | 'unavailable' | 'skipped'
  readonly reason?: string
  readonly detail?: string | null
  readonly prosePreview?: string
  /** Wall time for this case's synthesize call (ms). */
  readonly durationMs?: number
}

export type LiveLatencyStats = {
  readonly sampleCount: number
  readonly samplesMs: readonly number[]
  readonly p50Ms: number | null
  readonly p95Ms: number | null
}

export type LiveProbeReport = {
  readonly mode: 'skipped' | 'ran'
  readonly endpoint: string | null
  readonly modelId: string | null
  readonly modelContentDigest: string | null
  readonly cases: readonly LiveProbeCaseResult[]
  readonly availableCount: number
  readonly unavailableCount: number
  readonly latency: LiveLatencyStats | null
  readonly ok: boolean
  readonly summary: string
}

/** Nearest-rank percentile for sorted ascending samples. */
export function percentileMs(samplesMs: readonly number[], p: number): number | null {
  if (samplesMs.length === 0) return null
  if (p <= 0) return samplesMs[0] ?? null
  if (p >= 100) return samplesMs[samplesMs.length - 1] ?? null
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))] ?? null
}

function latencyFromCases(cases: readonly LiveProbeCaseResult[]): LiveLatencyStats {
  // Exclude short-circuit cases (e.g. invalidated-decision) so H10 reflects model path.
  const samplesMs = cases
    .filter((c) => c.caseId !== 'invalidated-decision')
    .map((c) => c.durationMs)
    .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms))
  return {
    sampleCount: samplesMs.length,
    samplesMs,
    p50Ms: percentileMs(samplesMs, 50),
    p95Ms: percentileMs(samplesMs, 95),
  }
}

export type LiveProbeOptions = {
  readonly endpoint: string
  readonly modelId: string
  readonly modelsDir?: string
  readonly modelContentDigest?: string
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

/**
 * Optional live probe against a host-local OpenAI-compatible server.
 * Not required for CI. Fails soft when the runtime is unreachable.
 */
export async function runLiveProbe(options: LiveProbeOptions): Promise<LiveProbeReport> {
  const modelsDir = options.modelsDir ?? resolve(process.cwd(), 'llm/models')
  const registry = loadModelRegistry(modelsDir)
  const settings = requireModelSettings(registry, options.modelId)
  const digest =
    options.modelContentDigest ?? settings.artifacts.expectedSha256 ?? 'unverified'
  const timeoutMs = options.timeoutMs ?? settings.limits.timeoutMs

  let languageModel: ReturnType<typeof createOpenAiCompatibleLoopbackLanguageModel>
  try {
    languageModel = createOpenAiCompatibleLoopbackLanguageModel({
      endpoint: options.endpoint,
      fetchImpl: options.fetchImpl,
    })
  } catch (error) {
    return {
      mode: 'ran',
      endpoint: options.endpoint,
      modelId: options.modelId,
      modelContentDigest: digest,
      cases: [],
      availableCount: 0,
      unavailableCount: 0,
      latency: null,
      ok: false,
      summary: error instanceof Error ? error.message : 'Invalid live endpoint',
    }
  }

  const port = createExplanationGenerationPort({
    languageModel,
    modelSettings: settings,
    modelContentDigest: digest,
    timeoutMs,
  })

  const cases: LiveProbeCaseResult[] = []
  for (const golden of GOLDEN_BASELINE_CASES) {
    const started = performance.now()
    const result = await port.synthesize({
      factBundle: golden.factBundle,
      promptVersion: FUTURE_LOAD_PROMPT_VERSION,
      timeoutMs,
    })
    const durationMs = Math.round(performance.now() - started)

    if (golden.id === 'invalidated-decision') {
      cases.push({
        caseId: golden.id,
        status: result.status,
        reason: result.status === 'unavailable' ? result.reason : undefined,
        detail: result.status === 'unavailable' ? result.detail : null,
        durationMs,
      })
      continue
    }

    if (result.status === 'available') {
      cases.push({
        caseId: golden.id,
        status: 'available',
        prosePreview: result.prose.slice(0, 160),
        durationMs,
      })
    } else {
      cases.push({
        caseId: golden.id,
        status: 'unavailable',
        reason: result.reason,
        detail: result.detail,
        durationMs,
      })
    }
  }

  const availableCount = cases.filter((c) => c.status === 'available').length
  const unavailableCount = cases.filter((c) => c.status === 'unavailable').length
  const latency = latencyFromCases(cases)
  const first = cases[0]
  const allUnreachable =
    cases.length > 0 &&
    cases.every(
      (c) =>
        c.status === 'unavailable' &&
        (c.reason === 'runtime-unreachable' || c.reason === 'timeout'),
    )

  return {
    mode: 'ran',
    endpoint: options.endpoint,
    modelId: options.modelId,
    modelContentDigest: digest,
    cases,
    availableCount,
    unavailableCount,
    latency,
    // Live probe is informational: unreachable is not a product regression.
    ok: !allUnreachable || availableCount > 0,
    summary: allUnreachable
      ? `Live runtime unreachable at ${options.endpoint} (${first?.detail ?? 'no detail'})`
      : `Live probe: ${availableCount} available, ${unavailableCount} unavailable of ${cases.length}`,
  }
}

export function formatLiveProbeReport(report: LiveProbeReport): string {
  if (report.mode === 'skipped') {
    return `LLM live probe: skipped (${report.summary})`
  }
  const lines = [
    `LLM live probe at ${report.endpoint} model=${report.modelId}`,
    report.summary,
    report.latency
      ? `latency ms: n=${report.latency.sampleCount} p50=${report.latency.p50Ms ?? 'n/a'} p95=${report.latency.p95Ms ?? 'n/a'}`
      : 'latency ms: (none)',
    '',
  ]
  for (const item of report.cases) {
    const timing = item.durationMs !== undefined ? ` [${item.durationMs}ms]` : ''
    const extra =
      item.status === 'available'
        ? item.prosePreview
        : `${item.reason ?? ''}${item.detail ? `: ${item.detail}` : ''}`
    lines.push(
      `${item.status.toUpperCase().padEnd(11)} ${item.caseId}${timing} — ${extra ?? ''}`,
    )
  }
  return lines.join('\n')
}
