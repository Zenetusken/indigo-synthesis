import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/modules/identity/bootstrap/owner-bootstrap'
import { resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import {
  completeSet,
  completeWorkout,
  getWorkoutSession,
  reportPain,
  startWorkout,
} from '@/modules/training/application/workouts'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import {
  resetProductData,
  seedCoherentProgram,
  TEST_NOW,
  TEST_TARGET_LOAD_GRAMS,
  TEST_TARGET_REPETITIONS,
} from './harness'

type CompletedProgressionFixture = {
  readonly sourceSessionId: string
  readonly sourceRevisionId: string
  readonly appliedRevisionId: string
  readonly programId: string
}

type WorkoutSnapshot = {
  readonly workoutId: string
  readonly workoutName: string
  readonly scheduledDate: string
  readonly slotCode: string
  readonly exerciseCode: string
  readonly exerciseName: string
  readonly exerciseOrdinal: number
  readonly safetyTier: string
  readonly rationaleCode: string
  readonly setOrdinal: number
  readonly targetLoadGrams: number
  readonly targetRepetitions: number
  readonly restSeconds: number
}

let integrationDatabase: DisposableIntegrationDatabase | undefined
let ownerId = ''

async function connectToIntegrationDatabase(): Promise<Client> {
  if (!integrationDatabase) throw new Error('Integration database is unavailable.')
  const client = new Client({ connectionString: integrationDatabase.databaseUrl })
  await client.connect()
  return client
}

async function rollbackQuietly(client: Client): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined)
}

async function expectSqlState(
  operation: Promise<unknown>,
  code: '23514' | '55000',
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code })
}

async function completedProgressionFixture(): Promise<CompletedProgressionFixture> {
  const seeded = await seedCoherentProgram(ownerId)
  const sourceSessionId = await startWorkout(
    ownerId,
    seeded.currentWorkoutId,
    newUuidV7(),
    TEST_NOW,
  )
  const session = await getWorkoutSession(ownerId, sourceSessionId)
  const setId = session?.exercises[0]?.sets[0]?.id
  if (!setId) throw new Error('Completed progression fixture has no set.')

  await completeSet({
    userId: ownerId,
    sessionId: sourceSessionId,
    setId,
    commandId: newUuidV7(),
    actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
    actualRepetitions: TEST_TARGET_REPETITIONS,
    rpe: 8,
    note: null,
  })
  await completeWorkout({
    userId: ownerId,
    sessionId: sourceSessionId,
    commandId: newUuidV7(),
    noPainAttested: true,
  })

  const client = await connectToIntegrationDatabase()
  try {
    const result = await client.query<{
      appliedRevisionId: string | null
      programId: string
    }>(
      `SELECT decision.applied_revision_id AS "appliedRevisionId",
              revision.program_id AS "programId"
       FROM adjustment_decision AS decision
       JOIN program_revision AS revision
         ON revision.id = decision.applied_revision_id
       WHERE decision.session_id = $1`,
      [sourceSessionId],
    )
    const saved = result.rows[0]
    if (!saved?.appliedRevisionId) {
      throw new Error('Completed fixture did not persist an applied revision.')
    }
    return {
      sourceSessionId,
      sourceRevisionId: seeded.revisionId,
      appliedRevisionId: saved.appliedRevisionId,
      programId: saved.programId,
    }
  } finally {
    await client.end()
  }
}

async function loadWorkoutSnapshot(
  client: Client,
  revisionId: string,
): Promise<WorkoutSnapshot> {
  const result = await client.query<WorkoutSnapshot>(
    `SELECT workout.id AS "workoutId",
            workout.name AS "workoutName",
            workout.scheduled_date::text AS "scheduledDate",
            workout.slot_code AS "slotCode",
            exercise.exercise_code AS "exerciseCode",
            exercise.exercise_name AS "exerciseName",
            exercise.ordinal AS "exerciseOrdinal",
            exercise.safety_tier AS "safetyTier",
            exercise.rationale_code AS "rationaleCode",
            prescribed.ordinal AS "setOrdinal",
            prescribed.target_load_grams AS "targetLoadGrams",
            prescribed.target_repetitions AS "targetRepetitions",
            prescribed.rest_seconds AS "restSeconds"
     FROM planned_workout AS workout
     JOIN exercise_prescription AS exercise
       ON exercise.planned_workout_id = workout.id
     JOIN set_prescription AS prescribed
       ON prescribed.exercise_prescription_id = exercise.id
     WHERE workout.revision_id = $1
     ORDER BY workout.ordinal, exercise.ordinal, prescribed.ordinal
     LIMIT 1`,
    [revisionId],
  )
  const snapshot = result.rows[0]
  if (!snapshot) throw new Error('Applied revision has no executable workout.')
  return snapshot
}

async function insertAndFinalizeSession(
  client: Client,
  snapshot: WorkoutSnapshot,
  suffix: string,
): Promise<string> {
  const sessionId = `h1-race-session-${suffix}`
  const exerciseId = `h1-race-exercise-${suffix}`
  await client.query(
    `INSERT INTO workout_session (
       id, user_id, planned_workout_id, planned_workout_name,
       scheduled_date, slot_code, status, started_at,
       optimistic_version, start_command_id, snapshot_finalized_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'initializing', now(), 1, $7, NULL)`,
    [
      sessionId,
      ownerId,
      snapshot.workoutId,
      snapshot.workoutName,
      snapshot.scheduledDate,
      snapshot.slotCode,
      `h1-race-start-${suffix}`,
    ],
  )
  await client.query(
    `INSERT INTO session_exercise (
       id, session_id, exercise_code, exercise_name, ordinal,
       safety_tier, rationale_code, original_exercise_code
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $3)`,
    [
      exerciseId,
      sessionId,
      snapshot.exerciseCode,
      snapshot.exerciseName,
      snapshot.exerciseOrdinal,
      snapshot.safetyTier,
      snapshot.rationaleCode,
    ],
  )
  await client.query(
    `INSERT INTO performed_set (
       id, session_exercise_id, ordinal, status, target_load_grams,
       target_repetitions, rest_seconds
     ) VALUES ($1, $2, $3, 'pending', $4, $5, $6)`,
    [
      `h1-race-set-${suffix}`,
      exerciseId,
      snapshot.setOrdinal,
      snapshot.targetLoadGrams,
      snapshot.targetRepetitions,
      snapshot.restSeconds,
    ],
  )
  await client.query(
    `UPDATE workout_session
     SET status = 'active', snapshot_finalized_at = now(), updated_at = now()
     WHERE id = $1`,
    [sessionId],
  )
  return sessionId
}

