import { GOLDEN_BASELINE_CASES, LLM_BASELINE_VERSION } from './golden-cases'
import type { LiveProbeReport } from './run-live-probe'
import type { OfflineBaselineReport } from './run-offline-baseline'

export type LlmMeasurementSnapshot = {
  readonly protocol: 'llm-measurement-protocol'
  readonly protocolDoc: 'docs/architecture/LLM_MEASUREMENT_PROTOCOL.md'
  readonly baselineVersion: string
  readonly offline: {
    readonly ok: boolean
    readonly passed: number
    readonly failed: number
    readonly durationMs: number
    readonly checkedAt: string
    readonly promptVersion: string
    readonly packCount: number
    readonly packIds: readonly string[]
    readonly goldenCaseCount: number
    readonly reasonCodes: readonly string[]
    readonly validationAcceptPassRate: number
    readonly validationRejectPassRate: number
    readonly synthesizeAvailablePassRate: number
  }
  readonly live: null | {
    readonly ran: boolean
    readonly unreachable: boolean
    readonly availableCount: number
    readonly unavailableCount: number
    readonly availableRate: number | null
    readonly endpoint: string | null
    readonly modelId: string | null
    readonly modelContentDigest: string | null
    readonly summary: string
    readonly failureReasons: Readonly<Record<string, number>>
    /** Per-case synthesize wall times (ms); H10 interactive calibration. */
    readonly latencyMs: null | {
      readonly sampleCount: number
      readonly p50: number | null
      readonly p95: number | null
      readonly samples: readonly number[]
    }
  }
  /**
   * Product browser path (`pnpm test:e2e:llm`). Optional; filled by archive scripts.
   * Not a CI gate.
   */
  readonly product?: null | {
    readonly e2eOk: boolean | null
    readonly e2eDurationMs: number | null
    readonly suite: 'test:e2e:llm'
    readonly note: string
  }
}

function rate(passed: number, total: number): number {
  if (total === 0) return 0
  return passed / total
}

function collectCheckRates(report: OfflineBaselineReport): {
  validationAcceptPassRate: number
  validationRejectPassRate: number
  synthesizeAvailablePassRate: number
} {
  const accepts = report.checks.filter((c) => c.id.endsWith('/accepted'))
  const rejectTraps = report.checks.filter((c) => c.id.includes('/reject:'))
  const synthesize = report.checks.filter((c) => c.id.endsWith('/synthesize-available'))

  return {
    validationAcceptPassRate: rate(accepts.filter((c) => c.ok).length, accepts.length),
    validationRejectPassRate: rate(
      rejectTraps.filter((c) => c.ok).length,
      rejectTraps.length,
    ),
    synthesizeAvailablePassRate: rate(
      synthesize.filter((c) => c.ok).length,
      synthesize.length,
    ),
  }
}

export function buildMeasurementSnapshot(input: {
  readonly offline: OfflineBaselineReport
  readonly offlineDurationMs: number
  readonly live: LiveProbeReport | null
  readonly product?: LlmMeasurementSnapshot['product']
}): LlmMeasurementSnapshot {
  const allReasonCodes = [
    ...new Set(GOLDEN_BASELINE_CASES.map((c) => c.factBundle.grounding.reasonCode)),
  ].sort()

  const rates = collectCheckRates(input.offline)

  let live: LlmMeasurementSnapshot['live'] = null
  if (input.live && input.live.mode === 'ran') {
    const failureReasons: Record<string, number> = {}
    for (const item of input.live.cases) {
      if (item.status === 'unavailable') {
        const key = item.reason ?? 'unknown'
        failureReasons[key] = (failureReasons[key] ?? 0) + 1
      }
    }
    const eligible = input.live.cases.filter((c) => c.caseId !== 'invalidated-decision')
    const availableEligible = eligible.filter((c) => c.status === 'available').length
    const unreachable =
      availableEligible === 0 &&
      eligible.every(
        (c) =>
          c.status === 'unavailable' &&
          (c.reason === 'runtime-unreachable' || c.reason === 'timeout'),
      )

    const latency = input.live.latency

    live = {
      ran: true,
      unreachable,
      availableCount: input.live.availableCount,
      unavailableCount: input.live.unavailableCount,
      availableRate: eligible.length === 0 ? null : availableEligible / eligible.length,
      endpoint: input.live.endpoint,
      modelId: input.live.modelId,
      modelContentDigest: input.live.modelContentDigest,
      summary: input.live.summary,
      failureReasons,
      latencyMs: latency
        ? {
            sampleCount: latency.sampleCount,
            p50: latency.p50Ms,
            p95: latency.p95Ms,
            samples: latency.samplesMs,
          }
        : null,
    }
  }

  return {
    protocol: 'llm-measurement-protocol',
    protocolDoc: 'docs/architecture/LLM_MEASUREMENT_PROTOCOL.md',
    baselineVersion: LLM_BASELINE_VERSION,
    offline: {
      ok: input.offline.ok,
      passed: input.offline.passed,
      failed: input.offline.failed,
      durationMs: input.offlineDurationMs,
      checkedAt: input.offline.checkedAt,
      promptVersion: input.offline.promptVersion,
      packCount: input.offline.modelPackIds.length,
      packIds: input.offline.modelPackIds,
      goldenCaseCount: GOLDEN_BASELINE_CASES.length,
      reasonCodes: allReasonCodes,
      validationAcceptPassRate: rates.validationAcceptPassRate,
      validationRejectPassRate: rates.validationRejectPassRate,
      synthesizeAvailablePassRate: rates.synthesizeAvailablePassRate,
    },
    live,
    product: input.product ?? null,
  }
}

export function formatMeasurementSummary(snapshot: LlmMeasurementSnapshot): string {
  const o = snapshot.offline
  const lines = [
    'Measurement snapshot',
    `  baselineVersion=${snapshot.baselineVersion}`,
    `  offline.ok=${o.ok} passed=${o.passed} failed=${o.failed} durationMs=${o.durationMs}`,
    `  packs=${o.packCount} goldenCases=${o.goldenCaseCount}`,
    `  acceptPassRate=${o.validationAcceptPassRate.toFixed(3)} rejectPassRate=${o.validationRejectPassRate.toFixed(3)} synthesizePassRate=${o.synthesizeAvailablePassRate.toFixed(3)}`,
    `  reasonCodes=${o.reasonCodes.join(',')}`,
  ]
  if (snapshot.live) {
    const l = snapshot.live
    const lat = l.latencyMs
    lines.push(
      `  live.ran=${l.ran} unreachable=${l.unreachable} availableRate=${l.availableRate ?? 'n/a'} (${l.availableCount} available)`,
      `  live.modelContentDigest=${l.modelContentDigest ?? 'n/a'}`,
      lat
        ? `  live.latencyMs.p50=${lat.p50 ?? 'n/a'} p95=${lat.p95 ?? 'n/a'} n=${lat.sampleCount}`
        : '  live.latencyMs=(none)',
      `  live.summary=${l.summary}`,
    )
  } else {
    lines.push('  live=(not run)')
  }
  if (snapshot.product) {
    const p = snapshot.product
    lines.push(
      `  product.suite=${p.suite} e2eOk=${p.e2eOk ?? 'n/a'} e2eDurationMs=${p.e2eDurationMs ?? 'n/a'}`,
      `  product.note=${p.note}`,
    )
  } else {
    lines.push('  product=(not run)')
  }
  return lines.join('\n')
}
