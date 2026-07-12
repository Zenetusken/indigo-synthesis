const postgresProtocols = new Set(['postgres:', 'postgresql:'])
const literalLoopbackHosts = new Set(['127.0.0.1', '[::1]'])

export type GuardedPostgresUrl = {
  readonly connectionString: string
  readonly database: string
  readonly effectivePort: string
  readonly hostname: string
  readonly username: string
}

function decodeUrlComponent(value: string, label: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error(`${label} contains invalid URL encoding.`)
  }
}

/**
 * Parses the structural PostgreSQL URL properties shared by destructive local test
 * harnesses. Callers remain responsible for applying their target-specific hostname,
 * database-name, and endpoint-equivalence policies.
 */
export function parseGuardedPostgresUrl(
  label: string,
  value: string | undefined,
): GuardedPostgresUrl {
  if (!value) throw new Error(`${label} is required.`)

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL.`)
  }

  if (!postgresProtocols.has(parsed.protocol)) {
    throw new Error(`${label} must use the postgres: or postgresql: scheme.`)
  }
  if (!parsed.hostname) throw new Error(`${label} must include a hostname.`)
  if (parsed.search) {
    throw new Error(`${label} must not use query parameters.`)
  }
  if (parsed.hash) throw new Error(`${label} must not use a URL fragment.`)

  const encodedDatabase = parsed.pathname.slice(1)
  const database = decodeUrlComponent(encodedDatabase, `${label} database name`)
  if (!encodedDatabase || database.includes('/') || database.includes('\0')) {
    throw new Error(`${label} must name exactly one PostgreSQL database.`)
  }

  const username = decodeUrlComponent(parsed.username, `${label} username`)
  if (username.includes('\0')) throw new Error(`${label} username must not contain NUL.`)

  return {
    connectionString: parsed.toString(),
    database,
    effectivePort: parsed.port || '5432',
    hostname: parsed.hostname,
    username,
  }
}

export function isLiteralLoopbackHost(hostname: string): boolean {
  return literalLoopbackHosts.has(hostname)
}
