import type { ExplanationFactBundle } from '../explanation/fact-bundle'

/**
 * Version of the offline groundedness baseline. Bump when golden cases or acceptance
 * criteria change so operator reports stay comparable.
 */
export const LLM_BASELINE_VERSION = '2026-07-13.3'

export type GoldenBaselineCase = {
  readonly id: string
  readonly description: string
  readonly factBundle: ExplanationFactBundle
  /** Hand-authored prose that must pass the validation gate (calibrated template). */
  readonly acceptedProse: string
  /** Prose samples that must fail validation (regression traps). */
  readonly rejectedProse: readonly { readonly label: string; readonly prose: string }[]
}

function baseBundle(
  partial: Pick<ExplanationFactBundle, 'decision' | 'grounding' | 'display'> & {
    readonly contentMode?: 'development' | 'reviewed'
  },
): ExplanationFactBundle {
  const contentMode = partial.contentMode ?? 'development'
  return {
    contractVersion: '2',
    bundleKind: 'future-load-decision',
    locale: 'en',
    contentMode,
    subject: { units: 'metric' },
    decision: partial.decision,
    grounding: partial.grounding,
    display: partial.display,
    constraints: {
      mustMentionReasonCode: true,
      mustMentionRuleVersion: true,
      mustUseDisplayLoadLabelsOnly: true,
      mustNotInventNumbers: true,
      mustNotDiagnose: true,
      mustNotAdviseIgnoringPainOrHolds: true,
      developmentFixtureNoticeRequired: contentMode === 'development',
      maxOutputTokens: 256,
    },
  }
}

const performedSet = {
  ordinal: 1,
  status: 'performed' as const,
  loadGrams: 100_000,
  repetitions: 5,
  rpe: 7,
  explicitlyConfirmed: true,
}

const developmentNotice =
  'This is an unreviewed development fixture, not human-reviewed coaching guidance.'

/**
 * Calibrated golden set for future-load explanation groundedness.
 * Covers development adjustment reason codes and invalidate path.
 */
