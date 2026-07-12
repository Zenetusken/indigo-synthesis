import { describe, expect, it } from 'vitest'
import { GOLDEN_BASELINE_CASES, LLM_BASELINE_VERSION } from './golden-cases'
import { formatOfflineBaselineReport, runOfflineBaseline } from './run-offline-baseline'

describe('offline LLM baseline', () => {
  it('covers the development adjustment reason-code surface', () => {
    const ids = new Set(GOLDEN_BASELINE_CASES.map((c) => c.id))
    expect(ids.has('increase-at-target')).toBe(true)
    expect(ids.has('hold-rpe-above-eight')).toBe(true)
    expect(ids.has('hold-skipped-set')).toBe(true)
    expect(ids.has('hold-missing-data')).toBe(true)
    expect(ids.has('hold-target-not-met')).toBe(true)
    expect(ids.has('hold-load-not-at-target')).toBe(true)
    expect(ids.has('hold-increment-exceeds-bound')).toBe(true)
    expect(ids.has('blocked-pain')).toBe(true)
    expect(ids.has('invalidated-decision')).toBe(true)
  })

  it('passes the calibrated offline baseline suite', async () => {
    const report = await runOfflineBaseline({
      now: () => new Date('2026-07-12T18:00:00.000Z'),
    })
    if (!report.ok) {
      // eslint-disable-next-line no-console
      console.error(formatOfflineBaselineReport(report))
    }
    expect(report.baselineVersion).toBe(LLM_BASELINE_VERSION)
    expect(report.ok).toBe(true)
    expect(report.failed).toBe(0)
    expect(report.passed).toBeGreaterThan(10)
  })
})
