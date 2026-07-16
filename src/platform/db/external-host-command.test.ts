import { EventEmitter } from 'node:events'
import type { QueryResult, QueryResultRow } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoordinationError } from '@/application/coordination'
import {
  type ExternalHostCaptureQuery,
  withExternalHostCommand,
} from './external-host-command'
import {
  type ExternalHostOneShotQuery,
  withExternalHostClientOwner,
  withExternalHostOneShot,
} from './external-host-one-shot'

const pgMocks = vi.hoisted(() => ({
  constructed: 0,
  nextClient: undefined as unknown,
}))

vi.mock('pg', async (importOriginal) => ({
  ...(await importOriginal<typeof import('pg')>()),
  Client: class {
    readonly connection: unknown
    readonly connect: () => Promise<void>
    readonly end: () => Promise<void>
    readonly query: FakeExternalClient['query']
    readonly on: FakeExternalClient['on']
    readonly removeListener: FakeExternalClient['removeListener']

    constructor(_config: unknown) {
      const target = pgMocks.nextClient as FakeExternalClient | undefined
      if (!target) throw new Error('No fake external client was configured.')
      pgMocks.constructed += 1
      this.connection = target.connection
      this.connect = target.connect
      this.end = target.end
      this.query = target.query
      this.on = target.on.bind(target)
      this.removeListener = target.removeListener.bind(target)
    }
  },
}))

vi.mock('@/platform/config/server', () => ({
  getServerConfig: () => ({ databaseUrl: 'postgresql://external-host.test/database' }),
}))

type Deferred<Value> = Readonly<{
  promise: Promise<Value>
  reject(error: unknown): void
  resolve(value: Value): void
}>

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

function queryResult<Row extends QueryResultRow>(rows: readonly Row[]): QueryResult<Row> {
  return {
    command: 'SELECT',
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows: [...rows],
  }
}

class FakeExternalClient extends EventEmitter {
  readonly destroy = vi.fn()
  readonly connection = { stream: { destroy: this.destroy } }
  readonly connect: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly end: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly query = vi.fn(
    async <Row extends QueryResultRow = QueryResultRow>(
      _text: string,
      _values?: readonly unknown[],
    ): Promise<QueryResult<Row>> => queryResult<Row>([]),
  )

