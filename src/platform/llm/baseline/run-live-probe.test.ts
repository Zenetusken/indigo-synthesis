import { describe, expect, it, vi } from 'vitest'
import { liveProbeSucceeded, runLiveProbe } from './run-live-probe'

describe('runLiveProbe', () => {
  it('reports a wholly unreachable eligible model path despite the invalidated control', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connection refused')
    })

    const report = await runLiveProbe({
      endpoint: 'http://127.0.0.1:8080/v1',
      modelId: 'qwen3.5-9b-q4_k_m',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(report.ok).toBe(false)
    expect(report.summary).toMatch(/runtime unreachable/i)
    expect(
      report.cases.find((entry) => entry.caseId === 'invalidated-decision'),
    ).toMatchObject({ status: 'unavailable', reason: 'invalidated-decision' })
    expect(fetchImpl).toHaveBeenCalledTimes(
      report.cases.filter((entry) => entry.caseId !== 'invalidated-decision').length,
    )
  })
})

describe('liveProbeSucceeded', () => {
  it('requires every eligible case to produce available prose', () => {
    expect(
      liveProbeSucceeded([
        { caseId: 'increase', status: 'available' },
        { caseId: 'hold', status: 'unavailable', reason: 'validation-failed' },
        {
          caseId: 'invalidated-decision',
          status: 'unavailable',
          reason: 'invalidated-decision',
        },
      ]),
    ).toBe(false)
    expect(
      liveProbeSucceeded([
        { caseId: 'increase', status: 'unavailable', reason: 'model-error' },
        { caseId: 'hold', status: 'unavailable', reason: 'validation-failed' },
      ]),
    ).toBe(false)
    expect(
      liveProbeSucceeded([
        { caseId: 'increase', status: 'available' },
        { caseId: 'hold', status: 'available' },
        {
          caseId: 'invalidated-decision',
          status: 'unavailable',
          reason: 'invalidated-decision',
        },
      ]),
    ).toBe(true)
  })
})
