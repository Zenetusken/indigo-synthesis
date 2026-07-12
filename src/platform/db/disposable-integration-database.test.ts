import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDisposableIntegrationDatabase,
  validateIntegrationDatabaseTarget,
} from './disposable-integration-database'

const nonce = 'ab'.repeat(12)
const databaseName = `indigo_identity_${nonce}_integration`
const administrationUrl = 'postgresql://indigo:admin-secret@127.0.0.1:5432/postgres'

type ClientEvent =
  | { readonly kind: 'connect' }
  | { readonly kind: 'end' }
  | {
      readonly kind: 'query'
      readonly text: string
      readonly values?: readonly unknown[]
    }

function simulatedClient(
  options: { readonly connectError?: Error; readonly createError?: Error } = {},
) {
  const events: ClientEvent[] = []
  return {
    events,
    client: {
      async connect() {
        events.push({ kind: 'connect' })
        if (options.connectError) throw options.connectError
      },
      async query(text: string, values?: readonly unknown[]) {
        events.push({ kind: 'query', text, values })
        if (text.startsWith('CREATE DATABASE') && options.createError) {
          throw options.createError
        }
      },
      async end() {
        events.push({ kind: 'end' })
      },
    },
  }
}

function deterministicEntropy(size: number): Uint8Array {
  return new Uint8Array(size).fill(0xab)
}

describe('integration database target guard', () => {
  it('derives a validated disposable target from a separate administration URL', () => {
    expect(
      validateIntegrationDatabaseTarget(administrationUrl, 'identity', databaseName),
    ).toEqual({
      administrationUrl,
      databaseName,
      databaseUrl: `postgresql://indigo:admin-secret@127.0.0.1:5432/${databaseName}`,
    })
  })

  it.each([
    [undefined, 'INTEGRATION_ADMIN_DATABASE_URL is required'],
    ['not a URL', 'must be a valid PostgreSQL URL'],
    ['https://indigo:secret@127.0.0.1/postgres', 'must use the postgres:'],
    [
      'postgresql://indigo:secret@127.0.0.1/postgres?host=database.internal',
      'must not use query parameters',
    ],
    [
      'postgresql://indigo:secret@127.0.0.1/postgres#override',
      'must not use a URL fragment',
    ],
    [
      'postgresql://indigo:secret@localhost/postgres',
      'must use the literal loopback host',
    ],
    [
      'postgresql://indigo:secret@database.internal/postgres',
      'must use the literal loopback host',
    ],
    ['postgresql://127.0.0.1/postgres', 'must include an explicit PostgreSQL username'],
  ])('rejects an unsafe administration URL %#', (url, message) => {
    expect(() =>
      validateIntegrationDatabaseTarget(url, 'identity', databaseName),
    ).toThrow(message)
  })

  it('accepts a literal IPv6 loopback administration URL', () => {
    const target = validateIntegrationDatabaseTarget(
      'postgres://indigo:secret@[::1]/postgres',
      'identity',
      databaseName,
    )

    expect(new URL(target.databaseUrl).hostname).toBe('[::1]')
    expect(new URL(target.databaseUrl).pathname).toBe(`/${databaseName}`)
  })

  it.each([
    ['Identity', databaseName, 'suite name must use lowercase'],
    ['identity/unsafe', databaseName, 'suite name must use lowercase'],
    ['identity', 'indigo_identity_short_integration', 'must match'],
    ['identity', `indigo_training_${nonce}_integration`, 'must match indigo_identity'],
    [
      'identity',
      `indigo_identity_${'AB'.repeat(12)}_integration`,
      'lowercase hex characters',
    ],
  ])('rejects an invalid suite or target name %#', (suite, target, message) => {
    expect(() =>
      validateIntegrationDatabaseTarget(administrationUrl, suite, target),
    ).toThrow(message)
  })

  it('rejects a generated name that PostgreSQL would truncate', () => {
    const longSuite = 'a'.repeat(30)
    const target = `indigo_${longSuite}_${nonce}_integration`

    expect(() =>
      validateIntegrationDatabaseTarget(administrationUrl, longSuite, target),
    ).toThrow('63-byte identifier limit')
  })

  it('rejects the administration database itself as the disposable target', () => {
    expect(() =>
      validateIntegrationDatabaseTarget(
        `postgresql://indigo:secret@127.0.0.1/${databaseName}`,
        'identity',
        databaseName,
      ),
    ).toThrow('must differ from the administrative connection database')
  })
})

