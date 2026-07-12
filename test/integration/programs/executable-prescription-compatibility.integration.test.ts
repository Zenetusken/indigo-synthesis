import { eq, sql } from 'drizzle-orm'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CanonicalValue } from '@/modules/methodology/domain/canonical'
import { canonicalSha256 } from '@/modules/methodology/domain/canonical'
import {
  activateProgram,
  getProgramOverview,
  ProgramUnavailableError,
} from '@/modules/programs/application/programs'
import {
  type ExecutablePrescriptionProjection,
  type ExecutablePrescriptionProjectionV1,
  executablePrescriptionHash,
  LEGACY_EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
  verifyExecutablePrescriptionIntegrity,
} from '@/modules/programs/domain/executable-prescription'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import { assertDatabaseReady } from '@/platform/db/preflight'
import {
  plannedWorkouts,
  programRevisions,
  setPrescriptions,
  user,
} from '@/platform/db/schema'
import {
  resetProductData,
  seedCoherentProgram,
  TEST_TARGET_LOAD_GRAMS,
} from '../training/harness'

const ownerId = 'program-compatibility-owner'
const originalProgramOrdinalMigrationHash =
  'a24d202530eb7b4179a65c0708a43b14cdd7f021bb8b5d082413148150f51c21'
const originalCrlfProgramOrdinalMigrationHash =
  '2900f743e521aa432d1fc6568aad04617cb89f6b9bccfb088c94ad6d23e04287'
const canonicalProgramOrdinalMigrationHash =
  'e5d7105d56a02ba8874fef8f2a724981363e74f809b22d909a0e7cec75564ba0'
const correctedCrlfProgramOrdinalMigrationHash =
  'd6267bcf692cdb7646813f1fa277d8e18b3fe495d267a342cd29e94700018431'
const programOrdinalMigrationCreatedAt = 1_783_823_225_722

let integrationDatabase: DisposableIntegrationDatabase | undefined

function toV1(
  current: ExecutablePrescriptionProjection,
): ExecutablePrescriptionProjectionV1 {
  return {
    hashMaterialVersion: LEGACY_EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
    engineVersion: current.engineVersion,
    methodology: current.methodology,
    template: current.template,
    normalizedInputHash: current.normalizedInputHash,
    workouts: current.workouts.map((workout) => ({
      scheduledDate: workout.scheduledDate,
      ordinal: workout.ordinal,
      slotCode: workout.slotCode,
      name: workout.name,
      exercises: workout.exercises,
    })),
  }
}

async function persistV1Draft() {
  const seeded = await seedCoherentProgram(ownerId, { status: 'draft' })
  const snapshot = toV1(seeded.outputSnapshot)
  await getDb()
    .update(programRevisions)
    .set({
      outputSnapshot: snapshot,
      outputHash: executablePrescriptionHash(snapshot),
    })
    .where(eq(programRevisions.id, seeded.revisionId))
  return { seeded, snapshot }
}

async function expectDraft(revisionId: string) {
  const [revision] = await getDb()
    .select({
      status: programRevisions.status,
      activatedAt: programRevisions.activatedAt,
    })
    .from(programRevisions)
    .where(eq(programRevisions.id, revisionId))
  expect(revision).toEqual({ status: 'draft', activatedAt: null })
}

