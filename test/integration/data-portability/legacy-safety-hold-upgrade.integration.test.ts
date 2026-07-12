import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { createDisposableIntegrationDatabase } from '@/platform/db/disposable-integration-database'

async function applyMigrations(client: Client, migrations: readonly MigrationMeta[]) {
  for (const migration of migrations) {
    await client.query('BEGIN')
    try {
      for (const statement of migration.sql) {
        if (statement.trim()) await client.query(statement)
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }
}

async function insertUser(
  client: Client,
  input: {
    readonly id: string
    readonly email: string
    readonly mode: 'bootstrap-owner' | 'owner-admin'
  },
) {
  await client.query(`SELECT set_config('indigo.user_creation_mode', $1, false)`, [
    input.mode,
  ])
  await client.query(
    `INSERT INTO "user" (id, name, email, email_verified)
     VALUES ($1, $2, $3, true)`,
    [input.id, input.id, input.email],
  )
}

async function seedProgram(client: Client, userId: string): Promise<string> {
  const programId = `${userId}-program`
  const revisionId = `${userId}-revision`
  await client.query(
    `INSERT INTO program (id, user_id, status) VALUES ($1, $2, 'draft')`,
    [programId, userId],
  )
  await client.query(
    `INSERT INTO program_revision (
       id, program_id, revision_number, status, engine_version,
       methodology_id, methodology_version, methodology_review_status,
       template_id, template_version, template_review_status,
       normalized_input_hash, output_hash, normalized_input, output_snapshot,
       warnings, manual_review_required
     ) VALUES (
       $1, $2, 1, 'draft', 'legacy-engine',
       'legacy-method', '1.0.0', 'development',
       'legacy-template', '1.0.0', 'development',
       'legacy-input', 'legacy-output', '{}'::jsonb, '{}'::jsonb,
       '[]'::jsonb, false
     )`,
    [revisionId, programId],
  )
  return revisionId
}

async function insertActiveSession(
  client: Client,
  input: {
    readonly userId: string
    readonly revisionId: string
    readonly suffix: string
    readonly ordinal: number
  },
): Promise<string> {
  const workoutId = `${input.userId}-${input.suffix}-workout`
  const sessionId = `${input.userId}-${input.suffix}-session`
  const scheduledDate = `2026-07-${String(10 + input.ordinal).padStart(2, '0')}`
  const slotCode = ['A', 'B', 'C'][(input.ordinal - 1) % 3] ?? 'A'
  await client.query(
    `INSERT INTO planned_workout (
       id, revision_id, scheduled_date, ordinal, program_ordinal, slot_code, name
     ) VALUES ($1, $2, $3, $4, $4, $5, $6)`,
    [
      workoutId,
      input.revisionId,
      scheduledDate,
      input.ordinal,
      slotCode,
      `Legacy workout ${input.suffix}`,
    ],
  )
  await client.query(
    `INSERT INTO workout_session (
       id, user_id, planned_workout_id, planned_workout_name,
       scheduled_date, slot_code, status, started_at,
       optimistic_version, start_command_id
     ) VALUES ($1, $2, $3, $4, $5, $6, 'active', now(), 1, $7)`,
    [
      sessionId,
      input.userId,
      workoutId,
      `Legacy workout ${input.suffix}`,
      scheduledDate,
      slotCode,
      `${sessionId}-start`,
    ],
  )
  return sessionId
}

async function reportPainAndAbandon(
  client: Client,
  input: {
    readonly userId: string
    readonly sessionId: string
    readonly holdId?: string
    readonly coalesced: boolean
    readonly includeAudit: boolean
  },
) {
  await client.query(
    `UPDATE workout_session
     SET status = 'paused', paused_at = now(), optimistic_version = 2, updated_at = now()
     WHERE id = $1`,
    [input.sessionId],
  )
  await client.query(
    `INSERT INTO session_feedback (session_id, pain_reported, details, answered_at)
     VALUES ($1, true, 'legacy pain report', now())`,
    [input.sessionId],
  )
  if (input.holdId) {
    await client.query(
      `INSERT INTO safety_hold (id, user_id, reason_code, details)
       VALUES ($1, $2, 'session-pain-reported', 'legacy source-less hold')`,
      [input.holdId, input.userId],
    )
  }
  if (input.includeAudit) {
    await client.query(
      `INSERT INTO audit_event (
         id, actor_user_id, subject_user_id, event_type,
         entity_type, entity_id, metadata
       ) VALUES (
         $1, $2, $2, 'session-safety-stop', 'workout-session', $3,
         jsonb_build_object('coalescedWithExistingHold', $4::boolean)
       )`,
      [`${input.sessionId}-audit`, input.userId, input.sessionId, input.coalesced],
    )
  }
  await client.query(
    `UPDATE workout_session
     SET status = 'abandoned', paused_at = NULL, abandoned_at = now(),
         abandoned_reason = 'Stopped after legacy pain report.',
         optimistic_version = 3, updated_at = now()
     WHERE id = $1`,
    [input.sessionId],
  )
}

async function completeWithoutPain(client: Client, sessionId: string) {
  await client.query(
    `INSERT INTO session_feedback (session_id, pain_reported, details, answered_at)
     VALUES ($1, false, NULL, now())`,
    [sessionId],
  )
  await client.query(
    `UPDATE workout_session
     SET status = 'completed', completed_at = now(), optimistic_version = 2,
         updated_at = now()
     WHERE id = $1`,
    [sessionId],
  )
}

async function reportPainOnCompletedSession(
  client: Client,
  input: { readonly userId: string; readonly sessionId: string },
) {
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
       SET pain_reported = true, details = 'later coalesced pain report',
           answered_at = now()
       WHERE session_id = $1`,
      [input.sessionId],
    )
    await client.query(
      `INSERT INTO audit_event (
         id, actor_user_id, subject_user_id, event_type,
         entity_type, entity_id, metadata
       ) VALUES (
         $1, $2, $2, 'session-safety-stop', 'workout-session', $3,
         jsonb_build_object('coalescedWithExistingHold', true)
       )`,
      [`${input.sessionId}-audit`, input.userId, input.sessionId],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

describe('legacy source-less safety hold migration', () => {
  it('maps only proven 0006-era sources and keeps ambiguous users fail-closed', async () => {
    const database = createDisposableIntegrationDatabase({
      administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
      suite: 'legacy_hold',
    })
    let client: Client | undefined
    await database.create()

    try {
      client = new Client({ connectionString: database.databaseUrl })
      await client.connect()
      const migrations = readMigrationFiles({ migrationsFolder: './drizzle' })
      expect(migrations).toHaveLength(13)
      await applyMigrations(client, migrations.slice(0, 7))

      const users = [
        { id: 'legacy-one', email: 'legacy-one@example.test' },
        { id: 'legacy-coalesced', email: 'legacy-coalesced@example.test' },
        { id: 'legacy-fallback', email: 'legacy-fallback@example.test' },
        { id: 'legacy-ambiguous', email: 'legacy-ambiguous@example.test' },
      ] as const
      for (const [index, user] of users.entries()) {
        await insertUser(client, {
          ...user,
          mode: index === 0 ? 'bootstrap-owner' : 'owner-admin',
        })
      }

      const oneRevision = await seedProgram(client, 'legacy-one')
      const oneSession = await insertActiveSession(client, {
        userId: 'legacy-one',
        revisionId: oneRevision,
        suffix: 'one',
        ordinal: 1,
      })
      await reportPainAndAbandon(client, {
        userId: 'legacy-one',
        sessionId: oneSession,
        holdId: 'legacy-one-hold',
        coalesced: false,
        includeAudit: true,
      })

      const coalescedRevision = await seedProgram(client, 'legacy-coalesced')
      const laterCoalescedSession = await insertActiveSession(client, {
        userId: 'legacy-coalesced',
        revisionId: coalescedRevision,
        suffix: 'later',
        ordinal: 2,
      })
      await completeWithoutPain(client, laterCoalescedSession)
      const coalescedSource = await insertActiveSession(client, {
        userId: 'legacy-coalesced',
        revisionId: coalescedRevision,
        suffix: 'source',
        ordinal: 1,
      })
      await reportPainAndAbandon(client, {
        userId: 'legacy-coalesced',
        sessionId: coalescedSource,
        holdId: 'legacy-coalesced-hold',
        coalesced: false,
        includeAudit: true,
      })
      await reportPainOnCompletedSession(client, {
        userId: 'legacy-coalesced',
        sessionId: laterCoalescedSession,
      })

      const fallbackRevision = await seedProgram(client, 'legacy-fallback')
      const fallbackSession = await insertActiveSession(client, {
        userId: 'legacy-fallback',
        revisionId: fallbackRevision,
        suffix: 'fallback',
        ordinal: 1,
      })
      await reportPainAndAbandon(client, {
        userId: 'legacy-fallback',
        sessionId: fallbackSession,
        holdId: 'legacy-fallback-hold',
        coalesced: false,
        includeAudit: false,
      })

      const ambiguousRevision = await seedProgram(client, 'legacy-ambiguous')
      const ambiguousFirst = await insertActiveSession(client, {
        userId: 'legacy-ambiguous',
        revisionId: ambiguousRevision,
        suffix: 'first',
        ordinal: 1,
      })
      await reportPainAndAbandon(client, {
        userId: 'legacy-ambiguous',
        sessionId: ambiguousFirst,
        holdId: 'legacy-ambiguous-hold',
        coalesced: false,
        includeAudit: false,
      })
      const ambiguousSecond = await insertActiveSession(client, {
        userId: 'legacy-ambiguous',
        revisionId: ambiguousRevision,
        suffix: 'second',
        ordinal: 2,
      })
      await reportPainAndAbandon(client, {
        userId: 'legacy-ambiguous',
        sessionId: ambiguousSecond,
        coalesced: true,
        includeAudit: false,
      })

      await applyMigrations(client, migrations.slice(7, 10))

      const sources = await client.query<{
        userId: string
        holdId: string
        sourceSessionId: string | null
      }>(
        `SELECT user_id AS "userId", id AS "holdId",
                source_session_id AS "sourceSessionId"
         FROM safety_hold
         ORDER BY user_id`,
      )
      expect(sources.rows).toEqual([
        {
          userId: 'legacy-ambiguous',
          holdId: 'legacy-ambiguous-hold',
          sourceSessionId: null,
        },
        {
          userId: 'legacy-coalesced',
          holdId: 'legacy-coalesced-hold',
          sourceSessionId: coalescedSource,
        },
        {
          userId: 'legacy-fallback',
          holdId: 'legacy-fallback-hold',
          sourceSessionId: fallbackSession,
        },
        {
          userId: 'legacy-one',
          holdId: 'legacy-one-hold',
          sourceSessionId: oneSession,
        },
      ])

      for (const fixture of [
        { userId: 'legacy-one', holdId: 'legacy-one-hold' },
        { userId: 'legacy-coalesced', holdId: 'legacy-coalesced-hold' },
        { userId: 'legacy-fallback', holdId: 'legacy-fallback-hold' },
      ]) {
        await client.query(
          `INSERT INTO safety_hold_resolution
             (id, hold_id, user_id, reason, acknowledged)
           VALUES ($1, $2, $3, 'I understand this is not symptom clearance.', true)`,
          [`${fixture.holdId}-resolution`, fixture.holdId, fixture.userId],
        )
      }
      await expect(
        client.query(
          `INSERT INTO safety_hold_resolution
             (id, hold_id, user_id, reason, acknowledged)
           VALUES (
             'legacy-ambiguous-resolution', 'legacy-ambiguous-hold',
             'legacy-ambiguous', 'Ambiguous source must stay blocked.', true
           )`,
        ),
      ).rejects.toMatchObject({ code: '23514' })

      const trigger = await client.query<{ enabled: string }>(
        `SELECT trigger.tgenabled AS enabled
         FROM pg_trigger AS trigger
         JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE trigger.tgname = 'safety_hold_provenance_guard'
           AND relation.relname = 'safety_hold'
           AND namespace.nspname = 'public'
           AND NOT trigger.tgisinternal`,
      )
      expect(trigger.rows).toEqual([{ enabled: 'O' }])
    } finally {
      await client?.end()
      await database.cleanup()
    }
  })
})
