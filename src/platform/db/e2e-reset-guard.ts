import { isLiteralLoopbackHost, parseGuardedPostgresUrl } from './postgres-url-guard'

const e2eDatabaseName = /^indigo_[a-z0-9]+(?:_[a-z0-9]+)*_e2e$/

function isE2eLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || isLiteralLoopbackHost(hostname)
}

/**
 * Validates every destructive assumption made by the local Playwright reset harness.
 * This function is intentionally pure so the caller can run it before opening a
 * connection or issuing any database command.
 */
export function validateLocalE2eResetTarget(
  administrationUrl: string | undefined,
  targetUrl: string | undefined,
): string {
  const administration = parseGuardedPostgresUrl('DATABASE_URL', administrationUrl)
  const target = parseGuardedPostgresUrl('E2E_DATABASE_URL', targetUrl)

  if (!e2eDatabaseName.test(target.database)) {
    throw new Error(
      'E2E_DATABASE_URL database must match indigo_<name>_e2e using lowercase letters, digits, and underscores.',
    )
  }
  if (target.database === administration.database) {
    throw new Error('E2E_DATABASE_URL database must differ from DATABASE_URL database.')
  }
  if (
    !isE2eLoopbackHost(administration.hostname) ||
    !isE2eLoopbackHost(target.hostname)
  ) {
    throw new Error('E2E reset URLs must use an explicit loopback host.')
  }
  if (target.hostname !== administration.hostname) {
    throw new Error('E2E reset URLs must use exactly the same host.')
  }
  if (target.effectivePort !== administration.effectivePort) {
    throw new Error('E2E reset URLs must use the same effective PostgreSQL port.')
  }
  if (!administration.username || !target.username) {
    throw new Error('E2E reset URLs must include an explicit PostgreSQL username.')
  }
  if (target.username !== administration.username) {
    throw new Error('E2E reset URLs must use exactly the same PostgreSQL username.')
  }

  return target.database
}
