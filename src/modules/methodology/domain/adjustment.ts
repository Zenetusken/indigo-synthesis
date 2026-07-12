import type { DevelopmentExerciseId } from './development-fixture'
import { UNREVIEWED_DEVELOPMENT_ADJUSTMENT_POLICY } from './development-fixture'

export type DevelopmentAdjustmentSetFact =
  | {
      readonly status: 'skipped'
    }
  | {
      readonly status: 'performed'
      readonly loadGrams: number | null
      readonly repetitions: number | null
      readonly rpe: number | null
      readonly explicitlyConfirmed: boolean
    }

export interface DevelopmentAdjustmentInput {
  readonly exerciseId: DevelopmentExerciseId
  readonly currentTargetLoadGrams: number
  readonly targetRepetitions: number
  readonly expectedSetCount: number
  readonly painReported: boolean | null
  readonly sets: readonly DevelopmentAdjustmentSetFact[]
}

export type DevelopmentAdjustmentReasonCode =
  | 'development.adjustment.pain-block'
  | 'development.adjustment.missing-data'
  | 'development.adjustment.skipped-set'
  | 'development.adjustment.rpe-above-eight'
  | 'development.adjustment.target-not-met'
  | 'development.adjustment.load-not-at-target'
  | 'development.adjustment.increment-exceeds-bound'
  | 'development.adjustment.increase'

export interface DevelopmentAdjustmentDecision {
  readonly contentMode: 'development'
  readonly developmentOnly: true
  readonly policyId: string
  readonly policyVersion: string
  readonly kind: 'blocked' | 'hold' | 'increase'
  readonly exerciseId: DevelopmentExerciseId
  readonly currentTargetLoadGrams: number
  readonly proposedTargetLoadGrams: number
  readonly reasonCode: DevelopmentAdjustmentReasonCode
  readonly notice: string
}

export class InvalidAdjustmentInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAdjustmentInputError'
  }
}

export const MAX_CANONICAL_LOAD_GRAMS = 1_000_000

const developmentNotice =
  'UNREVIEWED DEVELOPMENT FIXTURE — the RPE threshold, increment, percentage bound, and decision logic are not human-reviewed coaching guidance.'

function decision(
  input: DevelopmentAdjustmentInput,
  kind: DevelopmentAdjustmentDecision['kind'],
  reasonCode: DevelopmentAdjustmentReasonCode,
  proposedTargetLoadGrams = input.currentTargetLoadGrams,
): DevelopmentAdjustmentDecision {
  return {
    contentMode: 'development',
    developmentOnly: true,
    policyId: UNREVIEWED_DEVELOPMENT_ADJUSTMENT_POLICY.id,
    policyVersion: UNREVIEWED_DEVELOPMENT_ADJUSTMENT_POLICY.version,
    kind,
    exerciseId: input.exerciseId,
    currentTargetLoadGrams: input.currentTargetLoadGrams,
    proposedTargetLoadGrams,
    reasonCode,
    notice: developmentNotice,
  }
}