async function beginCorrectionTransaction(
  client: Client,
  fixture: CompletedProgressionFixture,
  suffix: string,
): Promise<string> {
  const commandId = `h1-race-command-${suffix}`
  const correctionId = `h1-race-correction-${suffix}`
  await client.query('BEGIN')
  await client.query(
    `INSERT INTO training_command_receipt (
       command_id, user_id, command_type, session_id, target_id,
       request_hash, result_snapshot
     ) VALUES ($1, $2, 'report-pain', $3, $3, $4, '{"status":"succeeded"}'::jsonb)`,
    [commandId, ownerId, fixture.sourceSessionId, `request-${suffix}`],
  )
  await client.query(
    `INSERT INTO training_fact_correction (
       id, user_id, session_id, actor_user_id, command_id,
       correction_kind, sequence, reason
     ) VALUES ($1, $2, $3, $2, $4, 'session-feedback', 1, $5)`,
    [
      correctionId,
      ownerId,
      fixture.sourceSessionId,
      commandId,
      `Concurrent post-completion correction ${suffix}.`,
    ],
  )
  await client.query(
    `INSERT INTO session_feedback_correction (
       correction_id, session_id, user_id, pain_reported, details, answered_at
     ) VALUES ($1, $2, $3, true, $4, now())`,
    [correctionId, fixture.sourceSessionId, ownerId, `race ${suffix}`],
  )
  await client.query(
    `WITH RECURSIVE affected_revision(revision_id) AS (
       SELECT DISTINCT applied_revision_id
       FROM adjustment_decision
       WHERE session_id = $2 AND applied_revision_id IS NOT NULL
       UNION
       SELECT lineage.revision_id
       FROM affected_revision AS affected
       JOIN program_revision_lineage AS lineage
         ON lineage.parent_revision_id = affected.revision_id
     )
     INSERT INTO program_revision_invalidation (revision_id, correction_id)
     SELECT revision_id, $1 FROM affected_revision`,
    [correctionId, fixture.sourceSessionId],
  )
  await client.query(
    `WITH RECURSIVE affected_revision(revision_id) AS (
       SELECT DISTINCT applied_revision_id
       FROM adjustment_decision
       WHERE session_id = $2 AND applied_revision_id IS NOT NULL
       UNION
       SELECT lineage.revision_id
       FROM affected_revision AS affected
       JOIN program_revision_lineage AS lineage
         ON lineage.parent_revision_id = affected.revision_id
     ), affected_decision(decision_id) AS (
       SELECT id FROM adjustment_decision WHERE session_id = $2
       UNION
       SELECT decision.id
       FROM affected_revision AS affected
       JOIN planned_workout AS workout ON workout.revision_id = affected.revision_id
       JOIN workout_session AS session ON session.planned_workout_id = workout.id
       JOIN adjustment_decision AS decision ON decision.session_id = session.id
     )
     INSERT INTO adjustment_decision_invalidation (decision_id, correction_id)
     SELECT decision_id, $1 FROM affected_decision`,
    [correctionId, fixture.sourceSessionId],
  )
  return correctionId
}

// pg sets Client.processID (the backend PID) after connect, but @types/pg omits it.
// Read it in a typed way rather than querying the client — it is mid-block here.
function backendPid(client: Client): number {
  const pid = (client as unknown as { processID: number | null }).processID
  if (pid === null) throw new Error('PostgreSQL client has no backend process id')
  return pid
}

async function waitUntilBlocked(observer: Client, blockedClient: Client): Promise<void> {
  const blockedPid = backendPid(blockedClient)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await observer.query<{ blocked: boolean }>(
      `SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked`,
      [blockedPid],
    )
    if (result.rows[0]?.blocked) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`PostgreSQL client ${blockedPid} did not block.`)
}

async function createActivationDescendant(
  fixture: CompletedProgressionFixture,
): Promise<{ readonly childRevisionId: string; readonly sourceSessionId: string }> {
  const client = await connectToIntegrationDatabase()
  try {
    const snapshot = await loadWorkoutSnapshot(client, fixture.appliedRevisionId)
    const sourceSessionId = await startWorkout(
      ownerId,
      snapshot.workoutId,
      newUuidV7(),
      new Date(`${snapshot.scheduledDate}T12:00:00.000Z`),
    )
    const childRevisionId = newUuidV7()
    await client.query(
      `INSERT INTO program_revision (
         id, program_id, revision_number, status, engine_version,
         methodology_id, methodology_version, methodology_review_status,
         template_id, template_version, template_review_status,
         normalized_input_hash, output_hash, normalized_input, output_snapshot,
         warnings, manual_review_required, activated_at
       )
       SELECT $1, program_id, revision_number + 1, 'draft', engine_version,
              methodology_id, methodology_version, methodology_review_status,
              template_id, template_version, template_review_status,
              normalized_input_hash || '-descendant', output_hash || '-descendant',
              normalized_input, output_snapshot, warnings, manual_review_required, NULL
       FROM program_revision
       WHERE id = $2`,
      [childRevisionId, fixture.appliedRevisionId],
    )
    await client.query(
      `INSERT INTO program_revision_lineage (
         revision_id, parent_revision_id, source_session_id, source_program_ordinal
       )
       SELECT $1, $2, $3, workout.program_ordinal
       FROM workout_session AS session
       JOIN planned_workout AS workout ON workout.id = session.planned_workout_id
       WHERE session.id = $3`,
      [childRevisionId, fixture.appliedRevisionId, sourceSessionId],
    )
    return { childRevisionId, sourceSessionId }
  } finally {
    await client.end()
  }
}

