import { MAX_CANONICAL_LOAD_GRAMS } from '@/modules/exercises/domain/load'
import { type CanonicalValue, canonicalSha256 } from './canonical'
import type {
  ContentHash,
  Prescription,
  PrescriptionWarning,
  RecommendationReason,
  RuleSetReference,
  VersionReference,
} from './contracts'
import {
  DEVELOPMENT_EXERCISE_IDS,
  type DevelopmentExerciseId,
  type DevelopmentSessionKey,
  UNREVIEWED_DEVELOPMENT_TEMPLATE,
} from './development-fixture'

export const DEVELOPMENT_ENGINE_VERSION = '0.1.0-development'

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7
export type ActivationEnvironment = 'development' | 'production'
export type ContentMode = 'development' | 'reviewed'
export type ContentReviewStatus = 'draft' | 'reviewed' | 'retired'

export interface SafetyAnswers {
  readonly isAdult: boolean | null
  readonly familiarWithResistanceTraining: boolean | null
  readonly hasCurrentPain: boolean | null
  readonly hasContraindication: boolean | null
  readonly hasProfessionalRestriction: boolean | null
}

export interface StartingLoadInput {
  readonly exerciseId: string
  readonly loadGrams: number
}

export interface ProgramGenerationInput {
  /** An athlete-local ISO calendar date. No implicit clock is consulted. */
  readonly asOfDate: string
  /** ISO weekdays: Monday = 1 through Sunday = 7. Exactly three are required. */
  readonly trainingWeekdays: readonly Weekday[]
  /** One explicit external starting load for every development-fixture exercise. */
  readonly startingLoads: readonly StartingLoadInput[]
  readonly safety: SafetyAnswers
}

export interface NormalizedProgramInput {
  readonly asOfDate: string
  readonly trainingWeekdays: readonly Weekday[]
  readonly startingLoads: readonly {
    readonly exerciseId: DevelopmentExerciseId
    readonly loadGrams: number
  }[]
  readonly safety: SafetyAnswers
}

export type SafetyBlockCode =
  | 'safety.current-pain'
  | 'safety.contraindication'
  | 'safety.professional-restriction'
  | 'safety.adult-eligibility-not-confirmed'
  | 'safety.lifting-familiarity-not-confirmed'
  | 'safety.missing-answer'

export type ContentBlockCode =
  | 'content.retired'
  | 'content.development-forbidden-in-production'
  | 'content.release-not-reviewed'

export interface GenerationBlocker {
  readonly category: 'safety' | 'content'
  readonly code: SafetyBlockCode | ContentBlockCode
  readonly summary: string
}

export interface ContentActivationEligibility {
  readonly eligible: boolean
  readonly manualReviewRequired: boolean
  readonly blockers: readonly GenerationBlocker[]
}

export interface ContentActivationInput {
  readonly environment: ActivationEnvironment
  readonly contentMode: ContentMode
  readonly methodologyStatus: ContentReviewStatus
  readonly templateStatus: ContentReviewStatus
}

export interface DevelopmentSetPrescription {
  readonly ordinal: number
  readonly targetLoadGrams: number
  readonly targetRepetitions: number
  readonly restSeconds: number
}

export interface DevelopmentExercisePrescription {
  readonly exerciseId: DevelopmentExerciseId
  readonly name: string
  readonly ordinal: number
  readonly sets: readonly DevelopmentSetPrescription[]
}

export interface DevelopmentPlannedWorkout {
  readonly plannedWorkoutId: string
  readonly cycle: number
  readonly sessionKey: DevelopmentSessionKey
  readonly localDate: string
  readonly exercises: readonly DevelopmentExercisePrescription[]
}

export interface DevelopmentProgramOutput {
  readonly contentMode: 'development'
  readonly developmentOnly: true
  readonly notice: string
  readonly asOfDate: string
  readonly plannedWorkouts: readonly DevelopmentPlannedWorkout[]
}

export type DevelopmentProgramPrescription = Prescription<DevelopmentProgramOutput>

export type DevelopmentProgramGenerationResult =
  | {
      readonly status: 'blocked'
      readonly normalizedInput: NormalizedProgramInput
      readonly normalizedInputHash: ContentHash
      readonly blockers: readonly GenerationBlocker[]
    }
  | {
      readonly status: 'created'
      readonly normalizedInput: NormalizedProgramInput
      readonly prescription: DevelopmentProgramPrescription
    }