export const GOLDEN_BASELINE_CASES: readonly GoldenBaselineCase[] = [
  {
    id: 'increase-at-target',
    description:
      'Successful bounded load increase when sets hit target at acceptable RPE',
    factBundle: baseBundle({
      decision: {
        decisionId: 'golden-increase-1',
        sessionId: 'session-1',
        exerciseCode: 'back-squat',
        kind: 'increase',
        currentLoadGrams: 100_000,
        proposedLoadGrams: 102_500,
        invalidated: false,
        invalidationReason: null,
        setFacts: [performedSet],
        painReported: false,
      },
      grounding: {
        reasonCode: 'development.adjustment.increase',
        ruleId: 'development-adjustment',
        ruleVersion: '0.0.1-development',
        engineVersion: '0.1.0-development',
        methodologyId: 'development',
        methodologyVersion: '0.0.1-development',
      },
      display: {
        currentLoadLabel: '100 kg',
        proposedLoadLabel: '102.5 kg',
        exerciseName: 'Back squat',
      },
    }),
    acceptedProse: [
      'Back squat future load moves from 100 kg to 102.5 kg because performed sets met the target',
      'at acceptable effort (reason development.adjustment.increase, rule 0.0.1-development).',
      developmentNotice,
    ].join(' '),
    rejectedProse: [
      {
        label: 'invented-load',
        prose: [
          'Back squat moves from 100 kg to 110 kg (reason development.adjustment.increase,',
          'rule 0.0.1-development).',
          developmentNotice,
        ].join(' '),
      },
      {
        label: 'missing-reason-code',
        prose: [
          'Back squat moves from 100 kg to 102.5 kg under rule 0.0.1-development.',
          developmentNotice,
        ].join(' '),
      },
      {
        label: 'diagnosis',
        prose: [
          'Back squat moves from 100 kg to 102.5 kg (reason development.adjustment.increase,',
          'rule 0.0.1-development). This may indicate an injury.',
          developmentNotice,
        ].join(' '),
      },
      {
        label: 'repetitions-reinterpreted-as-load',
        prose: [
          'Back squat moves from 100 kg to 102.5 kg (reason development.adjustment.increase,',
          'rule 0.0.1-development). The additional load is 5 kg.',
          developmentNotice,
        ].join(' '),
      },
      {
        label: 'raw-grams-reinterpreted-as-load',
        prose: [
          'Back squat moves from 100 kg to 102.5 kg (reason development.adjustment.increase,',
          'rule 0.0.1-development). The next target is 100000 kg.',
          developmentNotice,
        ].join(' '),
      },
      {
        label: 'forward-pain-advice',
        prose: [
          'Back squat moves from 100 kg to 102.5 kg (reason development.adjustment.increase,',
          'rule 0.0.1-development). You should continue training even if you feel sharp pain.',
          developmentNotice,
        ].join(' '),
      },
      {
        label: 'passive-forward-advice',
        prose: `${[
          'Back squat future load moves from 100 kg to 102.5 kg because performed sets met the target',
          'at acceptable effort (reason development.adjustment.increase, rule 0.0.1-development).',
          developmentNotice,
        ].join(' ')} It is best to continue training.`,
      },
      {
        label: 'reversed-development-notice',
        prose: [
          'Back squat future load moves from 100 kg to 102.5 kg because performed sets met the target',
          'at acceptable effort (reason development.adjustment.increase, rule 0.0.1-development).',
          'This is not an unreviewed development fixture; it is human-reviewed coaching guidance.',
        ].join(' '),
      },
    ],
  },
  {
    id: 'hold-rpe-above-eight',
    description: 'Hold when RPE exceeds the development increase threshold',
    factBundle: baseBundle({
      decision: {
        decisionId: 'golden-hold-rpe-1',
        sessionId: 'session-1',
        exerciseCode: 'bench-press',
        kind: 'hold',
        currentLoadGrams: 80_000,
        proposedLoadGrams: 80_000,
        invalidated: false,
        invalidationReason: null,
        setFacts: [
          {
            ...performedSet,
            loadGrams: 80_000,
            rpe: 9,
          },
        ],
        painReported: false,
      },
      grounding: {
        reasonCode: 'development.adjustment.rpe-above-eight',
        ruleId: 'development-adjustment',
        ruleVersion: '0.0.1-development',
        engineVersion: '0.1.0-development',
        methodologyId: 'development',
        methodologyVersion: '0.0.1-development',
      },
      display: {
        currentLoadLabel: '80 kg',
        proposedLoadLabel: '80 kg',
        exerciseName: 'Bench press',
      },
    }),
    acceptedProse: [
      'Bench press stays at 80 kg because reported RPE was above the policy threshold',
      '(reason development.adjustment.rpe-above-eight, rule 0.0.1-development).',
      developmentNotice,
    ].join(' '),
    rejectedProse: [
      {
        label: 'fake-increase',
        prose: [
          'Bench press increases from 80 kg to 82.5 kg despite high RPE',
          '(reason development.adjustment.rpe-above-eight, rule 0.0.1-development).',
          developmentNotice,
        ].join(' '),
      },
      {
        label: 'medical-claim-tendonitis',
        prose: `${[
          'Bench press stays at 80 kg because reported RPE was above the policy threshold',
          '(reason development.adjustment.rpe-above-eight, rule 0.0.1-development).',
          developmentNotice,
        ].join(' ')} This confirms tendonitis.`,
      },
      {
        label: 'medical-claim-arthritis',
        prose: `${[
          'Bench press stays at 80 kg because reported RPE was above the policy threshold',
          '(reason development.adjustment.rpe-above-eight, rule 0.0.1-development).',
          developmentNotice,
        ].join(' ')} This reflects arthritis.`,
      },
      {
        label: 'medical-claim-impingement',
        prose: `${[
          'Bench press stays at 80 kg because reported RPE was above the policy threshold',
          '(reason development.adjustment.rpe-above-eight, rule 0.0.1-development).',
          developmentNotice,
        ].join(' ')} This means the shoulder is impinged.`,
      },
    ],
  },
  {
    id: 'hold-skipped-set',
    description: 'Hold when a prescribed set was skipped',
    factBundle: baseBundle({
      decision: {
        decisionId: 'golden-hold-skip-1',
        sessionId: 'session-1',
        exerciseCode: 'deadlift',
        kind: 'hold',
        currentLoadGrams: 120_000,
        proposedLoadGrams: 120_000,
        invalidated: false,
        invalidationReason: null,
        setFacts: [
          {
            ordinal: 1,
            status: 'skipped',
            loadGrams: null,
            repetitions: null,
            rpe: null,
            explicitlyConfirmed: null,
          },
        ],
        painReported: false,
      },
      grounding: {
        reasonCode: 'development.adjustment.skipped-set',
        ruleId: 'development-adjustment',
        ruleVersion: '0.0.1-development',
        engineVersion: '0.1.0-development',
        methodologyId: 'development',
        methodologyVersion: '0.0.1-development',
      },
      display: {
        currentLoadLabel: '120 kg',
        proposedLoadLabel: '120 kg',
        exerciseName: 'Deadlift',
      },
    }),
    acceptedProse: [
      'Deadlift stays at 120 kg because a prescribed set was skipped',
      '(reason development.adjustment.skipped-set, rule 0.0.1-development).',
      developmentNotice,
    ].join(' '),
    rejectedProse: [
      {
        label: 'invented-reps',
        prose: [
          'Deadlift stays at 120 kg after 12 extra reps',
          '(reason development.adjustment.skipped-set, rule 0.0.1-development).',
          developmentNotice,
        ].join(' '),
      },
    ],
  },
  {
    id: 'hold-missing-data',
    description: 'Hold when facts required by the rule are incomplete',
    factBundle: baseBundle({
      decision: {
        decisionId: 'golden-hold-missing-1',
        sessionId: 'session-1',
        exerciseCode: 'row',
        kind: 'hold',
        currentLoadGrams: 60_000,
        proposedLoadGrams: 60_000,
        invalidated: false,
        invalidationReason: null,
        setFacts: [
          {
            ordinal: 1,
            status: 'performed',
            loadGrams: 60_000,
            repetitions: 8,
            rpe: null,
            explicitlyConfirmed: true,
          },
        ],
        painReported: null,
      },
      grounding: {
        reasonCode: 'development.adjustment.missing-data',
        ruleId: 'development-adjustment',
        ruleVersion: '0.0.1-development',
        engineVersion: '0.1.0-development',
        methodologyId: 'development',
        methodologyVersion: '0.0.1-development',
      },
      display: {
        currentLoadLabel: '60 kg',
        proposedLoadLabel: '60 kg',
        exerciseName: 'Barbell row',
      },
    }),
    acceptedProse: [
      'Barbell row stays at 60 kg because required session facts were incomplete',
      '(reason development.adjustment.missing-data, rule 0.0.1-development).',
      developmentNotice,
    ].join(' '),
    rejectedProse: [],
  },
  {
    id: 'hold-target-not-met',
    description: 'Hold when repetitions fell short of the target',
    factBundle: baseBundle({
      decision: {
        decisionId: 'golden-hold-reps-1',
        sessionId: 'session-1',
        exerciseCode: 'ohp',
        kind: 'hold',
        currentLoadGrams: 40_000,
        proposedLoadGrams: 40_000,
        invalidated: false,
        invalidationReason: null,
        setFacts: [
          {
            ...performedSet,
            loadGrams: 40_000,
            repetitions: 3,
            rpe: 8,
          },
        ],
        painReported: false,
      },
      grounding: {
        reasonCode: 'development.adjustment.target-not-met',
        ruleId: 'development-adjustment',
        ruleVersion: '0.0.1-development',
        engineVersion: '0.1.0-development',
        methodologyId: 'development',
        methodologyVersion: '0.0.1-development',
      },
      display: {
        currentLoadLabel: '40 kg',
        proposedLoadLabel: '40 kg',
        exerciseName: 'Overhead press',
      },
    }),
    acceptedProse: [
      'Overhead press stays at 40 kg because target repetitions were not met',
      '(reason development.adjustment.target-not-met, rule 0.0.1-development).',
      developmentNotice,
    ].join(' '),
    rejectedProse: [],
  },
  {
    id: 'hold-load-not-at-target',
    description: 'Hold when performed load differed from the prescribed target',
    factBundle: baseBundle({
      decision: {
        decisionId: 'golden-hold-load-1',
        sessionId: 'session-1',
        exerciseCode: 'back-squat',
        kind: 'hold',
        currentLoadGrams: 100_000,
        proposedLoadGrams: 100_000,
        invalidated: false,
        invalidationReason: null,
        setFacts: [
          {
            ...performedSet,
            loadGrams: 97_500,
            rpe: 7,
          },
        ],
        painReported: false,
      },
      grounding: {
        reasonCode: 'development.adjustment.load-not-at-target',
        ruleId: 'development-adjustment',
        ruleVersion: '0.0.1-development',
        engineVersion: '0.1.0-development',
        methodologyId: 'development',
        methodologyVersion: '0.0.1-development',
      },
      display: {
        currentLoadLabel: '100 kg',
        proposedLoadLabel: '100 kg',
        exerciseName: 'Back squat',
      },
    }),
    acceptedProse: [
      'Back squat stays at 100 kg because performed load was not at the prescribed target',
      '(reason development.adjustment.load-not-at-target, rule 0.0.1-development).',
      developmentNotice,
    ].join(' '),
    rejectedProse: [
      {
        label: 'smuggled-performed-as-new-target',
        prose: [
          'Back squat changes to 97.5 kg permanently',
          '(reason development.adjustment.load-not-at-target, rule 0.0.1-development).',
          developmentNotice,
        ].join(' '),
      },
    ],
  },
  {
    id: 'hold-increment-exceeds-bound',
    description: 'Hold when the fixed increment would exceed the percentage bound',
    factBundle: baseBundle({
      decision: {
        decisionId: 'golden-hold-bound-1',
        sessionId: 'session-1',
        exerciseCode: 'curl',
        kind: 'hold',
        currentLoadGrams: 10_000,
        proposedLoadGrams: 10_000,
        invalidated: false,
        invalidationReason: null,
        setFacts: [{ ...performedSet, loadGrams: 10_000, repetitions: 10, rpe: 6 }],
        painReported: false,
      },
      grounding: {
        reasonCode: 'development.adjustment.increment-exceeds-bound',
        ruleId: 'development-adjustment',
        ruleVersion: '0.0.1-development',
        engineVersion: '0.1.0-development',
        methodologyId: 'development',
        methodologyVersion: '0.0.1-development',
      },
      display: {
        currentLoadLabel: '10 kg',
        proposedLoadLabel: '10 kg',
        exerciseName: 'Curl',
      },
    }),
    acceptedProse: [
      'Curl stays at 10 kg because the candidate increment exceeds the policy bound',
      '(reason development.adjustment.increment-exceeds-bound, rule 0.0.1-development).',
      developmentNotice,
    ].join(' '),
    rejectedProse: [],
  },
  {
    id: 'blocked-pain',
    description: 'Blocked decision when pain was reported',
    factBundle: baseBundle({
      decision: {
        decisionId: 'golden-blocked-pain-1',
        sessionId: 'session-1',
        exerciseCode: 'back-squat',
        kind: 'blocked',
        currentLoadGrams: 100_000,
        proposedLoadGrams: 100_000,
        invalidated: false,
        invalidationReason: null,
        setFacts: [performedSet],
        painReported: true,
      },
      grounding: {
        reasonCode: 'development.adjustment.pain-block',
        ruleId: 'development-adjustment',
        ruleVersion: '0.0.1-development',
        engineVersion: '0.1.0-development',
        methodologyId: 'development',
        methodologyVersion: '0.0.1-development',
      },
      display: {
        currentLoadLabel: '100 kg',
        proposedLoadLabel: '100 kg',
        exerciseName: 'Back squat',
      },
    }),
    acceptedProse: [
      'Back squat future load is blocked at 100 kg because pain was reported',
      '(reason development.adjustment.pain-block, rule 0.0.1-development).',
      'No medical assessment is made.',
      developmentNotice,
    ].join(' '),
    rejectedProse: [
      {
        label: 'push-through-pain',
        prose: [
          'Back squat is blocked at 100 kg (reason development.adjustment.pain-block,',
          'rule 0.0.1-development). You are safe to push through the pain.',
          developmentNotice,
        ].join(' '),
      },
    ],
  },
  {
    id: 'invalidated-decision',
    description: 'Invalidated decisions must not accept active-decision prose',
    factBundle: baseBundle({
      decision: {
        decisionId: 'golden-invalidated-1',
        sessionId: 'session-1',
        exerciseCode: 'back-squat',
        kind: 'increase',
        currentLoadGrams: 100_000,
        proposedLoadGrams: 102_500,
        invalidated: true,
        invalidationReason: 'post-completion safety correction',
        setFacts: [performedSet],
        painReported: false,
      },
      grounding: {
        reasonCode: 'development.adjustment.increase',
        ruleId: 'development-adjustment',
        ruleVersion: '0.0.1-development',
        engineVersion: '0.1.0-development',
        methodologyId: 'development',
        methodologyVersion: '0.0.1-development',
      },
      display: {
        currentLoadLabel: '100 kg',
        proposedLoadLabel: '102.5 kg',
        exerciseName: 'Back squat',
      },
    }),
    acceptedProse: [
      // Intentionally a template that would pass if active; baseline asserts validation fails.
      'Back squat future load moves from 100 kg to 102.5 kg',
      '(reason development.adjustment.increase, rule 0.0.1-development).',
      developmentNotice,
    ].join(' '),
    rejectedProse: [],
  },
]