async function activateDescendant(
  client: Client,
  fixture: CompletedProgressionFixture,
  childRevisionId: string,
): Promise<void> {
  await client.query(
    `UPDATE program_revision SET status = 'superseded'
     WHERE id = $1 AND status = 'active'`,
    [fixture.appliedRevisionId],
  )
  await client.query(
    `UPDATE program_revision
     SET status = 'active', activated_at = now()
     WHERE id = $1 AND status = 'draft'`,
    [childRevisionId],
  )
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'h1_invariants',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  resetAuthForTests()
  await closeDb()
  await migrateDatabase()

  const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  const owner = await createOwnerWithBootstrapCode({
    name: 'H1 invariant owner',
    email: 'h1-invariants@example.test',
    password: 'h1-invariant-password',
    code: bootstrap.code,
  })
  ownerId = owner.id
})

beforeEach(async () => {
  await resetProductData()
})

afterAll(async () => {
  resetAuthForTests()
  await closeDb()
  integrationDatabase?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await integrationDatabase?.cleanup()
})

describe('0011 direct PostgreSQL invariant matrix', () => {
  it('rejects illegal aggregate, revision, session, snapshot, and child transitions', async () => {
    const seeded = await seedCoherentProgram(ownerId)
    const client = await connectToIntegrationDatabase()
    try {
      await expectSqlState(
        client.query(
          `INSERT INTO program (id, user_id, status)
           VALUES ($1, $2, 'active')`,
          [newUuidV7(), ownerId],
        ),
        '55000',
      )
      await expectSqlState(
        client.query(
          `INSERT INTO program_revision (
             id, program_id, revision_number, status, engine_version,
             methodology_id, methodology_version, methodology_review_status,
             template_id, template_version, template_review_status,
             normalized_input_hash, output_hash, normalized_input, output_snapshot,
             warnings, manual_review_required, activated_at
           )
           SELECT $1, program_id, revision_number + 20, 'active', engine_version,
                  methodology_id, methodology_version, methodology_review_status,
                  template_id, template_version, template_review_status,
                  normalized_input_hash, output_hash, normalized_input, output_snapshot,
                  warnings, manual_review_required, now()
           FROM program_revision WHERE id = $2`,
          [newUuidV7(), seeded.revisionId],
        ),
        '55000',
      )

      await expectSqlState(
        client.query(
          `INSERT INTO workout_session (
             id, user_id, planned_workout_id, planned_workout_name,
             scheduled_date, slot_code, status, started_at,
             optimistic_version, start_command_id, snapshot_finalized_at
           ) VALUES (
             $1, $2, $3, 'Illegal active insert', '2026-07-11', 'A',
             'active', now(), 1, $4, now()
           )`,
          [newUuidV7(), ownerId, seeded.currentWorkoutId, newUuidV7()],
        ),
        '55000',
      )

      const unfinalizedSessionId = newUuidV7()
      await client.query('BEGIN')
      try {
        await client.query(
          `INSERT INTO workout_session (
             id, user_id, planned_workout_id, planned_workout_name,
             scheduled_date, slot_code, status, started_at,
             optimistic_version, start_command_id, snapshot_finalized_at
           ) VALUES (
             $1, $2, $3, 'Unsealed snapshot', '2026-07-11', 'A',
             'initializing', now(), 1, $4, NULL
           )`,
          [unfinalizedSessionId, ownerId, seeded.currentWorkoutId, newUuidV7()],
        )
        await expectSqlState(client.query('COMMIT'), '55000')
      } finally {
        await rollbackQuietly(client)
      }

      const bornResolvedSessionId = newUuidV7()
      const bornResolvedExerciseId = newUuidV7()
      await client.query('BEGIN')
      try {
        await client.query(
          `INSERT INTO workout_session (
             id, user_id, planned_workout_id, planned_workout_name,
             scheduled_date, slot_code, status, started_at,
             optimistic_version, start_command_id, snapshot_finalized_at
           ) VALUES (
             $1, $2, $3, 'Resolved snapshot attack', '2026-07-11', 'A',
             'initializing', now(), 1, $4, NULL
           )`,
          [bornResolvedSessionId, ownerId, seeded.currentWorkoutId, newUuidV7()],
        )
        await client.query(
          `INSERT INTO session_exercise (
             id, session_id, exercise_code, exercise_name, ordinal,
             safety_tier, rationale_code, original_exercise_code
           ) VALUES (
             $1, $2, 'development.back-squat', 'Back squat', 1,
             'standard', 'test.snapshot-attack', 'development.back-squat'
           )`,
          [bornResolvedExerciseId, bornResolvedSessionId],
        )
        await expectSqlState(
          client.query(
            `INSERT INTO performed_set (
               id, session_exercise_id, ordinal, status, target_load_grams,
               target_repetitions, rest_seconds, actual_load_grams,
               actual_repetitions, rpe, load_provenance,
               repetitions_provenance, explicitly_confirmed, confirmed_at,
               command_id
             ) VALUES (
               $1, $2, 1, 'performed', 50000, 5, 120, 50000, 5, 8,
               'copied-target', 'copied-target', true, now(), $3
             )`,
            [newUuidV7(), bornResolvedExerciseId, newUuidV7()],
          ),
          '55000',
        )
      } finally {
        await rollbackQuietly(client)
      }

      const sessionId = await startWorkout(
        ownerId,
        seeded.currentWorkoutId,
        newUuidV7(),
        TEST_NOW,
      )
      const session = await getWorkoutSession(ownerId, sessionId)
      const exerciseId = session?.exercises[0]?.id
      const setId = session?.exercises[0]?.sets[0]?.id
      if (!exerciseId || !setId) throw new Error('Started SQL fixture is incomplete.')

      await expectSqlState(
        client.query(
          `UPDATE session_exercise
           SET exercise_name = 'Mutated released snapshot'
           WHERE id = $1`,
          [exerciseId],
        ),
        '55000',
      )
      await expectSqlState(
        client.query(
          `UPDATE performed_set
           SET status = 'performed', actual_load_grams = target_load_grams,
               actual_repetitions = target_repetitions, rpe = 8,
               load_provenance = 'copied-target',
               repetitions_provenance = 'copied-target',
               explicitly_confirmed = true, confirmed_at = now(),
               command_id = $2, updated_at = now()
           WHERE id = $1`,
          [setId, newUuidV7()],
        ),
        '55000',
      )
      await expectSqlState(
        client.query(
          `UPDATE workout_session
           SET status = 'completed', completed_at = now(),
               completion_command_id = $2,
               optimistic_version = optimistic_version + 1,
               updated_at = now()
           WHERE id = $1`,
          [sessionId, newUuidV7()],
        ),
        '55000',
      )

      const unrelatedRevisionId = newUuidV7()
      await client.query(
        `INSERT INTO program_revision (
           id, program_id, revision_number, status, engine_version,
           methodology_id, methodology_version, methodology_review_status,
           template_id, template_version, template_review_status,
           normalized_input_hash, output_hash, normalized_input, output_snapshot,
           warnings, manual_review_required, activated_at
         )
         SELECT $1, program_id, revision_number + 30, 'draft', engine_version,
                methodology_id, methodology_version, methodology_review_status,
                template_id, template_version, template_review_status,
                normalized_input_hash || '-unrelated', output_hash || '-unrelated',
                normalized_input, output_snapshot, warnings, manual_review_required, NULL
         FROM program_revision WHERE id = $2`,
        [unrelatedRevisionId, seeded.revisionId],
      )
      await expectSqlState(
        client.query(
          `INSERT INTO adjustment_decision (
             id, session_id, applied_revision_id, exercise_code, decision,
             current_load_grams, next_load_grams, reason_code, rule_version
           ) VALUES (
             $1, $2, $3, 'development.unrelated', 'hold',
             50000, 50000, 'test.unrelated', 'test-v1'
           )`,
          [newUuidV7(), sessionId, unrelatedRevisionId],
        ),
        '23514',
      )
    } finally {
      await client.end()
    }
  })

  it('rejects malformed, incomplete, unrelated, and mutable correction facts', async () => {
    const fixture = await completedProgressionFixture()
    const client = await connectToIntegrationDatabase()
    try {
      const wrongReceiptCommandId = newUuidV7()
      await client.query('BEGIN')
      try {
        await client.query(
          `INSERT INTO training_command_receipt (
             command_id, user_id, command_type, session_id, target_id,
             request_hash, result_snapshot
           ) VALUES ($1, $2, 'report-pain', $3, 'wrong-target', 'wrong-target',
                     '{"status":"succeeded"}'::jsonb)`,
          [wrongReceiptCommandId, ownerId, fixture.sourceSessionId],
        )
        await expectSqlState(
          client.query(
            `INSERT INTO training_fact_correction (
               id, user_id, session_id, actor_user_id, command_id,
               correction_kind, sequence, reason
             ) VALUES ($1, $2, $3, $2, $4, 'session-feedback', 1, 'Wrong receipt.')`,
            [newUuidV7(), ownerId, fixture.sourceSessionId, wrongReceiptCommandId],
          ),
          '23514',
        )
      } finally {
        await rollbackQuietly(client)
      }

      await client.query('BEGIN')
      try {
        const incompleteCommandId = newUuidV7()
        await client.query(
          `INSERT INTO training_command_receipt (
             command_id, user_id, command_type, session_id, target_id,
             request_hash, result_snapshot
           ) VALUES ($1, $2, 'report-pain', $3, $3, 'incomplete',
                     '{"status":"succeeded"}'::jsonb)`,
          [incompleteCommandId, ownerId, fixture.sourceSessionId],
        )
        await client.query(
          `INSERT INTO training_fact_correction (
             id, user_id, session_id, actor_user_id, command_id,
             correction_kind, sequence, reason
           ) VALUES ($1, $2, $3, $2, $4, 'session-feedback', 1, 'Incomplete correction.')`,
          [newUuidV7(), ownerId, fixture.sourceSessionId, incompleteCommandId],
        )
        await expectSqlState(client.query('COMMIT'), '55000')
      } finally {
        await rollbackQuietly(client)
      }

      await client.query('BEGIN')
      try {
        const commandId = newUuidV7()
        const correctionId = newUuidV7()
        await client.query(
          `INSERT INTO training_command_receipt (
             command_id, user_id, command_type, session_id, target_id,
             request_hash, result_snapshot
           ) VALUES ($1, $2, 'report-pain', $3, $3, 'unrelated',
                     '{"status":"succeeded"}'::jsonb)`,
          [commandId, ownerId, fixture.sourceSessionId],
        )
        await client.query(
          `INSERT INTO training_fact_correction (
             id, user_id, session_id, actor_user_id, command_id,
             correction_kind, sequence, reason
           ) VALUES ($1, $2, $3, $2, $4, 'session-feedback', 1, 'Causality test.')`,
          [correctionId, ownerId, fixture.sourceSessionId, commandId],
        )
        await client.query(
          `INSERT INTO session_feedback_correction (
             correction_id, session_id, user_id, pain_reported, details, answered_at
           ) VALUES ($1, $2, $3, true, 'causality test', now())`,
          [correctionId, fixture.sourceSessionId, ownerId],
        )
        await expectSqlState(
          client.query(
            `INSERT INTO program_revision_invalidation (revision_id, correction_id)
             VALUES ($1, $2)`,
            [fixture.sourceRevisionId, correctionId],
          ),
          '23514',
        )
      } finally {
        await rollbackQuietly(client)
      }

      await reportPain({
        userId: ownerId,
        sessionId: fixture.sourceSessionId,
        commandId: newUuidV7(),
        details: 'successful append-only correction',
      })
      const correction = await client.query<{ id: string }>(
        `SELECT id FROM training_fact_correction WHERE session_id = $1`,
        [fixture.sourceSessionId],
      )
      const correctionId = correction.rows[0]?.id
      if (!correctionId) throw new Error('Successful correction was not saved.')
      await expectSqlState(
        client.query(
          `UPDATE training_fact_correction SET reason = 'Tampered.' WHERE id = $1`,
          [correctionId],
        ),
        '55000',
      )
      await expectSqlState(
        client.query(
          `DELETE FROM program_revision_invalidation WHERE correction_id = $1`,
          [correctionId],
        ),
        '55000',
      )
    } finally {
      await client.end()
    }
  })
})

