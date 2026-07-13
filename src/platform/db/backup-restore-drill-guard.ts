import { isLiteralLoopbackHost } from './postgres-url-guard'

const backupRestoreDatabaseName = /^indigo_backup_restore_[a-f0-9]{24}_integration$/
const containerName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

export type BackupRestoreDrillPgClient =
  | { readonly kind: 'host' }
  | {
      readonly kind: 'container'
      readonly container: string
      readonly host: string
      readonly port: string
    }

/** Prevent ambient libpq variables from overriding the drill's guarded endpoint. */
export function omitAmbientPostgresEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith('PG')),
  )
}

/**
 * Defense in depth for the drill's one destructive step. The disposable-database
 * harness generates this shape; the drill rechecks it immediately before wiping.
 */
export function assertBackupRestoreDrillDatabaseName(database: string): void {
  if (!backupRestoreDatabaseName.test(database)) {
    throw new Error(
      'Backup/restore drill database must match indigo_backup_restore_<24 lowercase hex characters>_integration.',
    )
  }
}

/**
 * Resolves the optional PostgreSQL client-container adapter. Container mode remains an
 * operator-selected development convenience and can reach only PostgreSQL on that
 * container's own loopback interface.
 */
export function resolveBackupRestoreDrillPgClient(input: {
  readonly container: string | undefined
  readonly host: string | undefined
  readonly port: string | undefined
}): BackupRestoreDrillPgClient {
  if (!input.container) {
    if (input.host || input.port) {
      throw new Error(
        'Backup/restore drill container host or port requires INDIGO_BACKUP_DRILL_PG_CONTAINER.',
      )
    }
    return { kind: 'host' }
  }

  if (!containerName.test(input.container)) {
    throw new Error(
      'INDIGO_BACKUP_DRILL_PG_CONTAINER must be a plain Docker container name or ID.',
    )
  }

  const host = input.host ?? '127.0.0.1'
  if (!isLiteralLoopbackHost(host)) {
    throw new Error(
      'INDIGO_BACKUP_DRILL_CONTAINER_HOST must be the literal loopback host 127.0.0.1 or [::1].',
    )
  }

  const port = input.port ?? '5432'
  if (!/^\d{1,5}$/.test(port)) {
    throw new Error('INDIGO_BACKUP_DRILL_CONTAINER_PORT must be a decimal TCP port.')
  }
  const numericPort = Number(port)
  if (numericPort < 1 || numericPort > 65_535) {
    throw new Error('INDIGO_BACKUP_DRILL_CONTAINER_PORT must be between 1 and 65535.')
  }

  return { kind: 'container', container: input.container, host, port }
}