describe('disposable integration database lifecycle', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses cryptographic-shape entropy in the validated database name', () => {
    const simulation = simulatedClient()
    const harness = createDisposableIntegrationDatabase(
      { administrationUrl, suite: 'identity' },
      {
        createClient: () => simulation.client,
        randomBytes: deterministicEntropy,
      },
    )

    expect(harness.databaseName).toBe(databaseName)
  })

  it('validates the required administration URL before constructing a client', () => {
    vi.stubEnv('DATABASE_URL', administrationUrl)
    const createClient = vi.fn(() => simulatedClient().client)

    expect(() =>
      createDisposableIntegrationDatabase(
        { administrationUrl: undefined, suite: 'identity' },
        { createClient, randomBytes: deterministicEntropy },
      ),
    ).toThrow('INTEGRATION_ADMIN_DATABASE_URL is required')
    expect(createClient).not.toHaveBeenCalled()
  })

  it('never terminates or drops after a CREATE name collision', async () => {
    const collision = Object.assign(new Error('database already exists'), {
      code: '42P04',
    })
    const simulation = simulatedClient({ createError: collision })
    const harness = createDisposableIntegrationDatabase(
      { administrationUrl, suite: 'identity' },
      {
        createClient: () => simulation.client,
        randomBytes: deterministicEntropy,
      },
    )

    await expect(harness.create()).rejects.toBe(collision)
    await harness.cleanup()

    expect(simulation.events).toEqual([
      { kind: 'connect' },
      { kind: 'query', text: `CREATE DATABASE "${databaseName}"`, values: undefined },
      { kind: 'end' },
    ])
  })

  it('never runs destructive cleanup after a connection failure', async () => {
    const failure = new Error('connection refused')
    const simulation = simulatedClient({ connectError: failure })
    const harness = createDisposableIntegrationDatabase(
      { administrationUrl, suite: 'identity' },
      {
        createClient: () => simulation.client,
        randomBytes: deterministicEntropy,
      },
    )

    await expect(harness.create()).rejects.toBe(failure)
    await harness.cleanup()

    expect(simulation.events).toEqual([{ kind: 'connect' }, { kind: 'end' }])
  })

  it('terminates and drops only after CREATE succeeds, then closes once', async () => {
    const simulation = simulatedClient()
    const harness = createDisposableIntegrationDatabase(
      { administrationUrl, suite: 'identity' },
      {
        createClient: () => simulation.client,
        randomBytes: deterministicEntropy,
      },
    )

    await harness.create()
    await harness.cleanup()
    await harness.cleanup()

    expect(simulation.events).toEqual([
      { kind: 'connect' },
      { kind: 'query', text: `CREATE DATABASE "${databaseName}"`, values: undefined },
      {
        kind: 'query',
        text: expect.stringContaining('SELECT pg_terminate_backend(pid)'),
        values: [databaseName],
      },
      { kind: 'query', text: `DROP DATABASE "${databaseName}"`, values: undefined },
      { kind: 'end' },
    ])
  })

  it('restores the prior application DATABASE_URL during cleanup', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://application/original')
    const simulation = simulatedClient()
    const harness = createDisposableIntegrationDatabase(
      { administrationUrl, suite: 'identity' },
      {
        createClient: () => simulation.client,
        randomBytes: deterministicEntropy,
      },
    )

    await harness.create()
    harness.activateDatabaseUrl()
    expect(process.env.DATABASE_URL).toBe(harness.databaseUrl)

    await harness.cleanup()
    expect(process.env.DATABASE_URL).toBe('postgresql://application/original')
  })
})