describe('completed-session correction durability', () => {
  it('keeps the original no-pain fact and durably invalidates every causal output', async () => {
    const fixture = await completedProgressionFixture()
    await reportPain({
      userId: ownerId,
      sessionId: fixture.sourceSessionId,
      commandId: newUuidV7(),
      details: 'post-completion pain for durability verification',
    })

    const client = await connectToIntegrationDatabase()
    try {
      const history = await client.query<{
        correctionKind: string
        correctionReason: string
        correctedDetails: string | null
        correctedPain: boolean
        originalDetails: string | null
        originalPain: boolean
      }>(
        `SELECT feedback.pain_reported AS "originalPain",
                feedback.details AS "originalDetails",
                correction.correction_kind AS "correctionKind",
                correction.reason AS "correctionReason",
                effective.pain_reported AS "correctedPain",
                effective.details AS "correctedDetails"
         FROM session_feedback AS feedback
         JOIN training_fact_correction AS correction
           ON correction.session_id = feedback.session_id
         JOIN session_feedback_correction AS effective
           ON effective.correction_id = correction.id
         WHERE feedback.session_id = $1`,
        [fixture.sourceSessionId],
      )
      expect(history.rows).toEqual([
        {
          originalPain: false,
          originalDetails: null,
          correctionKind: 'session-feedback',
          correctionReason: 'Pain reported after session completion.',
          correctedPain: true,
          correctedDetails: 'post-completion pain for durability verification',
        },
      ])

      const durability = await client.query<{
        durable: boolean
        missingDecisions: number
        missingRevisions: number
      }>(
        `WITH RECURSIVE affected_revision(revision_id) AS (
           SELECT DISTINCT applied_revision_id
           FROM adjustment_decision
           WHERE session_id = $1 AND applied_revision_id IS NOT NULL
           UNION
           SELECT lineage.revision_id
           FROM affected_revision AS affected
           JOIN program_revision_lineage AS lineage
             ON lineage.parent_revision_id = affected.revision_id
         ), affected_decision(decision_id) AS (
           SELECT id FROM adjustment_decision WHERE session_id = $1
           UNION
           SELECT decision.id
           FROM affected_revision AS affected
           JOIN planned_workout AS workout ON workout.revision_id = affected.revision_id
           JOIN workout_session AS session ON session.planned_workout_id = workout.id
           JOIN adjustment_decision AS decision ON decision.session_id = session.id
         )
         SELECT indigo_completed_session_invalidation_is_durable($1) AS durable,
                (SELECT count(*)::int
                 FROM affected_revision AS affected
                 LEFT JOIN program_revision_invalidation AS invalidation
                   ON invalidation.revision_id = affected.revision_id
                 WHERE invalidation.revision_id IS NULL) AS "missingRevisions",
                (SELECT count(*)::int
                 FROM affected_decision AS affected
                 LEFT JOIN adjustment_decision_invalidation AS invalidation
                   ON invalidation.decision_id = affected.decision_id
                 WHERE invalidation.decision_id IS NULL) AS "missingDecisions"`,
        [fixture.sourceSessionId],
      )
      expect(durability.rows).toEqual([
        { durable: true, missingDecisions: 0, missingRevisions: 0 },
      ])

      const lifecycle = await client.query<{
        programStatus: string
        revisionStatus: string
      }>(
        `SELECT aggregate.status AS "programStatus",
                revision.status AS "revisionStatus"
         FROM program AS aggregate
         JOIN program_revision AS revision ON revision.program_id = aggregate.id
         WHERE aggregate.id = $1 AND revision.id = $2`,
        [fixture.programId, fixture.appliedRevisionId],
      )
      expect(lifecycle.rows).toEqual([
        { programStatus: 'retired', revisionStatus: 'superseded' },
      ])
    } finally {
      await client.end()
    }
  })
})