export class InvalidProgramInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'InvalidProgramInputError'
  }
}

const developmentMethodologyRelease: RuleSetReference = {
  id: 'development.methodology-fixture',
  version: '0.0.1-development',
  status: 'draft',
  reviewerIds: [],
}

const developmentTemplateReference: VersionReference = {
  id: UNREVIEWED_DEVELOPMENT_TEMPLATE.id,
  version: UNREVIEWED_DEVELOPMENT_TEMPLATE.version,
}

const developmentReasons: readonly RecommendationReason[] = [
  {
    code: 'development.fixture-instantiation',
    summary:
      'The schedule and prescriptions come from an unreviewed development fixture.',
    sourceReferences: [],
  },
]

const developmentWarnings: readonly PrescriptionWarning[] = [
  {
    code: 'development.not-human-reviewed',
    summary:
      'Development fixture only: exercise, set, repetition, rest, and progression values are not human-reviewed coaching guidance.',
    sourceReferences: [],
  },
]

function contentHash(value: CanonicalValue): ContentHash {
  return {
    algorithm: 'sha256',
    value: canonicalSha256(value),
  }
}

function assertIsoDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) {
    throw new InvalidProgramInputError(
      'input.invalid-as-of-date',
      'asOfDate must be an ISO calendar date in YYYY-MM-DD form.',
    )
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new InvalidProgramInputError(
      'input.invalid-as-of-date',
      'asOfDate must identify a real calendar date.',
    )
  }
}

function normalizeWeekdays(values: readonly Weekday[]): readonly Weekday[] {
  if (values.length !== 3) {
    throw new InvalidProgramInputError(
      'input.invalid-training-weekdays',
      'Exactly three training weekdays are required.',
    )
  }

  for (const value of values) {
    if (!Number.isInteger(value) || value < 1 || value > 7) {
      throw new InvalidProgramInputError(
        'input.invalid-training-weekdays',
        'Training weekdays must use ISO values 1 through 7.',
      )
    }
  }

  const sorted = [...values].sort((left, right) => left - right)
  if (new Set(sorted).size !== 3) {
    throw new InvalidProgramInputError(
      'input.invalid-training-weekdays',
      'Training weekdays must be distinct.',
    )
  }

  return sorted
}

function normalizeStartingLoads(
  values: readonly StartingLoadInput[],
): NormalizedProgramInput['startingLoads'] {
  const expected = new Set<string>(DEVELOPMENT_EXERCISE_IDS)
  const supplied = new Map<string, number>()

  for (const value of values) {
    if (!expected.has(value.exerciseId)) {
      throw new InvalidProgramInputError(
        'input.unknown-development-exercise',
        `Unknown development-fixture exercise: ${value.exerciseId}.`,
      )
    }
    if (supplied.has(value.exerciseId)) {
      throw new InvalidProgramInputError(
        'input.duplicate-starting-load',
        `Starting load supplied more than once for ${value.exerciseId}.`,
      )
    }
    if (
      !Number.isSafeInteger(value.loadGrams) ||
      value.loadGrams < 0 ||
      value.loadGrams > MAX_CANONICAL_LOAD_GRAMS
    ) {
      throw new InvalidProgramInputError(
        'input.invalid-starting-load',
        `Starting loads must be integer grams between 0 and ${MAX_CANONICAL_LOAD_GRAMS}.`,
      )
    }

    supplied.set(value.exerciseId, value.loadGrams)
  }

  const missing = DEVELOPMENT_EXERCISE_IDS.filter((id) => !supplied.has(id))
  if (missing.length > 0) {
    throw new InvalidProgramInputError(
      'input.missing-starting-load',
      `Missing explicit starting loads for: ${missing.join(', ')}.`,
    )
  }

  return DEVELOPMENT_EXERCISE_IDS.map((exerciseId) => ({
    exerciseId,
    loadGrams: supplied.get(exerciseId) ?? 0,
  })).sort((left, right) => {
    if (left.exerciseId < right.exerciseId) return -1
    if (left.exerciseId > right.exerciseId) return 1
    return 0
  })
}

function assertSafetyAnswerTypes(safety: SafetyAnswers): void {
  for (const [field, value] of Object.entries(safety)) {
    if (value !== null && typeof value !== 'boolean') {
      throw new InvalidProgramInputError(
        'input.invalid-safety-answer',
        `${field} must be true, false, or null.`,
      )
    }
  }
}

