import { describe, expect, it } from 'vitest'
import {
  assertBackupRestoreDrillDatabaseName,
  omitAmbientPostgresEnvironment,
  resolveBackupRestoreDrillPgClient,
} from './backup-restore-drill-guard'

describe('backup/restore drill target guard', () => {
  it('accepts only the exact disposable harness database shape', () => {
    expect(() =>
      assertBackupRestoreDrillDatabaseName(
        'indigo_backup_restore_0123456789abcdef01234567_integration',
      ),
    ).not.toThrow()
  })

  it.each([
    'indigo_synthesis',
    'indigo_backup_restore_integration',
    'indigo_backup_restore_0123456789abcdef0123456_integration',
    'indigo_backup_restore_0123456789abcdef012345678_integration',
    'indigo_backup_restore_0123456789ABCDEF01234567_integration',
    'indigo_backup_restore_0123456789abcdef01234567_integration_extra',
  ])('rejects the unsafe target %s', (database) => {
    expect(() => assertBackupRestoreDrillDatabaseName(database)).toThrow(
      'must match indigo_backup_restore_',
    )
  })
})

describe('backup/restore drill PostgreSQL client adapter', () => {
  it('removes ambient libpq endpoint and credential overrides', () => {
    expect(
      omitAmbientPostgresEnvironment({
        HOME: '/home/operator',
        PATH: '/usr/bin',
        PGHOSTADDR: '203.0.113.20',
        PGPASSWORD: 'ambient-secret',
        PGSERVICE: 'valuable-production-database',
      }),
    ).toEqual({ HOME: '/home/operator', PATH: '/usr/bin' })
  })

  it('uses host PostgreSQL tools by default', () => {
    expect(
      resolveBackupRestoreDrillPgClient({
        container: undefined,
        host: undefined,
        port: undefined,
      }),
    ).toEqual({ kind: 'host' })
  })

  it('defaults an explicit container to its own loopback PostgreSQL endpoint', () => {
    expect(
      resolveBackupRestoreDrillPgClient({
        container: 'indigo-synthesis-postgres',
        host: undefined,
        port: undefined,
      }),
    ).toEqual({
      kind: 'container',
      container: 'indigo-synthesis-postgres',
      host: '127.0.0.1',
      port: '5432',
    })
  })

  it('accepts literal IPv6 loopback and an explicit valid port', () => {
    expect(
      resolveBackupRestoreDrillPgClient({
        container: '0f95bea81eb5',
        host: '[::1]',
        port: '55432',
      }),
    ).toMatchObject({ kind: 'container', host: '[::1]', port: '55432' })
  })

  it.each([
    [{ container: undefined, host: '127.0.0.1', port: undefined }, 'requires'],
    [{ container: 'unsafe name', host: undefined, port: undefined }, 'plain Docker'],
    [
      { container: 'postgres', host: 'database.internal', port: undefined },
      'literal loopback',
    ],
    [{ container: 'postgres', host: undefined, port: 'not-a-port' }, 'decimal TCP'],
    [{ container: 'postgres', host: undefined, port: '0' }, 'between 1 and 65535'],
    [{ container: 'postgres', host: undefined, port: '65536' }, 'between 1 and 65535'],
  ])('rejects an unsafe container adapter %#', (input, message) => {
    expect(() => resolveBackupRestoreDrillPgClient(input)).toThrow(message)
  })
})