  constructor(
    options: {
      readonly connect?: () => Promise<void>
      readonly end?: () => Promise<void>
    } = {},
  ) {
    super()
    this.connect = vi.fn(options.connect ?? (() => Promise.resolve()))
    this.end = vi.fn(options.end ?? (() => Promise.resolve()))
  }
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test')
  pgMocks.constructed = 0
  pgMocks.nextClient = undefined
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('external host command', () => {
  it('scopes query-only work and returns only after closing the dedicated client', async () => {
    const client = new FakeExternalClient()
    pgMocks.nextClient = client
    let retainedQuery: ExternalHostOneShotQuery | undefined

    await expect(
      withExternalHostOneShot(
        {
          hostInvocationId: 'query-only-success',
          allowTestWithoutInheritedLock: true,
        },
        async (query) => {
          retainedQuery = query
          await query.query('SELECT 1')
          return 'complete'
        },
      ),
    ).resolves.toBe('complete')

    expect(client.end).toHaveBeenCalledOnce()
    expect(client.listenerCount('error')).toBe(0)
    await expect(retainedQuery?.query('SELECT 1')).rejects.toThrow(
      'capture scope is revoked',
    )
  })

  it('closes a query-only client when its operation fails', async () => {
    const failure = new Error('preflight failed')
    const client = new FakeExternalClient()
    pgMocks.nextClient = client

    await expect(
      withExternalHostOneShot(
        {
          hostInvocationId: 'query-only-failure',
          allowTestWithoutInheritedLock: true,
        },
        async () => {
          throw failure
        },
      ),
    ).rejects.toBe(failure)

    expect(client.end).toHaveBeenCalledOnce()
    expect(client.listenerCount('error')).toBe(0)
  })

  it('permits only one active external-host owner per process', async () => {
    const entered = deferred<void>()
    const release = deferred<string>()
    const client = new FakeExternalClient()
    pgMocks.nextClient = client

    const first = withExternalHostOneShot(
      {
        hostInvocationId: 'active-owner',
        allowTestWithoutInheritedLock: true,
      },
      async () => {
        entered.resolve(undefined)
        return release.promise
      },
    )
    await entered.promise

    await expect(
      withExternalHostOneShot(
        {
          hostInvocationId: 'concurrent-owner',
          allowTestWithoutInheritedLock: true,
        },
        async () => 'must not run',
      ),
    ).rejects.toThrow('already active')
    expect(pgMocks.constructed).toBe(1)

    release.resolve('complete')
    await expect(first).resolves.toBe('complete')
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('bounds a stalled connect, hard-closes it, and ignores late settlement', async () => {
    const pendingConnect = deferred<void>()
    const client = new FakeExternalClient({ connect: () => pendingConnect.promise })
    pgMocks.nextClient = client
    const capture = vi.fn()
    const run = vi.fn()

    await expect(
      withExternalHostCommand(
        {
          hostInvocationId: 'stalled-connect',
          allowTestWithoutInheritedLock: true,
          connectTimeoutMs: 5,
          closeTimeoutMs: 5,
        },
        capture,
        run,
      ),
    ).rejects.toMatchObject({ code: 'uow.connection-lost' })

    expect(client.destroy).toHaveBeenCalled()
    expect(client.end).toHaveBeenCalledOnce()
    expect(client.listenerCount('error')).toBe(0)
    expect(capture).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()

    pendingConnect.resolve(undefined)
    await Promise.resolve()
    expect(run).not.toHaveBeenCalled()
  })

  it('revokes capture access and closes the client when capture stalls', async () => {
    const pendingCapture = deferred<never>()
    const client = new FakeExternalClient()
    pgMocks.nextClient = client
    let leakedQuery: ExternalHostCaptureQuery | undefined

    await expect(
      withExternalHostCommand(
        {
          hostInvocationId: 'stalled-capture',
          allowTestWithoutInheritedLock: true,
          captureTimeoutMs: 5,
          closeTimeoutMs: 5,
        },
        (query) => {
          leakedQuery = query
          return pendingCapture.promise
        },
        async () => 'unreachable',
      ),
    ).rejects.toMatchObject({ code: 'uow.connection-lost' })

    expect(client.destroy).toHaveBeenCalled()
    expect(client.end).toHaveBeenCalledOnce()
    expect(client.listenerCount('error')).toBe(0)
    await expect(leakedQuery?.query('SELECT 1')).rejects.toThrow(
      'capture scope is revoked',
    )
  })

  it('reports capture and bounded-close failures without retaining listeners', async () => {
    const captureFailure = new Error('capture failed')
    const client = new FakeExternalClient({ end: () => new Promise(() => undefined) })
    pgMocks.nextClient = client

    const outcome = withExternalHostCommand(
      {
        hostInvocationId: 'capture-close-failure',
        allowTestWithoutInheritedLock: true,
        closeTimeoutMs: 5,
      },
      async () => {
        throw captureFailure
      },
      async () => 'unreachable',
    )

    await expect(outcome).rejects.toMatchObject({
      errors: [captureFailure, expect.objectContaining({ code: 'uow.cleanup-failed' })],
    })
    expect(client.destroy).toHaveBeenCalled()
    expect(client.listenerCount('error')).toBe(0)
  })

  it('bounds final client close after successful capture and callback work', async () => {
    const client = new FakeExternalClient({ end: () => new Promise(() => undefined) })
    pgMocks.nextClient = client

    await expect(
      withExternalHostCommand(
        {
          hostInvocationId: 'stalled-final-close',
          allowTestWithoutInheritedLock: true,
          closeTimeoutMs: 5,
        },
        async () => Object.freeze({ expected: true }),
        async (captured) => captured,
      ),
    ).rejects.toMatchObject({ code: 'uow.cleanup-failed' })

    expect(client.end).toHaveBeenCalledOnce()
    expect(client.destroy).toHaveBeenCalled()
    expect(client.listenerCount('error')).toBe(0)
  })

  it('bounds explicitly timed raw-owner work and hard-closes its client', async () => {
    const pendingRun = deferred<string>()
    const client = new FakeExternalClient()
    pgMocks.nextClient = client

    const outcome = withExternalHostCommand(
      {
        hostInvocationId: 'stalled-owner-work',
        allowTestWithoutInheritedLock: true,
        runTimeoutMs: 5,
      },
      async () => 'captured',
      async () => pendingRun.promise,
    )

    await expect(outcome).rejects.toMatchObject({ code: 'uow.connection-lost' })
    expect(client.destroy).toHaveBeenCalled()
    expect(client.end).toHaveBeenCalledOnce()

    pendingRun.resolve('late')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(client.listenerCount('error')).toBe(0)
  })

  it('preserves raw-owner work and final-close failures together', async () => {
    const operationFailure = new Error('migration failed')
    const client = new FakeExternalClient({ end: () => new Promise(() => undefined) })
    pgMocks.nextClient = client

    await expect(
      withExternalHostClientOwner(
        {
          hostInvocationId: 'owner-work-close-failure',
          allowTestWithoutInheritedLock: true,
          closeTimeoutMs: 5,
        },
        async () => undefined,
        async () => {
          throw operationFailure
        },
      ),
    ).rejects.toMatchObject({
      errors: [operationFailure, expect.objectContaining({ code: 'uow.cleanup-failed' })],
    })

    expect(client.destroy).toHaveBeenCalled()
    expect(client.listenerCount('error')).toBe(0)
  })

  it('preserves independent same-code work and close failures', async () => {
    const operationFailure = new CoordinationError('uow.cleanup-failed')
    const client = new FakeExternalClient({ end: () => new Promise(() => undefined) })
    pgMocks.nextClient = client

    let rejection: unknown
    try {
      await withExternalHostClientOwner(
        {
          hostInvocationId: 'same-code-independent-failures',
          allowTestWithoutInheritedLock: true,
          closeTimeoutMs: 5,
        },
        async () => undefined,
        async () => {
          throw operationFailure
        },
      )
    } catch (error) {
      rejection = error
    }

    expect(rejection).toMatchObject({
      errors: [operationFailure, expect.objectContaining({ code: 'uow.cleanup-failed' })],
    })
    const errors = (rejection as AggregateError).errors
    expect(errors[0]).not.toBe(errors[1])
  })

  it('preserves platform callback and final-close failures together', async () => {
    const callbackFailure = new Error('identity callback failed')
    const client = new FakeExternalClient({ end: () => new Promise(() => undefined) })
    pgMocks.nextClient = client

    await expect(
      withExternalHostCommand(
        {
          hostInvocationId: 'platform-work-close-failure',
          allowTestWithoutInheritedLock: true,
          closeTimeoutMs: 5,
        },
        async () => undefined,
        async () => {
          throw callbackFailure
        },
      ),
    ).rejects.toMatchObject({
      errors: [callbackFailure, expect.objectContaining({ code: 'uow.cleanup-failed' })],
    })

    expect(client.destroy).toHaveBeenCalled()
    expect(client.listenerCount('error')).toBe(0)
  })

  it('rejects a capture-time connection error before mutation work begins', async () => {
    const connectionFailure = new Error('socket failed during capture')
    const client = new FakeExternalClient()
    pgMocks.nextClient = client
    const run = vi.fn()

    await expect(
      withExternalHostCommand(
        {
          hostInvocationId: 'capture-connection-error',
          allowTestWithoutInheritedLock: true,
        },
        async () => {
          client.emit('error', connectionFailure)
          return 'captured'
        },
        run,
      ),
    ).rejects.toBe(connectionFailure)

    expect(run).not.toHaveBeenCalled()
    expect(client.end).toHaveBeenCalledOnce()
    expect(client.listenerCount('error')).toBe(0)
  })

  it('keeps the unlocked adapter path test-only and validates bounds before construction', async () => {
    await expect(
      withExternalHostOneShot(
        { hostInvocationId: 'missing-host-lock' },
        async () => undefined,
      ),
    ).rejects.toThrow('run-external-host-command.sh')
    expect(pgMocks.constructed).toBe(0)

    vi.stubEnv('NODE_ENV', 'production')
    await expect(
      withExternalHostCommand(
        {
          hostInvocationId: 'unsafe-bypass',
          allowTestWithoutInheritedLock: true,
        },
        async () => undefined,
        async () => undefined,
      ),
    ).rejects.toThrow('restricted to test processes')

    vi.stubEnv('NODE_ENV', 'test')
    await expect(
      withExternalHostCommand(
        {
          hostInvocationId: 'invalid-timeout',
          allowTestWithoutInheritedLock: true,
          connectTimeoutMs: 0,
        },
        async () => undefined,
        async () => undefined,
      ),
    ).rejects.toThrow('connect timeout must be from 1 through 120000')
    expect(pgMocks.constructed).toBe(0)
  })

  // This test intentionally poisons the module-scoped owner lease, so it must remain last.
  it('fences every later owner when physical teardown cannot be confirmed', async () => {
    const client = new FakeExternalClient({ end: () => new Promise(() => undefined) })
    Reflect.set(client, 'connection', {})
    pgMocks.nextClient = client

    await expect(
      withExternalHostOneShot(
        {
          hostInvocationId: 'unconfirmed-teardown',
          allowTestWithoutInheritedLock: true,
          closeTimeoutMs: 5,
        },
        async () => 'complete',
      ),
    ).rejects.toMatchObject({ code: 'uow.cleanup-failed' })

    expect(client.end).toHaveBeenCalledOnce()
    expect(client.destroy).not.toHaveBeenCalled()
    expect(client.listenerCount('error')).toBe(1)

    pgMocks.nextClient = new FakeExternalClient()
    await expect(
      withExternalHostOneShot(
        {
          hostInvocationId: 'owner-after-unconfirmed-teardown',
          allowTestWithoutInheritedLock: true,
        },
        async () => 'must not run',
      ),
    ).rejects.toThrow('teardown is unconfirmed')
    expect(pgMocks.constructed).toBe(1)
  })
})