async function applyMigrationPrefixWithLedger(
  client: Client,
  migrations: readonly MigrationMeta[],
) {
  await client.query('CREATE SCHEMA IF NOT EXISTS drizzle')
  await client.query(`
    CREATE TABLE drizzle.__drizzle_migrations (
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
      await client.query('ROLLBACK')
      throw error
    }
  }
}

function pre004Projection(): ExecutablePrescriptionProjectionV1 {
  const normalizedInputHash = canonicalSha256({ fixture: 'pre-0004-v1-upgrade' })
  return {
    hashMaterialVersion: LEGACY_EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
    engineVersion: 'pre-0004-engine',
    methodology: {
      id: 'development.methodology-fixture',
      version: '0.0.1-development',
      reviewStatus: 'development',
    },
    template: {
      id: 'development.full-body-three-day',
      version: '0.0.1-development',
      reviewStatus: 'development',
    },
    normalizedInputHash,
    workouts: [
      {
        scheduledDate: '2026-07-11',
        ordinal: 1,
        slotCode: 'A',
        name: 'Pre-0004 active workout',
        exercises: [
          {
            exerciseCode: 'development.back-squat',
            exerciseName: 'Back squat — development fixture',
            ordinal: 1,
            safetyTier: 'standard',
            rationaleCode: 'development.pre-0004-upgrade',
            sets: [
              {
                ordinal: 1,
                setKind: 'working',
                targetLoadGrams: TEST_TARGET_LOAD_GRAMS,
                targetRepetitions: 5,
                restSeconds: 120,
              },
            ],
          },
        ],
      },
    ],
  }
}

async function seedPre004ActiveRevision(client: Client) {
  const snapshot = pre004Projection()
  const normalizedInput = { fixture: 'pre-0004-v1-upgrade' } satisfies CanonicalValue
  await client.query(
    `INSERT INTO "user" (id, name, email, email_verified)
     VALUES ('pre-0004-owner', 'Pre-0004 owner', 'pre-0004@example.test', true)`,
  )
  await client.query(
    `INSERT INTO program (id, user_id, status)
     VALUES ('pre-0004-program', 'pre-0004-owner', 'draft')`,
  )
  await client.query(
    `INSERT INTO program_revision (
       id, program_id, revision_number, status, engine_version,
       methodology_id, methodology_version, methodology_review_status,
       template_id, template_version, template_review_status,
       normalized_input_hash, output_hash, normalized_input, output_snapshot,
       warnings, manual_review_required
     ) VALUES (
       'pre-0004-revision', 'pre-0004-program', 1, 'draft', $1,
       $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
       '[]'::jsonb, true
     )`,
    [
      snapshot.engineVersion,
      snapshot.methodology.id,
      snapshot.methodology.version,
      snapshot.methodology.reviewStatus,
      snapshot.template.id,
      snapshot.template.version,
      snapshot.template.reviewStatus,
      snapshot.normalizedInputHash,
      executablePrescriptionHash(snapshot),
      JSON.stringify(normalizedInput),
      JSON.stringify(snapshot),
    ],
  )
  await client.query(
    `INSERT INTO planned_workout
       (id, revision_id, scheduled_date, ordinal, slot_code, name)
     VALUES (
       'pre-0004-workout', 'pre-0004-revision', '2026-07-11', 1, 'A',
       'Pre-0004 active workout'
     )`,
  )
  await client.query(
    `INSERT INTO exercise_prescription (
       id, planned_workout_id, exercise_code, exercise_name, ordinal,
       safety_tier, rationale_code
     ) VALUES (
       'pre-0004-exercise', 'pre-0004-workout', 'development.back-squat',
       'Back squat — development fixture', 1, 'standard',
       'development.pre-0004-upgrade'
     )`,
  )
  await client.query(
    `INSERT INTO set_prescription (
       id, exercise_prescription_id, ordinal, set_kind,
       target_load_grams, target_repetitions, rest_seconds
     ) VALUES (
       'pre-0004-set', 'pre-0004-exercise', 1, 'working', $1, 5, 120
     )`,
    [TEST_TARGET_LOAD_GRAMS],
  )
  await client.query(`UPDATE program SET status = 'active' WHERE id = 'pre-0004-program'`)
  await client.query(
    `UPDATE program_revision
     SET status = 'active', activated_at = now()
     WHERE id = 'pre-0004-revision'`,
  )
}

async function withPendingLedgerProvenanceMigration(
  suite: string,
  exercise: (client: Client) => Promise<void>,
) {
  const database = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite,
  })
  let client: Client | undefined
  await database.create()

  try {
    client = new Client({ connectionString: database.databaseUrl })
    await client.connect()
    const migrations = readMigrationFiles({ migrationsFolder: './drizzle' })
    expect(migrations).toHaveLength(14)
    await applyMigrationPrefixWithLedger(client, migrations.slice(0, 10))

    database.activateDatabaseUrl()
    resetServerConfigForTests()
    await closeDb()

    await exercise(client)
  } finally {
    await closeDb()
    database.restoreDatabaseUrl()
    resetServerConfigForTests()
    await client?.end()
    await database.cleanup()
  }
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'program_compat',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  await closeDb()
  await migrateDatabase()

  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT set_config('indigo.user_creation_mode', 'bootstrap-owner', true)`,
    )
    await transaction.insert(user).values({
      id: ownerId,
      name: 'Program compatibility owner',
      email: 'program-compatibility@example.test',
      emailVerified: true,
    })
  })
})

