import { describe, expect, it } from 'vitest'
import { buildMeasurementSnapshot, formatMeasurementSummary } from './metrics'
import { percentileMs } from './run-live-probe'
import type { LiveProbeReport } from './run-live-probe'
import type { OfflineBaselineReport } from './run-offline-baseline'

describe('percentileMs', () => {
  it('returns null for empty samples', () => {
    expect(percentileMs([], 50)).toBeNull()
  })

  it('computes nearest-rank p50 and p95', () => {
    const samples = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    expect(percentileMs(samples, 50)).toBe(500)
    expect(percentileMs(samples, 95)).toBe(1000)
    expect(percentileMs([1700], 50)).toBe(1700)
    expect(percentileMs([1700], 95)).toBe(1700)
  })
})

describe('buildMeasurementSnapshot live latency', () => {
  const offline: OfflineBaselineReport = {
    ok: true,
    passed: 28,
    failed: 0,
    checkedAt: '2026-07-13T00:00:00.000Z',
    promptVersion: 'future-load.v1',
    baselineVersion: '2026-07-12.1',
    modelPackIds: ['qwen3.5-9b-q4_k_m', 'qwen3.5-9b-q5_k_m'],
    checks: [
      { id: 'increase-at-target/accepted', ok: true, detail: 'ok' },
      { id: 'increase-at-target/reject:invented-load', ok: true, detail: 'ok' },
      { id: 'increase-at-target/synthesize-available', ok: true, detail: 'ok' },
    ],
  }

  it('includes latency percentiles and model digest from the live probe', () => {
    const live: LiveProbeReport = {
      mode: 'ran',
      endpoint: 'http://127.0.0.1:8080/v1',
      modelId: 'qwen3.5-9b-q4_k_m',
      modelContentDigest: 'a'.repeat(64),
      cases: [
        {
          caseId: 'increase-at-target',
          status: 'available',
          durationMs: 1500,
          prosePreview: 'ok',
        },
        {
          caseId: 'hold-rpe-above-eight',
          status: 'available',
          durationMs: 1700,
          prosePreview: 'ok',
        },
        {
          caseId: 'invalidated-decision',
          status: 'unavailable',
          reason: 'invalidated-decision',
          durationMs: 5,
        },
      ],
      availableCount: 2,
      unavailableCount: 1,
      latency: {
        sampleCount: 2,
        samplesMs: [1500, 1700],
        p50Ms: 1500,
        p95Ms: 1700,
      },
      ok: true,
      summary: 'Live probe: 2 available, 1 unavailable of 3',
    }

    const snapshot = buildMeasurementSnapshot({
      offline,
      offlineDurationMs: 12,
      live,
      product: {
        e2eOk: true,
        e2eDurationMs: 13_000,
        suite: 'test:e2e:llm',
        note: 'archive run',
      },
    })

    expect(snapshot.live?.latencyMs).toEqual({
      sampleCount: 2,
      p50: 1500,
      p95: 1700,
      samples: [1500, 1700],
    })
    expect(snapshot.live?.modelContentDigest).toBe('a'.repeat(64))
    expect(snapshot.product?.e2eOk).toBe(true)
    expect(formatMeasurementSummary(snapshot)).toContain('live.latencyMs.p50=1500')
    expect(formatMeasurementSummary(snapshot)).toContain('product.suite=test:e2e:llm')
  })
})