export function normalizeProgramInput(
  input: ProgramGenerationInput,
): NormalizedProgramInput {
  assertIsoDate(input.asOfDate)
  assertSafetyAnswerTypes(input.safety)

  return {
    asOfDate: input.asOfDate,
    trainingWeekdays: normalizeWeekdays(input.trainingWeekdays),
    startingLoads: normalizeStartingLoads(input.startingLoads),
    safety: {
      isAdult: input.safety.isAdult,
      familiarWithResistanceTraining: input.safety.familiarWithResistanceTraining,
      hasCurrentPain: input.safety.hasCurrentPain,
      hasContraindication: input.safety.hasContraindication,
      hasProfessionalRestriction: input.safety.hasProfessionalRestriction,
    },
  }
}

export function evaluateSafety(safety: SafetyAnswers): readonly GenerationBlocker[] {
  const blockers: GenerationBlocker[] = []

  if (safety.hasCurrentPain === true) {
    blockers.push({
      category: 'safety',
      code: 'safety.current-pain',
      summary: 'Current pain blocks program creation.',
    })
  }
  if (safety.hasContraindication === true) {
    blockers.push({
      category: 'safety',
      code: 'safety.contraindication',
      summary: 'A reported contraindication blocks program creation.',
    })
  }
  if (safety.hasProfessionalRestriction === true) {
    blockers.push({
      category: 'safety',
      code: 'safety.professional-restriction',
      summary: 'A reported professional restriction blocks program creation.',
    })
  }
  if (safety.isAdult === false) {
    blockers.push({
      category: 'safety',
      code: 'safety.adult-eligibility-not-confirmed',
      summary: 'The development fixture is limited to adults.',
    })
  }
  if (safety.familiarWithResistanceTraining === false) {
    blockers.push({
      category: 'safety',
      code: 'safety.lifting-familiarity-not-confirmed',
      summary: 'The development fixture requires prior resistance-training familiarity.',
    })
  }

  const missing = Object.entries(safety)
    .filter(([, value]) => value === null)
    .map(([field]) => field)
    .sort()

  if (missing.length > 0) {
    blockers.push({
      category: 'safety',
      code: 'safety.missing-answer',
      summary: `Safety answers are unavailable for: ${missing.join(', ')}.`,
    })
  }

  return blockers
}

export function evaluateContentActivation(
  input: ContentActivationInput,
): ContentActivationEligibility {
  const blockers: GenerationBlocker[] = []

  if (input.methodologyStatus === 'retired' || input.templateStatus === 'retired') {
    blockers.push({
      category: 'content',
      code: 'content.retired',
      summary: 'Retired methodology or template content cannot be activated.',
    })
  }

  if (input.environment === 'production' && input.contentMode === 'development') {
    blockers.push({
      category: 'content',
      code: 'content.development-forbidden-in-production',
      summary: 'Development-only content cannot be activated in production.',
    })
  }

  if (
    input.contentMode === 'reviewed' &&
    (input.methodologyStatus !== 'reviewed' || input.templateStatus !== 'reviewed')
  ) {
    blockers.push({
      category: 'content',
      code: 'content.release-not-reviewed',
      summary: 'Reviewed content requires reviewed methodology and template releases.',
    })
  }

  return {
    eligible: blockers.length === 0,
    manualReviewRequired: input.contentMode === 'development',
    blockers,
  }
}

function parseDate(value: string): Date {
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number)
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  return date
}

function formatDate(value: Date): string {
  return [
    value.getUTCFullYear().toString().padStart(4, '0'),
    (value.getUTCMonth() + 1).toString().padStart(2, '0'),
    value.getUTCDate().toString().padStart(2, '0'),
  ].join('-')
}

function isoWeekday(value: Date): Weekday {
  const day = value.getUTCDay()
  return (day === 0 ? 7 : day) as Weekday
}

function addOneDay(value: Date): Date {
  const next = new Date(value.getTime())
  next.setUTCDate(next.getUTCDate() + 1)
  return next
}

