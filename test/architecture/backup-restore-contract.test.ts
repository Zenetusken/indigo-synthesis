import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  readonly scripts?: Record<string, string>
}
const runbook = readFileSync('docs/operations/BACKUP_RESTORE.md', 'utf8')
const drill = readFileSync('scripts/db/backup-restore-drill.ts', 'utf8')

const sharedLockAcquisition = `(
if ! command -v flock >/dev/null 2>&1; then
  echo "ERROR: flock is required to serialize Indigo host database commands" >&2
  exit 2
fi
source scripts/lib/host-lock.sh
LOCK_PATH="$(indigo_host_lock_dir)/database-external-host.lock"
exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  echo "ERROR: another Indigo host database command is active ($LOCK_PATH)" >&2
  exit 75
fi`

function section(start: string, end: string): string {
  const startIndex = runbook.indexOf(start)
  const endIndex = runbook.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return runbook.slice(startIndex, endIndex)
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

function expectBoundedSharedLock(
  procedure: string,
  firstDatabaseOperation: string,
  finalLockedOperation: string,
  releaseMarker: string,
): void {
  expect(occurrences(procedure, sharedLockAcquisition)).toBe(1)
  expect(occurrences(procedure, 'source scripts/lib/host-lock.sh')).toBe(1)
  expect(
    occurrences(
      procedure,
      'LOCK_PATH="$(indigo_host_lock_dir)/database-external-host.lock"',
    ),
  ).toBe(1)
  expect(occurrences(procedure, 'exec 9>"$LOCK_PATH"')).toBe(1)
  expect(occurrences(procedure, 'if ! flock -n 9; then')).toBe(1)
  expect(occurrences(procedure, 'exit 75')).toBe(1)
  expect(occurrences(procedure, releaseMarker)).toBe(1)

  const lockStart = procedure.indexOf(sharedLockAcquisition)
  const databaseStart = procedure.indexOf(firstDatabaseOperation)
  const lockedWorkEnd = procedure.indexOf(finalLockedOperation, databaseStart)
  const release = procedure.indexOf(`)\n${releaseMarker}`)
  expect(lockStart).toBeGreaterThanOrEqual(0)
  expect(lockStart).toBeLessThan(databaseStart)
  expect(databaseStart).toBeLessThanOrEqual(lockedWorkEnd)
  expect(lockedWorkEnd).toBeLessThan(release)
}

describe('backup/restore operator contract', () => {
  it('exposes the guarded drill through the package command surface', () => {
    expect(packageJson.scripts?.['db:backup-restore-drill']).toContain(
      'scripts/db/backup-restore-drill.ts',
    )
    expect(packageJson.scripts?.['db:backup-restore-drill']).toContain(
      '--env-file-if-exists=.env.local',
    )
  })

  it('keeps destructive drill work on a generated disposable database', () => {
    expect(drill).toContain('createDisposableIntegrationDatabase')
    expect(drill).toContain("suite: 'backup_restore'")
    expect(drill).toContain('assertBackupRestoreDrillDatabaseName(database.databaseName)')
    expect(drill).toContain('DROP SCHEMA IF EXISTS drizzle CASCADE')
    expect(drill).not.toContain('administrationUrl: process.env.DATABASE_URL')
  })

  it('serializes every production database procedure on the exact shared host lock', () => {
    const backupSection = section('## Create a backup', '## Restore without overwriting')
    const restoreSection = section(
      '## Restore without overwriting',
      '## Reconcile the recovery point',
    )
    const invalidationSection = section(
      '## Invalidate restored authority',
      '## Guarded repository drill',
    )

    expectBoundedSharedLock(
      backupSection,
      'SOURCE_IDENTITY=',
      'pg_dump \\\n',
      '# The bounded backup lock scope has exited; file descriptor 9 is closed here.',
    )
    expectBoundedSharedLock(
      restoreSection,
      'createdb \\\n',
      '--single-transaction \\\n',
      '# The bounded restore lock scope has exited; file descriptor 9 is closed here.',
    )
    expectBoundedSharedLock(
      invalidationSection,
      'CUTOVER_IDENTITY=',
      '$secure_restore$;\nSQL',
      '# The authority-invalidation lock scope has exited; file descriptor 9 is closed here.',
    )

    expect(occurrences(runbook, sharedLockAcquisition)).toBe(3)
    expect(runbook).toMatch(/same POSIX user that runs Indigo's packaged host commands/)
    expect(runbook).toMatch(
      /Do not run a second manual or automated Indigo host database\s+job in parallel\./,
    )
    expect(runbook).toMatch(
      /A different UID has a different lock namespace and therefore is not a\s+safe way to run concurrent work\./,
    )

    const restoreRelease = restoreSection.indexOf(
      '# The bounded restore lock scope has exited; file descriptor 9 is closed here.',
    )
    const wrappedPreflight = restoreSection.indexOf('\npnpm db:preflight\n')
    expect(restoreRelease).toBeGreaterThanOrEqual(0)
    expect(wrappedPreflight).toBeGreaterThan(restoreRelease)

    const invalidationRelease = invalidationSection.indexOf(
      '# The authority-invalidation lock scope has exited; file descriptor 9 is closed here.',
    )
    const wrappedRecoveryIssue = invalidationSection.indexOf(
      '\npnpm owner:recover issue \\\n',
    )
    const wrappedRecoveryRedeem = invalidationSection.indexOf(
      '\npnpm owner:recover redeem \\\n',
    )
    expect(invalidationRelease).toBeGreaterThanOrEqual(0)
    expect(wrappedRecoveryIssue).toBeGreaterThan(invalidationRelease)
    expect(wrappedRecoveryRedeem).toBeGreaterThan(wrappedRecoveryIssue)
  })

  it('documents backup sensitivity, secure restore cutover, preflight, and media scope', () => {
    const backupSection = section('## Create a backup', '## Restore without overwriting')
    const restoreSection = section(
      '## Restore without overwriting',
      '## Reconcile the recovery point',
    )
    const invalidationSection = section(
      '## Invalidate restored authority',
      '## Guarded repository drill',
    )

    expect(runbook).toMatch(
      /Do not drop, truncate, or restore over\s+the only live copy\./,
    )
    expect(runbook).toContain('pnpm db:preflight')
    expect(runbook).toContain('pg_dump')
    expect(runbook).toContain('pg_restore')
    expect(runbook).toMatch(/Local media is\s+not implemented\./)
    expect(runbook).toMatch(/Never place plaintext\s+secrets in a command argument/)
    expect(runbook).toContain('set -euo pipefail')
    expect(runbook).toContain('sha256sum --check')
    for (const databaseSection of [backupSection, restoreSection, invalidationSection]) {
      expect(databaseSection).toContain(
        'unset PGPASSWORD PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS',
      )
      expect(databaseSection).toContain('current_user')
      expect(databaseSection).toContain('inet_server_addr()')
      expect(databaseSection).toContain('inet_server_port()')
      expect(databaseSection).toContain('EXPECTED_PG_SERVER_ADDRESS')
    }
    expect(backupSection.indexOf('SOURCE_IDENTITY=')).toBeLessThan(
      backupSection.indexOf('pg_dump \\\n'),
    )
    expect(restoreSection.indexOf('RESTORE_IDENTITY=')).toBeLessThan(
      restoreSection.indexOf('pg_restore \\\n'),
    )
    expect(invalidationSection.indexOf('CUTOVER_IDENTITY=')).toBeLessThan(
      invalidationSection.indexOf('DELETE FROM public.session;'),
    )
    const authorityTransactionStart = invalidationSection.indexOf('BEGIN;')
    const firstAuthorityInvalidation = invalidationSection.indexOf(
      'DELETE FROM public.destructive_reauthentication_state;',
    )
    const epochRotation = invalidationSection.indexOf(
      'SET product_mutation_epoch = gen_random_uuid()',
    )
    const authorityTransactionCommit = invalidationSection.indexOf('COMMIT;')
    const postCommitAssertion = invalidationSection.indexOf('DO $secure_restore$')
    expect(authorityTransactionStart).toBeGreaterThanOrEqual(0)
    expect(authorityTransactionStart).toBeLessThan(firstAuthorityInvalidation)
    expect(firstAuthorityInvalidation).toBeLessThan(epochRotation)
    expect(epochRotation).toBeLessThan(authorityTransactionCommit)
    expect(authorityTransactionCommit).toBeLessThan(postCommitAssertion)
    expect(invalidationSection).toContain(
      'SET product_mutation_epoch = gen_random_uuid()',
    )
    expect(invalidationSection).toContain(
      'secure restore installation epoch did not rotate exactly once',
    )
    expect(runbook).toContain('test "$RESTORE_RELATIONS" = 0')
    expect(runbook.indexOf('createdb')).toBeLessThan(runbook.indexOf('pg_restore \\\n'))
    expect(runbook).toContain('psql --no-psqlrc')
    expect(runbook).toContain('SET LOCAL search_path = pg_catalog, public;')
    expect(runbook).toContain('DELETE FROM public.session;')
    expect(runbook).toContain('DELETE FROM public.verification;')
    expect(runbook).toContain('DELETE FROM public.member_reset_state;')
    expect(runbook).toContain('DELETE FROM public.web_recovery_rate_limit_bucket;')
    expect(runbook).toContain('DELETE FROM public.deletion_plan;')
    expect(runbook).toMatch(/UPDATE public\.account\s+SET password = NULL/)
    expect(runbook).toContain('secure restore authority invalidation did not reach zero')
    expect(runbook).toContain('mktemp')
    expect(runbook).toMatch(/reconcile every externally recorded change/)
    expect(runbook).toMatch(
      /If there is no trustworthy incident,\s+privacy, and safety change record/,
    )
    expect(runbook).toMatch(/Secret rotation is mandatory for the secure-default cutover/)
    expect(runbook).toMatch(
      /simple rollback.*permitted only \*\*before the restored\s+deployment is exposed.*before it accepts any non-prescribed post-restore\s+mutation/s,
    )
    expect(runbook).toMatch(
      /cut over explicitly: stop the\s+application, select the restored `DATABASE_URL` and the restored deployment's newly generated\s+`BETTER_AUTH_SECRET` together, and start the application on loopback/,
    )
    expect(runbook).toMatch(
      /returning to the original database is a new\s+recovery cutover/i,
    )
    expect(runbook).toMatch(
      /Reusing the original secret or its\s+pre-cutover epoch after exposure/,
    )
    expect(runbook).toContain('openssl rand -base64 48')
  })

  it('proves the exact opaque installation epoch survives the guarded drill', () => {
    expect(runbook).toMatch(/test-only, disposable integration proof/)
    expect(runbook).toMatch(/not a production\s+backup command/)
    expect(runbook).toMatch(/not prove an\s+operator's encryption/)
    expect(drill).toContain('expectedEpoch = await seedProof')
    expect(drill).toContain('product_mutation_epoch AS "productMutationEpoch"')
    expect(drill).toContain(
      'Restored installation mutation epoch does not match the backup.',
    )
    const outputStart = drill.indexOf('process.stdout.write(')
    const cleanupStart = drill.indexOf('\n} finally {', outputStart)
    expect(outputStart).toBeGreaterThanOrEqual(0)
    expect(cleanupStart).toBeGreaterThan(outputStart)
    expect(drill.match(/process\.stdout\.write\(/g)).toHaveLength(1)
    expect(drill).not.toContain('process.stderr.write(')
    expect(drill).not.toMatch(/console\.(?:debug|error|info|log|warn)\s*\(/)
    expect(drill.slice(outputStart, cleanupStart)).not.toContain('expectedEpoch')
  })
})
