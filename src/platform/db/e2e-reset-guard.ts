const postgresProtocols = new Set(['postgres:', 'postgresql:'])
const localHarnessHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
const e2eDatabaseName = /^indigo_[a-z0-9]+(?:_[a-z0-9]+)*_e2e$/

function parsePostgresUrl(label: string, value: string | undefined): URL {
  if (!value) {
    throw new Error(`${label} is required for the local E2E database reset.`)
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL.`)
  }

  if (!postgresProtocols.has(parsed.protocol)) {
    throw new Error(`${label} must use the postgres: or postgresql: scheme.`)
  }
  if (!parsed.hostname) {
    throw new Error(`${label} must include a hostname.`)
  }
  if (parsed.search) {
    throw new Error(
      `${label} must not use query parameters in the destructive local reset harness.`,
    )
  }

  return parsed
}

function decodeUrlComponent(value: string, label: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error(`${label} contains invalid URL encoding.`)
  }
}

function databaseFrom(url: URL, label: string): string {
  const encodedName = url.pathname.slice(1)
  const name = decodeUrlComponent(encodedName, `${label} database name`)

  if (!encodedName || name.includes('/') || name.includes('\0')) {
    throw new Error(`${label} must name exactly one PostgreSQL database.`)
  }

  return name
}

function usernameFrom(url: URL, label: string): string {
  return decodeUrlComponent(url.username, `${label} username`)
}

function effectivePostgresPort(url: URL): string {
  return url.port || '5432'
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
  const administration = parsePostgresUrl('DATABASE_URL', administrationUrl)
  const target = parsePostgresUrl('E2E_DATABASE_URL', targetUrl)
  const administrationDatabase = databaseFrom(administration, 'DATABASE_URL')
  const targetDatabase = databaseFrom(target, 'E2E_DATABASE_URL')
  const administrationUsername = usernameFrom(administration, 'DATABASE_URL')
  const targetUsername = usernameFrom(target, 'E2E_DATABASE_URL')

  if (!e2eDatabaseName.test(targetDatabase)) {
    throw new Error(
      'E2E_DATABASE_URL database must match indigo_<name>_e2e using lowercase letters, digits, and underscores.',
    )
  }
  if (targetDatabase === administrationDatabase) {
    throw new Error('E2E_DATABASE_URL database must differ from DATABASE_URL database.')
  }
  if (
    !localHarnessHosts.has(administration.hostname) ||
    !localHarnessHosts.has(target.hostname)
  ) {
    throw new Error('E2E reset URLs must use an explicit loopback host.')
  }
  if (target.hostname !== administration.hostname) {
    throw new Error('E2E reset URLs must use exactly the same host.')
  }
  if (effectivePostgresPort(target) !== effectivePostgresPort(administration)) {
    throw new Error('E2E reset URLs must use the same effective PostgreSQL port.')
  }
  if (!administrationUsername || !targetUsername) {
    throw new Error('E2E reset URLs must include an explicit PostgreSQL username.')
  }
  if (targetUsername !== administrationUsername) {
    throw new Error('E2E reset URLs must use exactly the same PostgreSQL username.')
  }

  return targetDatabase
}
