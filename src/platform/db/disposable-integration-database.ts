import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { isLiteralLoopbackHost, parseGuardedPostgresUrl } from './postgres-url-guard'

const integrationNonceBytes = 12
const integrationNonceHexLength = integrationNonceBytes * 2
const postgresIdentifierByteLimit = 63
const suiteNamePattern = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

export type ValidatedIntegrationDatabaseTarget = {
  readonly administrationUrl: string
  readonly databaseName: string
  readonly databaseUrl: string
}

type AdministrationClient = {
  connect(): Promise<void>
  query(text: string, values?: readonly unknown[]): Promise<unknown>
  end(): Promise<void>
}

type HarnessDependencies = {
  readonly createClient?: (connectionString: string) => AdministrationClient
  readonly randomBytes?: (size: number) => Uint8Array
}

function validateSuiteName(suite: string): void {
  if (!suiteNamePattern.test(suite)) {
    throw new Error(
      'Integration suite name must use lowercase letters, digits, and single underscores.',
    )
  }
}

function expectedDatabaseNamePattern(suite: string): RegExp {
  validateSuiteName(suite)
  return new RegExp(
    `^indigo_${suite}_[a-f0-9]{${integrationNonceHexLength}}_integration$`,
  )
}

function createDatabaseName(
  suite: string,
  randomSource: (size: number) => Uint8Array,
): string {
  validateSuiteName(suite)
  const nonce = randomSource(integrationNonceBytes)
  if (nonce.byteLength !== integrationNonceBytes) {
    throw new Error(
      `Integration database entropy source must return ${integrationNonceBytes} bytes.`,
    )
  }
  return `indigo_${suite}_${Buffer.from(nonce).toString('hex')}_integration`
}

/** Pure validation that runs before an administration client is constructed. */
export function validateIntegrationDatabaseTarget(
  administrationUrl: string | undefined,
  suite: string,
  databaseName: string,
): ValidatedIntegrationDatabaseTarget {
  const administration = parseGuardedPostgresUrl(
    'INTEGRATION_ADMIN_DATABASE_URL',
    administrationUrl,
  )

  if (!isLiteralLoopbackHost(administration.hostname)) {
    throw new Error(
      'INTEGRATION_ADMIN_DATABASE_URL must use the literal loopback host 127.0.0.1 or [::1].',
    )
  }
  if (!administration.username) {
    throw new Error(
      'INTEGRATION_ADMIN_DATABASE_URL must include an explicit PostgreSQL username.',
    )
  }
  if (!expectedDatabaseNamePattern(suite).test(databaseName)) {
    throw new Error(
      `Integration database must match indigo_${suite}_<${integrationNonceHexLength} lowercase hex characters>_integration.`,
    )
  }
  if (Buffer.byteLength(databaseName, 'utf8') > postgresIdentifierByteLimit) {
    throw new Error(
      `Integration database name exceeds PostgreSQL's ${postgresIdentifierByteLimit}-byte identifier limit.`,
    )
  }
  if (administration.database === databaseName) {
    throw new Error(
      'Integration database must differ from the administrative connection database.',
    )
  }

  const target = new URL(administration.connectionString)
  target.pathname = `/${databaseName}`

  return {
    administrationUrl: administration.connectionString,
    databaseName,
    databaseUrl: target.toString(),
  }
}

function defaultClientFactory(connectionString: string): AdministrationClient {
  const client = new Client({ connectionString })
  return {
    connect: async () => {
      await client.connect()
    },
    query: (text, values) => client.query(text, values ? [...values] : undefined),
    end: () => client.end(),
  }
}

function quotedDatabaseIdentifier(databaseName: string): string {
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new Error('Refusing to quote an unvalidated integration database identifier.')
  }
  return `"${databaseName}"`
}

export type DisposableIntegrationDatabase = {
  readonly databaseName: string
  readonly databaseUrl: string
  create(): Promise<void>
  activateDatabaseUrl(): void
  restoreDatabaseUrl(): void
  cleanup(): Promise<void>
}

class DisposableIntegrationDatabaseHarness implements DisposableIntegrationDatabase {
  readonly databaseName: string
  readonly databaseUrl: string

  private readonly administrationClient: AdministrationClient
  private clientStarted = false
  private closed = false
  private created = false
  private databaseUrlActive = false
  private originalDatabaseUrl: string | undefined

  constructor(
    target: ValidatedIntegrationDatabaseTarget,
    createClient: HarnessDependencies['createClient'],
  ) {
    this.databaseName = target.databaseName
    this.databaseUrl = target.databaseUrl
    this.administrationClient = (createClient ?? defaultClientFactory)(
      target.administrationUrl,
    )
  }

  async create(): Promise<void> {
    if (this.clientStarted) {
      throw new Error('Integration database creation was already attempted.')
    }

    this.clientStarted = true
    await this.administrationClient.connect()
    await this.administrationClient.query(
      `CREATE DATABASE ${quotedDatabaseIdentifier(this.databaseName)}`,
    )
    this.created = true
  }

  activateDatabaseUrl(): void {
    if (!this.created || this.closed) {
      throw new Error('Integration database must be created before it can be activated.')
    }
    if (this.databaseUrlActive) {
      throw new Error('Integration database URL is already active.')
    }

    this.originalDatabaseUrl = process.env.DATABASE_URL
    Reflect.set(process.env, 'DATABASE_URL', this.databaseUrl)
    this.databaseUrlActive = true
  }

  restoreDatabaseUrl(): void {
    if (!this.databaseUrlActive) return

    if (this.originalDatabaseUrl === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_URL')
    } else {
      Reflect.set(process.env, 'DATABASE_URL', this.originalDatabaseUrl)
    }
    this.databaseUrlActive = false
  }

  async cleanup(): Promise<void> {
    this.restoreDatabaseUrl()
    if (!this.clientStarted || this.closed) return

    try {
      if (this.created) {
        await this.administrationClient.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [this.databaseName],
        )
        await this.administrationClient.query(
          `DROP DATABASE ${quotedDatabaseIdentifier(this.databaseName)}`,
        )
        this.created = false
      }
    } finally {
      this.closed = true
      await this.administrationClient.end()
    }
  }
}

export function createDisposableIntegrationDatabase(
  options: {
    readonly administrationUrl: string | undefined
    readonly suite: string
  },
  dependencies: HarnessDependencies = {},
): DisposableIntegrationDatabase {
  const databaseName = createDatabaseName(
    options.suite,
    dependencies.randomBytes ?? randomBytes,
  )
  const target = validateIntegrationDatabaseTarget(
    options.administrationUrl,
    options.suite,
    databaseName,
  )
  return new DisposableIntegrationDatabaseHarness(target, dependencies.createClient)
}