describe('same-user correction serialization', () => {
  it.each([
    { label: 'correction commits before start/finalize', correctionFirst: true },
    { label: 'start/finalize commits before correction', correctionFirst: false },
  ])('$label', async ({ correctionFirst }) => {
    const fixture = await completedProgressionFixture()
    const correctionClient = await connectToIntegrationDatabase()
    const consumerClient = await connectToIntegrationDatabase()
    const observer = await connectToIntegrationDatabase()
    const suffix = correctionFirst ? 'correction-first-start' : 'start-first'
    const sessionId = `h1-race-session-${suffix}`
    try {
      const snapshot = await loadWorkoutSnapshot(observer, fixture.appliedRevisionId)
      if (correctionFirst) {
        await beginCorrectionTransaction(correctionClient, fixture, suffix)
        await consumerClient.query('BEGIN')
        const startPromise = insertAndFinalizeSession(consumerClient, snapshot, suffix)
        await waitUntilBlocked(observer, consumerClient)
        await correctionClient.query('COMMIT')
        await expectSqlState(startPromise, '55000')
        await rollbackQuietly(consumerClient)
      } else {
        await consumerClient.query('BEGIN')
        await insertAndFinalizeSession(consumerClient, snapshot, suffix)
        const correctionPromise = beginCorrectionTransaction(
          correctionClient,
          fixture,
          suffix,
        )
        await waitUntilBlocked(observer, correctionClient)
        await consumerClient.query('COMMIT')
        await correctionPromise
        await correctionClient.query('COMMIT')
      }

      const result = await observer.query<{
        programStatus: string
        revisionStatus: string
        sessionStatus: string | null
      }>(
        `SELECT aggregate.status AS "programStatus",
                revision.status AS "revisionStatus",
                session.status AS "sessionStatus"
         FROM program AS aggregate
         JOIN program_revision AS revision ON revision.program_id = aggregate.id
         LEFT JOIN workout_session AS session ON session.id = $3
         WHERE aggregate.id = $1 AND revision.id = $2`,
        [fixture.programId, fixture.appliedRevisionId, sessionId],
      )
      expect(result.rows).toEqual([
        {
          programStatus: 'retired',
          revisionStatus: 'superseded',
          sessionStatus: correctionFirst ? null : 'paused',
        },
      ])
    } finally {
      await rollbackQuietly(correctionClient)
      await rollbackQuietly(consumerClient)
      await Promise.all([correctionClient.end(), consumerClient.end(), observer.end()])
    }
  })

  it.each([
    { label: 'correction commits before activation', correctionFirst: true },
    { label: 'activation commits before correction', correctionFirst: false },
  ])('$label', async ({ correctionFirst }) => {
    const fixture = await completedProgressionFixture()
    const descendant = await createActivationDescendant(fixture)
    const correctionClient = await connectToIntegrationDatabase()
    const consumerClient = await connectToIntegrationDatabase()
    const observer = await connectToIntegrationDatabase()
    const suffix = correctionFirst ? 'correction-first-activation' : 'activation-first'
    try {
      if (correctionFirst) {
        await beginCorrectionTransaction(correctionClient, fixture, suffix)
        await consumerClient.query('BEGIN')
        const activationPromise = activateDescendant(
          consumerClient,
          fixture,
          descendant.childRevisionId,
        )
        await waitUntilBlocked(observer, consumerClient)
        await correctionClient.query('COMMIT')
        await expectSqlState(activationPromise, '55000')
        await rollbackQuietly(consumerClient)
      } else {
        await consumerClient.query('BEGIN')
        await activateDescendant(consumerClient, fixture, descendant.childRevisionId)
        const correctionPromise = beginCorrectionTransaction(
          correctionClient,
          fixture,
          suffix,
        )
        await waitUntilBlocked(observer, correctionClient)
        await consumerClient.query('COMMIT')
        await correctionPromise
        await correctionClient.query('COMMIT')
      }

      const result = await observer.query<{
        childStatus: string
        parentStatus: string
        programStatus: string
        sourceSessionStatus: string
      }>(
        `SELECT aggregate.status AS "programStatus",
                parent.status AS "parentStatus",
                child.status AS "childStatus",
                session.status AS "sourceSessionStatus"
         FROM program AS aggregate
         JOIN program_revision AS parent ON parent.program_id = aggregate.id
         JOIN program_revision AS child ON child.program_id = aggregate.id
         JOIN workout_session AS session ON session.id = $4
         WHERE aggregate.id = $1 AND parent.id = $2 AND child.id = $3`,
        [
          fixture.programId,
          fixture.appliedRevisionId,
          descendant.childRevisionId,
          descendant.sourceSessionId,
        ],
      )
      expect(result.rows).toEqual([
        {
          programStatus: 'retired',
          parentStatus: 'superseded',
          childStatus: correctionFirst ? 'draft' : 'superseded',
          sourceSessionStatus: 'paused',
        },
      ])
    } finally {
      await rollbackQuietly(correctionClient)
      await rollbackQuietly(consumerClient)
      await Promise.all([correctionClient.end(), consumerClient.end(), observer.end()])
    }
  })
})

