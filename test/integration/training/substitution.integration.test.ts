import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/modules/identity/bootstrap/owner-bootstrap'
import { resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import {
  getWorkoutSession,
  proposeExerciseSubstitution,
  startWorkout,
} from '@/modules/training/application/workouts'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import { resetProductData, seedCoherentProgram, TEST_NOW } from './harness'

let integrationDatabase: DisposableIntegrationDatabase | undefined
let ownerId = ''

async function substitutionFacts(sessionId: string) {
  const result = await getDb().execute<{
    exercise_snapshot: unknown
    performed_set_snapshot: unknown
    receipt_count: number
    session_snapshot: unknown
  }>(sql`
    SELECT
      (SELECT row_to_json(session_row)
       FROM (
         SELECT id, user_id, planned_workout_id, status, optimistic_version,
                started_at, paused_at, completed_at, abandoned_at,
                snapshot_finalized_at, updated_at
         FROM workout_session
         WHERE id = ${sessionId}
       ) AS session_row) AS session_snapshot,
      (SELECT json_agg(row_to_json(exercise_row) ORDER BY ordinal)
       FROM (
         SELECT id, session_id, exercise_code, exercise_name, ordinal, safety_tier,
                rationale_code, original_exercise_code, substitution_reason
         FROM session_exercise
         WHERE session_id = ${sessionId}
       ) AS exercise_row) AS exercise_snapshot,
      (SELECT json_agg(row_to_json(set_row) ORDER BY session_exercise_id, ordinal)
       FROM (
         SELECT performed_set.*
         FROM performed_set
         JOIN session_exercise
           ON session_exercise.id = performed_set.session_exercise_id
         WHERE session_exercise.session_id = ${sessionId}
       ) AS set_row) AS performed_set_snapshot,
      (SELECT count(*)::int
       FROM training_command_receipt
       WHERE session_id = ${sessionId}) AS receipt_count
  `)
  const facts = result.rows[0]
  if (!facts) throw new Error('Substitution fixture facts are unavailable.')
  return facts
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'substitution',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  resetAuthForTests()
  await closeDb()
  await migrateDatabase()

  const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  const owner = await createOwnerWithBootstrapCode({
    name: 'Substitution Integration Owner',
    email: 'substitution-owner@example.test',
    password: 'substitution-owner-password',
    code: bootstrap.code,
  })
  ownerId = owner.id
})

afterAll(async () => {
  resetAuthForTests()
  await closeDb()
  integrationDatabase?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await integrationDatabase?.cleanup()
})

beforeEach(async () => {
  await resetProductData()
})

describe('exercise substitution proposal boundary', () => {
  it('denies an owned proposal and its replay without changing workout facts', async () => {
    const seeded = await seedCoherentProgram(ownerId)
    const sessionId = await startWorkout(
      ownerId,
      seeded.currentWorkoutId,
      newUuidV7(),
      TEST_NOW,
    )
    const session = await getWorkoutSession(ownerId, sessionId)
    const exercise = session?.exercises[0]
    if (!exercise) throw new Error('Started substitution fixture has no exercise.')

    const command = {
      userId: ownerId,
      sessionId,
      sessionExerciseId: exercise.id,
      commandId: newUuidV7(),
      requestedExerciseCode: 'development.front-squat',
    }
    const before = await substitutionFacts(sessionId)

    await expect(proposeExerciseSubstitution(command)).rejects.toMatchObject({
      code: 'substitution.unapproved',
    })
    await expect(proposeExerciseSubstitution(command)).rejects.toMatchObject({
      code: 'substitution.unapproved',
    })

    expect(await substitutionFacts(sessionId)).toEqual(before)
  })

  it("does not disclose another actor's session exercise", async () => {
    const seeded = await seedCoherentProgram(ownerId)
    const sessionId = await startWorkout(
      ownerId,
      seeded.currentWorkoutId,
      newUuidV7(),
      TEST_NOW,
    )
    const session = await getWorkoutSession(ownerId, sessionId)
    const exercise = session?.exercises[0]
    if (!exercise) throw new Error('Started substitution fixture has no exercise.')
    const before = await substitutionFacts(sessionId)

    await expect(
      proposeExerciseSubstitution({
        userId: newUuidV7(),
        sessionId,
        sessionExerciseId: exercise.id,
        commandId: newUuidV7(),
        requestedExerciseCode: 'development.front-squat',
      }),
    ).rejects.toMatchObject({ code: 'exercise.not-found' })

    expect(await substitutionFacts(sessionId)).toEqual(before)
  })
})
