import { describe, expect, it } from 'vitest'
import {
  buildFutureLoadFactBundle,
  FactBundleBuildError,
  type PersistedFutureLoadDecision,
} from './build-fact-bundle'
import { canonicalFutureLoadExplanation } from './canonical-prose'
import { factBundleHash } from './fact-bundle'
import { validateExplanationProse } from './validate-prose'

/** Labels mirror athletes formatLoad for these gram values (asserted independently). */
const METRIC_100KG = '100 kg'
const METRIC_102_5KG = '102.5 kg'
const IMPERIAL_100KG_ISH = '220.462 lb' // 100000 / 453.59237 ≈ 220.462

function sampleSource(
  overrides: Partial<PersistedFutureLoadDecision> = {},
): PersistedFutureLoadDecision {
  const base: PersistedFutureLoadDecision = {
    decisionId: 'dec-1',
    sessionId: 'ses-1',
    exerciseCode: 'development.back-squat',
    exerciseName: 'Back squat — development fixture',
    decision: 'increase',
    currentLoadGrams: 100_000,
    nextLoadGrams: 102_500,
    reasonCode: 'development.adjustment.increase',
    ruleVersion: '0.0.1-development',
    currentLoadLabel: METRIC_100KG,
    proposedLoadLabel: METRIC_102_5KG,
    units: 'metric',
    contentMode: 'development',
    engineVersion: '0.1.0-development',
    methodologyId: 'development.methodology-fixture',
    methodologyVersion: '0.0.1-development',
    painReported: false,
  }

  return { ...base, ...overrides }
}

describe('buildFutureLoadFactBundle', () => {
  it('maps increase rows without inventing loads', () => {
    const source = sampleSource()
    const bundle = buildFutureLoadFactBundle(source)
    expect(bundle.decision.kind).toBe('increase')
    expect(bundle.decision.currentLoadGrams).toBe(100_000)
    expect(bundle.decision.proposedLoadGrams).toBe(102_500)
    expect(bundle.display.currentLoadLabel).toBe(METRIC_100KG)
    expect(bundle.display.proposedLoadLabel).toBe(METRIC_102_5KG)
    expect(bundle.grounding.reasonCode).toBe('development.adjustment.increase')
    expect(bundle.constraints.developmentFixtureNoticeRequired).toBe(true)
  })

  it('maps database unavailable to FactBundle blocked', () => {
    const bundle = buildFutureLoadFactBundle(
      sampleSource({
        decision: 'unavailable',
        nextLoadGrams: 100_000,
        proposedLoadLabel: METRIC_100KG,
        reasonCode: 'development.adjustment.pain-block',
      }),
    )
    expect(bundle.decision.kind).toBe('blocked')
  })

  it('maps hold without changing loads', () => {
    const bundle = buildFutureLoadFactBundle(
      sampleSource({
        decision: 'hold',
        nextLoadGrams: 100_000,
        proposedLoadLabel: METRIC_100KG,
        reasonCode: 'development.adjustment.rpe-above-eight',
      }),
    )
    expect(bundle.decision.kind).toBe('hold')
    expect(bundle.decision.proposedLoadGrams).toBe(100_000)
  })

  it('is stable under hashing for identical sources', () => {
    const a = buildFutureLoadFactBundle(sampleSource())
    const b = buildFutureLoadFactBundle(sampleSource())
    expect(factBundleHash(a)).toBe(factBundleHash(b))
  })

  it('fails closed on null loads', () => {
    expect(() =>
      buildFutureLoadFactBundle(
        sampleSource({
          currentLoadGrams: null,
          currentLoadLabel: 'Unavailable',
        }),
      ),
    ).toThrow(FactBundleBuildError)
  })

  it('builds bundles whose hand-calibrated prose still validates (measure H7→H3)', () => {
    const bundle = buildFutureLoadFactBundle(sampleSource())
    const prose = canonicalFutureLoadExplanation(bundle)
    expect(prose).not.toBeNull()
    if (!prose) throw new Error('sample bundle has no safe explanation')
    expect(validateExplanationProse(prose, bundle)).toEqual({ ok: true })
  })

  it('preserves caller-supplied imperial labels without unit conversion', () => {
    const bundle = buildFutureLoadFactBundle(
      sampleSource({
        units: 'imperial',
        currentLoadLabel: IMPERIAL_100KG_ISH,
        proposedLoadLabel: '225.973 lb',
      }),
    )
    expect(bundle.subject.units).toBe('imperial')
    expect(bundle.display.currentLoadLabel).toBe(IMPERIAL_100KG_ISH)
  })
})