async function applyMigrations(
  client: Client,
  migrations: readonly MigrationMeta[],
): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS drizzle')
  await client.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `)
  for (const migration of migrations) {
    await client.query('BEGIN')
    try {
      for (const statement of migration.sql) {
        if (statement.trim()) await client.query(statement)
      }
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2)`,
        [migration.hash, migration.folderMillis],
      )
      await client.query('COMMIT')
    } catch (error) {
      await rollbackQuietly(client)
      throw error
    }
  }
}

async function seedLegacyCompletedPainCorrection(client: Client): Promise<void> {
  await client.query(
    `SELECT set_config('indigo.user_creation_mode', 'bootstrap-owner', false)`,
  )
  await client.query(
    `INSERT INTO "user" (id, name, email, email_verified)
     VALUES ('legacy-h1-owner', 'Legacy H1 owner', 'legacy-h1@example.test', true)`,
  )
  await client.query(
    `INSERT INTO program (id, user_id, status)
     VALUES ('legacy-h1-program', 'legacy-h1-owner', 'draft')`,
  )
  await client.query(
    `INSERT INTO program_revision (
       id, program_id, revision_number, status, engine_version,
       methodology_id, methodology_version, methodology_review_status,
       template_id, template_version, template_review_status,
       normalized_input_hash, output_hash, normalized_input, output_snapshot,
       warnings, manual_review_required
     ) VALUES (
       'legacy-h1-parent', 'legacy-h1-program', 1, 'draft', 'legacy-engine',
       'legacy-method', '1.0.0', 'development',
       'legacy-template', '1.0.0', 'development',
       'legacy-input-parent', 'legacy-output-parent',
       '{"fixture":"legacy-h1-parent"}'::jsonb,
       '{"fixture":"legacy-h1-parent"}'::jsonb,
       '[]'::jsonb, false
     )`,
  )
  await client.query(
    `INSERT INTO planned_workout (
       id, revision_id, scheduled_date, ordinal, program_ordinal, slot_code, name
     ) VALUES (
       'legacy-h1-workout', 'legacy-h1-parent', '2026-07-11', 1, 1, 'A',
       'Legacy H1 workout'
     )`,
  )
  await client.query(
    `INSERT INTO exercise_prescription (
       id, planned_workout_id, exercise_code, exercise_name, ordinal,
       safety_tier, rationale_code
     ) VALUES (
       'legacy-h1-prescription', 'legacy-h1-workout',
       'development.back-squat', 'Back squat', 1, 'standard', 'legacy.h1'
     )`,
  )
  await client.query(
    `INSERT INTO set_prescription (
       id, exercise_prescription_id, ordinal, set_kind,
       target_load_grams, target_repetitions, rest_seconds
     ) VALUES (
       'legacy-h1-set-prescription', 'legacy-h1-prescription',
       1, 'working', 50000, 5, 120
     )`,
  )
  await client.query(
    `UPDATE program_revision
     SET status = 'active', activated_at = '2026-07-11T11:00:00Z'
     WHERE id = 'legacy-h1-parent'`,
  )
  await client.query(
    `UPDATE program SET status = 'active' WHERE id = 'legacy-h1-program'`,
  )
  await client.query(
    `INSERT INTO workout_session (
       id, user_id, planned_workout_id, planned_workout_name,
       scheduled_date, slot_code, status, started_at,
       optimistic_version, start_command_id
     ) VALUES (
       'legacy-h1-session', 'legacy-h1-owner', 'legacy-h1-workout',
       'Legacy H1 workout', '2026-07-11', 'A', 'active',
       '2026-07-11T12:00:00Z', 1, 'legacy-h1-start'
     )`,
  )
  await client.query(
    `INSERT INTO session_exercise (
       id, session_id, exercise_code, exercise_name, ordinal,
       safety_tier, rationale_code, original_exercise_code
     ) VALUES (
       'legacy-h1-exercise', 'legacy-h1-session',
       'development.back-squat', 'Back squat', 1,
       'standard', 'legacy.h1', 'development.back-squat'
     )`,
  )
  await client.query(
    `INSERT INTO performed_set (
       id, session_exercise_id, ordinal, status,
       target_load_grams, target_repetitions, rest_seconds
     ) VALUES (
       'legacy-h1-set', 'legacy-h1-exercise', 1, 'pending', 50000, 5, 120
     )`,
  )
  await client.query(
    `INSERT INTO program_revision (
       id, program_id, revision_number, status, engine_version,
       methodology_id, methodology_version, methodology_review_status,
       template_id, template_version, template_review_status,
       normalized_input_hash, output_hash, normalized_input, output_snapshot,
       warnings, manual_review_required
     ) VALUES (
       'legacy-h1-child', 'legacy-h1-program', 2, 'draft', 'legacy-engine',
       'legacy-method', '1.0.0', 'development',
       'legacy-template', '1.0.0', 'development',
       'legacy-input-child', 'legacy-output-child',
       '{"fixture":"legacy-h1-child"}'::jsonb,
       '{"fixture":"legacy-h1-child"}'::jsonb,
       '[]'::jsonb, false
     )`,
  )
  await client.query(
    `INSERT INTO program_revision_lineage (
       revision_id, parent_revision_id, source_session_id, source_program_ordinal
     ) VALUES (
       'legacy-h1-child', 'legacy-h1-parent', 'legacy-h1-session', 1
     )`,
  )
  await client.query(
    `INSERT INTO adjustment_decision (
       id, session_id, applied_revision_id, exercise_code, decision,
       current_load_grams, next_load_grams, reason_code, rule_version
     ) VALUES (
       'legacy-h1-decision', 'legacy-h1-session', 'legacy-h1-child',
       'development.back-squat', 'increase', 50000, 52500,
       'legacy.progression', 'legacy-v1'
     )`,
  )
  await client.query(
    `UPDATE program_revision SET status = 'superseded'
     WHERE id = 'legacy-h1-parent'`,
  )
  await client.query(
    `UPDATE program_revision
     SET status = 'active', activated_at = '2026-07-11T12:30:00Z'
     WHERE id = 'legacy-h1-child'`,
  )
  await client.query(
    `INSERT INTO training_command_receipt (
       command_id, user_id, command_type, session_id, target_id,
       request_hash, result_snapshot
     ) VALUES (
       'legacy-h1-complete-set', 'legacy-h1-owner', 'complete-set',
       'legacy-h1-session', 'legacy-h1-set', 'legacy-complete-set',
       '{"status":"succeeded"}'::jsonb
     )`,
  )
  await client.query(
    `UPDATE performed_set
     SET status = 'performed', actual_load_grams = 50000,
         actual_repetitions = 5, rpe = 8,
         load_provenance = 'copied-target',
         repetitions_provenance = 'copied-target',
         explicitly_confirmed = true,
         confirmed_at = '2026-07-11T12:45:00Z',
         command_id = 'legacy-h1-complete-set'
     WHERE id = 'legacy-h1-set'`,
  )
  await client.query(
    `UPDATE workout_session
     SET optimistic_version = 2, updated_at = '2026-07-11T12:45:00Z'
     WHERE id = 'legacy-h1-session'`,
  )
  await client.query(
    `INSERT INTO session_feedback (
       session_id, pain_reported, details, answered_at
     ) VALUES (
       'legacy-h1-session', false, NULL, '2026-07-11T13:00:00Z'
     )`,
  )
  await client.query(
    `INSERT INTO training_command_receipt (
       command_id, user_id, command_type, session_id, target_id,
       request_hash, result_snapshot
     ) VALUES (
       'legacy-h1-complete-workout', 'legacy-h1-owner', 'complete-workout',
       'legacy-h1-session', 'legacy-h1-session', 'legacy-complete-workout',
       '{"status":"succeeded"}'::jsonb
     )`,
  )
  await client.query(
    `UPDATE workout_session
     SET status = 'completed', completed_at = '2026-07-11T13:00:00Z',
         optimistic_version = 3,
         completion_command_id = 'legacy-h1-complete-workout',
         updated_at = '2026-07-11T13:00:00Z'
     WHERE id = 'legacy-h1-session'`,
  )
  await client.query(
    `INSERT INTO training_command_receipt (
       command_id, user_id, command_type, session_id, target_id,
       request_hash, result_snapshot, created_at
     ) VALUES (
       'legacy-h1-report-pain', 'legacy-h1-owner', 'report-pain',
       'legacy-h1-session', 'legacy-h1-session', 'legacy-report-pain',
       '{"status":"succeeded"}'::jsonb, '2026-07-11T14:00:00Z'
     )`,
  )
  await client.query('BEGIN')
  try {
    await client.query(
      `SELECT set_config(
         'indigo.session_feedback_write_mode',
         'post-completion-safety-report',
         true
       )`,
    )
    await client.query(
      `UPDATE session_feedback
       SET pain_reported = true,
           details = 'legacy post-completion pain',
           answered_at = '2026-07-11T14:00:00Z'
       WHERE session_id = 'legacy-h1-session'`,
    )
    await client.query('COMMIT')
  } catch (error) {
    await rollbackQuietly(client)
    throw error
  }
}