function buildSchedule(
  input: NormalizedProgramInput,
): readonly DevelopmentPlannedWorkout[] {
  const loadByExercise = new Map(
    input.startingLoads.map((entry) => [entry.exerciseId, entry.loadGrams]),
  )
  const selectedWeekdays = new Set(input.trainingWeekdays)
  const workoutCount =
    UNREVIEWED_DEVELOPMENT_TEMPLATE.cycleCount *
    UNREVIEWED_DEVELOPMENT_TEMPLATE.sessions.length
  const workouts: DevelopmentPlannedWorkout[] = []
  let candidateDate = parseDate(input.asOfDate)

  while (workouts.length < workoutCount) {
    if (selectedWeekdays.has(isoWeekday(candidateDate))) {
      const workoutOrdinal = workouts.length
      const templateSession =
        UNREVIEWED_DEVELOPMENT_TEMPLATE.sessions[
          workoutOrdinal % UNREVIEWED_DEVELOPMENT_TEMPLATE.sessions.length
        ]
      if (!templateSession) {
        throw new InvalidProgramInputError(
          'template.invalid-development-fixture',
          'The development fixture has no session for the schedule position.',
        )
      }

      const cycle =
        Math.floor(workoutOrdinal / UNREVIEWED_DEVELOPMENT_TEMPLATE.sessions.length) + 1
      const localDate = formatDate(candidateDate)

      workouts.push({
        plannedWorkoutId: `${UNREVIEWED_DEVELOPMENT_TEMPLATE.id}:${cycle}:${templateSession.key}:${localDate}`,
        cycle,
        sessionKey: templateSession.key,
        localDate,
        exercises: templateSession.exercises.map((exercise, exerciseIndex) => ({
          exerciseId: exercise.id,
          name: exercise.name,
          ordinal: exerciseIndex + 1,
          sets: Array.from({ length: exercise.sets }, (_, setIndex) => ({
            ordinal: setIndex + 1,
            targetLoadGrams: loadByExercise.get(exercise.id) ?? 0,
            targetRepetitions: exercise.reps,
            restSeconds: exercise.restSeconds,
          })),
        })),
      })
    }

    candidateDate = addOneDay(candidateDate)
  }

  return workouts
}

function normalizedInputHash(input: NormalizedProgramInput): ContentHash {
  return contentHash(input as unknown as CanonicalValue)
}

export function generateDevelopmentProgram(
  input: ProgramGenerationInput,
  environment: ActivationEnvironment,
): DevelopmentProgramGenerationResult {
  const normalizedInput = normalizeProgramInput(input)
  const inputHash = normalizedInputHash(normalizedInput)
  const safetyBlockers = evaluateSafety(normalizedInput.safety)
  const activation = evaluateContentActivation({
    environment,
    contentMode: UNREVIEWED_DEVELOPMENT_TEMPLATE.contentMode,
    methodologyStatus: developmentMethodologyRelease.status,
    templateStatus: UNREVIEWED_DEVELOPMENT_TEMPLATE.reviewStatus,
  })
  const blockers = [...safetyBlockers, ...activation.blockers]

  if (blockers.length > 0) {
    return {
      status: 'blocked',
      normalizedInput,
      normalizedInputHash: inputHash,
      blockers,
    }
  }

  const output: DevelopmentProgramOutput = {
    contentMode: 'development',
    developmentOnly: true,
    notice:
      'UNREVIEWED DEVELOPMENT FIXTURE — never human-reviewed coaching guidance and never eligible for production activation.',
    asOfDate: normalizedInput.asOfDate,
    plannedWorkouts: buildSchedule(normalizedInput),
  }
  const outputHashMaterial = {
    engineVersion: DEVELOPMENT_ENGINE_VERSION,
    methodologyRelease: developmentMethodologyRelease,
    template: developmentTemplateReference,
    normalizedInputHash: inputHash,
    output,
    reasons: developmentReasons,
    warnings: developmentWarnings,
    manualReview: {
      required: true,
      reasonCodes: ['development.not-human-reviewed'],
    },
  } as unknown as CanonicalValue

  return {
    status: 'created',
    normalizedInput,
    prescription: {
      engineVersion: DEVELOPMENT_ENGINE_VERSION,
      methodologyRelease: developmentMethodologyRelease,
      template: developmentTemplateReference,
      normalizedInputHash: inputHash,
      outputHash: contentHash(outputHashMaterial),
      output,
      reasons: developmentReasons,
      warnings: developmentWarnings,
      manualReview: {
        required: true,
        reasonCodes: ['development.not-human-reviewed'],
      },
    },
  }
}
