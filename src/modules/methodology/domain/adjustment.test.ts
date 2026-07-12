import { describe, expect, it } from 'vitest'
import {
  type DevelopmentAdjustmentInput,
  decideDevelopmentLoadAdjustment,
  InvalidAdjustmentInputError,
  MAX_CANONICAL_LOAD_GRAMS,
} from './adjustment'

function eligibleInput(): DevelopmentAdjustmentInput {
  return {
    exerciseId: 'development.back-squat',
    currentTargetLoadGrams: 40_000,
    targetRepetitions: 5,
    expectedSetCount: 3,
    painReported: false,
    sets: Array.from({ length: 3 }, () => ({
      status: 'performed' as const,
      loadGrams: 40_000,
      repetitions: 5,
      rpe: 8,
      explicitlyConfirmed: true,
    })),
  }
}

describe('unreviewed development load adjustment', () => {
  it('proposes one bounded development-fixture increment when all facts qualify', () => {
    const result = decideDevelopmentLoadAdjustment(eligibleInput())

    expect(result).toMatchObject({
      kind: 'increase',
      currentTargetLoadGrams: 40_000,
      proposedTargetLoadGrams: 41_000,
      reasonCode: 'development.adjustment.increase',
      contentMode: 'development',
      developmentOnly: true,
    })
    expect(result.notice).toContain('UNREVIEWED DEVELOPMENT FIXTURE')
  })

  it('lets pain outrank skipped and missing set facts', () => {
    const input = eligibleInput()
    const result = decideDevelopmentLoadAdjustment({
      ...input,
      painReported: true,
      sets: [{ status: 'skipped' }],
    })

    expect(result.kind).toBe('blocked')
    expect(result.reasonCode).toBe('development.adjustment.pain-block')
  })

  it('suppresses an increase after any skipped set', () => {
    const input = eligibleInput()
    const result = decideDevelopmentLoadAdjustment({
      ...input,
      sets: [...input.sets.slice(0, 2), { status: 'skipped' }],
    })

    expect(result.kind).toBe('hold')
    expect(result.reasonCode).toBe('development.adjustment.skipped-set')
  })

  it.each([
    {
      label: 'missing pain answer',
      mutate: (input: DevelopmentAdjustmentInput): DevelopmentAdjustmentInput => ({
        ...input,
        painReported: null,
      }),
    },
    {
      label: 'missing set',
      mutate: (input: DevelopmentAdjustmentInput): DevelopmentAdjustmentInput => ({
        ...input,
        sets: input.sets.slice(1),
      }),
    },
    {
      label: 'unconfirmed performed fact',
      mutate: (input: DevelopmentAdjustmentInput): DevelopmentAdjustmentInput => ({
        ...input,
        sets: input.sets.map((set, index) =>
          index === 0 && set.status === 'performed'
            ? { ...set, explicitlyConfirmed: false }
            : set,
        ),
      }),
    },
    {
      label: 'missing RPE',
      mutate: (input: DevelopmentAdjustmentInput): DevelopmentAdjustmentInput => ({
        ...input,
        sets: input.sets.map((set, index) =>
          index === 0 && set.status === 'performed' ? { ...set, rpe: null } : set,
        ),
      }),
    },
  ])('suppresses an increase for $label', ({ mutate }) => {
    const result = decideDevelopmentLoadAdjustment(mutate(eligibleInput()))

    expect(result.kind).toBe('hold')
    expect(result.reasonCode).toBe('development.adjustment.missing-data')
  })

  it('suppresses an increase when any RPE is above the fixture threshold of 8', () => {
    const input = eligibleInput()
    const result = decideDevelopmentLoadAdjustment({
      ...input,
      sets: input.sets.map((set, index) =>
        index === 0 && set.status === 'performed' ? { ...set, rpe: 8.1 } : set,
      ),
    })

    expect(result.kind).toBe('hold')
    expect(result.reasonCode).toBe('development.adjustment.rpe-above-eight')
  })

  it('suppresses an increase when repetitions do not meet the fixture target', () => {
    const input = eligibleInput()
    const result = decideDevelopmentLoadAdjustment({
      ...input,
      sets: input.sets.map((set, index) =>
        index === 0 && set.status === 'performed' ? { ...set, repetitions: 4 } : set,
      ),
    })

    expect(result.kind).toBe('hold')
    expect(result.reasonCode).toBe('development.adjustment.target-not-met')
  })

  it('holds when the fixture increment would exceed its percentage bound', () => {
    const input = eligibleInput()
    const result = decideDevelopmentLoadAdjustment({
      ...input,
      currentTargetLoadGrams: 20_000,
      sets: input.sets.map((set) =>
        set.status === 'performed' ? { ...set, loadGrams: 20_000 } : set,
      ),
    })

    expect(result.kind).toBe('hold')
    expect(result.reasonCode).toBe('development.adjustment.increment-exceeds-bound')
  })

  it('holds when an increase would exceed the canonical database load bound', () => {
    const input = eligibleInput()
    const result = decideDevelopmentLoadAdjustment({
      ...input,
      currentTargetLoadGrams: MAX_CANONICAL_LOAD_GRAMS,
      sets: input.sets.map((set) =>
        set.status === 'performed'
          ? { ...set, loadGrams: MAX_CANONICAL_LOAD_GRAMS }
          : set,
      ),
    })

    expect(result.kind).toBe('hold')
    expect(result.proposedTargetLoadGrams).toBe(MAX_CANONICAL_LOAD_GRAMS)
    expect(result.reasonCode).toBe('development.adjustment.increment-exceeds-bound')
  })

  it('rejects malformed performed facts rather than normalizing them', () => {
    const input = eligibleInput()

    expect(() =>
      decideDevelopmentLoadAdjustment({
        ...input,
        sets: input.sets.map((set, index) =>
          index === 0 && set.status === 'performed' ? { ...set, rpe: 11 } : set,
        ),
      }),
    ).toThrow(InvalidAdjustmentInputError)
  })
})