beforeEach(async () => {
  await resetProductData()
})

afterAll(async () => {
  await closeDb()
  integrationDatabase?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await integrationDatabase?.cleanup()
})

describe('executable prescription v1 compatibility', () => {
  it('activates a typed v1 draft without rewriting its historical hash material', async () => {
    const { seeded, snapshot } = await persistV1Draft()

    await activateProgram(ownerId, seeded.revisionId)

    const [revision] = await getDb()
      .select()
      .from(programRevisions)
      .where(eq(programRevisions.id, seeded.revisionId))
    expect(revision).toMatchObject({
      status: 'active',
      outputHash: executablePrescriptionHash(snapshot),
      outputSnapshot: snapshot,
    })
  })

  it('rejects independently tampered executable rows under a v1 snapshot', async () => {
    const { seeded } = await persistV1Draft()
    await getDb()
      .update(setPrescriptions)
      .set({ targetLoadGrams: TEST_TARGET_LOAD_GRAMS + 1_000 })
      .where(eq(setPrescriptions.id, seeded.currentSetPrescriptionId))

    await expect(activateProgram(ownerId, seeded.revisionId)).rejects.toMatchObject({
      code: 'program.prescription-integrity-failed',
    })
    await expectDraft(seeded.revisionId)
  })

  it('rejects a relational program ordinal omitted from v1 hash material through the activation validator', async () => {
    const { seeded } = await persistV1Draft()
    await getDb()
      .update(plannedWorkouts)
      .set({ programOrdinal: 3 })
      .where(eq(plannedWorkouts.id, seeded.currentWorkoutId))

    await expect(activateProgram(ownerId, seeded.revisionId)).rejects.toMatchObject({
      code: 'program.prescription-invalid',
    })
    await expectDraft(seeded.revisionId)
  })

  it('rejects a v2 snapshot retagged as v1 even when its replacement hash matches', async () => {
    const seeded = await seedCoherentProgram(ownerId, { status: 'draft' })
    const retaggedSnapshot = {
      ...seeded.outputSnapshot,
      hashMaterialVersion: LEGACY_EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
    } satisfies CanonicalValue
    await getDb()
      .update(programRevisions)
      .set({
        outputSnapshot: retaggedSnapshot,
        outputHash: canonicalSha256(retaggedSnapshot),
      })
      .where(eq(programRevisions.id, seeded.revisionId))

    await expect(activateProgram(ownerId, seeded.revisionId)).rejects.toMatchObject({
      code: 'program.prescription-integrity-failed',
    })
    await expectDraft(seeded.revisionId)
  })

  it.each([
    ['JSON null', null],
    ['array', []],
    ['missing version', {}],
    ['unknown version', { hashMaterialVersion: 'executable-prescription-v3' }],
  ] as const)('rejects a %s persisted snapshot with the domain integrity error', async (_case, invalidSnapshot) => {
    const { seeded } = await persistV1Draft()
    await getDb().execute(sql`
        UPDATE ${programRevisions}
        SET output_snapshot = ${JSON.stringify(invalidSnapshot)}::jsonb
        WHERE id = ${seeded.revisionId}
      `)

    await expect(activateProgram(ownerId, seeded.revisionId)).rejects.toEqual(
      expect.objectContaining({
        code: 'program.prescription-integrity-failed',
        name: ProgramUnavailableError.name,
      }),
    )
    await expectDraft(seeded.revisionId)
  })
})

