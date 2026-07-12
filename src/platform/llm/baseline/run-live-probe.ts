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
}

export type LiveProbeReport = {
  readonly mode: 'skipped' | 'ran'
  readonly endpoint: string | null
  readonly modelId: string | null
  readonly cases: readonly LiveProbeCaseResult[]
  readonly availableCount: number
  readonly unavailableCount: number
  readonly ok: boolean
  readonly summary: string
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
      cases: [],
      availableCount: 0,
      unavailableCount: 0,
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
    if (golden.id === 'invalidated-decision') {
      const result = await port.synthesize({
        factBundle: golden.factBundle,
        promptVersion: FUTURE_LOAD_PROMPT_VERSION,
        timeoutMs,
      })
      cases.push({
        caseId: golden.id,
        status: result.status,
        reason: result.status === 'unavailable' ? result.reason : undefined,
        detail: result.status === 'unavailable' ? result.detail : null,
      })
      continue
    }

    const result = await port.synthesize({
      factBundle: golden.factBundle,
      promptVersion: FUTURE_LOAD_PROMPT_VERSION,
      timeoutMs,
    })

    if (result.status === 'available') {
      cases.push({
        caseId: golden.id,
        status: 'available',
        prosePreview: result.prose.slice(0, 160),
      })
    } else {
      cases.push({
        caseId: golden.id,
        status: 'unavailable',
        reason: result.reason,
        detail: result.detail,
      })
    }
  }

  const availableCount = cases.filter((c) => c.status === 'available').length
  const unavailableCount = cases.filter((c) => c.status === 'unavailable').length
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
    cases,
    availableCount,
    unavailableCount,
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
    '',
  ]
  for (const item of report.cases) {
    const extra =
      item.status === 'available'
        ? item.prosePreview
        : `${item.reason ?? ''}${item.detail ? `: ${item.detail}` : ''}`
    lines.push(`${item.status.toUpperCase().padEnd(11)} ${item.caseId} — ${extra ?? ''}`)
  }
  return lines.join('\n')
}
