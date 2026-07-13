import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  readonly scripts?: Record<string, string>
}
const runbook = readFileSync('docs/operations/BACKUP_RESTORE.md', 'utf8')
const drill = readFileSync('scripts/db/backup-restore-drill.ts', 'utf8')

function section(start: string, end: string): string {
  const startIndex = runbook.indexOf(start)
  const endIndex = runbook.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return runbook.slice(startIndex, endIndex)
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
    expect(runbook).toContain('openssl rand -base64 48')
  })
})