describe('pre-0004 active prescription upgrade', () => {
  it('backfills program ordinals without weakening released-row immutability or v1 integrity', async () => {
    const database = createDisposableIntegrationDatabase({
      administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
      suite: 'pre_0004_program',
    })
    let client: Client | undefined
    await database.create()

    try {
      client = new Client({ connectionString: database.databaseUrl })
      await client.connect()
      const migrations = readMigrationFiles({ migrationsFolder: './drizzle' })
      expect(migrations.length).toBeGreaterThanOrEqual(5)
      await applyMigrationPrefixWithLedger(client, migrations.slice(0, 4))
      await seedPre004ActiveRevision(client)

      database.activateDatabaseUrl()
      resetServerConfigForTests()
      await closeDb()
      await migrateDatabase()

      const overview = await getProgramOverview('pre-0004-owner')
      expect(overview).toMatchObject({
        revisionId: 'pre-0004-revision',
        revisionStatus: 'active',
        outputHash: executablePrescriptionHash(pre004Projection()),
        workouts: [{ ordinal: 1, programOrdinal: 1 }],
      })

      const workout = await client.query<{ ordinal: number; programOrdinal: number }>(
        `SELECT ordinal, program_ordinal AS "programOrdinal"
         FROM planned_workout
         WHERE id = 'pre-0004-workout'`,
      )
      expect(workout.rows).toEqual([{ ordinal: 1, programOrdinal: 1 }])

      const trigger = await client.query<{ enabled: string }>(
        `SELECT trigger.tgenabled AS enabled
         FROM pg_trigger AS trigger
         JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
         WHERE trigger.tgname = 'planned_workout_immutability_guard'
           AND relation.relname = 'planned_workout'
           AND NOT trigger.tgisinternal`,
      )
      expect(trigger.rows).toEqual([{ enabled: 'O' }])
      await expect(
        client.query(
          `UPDATE planned_workout SET name = 'tampered'
           WHERE id = 'pre-0004-workout'`,
        ),
      ).rejects.toMatchObject({ code: '55000' })

      const revision = await client.query<{
        normalizedInputHash: string
        outputHash: string
        normalizedInput: CanonicalValue
        outputSnapshot: CanonicalValue
      }>(
        `SELECT normalized_input_hash AS "normalizedInputHash",
                output_hash AS "outputHash",
                normalized_input AS "normalizedInput",
                output_snapshot AS "outputSnapshot"
         FROM program_revision
         WHERE id = 'pre-0004-revision'`,
      )
      const saved = revision.rows[0]
      if (!saved) throw new Error('Upgraded v1 revision was not preserved.')
      expect(
        verifyExecutablePrescriptionIntegrity({
          normalizedInput: saved.normalizedInput,
          storedNormalizedInputHash: saved.normalizedInputHash,
          storedOutputSnapshot: saved.outputSnapshot,
          storedOutputHash: saved.outputHash,
          persistedProjection: pre004Projection(),
        }),
      ).toEqual({ valid: true })
    } finally {
      await closeDb()
      database.restoreDatabaseUrl()
      resetServerConfigForTests()
      await client?.end()
      await database.cleanup()
    }
  })
})

