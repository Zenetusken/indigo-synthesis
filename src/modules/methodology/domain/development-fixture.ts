/**
 * DEVELOPMENT FIXTURE ONLY.
 *
 * No exercise selection, set count, repetition target, rest period, duration, or
 * progression number below has received human strength-program, safety, evidence, or
 * rights review. This fixture exists solely to exercise deterministic product behavior
 * and is ineligible for production activation.
 */
export const UNREVIEWED_DEVELOPMENT_TEMPLATE = {
  id: 'development.full-body-three-day',
  version: '0.0.1-development',
  contentMode: 'development',
  reviewStatus: 'draft',
  cycleCount: 2,
  sessions: [
    {
      key: 'A',
      exercises: [
        {
          id: 'development.back-squat',
          name: 'Back squat — development fixture',
          sets: 3,
          reps: 5,
          restSeconds: 120,
        },
        {
          id: 'development.bench-press',
          name: 'Bench press — development fixture',
          sets: 3,
          reps: 5,
          restSeconds: 120,
        },
        {
          id: 'development.barbell-row',
          name: 'Barbell row — development fixture',
          sets: 3,
          reps: 8,
          restSeconds: 90,
        },
      ],
    },
    {
      key: 'B',
      exercises: [
        {
          id: 'development.deadlift',
          name: 'Deadlift — development fixture',
          sets: 1,
          reps: 5,
          restSeconds: 120,
        },
        {
          id: 'development.overhead-press',
          name: 'Overhead press — development fixture',
          sets: 3,
          reps: 6,
          restSeconds: 120,
        },
        {
          id: 'development.back-squat',
          name: 'Back squat — development fixture',
          sets: 3,
          reps: 5,
          restSeconds: 120,
        },
      ],
    },
    {
      key: 'C',
      exercises: [
        {
          id: 'development.bench-press',
          name: 'Bench press — development fixture',
          sets: 3,
          reps: 5,
          restSeconds: 120,
        },
        {
          id: 'development.barbell-row',
          name: 'Barbell row — development fixture',
          sets: 3,
          reps: 8,
          restSeconds: 90,
        },
        {
          id: 'development.deadlift',
          name: 'Deadlift — development fixture',
          sets: 1,
          reps: 5,
          restSeconds: 120,
        },
      ],
    },
  ],
} as const

/**
 * DEVELOPMENT FIXTURE ONLY. The threshold, step, and percentage cap are unreviewed
 * technical test values and must never be presented as coaching guidance.
 */
export const UNREVIEWED_DEVELOPMENT_ADJUSTMENT_POLICY = {
  id: 'development.bounded-load-step',
  version: '0.0.1-development',
  maximumRpeForIncrease: 8,
  incrementGrams: 1_000,
  maximumIncreaseBasisPoints: 250,
} as const

export type DevelopmentSessionKey =
  (typeof UNREVIEWED_DEVELOPMENT_TEMPLATE.sessions)[number]['key']

export type DevelopmentExerciseId =
  (typeof UNREVIEWED_DEVELOPMENT_TEMPLATE.sessions)[number]['exercises'][number]['id']

export const DEVELOPMENT_EXERCISE_IDS = [
  'development.back-squat',
  'development.bench-press',
  'development.barbell-row',
  'development.deadlift',
  'development.overhead-press',
] as const satisfies readonly DevelopmentExerciseId[]

export const DEVELOPMENT_EXERCISE_EQUIPMENT = {
  'development.back-squat': ['barbell', 'rack', 'plates'],
  'development.bench-press': ['barbell', 'bench', 'rack', 'plates'],
  'development.barbell-row': ['barbell', 'plates'],
  'development.deadlift': ['barbell', 'plates'],
  'development.overhead-press': ['barbell', 'rack', 'plates'],
} as const satisfies Readonly<
  Record<DevelopmentExerciseId, readonly ('barbell' | 'rack' | 'bench' | 'plates')[]>
>