describe('populated 0010 to 0011 H1 upgrade', () => {
  it('rewrites legacy terminal feedback into immutable original plus causal correction facts', async () => {
    const database = createDisposableIntegrationDatabase({
      administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
      suite: 'h1_upgrade',
    })
    let client: Client | undefined
    await database.create()
    try {
      client = new Client({ connectionString: database.databaseUrl })
      await client.connect()
      const migrations = readMigrationFiles({ migrationsFolder: './drizzle' })
      expect(migrations.length).toBeGreaterThanOrEqual(12)
      await applyMigrations(client, migrations.slice(0, 11))
      await seedLegacyCompletedPainCorrection(client)
      await applyMigrations(client, migrations.slice(11, 12))

      const history = await client.query<{
        answeredAt: Date
        correctedDetails: string | null
        correctedPain: boolean
        correctionKind: string
        originalDetails: string | null
        originalPain: boolean
        sequence: number
      }>(
        `SELECT original.pain_reported AS "originalPain",
                original.details AS "originalDetails",
                original.answered_at AS "answeredAt",
                correction.correction_kind AS "correctionKind",
                correction.sequence,
                effective.pain_reported AS "correctedPain",
                effective.details AS "correctedDetails"
         FROM session_feedback AS original
         JOIN training_fact_correction AS correction
           ON correction.session_id = original.session_id
         JOIN session_feedback_correction AS effective
           ON effective.correction_id = correction.id
         WHERE original.session_id = 'legacy-h1-session'`,
      )
      expect(history.rows).toHaveLength(1)
      expect(history.rows[0]).toMatchObject({
        originalPain: false,
        originalDetails: null,
        correctionKind: 'session-feedback',
        sequence: 1,
        correctedPain: true,
        correctedDetails: 'legacy post-completion pain',
      })
      expect(history.rows[0]?.answeredAt.toISOString()).toBe('2026-07-11T13:00:00.000Z')

      const invalidation = await client.query<{
        decisionInvalidated: boolean
        durable: boolean
        programStatus: string
        revisionInvalidated: boolean
        revisionStatus: string
      }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM adjustment_decision_invalidation
             WHERE decision_id = 'legacy-h1-decision'
           ) AS "decisionInvalidated",
           EXISTS (
             SELECT 1 FROM program_revision_invalidation
             WHERE revision_id = 'legacy-h1-child'
           ) AS "revisionInvalidated",
           indigo_completed_session_invalidation_is_durable(
             'legacy-h1-session'
           ) AS durable,
           aggregate.status AS "programStatus",
           revision.status AS "revisionStatus"
         FROM program AS aggregate
         JOIN program_revision AS revision
           ON revision.program_id = aggregate.id
         WHERE aggregate.id = 'legacy-h1-program'
           AND revision.id = 'legacy-h1-child'`,
      )
      expect(invalidation.rows).toEqual([
        {
          decisionInvalidated: true,
          revisionInvalidated: true,
          durable: true,
          programStatus: 'retired',
          revisionStatus: 'superseded',
        },
      ])

      await expectSqlState(
        client.query(
          `UPDATE session_feedback
           SET details = 'history tamper'
           WHERE session_id = 'legacy-h1-session'`,
        ),
        '55000',
      )
    } finally {
      await client?.end()
      await database.cleanup()
    }
  })
})