describe('program-ordinal migration ledger provenance', () => {
  it.each([
    ['origin LF', 'ledger_origin_lf', originalProgramOrdinalMigrationHash],
    ['origin CRLF', 'ledger_origin_crlf', originalCrlfProgramOrdinalMigrationHash],
    ['corrected CRLF', 'ledger_fix_crlf', correctedCrlfProgramOrdinalMigrationHash],
  ] as const)('normalizes the exact %s 0004 hash to corrected LF', async (_case, suite, acceptedHash) => {
    await withPendingLedgerProvenanceMigration(suite, async (client) => {
      const updated = await client.query(
        `UPDATE drizzle.__drizzle_migrations
         SET hash = $1
         WHERE created_at = $2`,
        [acceptedHash, programOrdinalMigrationCreatedAt],
      )
      expect(updated.rowCount).toBe(1)

      await migrateDatabase()

      const ledger = await client.query<{ hash: string }>(
        `SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
        [programOrdinalMigrationCreatedAt],
      )
      expect(ledger.rows).toEqual([{ hash: canonicalProgramOrdinalMigrationHash }])
      await expect(assertDatabaseReady()).resolves.toMatchObject({
        appliedMigrationCount: 14,
        migrationLedgerCanonical: true,
      })

      await client.query(
        `UPDATE drizzle.__drizzle_migrations
         SET hash = $1
         WHERE created_at = $2`,
        ['0'.repeat(64), programOrdinalMigrationCreatedAt],
      )
      await expect(assertDatabaseReady()).rejects.toThrow(
        'program-ordinal migration ledger provenance is not canonical',
      )
    })
  })

  it('accepts the corrected canonical 0004 hash without changing it', async () => {
    await withPendingLedgerProvenanceMigration('ledger_canonical', async (client) => {
      const before = await client.query<{ hash: string }>(
        `SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
        [programOrdinalMigrationCreatedAt],
      )
      expect(before.rows).toEqual([{ hash: canonicalProgramOrdinalMigrationHash }])

      await migrateDatabase()

      const after = await client.query<{ hash: string }>(
        `SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
        [programOrdinalMigrationCreatedAt],
      )
      expect(after.rows).toEqual(before.rows)
      await expect(assertDatabaseReady()).resolves.toMatchObject({
        appliedMigrationCount: 14,
        migrationLedgerCanonical: true,
      })
    })
  })

  it('rejects an unknown 0004 ledger hash without recording provenance completion', async () => {
    await withPendingLedgerProvenanceMigration('ledger_unknown', async (client) => {
      const unknownHash = 'f'.repeat(64)
      await client.query(
        `UPDATE drizzle.__drizzle_migrations
         SET hash = $1
         WHERE created_at = $2`,
        [unknownHash, programOrdinalMigrationCreatedAt],
      )

      await expect(migrateDatabase()).rejects.toMatchObject({
        cause: expect.objectContaining({
          code: '55000',
          message: expect.stringContaining(
            'migration ledger contains an unknown 0004 provenance hash',
          ),
        }),
      })
      const ledger = await client.query<{ hash: string }>(
        `SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
        [programOrdinalMigrationCreatedAt],
      )
      expect(ledger.rows).toEqual([{ hash: unknownHash }])
      const applied = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
      )
      expect(applied.rows).toEqual([{ count: 10 }])
    })
  })

  it('rejects a missing 0004 ledger row', async () => {
    await withPendingLedgerProvenanceMigration('ledger_missing', async (client) => {
      const removed = await client.query(
        `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
        [programOrdinalMigrationCreatedAt],
      )
      expect(removed.rowCount).toBe(1)

      await expect(migrateDatabase()).rejects.toMatchObject({
        cause: expect.objectContaining({
          code: '55000',
          message: expect.stringContaining(
            'migration ledger is missing the canonical 0004 provenance row',
          ),
        }),
      })
    })
  })

  it('rejects duplicate 0004 ledger rows', async () => {
    await withPendingLedgerProvenanceMigration('ledger_duplicate', async (client) => {
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2)`,
        [canonicalProgramOrdinalMigrationHash, programOrdinalMigrationCreatedAt],
      )

      await expect(migrateDatabase()).rejects.toMatchObject({
        cause: expect.objectContaining({
          code: '55000',
          message: expect.stringContaining(
            'migration ledger contains 2 rows for 0004 provenance',
          ),
        }),
      })
    })
  })
})
