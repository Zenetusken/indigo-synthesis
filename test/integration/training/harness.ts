import { eq } from 'drizzle-orm'
import { canonicalSha256 } from '@/modules/methodology/domain/canonical'
import { getDb } from '@/platform/db/client'
import {
  athleteEquipment,
  athleteProfiles,
  athleteTrainingDays,
  exercisePrescriptions,
  plannedWorkouts,
  programRevisions,
  programs,
  setPrescriptions,
  strengthBaselines,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

export const TEST_NOW = new Date('2026-07-11T12:00:00.000Z')
export const TEST_TODAY = '2026-07-11'
export const TEST_NEXT_DAY = '2026-07-13'
export const TEST_TARGET_LOAD_GRAMS = 50_000
export const TEST_TARGET_REPETITIONS = 5

export type SeededProgram = {
  readonly programId: string
  readonly revisionId: string
  readonly originalOutputHash: string
  readonly currentWorkoutId: string
  readonly currentPrescriptionId: string
  readonly currentSetPrescriptionId: string
  readonly nextWorkoutId: string
  readonly nextPrescriptionId: string
  readonly nextSetPrescriptionId: string
}

export async function resetProductData(): Promise<void> {
  await getDb().execute(`
    TRUNCATE TABLE
      audit_event,
      deletion_plan,
      deletion_tombstone,
      safety_hold,
      strength_baseline,
      athlete_equipment,
      athlete_training_day,
      athlete_profile,
      program
    CASCADE
  `)
}

export async function seedCoherentProgram(
  userId: string,
  options: { readonly status?: 'active' | 'draft' } = {},
): Promise<SeededProgram> {
  const status = options.status ?? 'active'
  const programId = newUuidV7()
  const revisionId = newUuidV7()
  const currentWorkoutId = newUuidV7()
  const currentPrescriptionId = newUuidV7()
  const currentSetPrescriptionId = newUuidV7()
  const nextWorkoutId = newUuidV7()
  const nextPrescriptionId = newUuidV7()
  const nextSetPrescriptionId = newUuidV7()

  const normalizedInput = {
    fixture: 'training-integration',
    userId,
    schedule: [TEST_TODAY, TEST_NEXT_DAY],
  }
  const outputSnapshot = {
    fixture: 'training-integration',
    workouts: [
      {
        ordinal: 1,
        date: TEST_TODAY,
        exerciseCode: 'development.back-squat',
        targetLoadGrams: TEST_TARGET_LOAD_GRAMS,
        targetRepetitions: TEST_TARGET_REPETITIONS,
      },
      {
        ordinal: 2,
        date: TEST_NEXT_DAY,
        exerciseCode: 'development.back-squat',
        targetLoadGrams: TEST_TARGET_LOAD_GRAMS,
        targetRepetitions: TEST_TARGET_REPETITIONS,
      },
    ],
  }
  const normalizedInputHash = canonicalSha256(normalizedInput)
  const outputHash = canonicalSha256({ normalizedInputHash, outputSnapshot })

  await getDb().transaction(async (transaction) => {
    await transaction.insert(athleteProfiles).values({
      userId,
      units: 'metric',
      timezone: 'UTC',
      goal: 'general-strength',
      experience: 'familiar',
      sessionMinutes: 60,
      adultAttested: true,
      techniqueAttested: true,
      restrictionStatus: 'none',
      limitations: null,
      confirmedAt: TEST_NOW,
    })
    await transaction.insert(athleteTrainingDays).values([
      { userId, weekday: 1, ordinal: 1 },
      { userId, weekday: 3, ordinal: 2 },
      { userId, weekday: 5, ordinal: 3 },
    ])
    await transaction.insert(athleteEquipment).values(
      ['barbell', 'rack', 'bench', 'plates'].map((equipmentCode) => ({
        userId,
        equipmentCode,
      })),
    )
    await transaction.insert(strengthBaselines).values({
      id: newUuidV7(),
      userId,
      exerciseCode: 'development.back-squat',
      loadGrams: TEST_TARGET_LOAD_GRAMS,
      repetitions: TEST_TARGET_REPETITIONS,
      protocol: 'user-attested-working-set',
      testedOn: TEST_TODAY,
      provenance: 'user-attested',
    })
    await transaction.insert(programs).values({
      id: programId,
      userId,
      status,
    })
    await transaction.insert(programRevisions).values({
      id: revisionId,
      programId,
      revisionNumber: 1,
      status: 'draft',
      engineVersion: 'training-integration-v1',
      methodologyId: 'development.methodology-fixture',
      methodologyVersion: '0.0.1-development',
      methodologyReviewStatus: 'development',
      templateId: 'development.full-body-three-day',
      templateVersion: '0.0.1-development',
      templateReviewStatus: 'development',
      normalizedInputHash,
      outputHash,
      normalizedInput,
      outputSnapshot,
      warnings: ['UNREVIEWED DEVELOPMENT FIXTURE'],
      manualReviewRequired: true,
      activatedAt: null,
    })
    await transaction.insert(plannedWorkouts).values([
      {
        id: currentWorkoutId,
        revisionId,
        scheduledDate: TEST_TODAY,
        ordinal: 1,
        slotCode: 'A',
        name: 'Current development fixture',
      },
      {
        id: nextWorkoutId,
        revisionId,
        scheduledDate: TEST_NEXT_DAY,
        ordinal: 2,
        slotCode: 'B',
        name: 'Next development fixture',
      },
    ])
    await transaction.insert(exercisePrescriptions).values([
      {
        id: currentPrescriptionId,
        plannedWorkoutId: currentWorkoutId,
        exerciseCode: 'development.back-squat',
        exerciseName: 'Back squat — development fixture',
        ordinal: 1,
        safetyTier: 'standard',
        rationaleCode: 'development.integration-baseline',
      },
      {
        id: nextPrescriptionId,
        plannedWorkoutId: nextWorkoutId,
        exerciseCode: 'development.back-squat',
        exerciseName: 'Back squat — development fixture',
        ordinal: 1,
        safetyTier: 'standard',
        rationaleCode: 'development.integration-baseline',
      },
    ])
    await transaction.insert(setPrescriptions).values([
      {
        id: currentSetPrescriptionId,
        exercisePrescriptionId: currentPrescriptionId,
        ordinal: 1,
        setKind: 'working',
        targetLoadGrams: TEST_TARGET_LOAD_GRAMS,
        targetRepetitions: TEST_TARGET_REPETITIONS,
        restSeconds: 120,
      },
      {
        id: nextSetPrescriptionId,
        exercisePrescriptionId: nextPrescriptionId,
        ordinal: 1,
        setKind: 'working',
        targetLoadGrams: TEST_TARGET_LOAD_GRAMS,
        targetRepetitions: TEST_TARGET_REPETITIONS,
        restSeconds: 120,
      },
    ])
    if (status === 'active') {
      await transaction
        .update(programRevisions)
        .set({ status: 'active', activatedAt: TEST_NOW })
        .where(eq(programRevisions.id, revisionId))
    }
  })

  return {
    programId,
    revisionId,
    originalOutputHash: outputHash,
    currentWorkoutId,
    currentPrescriptionId,
    currentSetPrescriptionId,
    nextWorkoutId,
    nextPrescriptionId,
    nextSetPrescriptionId,
  }
}