function assertValidInput(input: DevelopmentAdjustmentInput): void {
  if (
    !Number.isSafeInteger(input.currentTargetLoadGrams) ||
    input.currentTargetLoadGrams < 0 ||
    input.currentTargetLoadGrams > MAX_CANONICAL_LOAD_GRAMS ||
    !Number.isSafeInteger(input.targetRepetitions) ||
    input.targetRepetitions < 1 ||
    !Number.isSafeInteger(input.expectedSetCount) ||
    input.expectedSetCount < 1
  ) {
    throw new InvalidAdjustmentInputError(
      'Target load, repetitions, and set count must be non-negative integer grams and positive integer counts.',
    )
  }

  if (input.painReported !== null && typeof input.painReported !== 'boolean') {
    throw new InvalidAdjustmentInputError('painReported must be true, false, or null.')
  }

  for (const set of input.sets) {
    if (set.status !== 'performed' && set.status !== 'skipped') {
      throw new InvalidAdjustmentInputError('Set status must be performed or skipped.')
    }

    if (set.status !== 'performed') {
      continue
    }

    if (typeof set.explicitlyConfirmed !== 'boolean') {
      throw new InvalidAdjustmentInputError(
        'Performed set confirmation must be a boolean.',
      )
    }

    if (
      (set.loadGrams !== null &&
        (!Number.isSafeInteger(set.loadGrams) || set.loadGrams < 0)) ||
      (set.repetitions !== null &&
        (!Number.isSafeInteger(set.repetitions) || set.repetitions < 0)) ||
      (set.rpe !== null && (!Number.isFinite(set.rpe) || set.rpe < 1 || set.rpe > 10))
    ) {
      throw new InvalidAdjustmentInputError(
        'Performed set facts contain an out-of-range value.',
      )
    }
  }
}

/**
 * Evaluates an intentionally small, unreviewed development policy. Safety and factual
 * incompleteness always outrank the candidate increase.
 */
export function decideDevelopmentLoadAdjustment(
  input: DevelopmentAdjustmentInput,
): DevelopmentAdjustmentDecision {
  assertValidInput(input)

  if (input.painReported === true) {
    return decision(input, 'blocked', 'development.adjustment.pain-block')
  }

  if (input.painReported === null || input.sets.length !== input.expectedSetCount) {
    return decision(input, 'hold', 'development.adjustment.missing-data')
  }

  if (input.sets.some((set) => set.status === 'skipped')) {
    return decision(input, 'hold', 'development.adjustment.skipped-set')
  }

  const performedSets = input.sets.filter(
    (set): set is Extract<DevelopmentAdjustmentSetFact, { status: 'performed' }> =>
      set.status === 'performed',
  )

  if (
    performedSets.some(
      (set) =>
        set.loadGrams === null ||
        set.repetitions === null ||
        set.rpe === null ||
        !set.explicitlyConfirmed,
    )
  ) {
    return decision(input, 'hold', 'development.adjustment.missing-data')
  }

  if (
    performedSets.some(
      (set) =>
        (set.rpe ?? Number.POSITIVE_INFINITY) >
        UNREVIEWED_DEVELOPMENT_ADJUSTMENT_POLICY.maximumRpeForIncrease,
    )
  ) {
    return decision(input, 'hold', 'development.adjustment.rpe-above-eight')
  }

  if (performedSets.some((set) => (set.repetitions ?? -1) < input.targetRepetitions)) {
    return decision(input, 'hold', 'development.adjustment.target-not-met')
  }

  if (performedSets.some((set) => set.loadGrams !== input.currentTargetLoadGrams)) {
    return decision(input, 'hold', 'development.adjustment.load-not-at-target')
  }

  const maximumIncreaseGrams = Number(
    (BigInt(input.currentTargetLoadGrams) *
      BigInt(UNREVIEWED_DEVELOPMENT_ADJUSTMENT_POLICY.maximumIncreaseBasisPoints)) /
      10_000n,
  )

  if (UNREVIEWED_DEVELOPMENT_ADJUSTMENT_POLICY.incrementGrams > maximumIncreaseGrams) {
    return decision(input, 'hold', 'development.adjustment.increment-exceeds-bound')
  }

  const proposedTargetLoadGrams =
    input.currentTargetLoadGrams + UNREVIEWED_DEVELOPMENT_ADJUSTMENT_POLICY.incrementGrams
  if (
    !Number.isSafeInteger(proposedTargetLoadGrams) ||
    proposedTargetLoadGrams > MAX_CANONICAL_LOAD_GRAMS
  ) {
    return decision(input, 'hold', 'development.adjustment.increment-exceeds-bound')
  }

  return decision(
    input,
    'increase',
    'development.adjustment.increase',
    proposedTargetLoadGrams,
  )
}
