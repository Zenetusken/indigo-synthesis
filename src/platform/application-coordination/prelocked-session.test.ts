import { EventEmitter } from 'node:events'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import type {
  MutationAuthority,
  PrelockedSessionLease,
  PrelockedSessionOperation,
  UnitOfWorkRequest,
} from '@/application/coordination'
import { createInstallationMutationEpoch } from './lifecycle-values'
import {
  consumePreparedMutationAuthority,
  createPlatformMutationAuthorityIssuer,
  type IssuedMutationAuthority,
  prepareMutationAuthorityClaim,
} from './mutation-authority'
import {
  bindPrelockedSessionExecution,
  createPlatformPrelockedSessionIntentFactory,
  createPlatformPrelockedSessionPort,
  type PlatformExternalHostConnection,
  resolvePlatformPrelockedSession,
  withPlatformExternalHostConnection,
} from './prelocked-session'

const epochValue = '10000000-0000-4000-8000-000000000001'

function epoch() {
  return createInstallationMutationEpoch(epochValue)
}

function checkedSignOutIssuance() {
  return createPlatformMutationAuthorityIssuer().checkedSignOut({
    expectedEpoch: epoch(),
    signedTokenDigest: 'signed-token-digest',
    resolvedAccountUserId: 'user-1',
  })
}

function emailSignInIssuance() {
  return createPlatformMutationAuthorityIssuer().emailSignIn({
    expectedEpoch: epoch(),
    emailDigest: 'email-digest',
    resolvedAccountUserIds: ['user-1'],
  })
}

function ownerRecoveryIssueIssuance(hostInvocationId = 'host-invocation-1') {
  return createPlatformMutationAuthorityIssuer().ownerRecoveryIssue({
    expectedEpoch: epoch(),
    expectedOwnerUserId: 'owner-1',
    hostInvocationId,
  })
}

function instanceResetAttemptIssuance() {
  const issuer = createPlatformMutationAuthorityIssuer()
  return issuer.instanceResetAttempt({
    authenticated: issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'owner-1',
      sessionId: 'owner-session-1',
      expectedRole: 'owner',
    }),
  })
}

function memberResetIssueAttemptIssuance() {
  const issuer = createPlatformMutationAuthorityIssuer()
  return issuer.memberResetIssueAttempt({
    authenticated: issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'owner-1',
      sessionId: 'owner-session-1',
      expectedRole: 'owner',
    }),
    targetUserId: 'member-1',
  })
}

function subjectDeletionAttemptIssuance() {
  const issuer = createPlatformMutationAuthorityIssuer()
  return issuer.traineeDataDeletionAttempt({
    authenticated: issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'member-1',
      sessionId: 'member-session-1',
      expectedRole: 'member',
    }),
  })
}

function requestOperationFor(
  authority: MutationAuthority,
): UnitOfWorkRequest['operation'] {
  switch (authority.kind) {
    case 'destructive-reauthentication-attempt':
      return 'destructive-reauthentication-attempt'
    case 'authenticated-destructive':
      if (authority.purpose === 'trainee-data-deletion') return 'subject-deletion'
      if (authority.purpose === 'instance-reset') return 'instance-reset'
      return 'destructive-identity-mutation'
    case 'credential-lifecycle':
      return 'credential-lifecycle-mutation'
    case 'host-bootstrap':
      return 'host-bootstrap-mutation'
    case 'owner-recovery-issue':
    case 'expired-session-maintenance':
      return 'host-maintenance'
    case 'authenticated-session':
      throw new TypeError('Prelocked-session tests require prelocked authority.')
  }
}

function consumedClaim(
  issued: IssuedMutationAuthority<MutationAuthority>,
  lease: PrelockedSessionLease<PrelockedSessionOperation>,
  expectedOperation: PrelockedSessionOperation,
) {
  const authority = issued.authority
  const request = {
    operation: requestOperationFor(authority),
    authority,
    expectedEpoch: issued.expectedEpoch,
    session: { kind: 'prelocked', lease },
    subjectLock:
      authority.kind === 'authenticated-destructive' &&
      authority.purpose === 'trainee-data-deletion'
        ? { subjectUserId: authority.actorUserId, mode: 'exclusive' }
        : null,
  } as unknown as UnitOfWorkRequest
  prepareMutationAuthorityClaim(request, expectedOperation)
  return consumePreparedMutationAuthority(request)
}

type RuntimeGlobal = typeof globalThis & {
  indigoDatabaseRuntimeState?: unknown
}

type CheckoutOptions = { readonly signal?: AbortSignal }
type QueryResult = { rows: { unlocked?: boolean }[] }

type TestAcquisition = {
  readonly client: PoolClient
  readonly closedWith: (Error | undefined)[]
  readonly forceDestroy: Mock<(error: Error) => void>
  readonly onCheckout: Mock<(options?: CheckoutOptions) => Promise<void>>
  readonly query: Mock<
    (statement: unknown, parameters?: readonly unknown[]) => Promise<QueryResult>
  >
  readonly release: Mock<(error?: Error | boolean) => void>
  pauseCleanupUntil(barrier: Promise<void>, onStarted: () => void): void
  stallNextQuery(
    matcher: string,
    promise: Promise<QueryResult>,
    onDispatched?: () => void,
  ): void
}

function deferred<Value>() {
  let resolve: (value: Value) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const runtimeGlobal = globalThis as RuntimeGlobal
let previousRuntimeState: unknown
let pendingAcquisitions: TestAcquisition[] = []

const acquireTrustedControl = vi.fn(async (options?: CheckoutOptions) =>
  checkout(options),
)
const acquireSubmittedEmailControl = vi.fn(async (options?: CheckoutOptions) =>
  checkout(options),
)

async function checkout(options?: CheckoutOptions) {
  const acquired = pendingAcquisitions.shift()
  if (!acquired) throw new Error('No fake credential-control client was queued.')
  await acquired.onCheckout(options)
  let observed: Error | undefined
  const listeners = new Set<(error: Error) => void>()
  const onError = (error: Error): void => {
    observed ??= error
    for (const listener of listeners) listener(observed)
  }
  ;(acquired.client as unknown as EventEmitter).on('error', onError)
  return {
    client: acquired.client,
    error: () => observed,
    dispose: () => {
      listeners.clear()
      ;(acquired.client as unknown as EventEmitter).removeListener('error', onError)
    },
    subscribe: (listener: (error: Error) => void) => {
      if (observed) {
        listener(observed)
        return () => undefined
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

beforeEach(() => {
  previousRuntimeState = runtimeGlobal.indigoDatabaseRuntimeState
  pendingAcquisitions = []
  acquireTrustedControl.mockClear()
  acquireSubmittedEmailControl.mockClear()
  runtimeGlobal.indigoDatabaseRuntimeState = {
    kind: 'live',
    runtime: {
      acquireTrustedMonitoredControl: acquireTrustedControl,
      acquireSubmittedEmailMonitoredControl: acquireSubmittedEmailControl,
    },
  }
})

afterEach(() => {
  runtimeGlobal.indigoDatabaseRuntimeState = previousRuntimeState
})

function acquisition(options: { readonly enqueue?: boolean } = {}): TestAcquisition {
  const closedWith: (Error | undefined)[] = []
  let cleanupBarrier: Promise<void> | undefined
  let cleanupStarted: (() => void) | undefined
  let cleanupPaused = false
  const stalledQueries: Array<{
    readonly matcher: string
    readonly onDispatched?: () => void
    readonly promise: Promise<QueryResult>
  }> = []
  const query = vi.fn((statement: unknown, _parameters?: readonly unknown[]) => {
    const text = typeof statement === 'string' ? statement : ''
    const stalledIndex = stalledQueries.findIndex(({ matcher }) => text.includes(matcher))
    if (stalledIndex >= 0) {
      const [stalled] = stalledQueries.splice(stalledIndex, 1)
      if (!stalled) throw new Error('A stalled-query rule disappeared.')
      stalled.onDispatched?.()
      return stalled.promise
    }
    if (!cleanupPaused && cleanupBarrier && text.includes('pg_advisory_unlock')) {
      cleanupPaused = true
      cleanupStarted?.()
      return cleanupBarrier.then(() => ({ rows: [{ unlocked: true }] }))
    }
    return Promise.resolve(
      text.includes('pg_advisory_unlock') ? { rows: [{ unlocked: true }] } : { rows: [] },
    )
  })
  const release = vi.fn((error?: Error | boolean) => {
    closedWith.push(error instanceof Error ? error : undefined)
  })
  const forceDestroy = vi.fn((error: Error) => release(error))
  const client = Object.assign(new EventEmitter(), {
    query,
    release,
  }) as unknown as PoolClient
  const onCheckout = vi.fn(async (_options?: CheckoutOptions) => undefined)
  const acquired: TestAcquisition = {
    client,
    closedWith,
    forceDestroy,
    onCheckout,
    query,
    release,
    pauseCleanupUntil(barrier: Promise<void>, onStarted: () => void) {
      cleanupBarrier = barrier
      cleanupStarted = onStarted
    },
    stallNextQuery(
      matcher: string,
      promise: Promise<QueryResult>,
      onDispatched?: () => void,
    ) {
      stalledQueries.push({ matcher, onDispatched, promise })
    },
  }
  if (options.enqueue !== false) pendingAcquisitions.push(acquired)
  return acquired
}

describe('Platform prelocked sessions', () => {
  it('exposes only one authority argument on every sealed intent method', () => {
    const factory = createPlatformPrelockedSessionIntentFactory()
    const checkedSignOutParameterCount: Parameters<
      typeof factory.checkedSignOut
    >['length'] = 1

    expect(checkedSignOutParameterCount).toBe(1)
    expect(Object.values(factory).map((method) => method.length)).toEqual(
      Array.from({ length: 13 }, () => 1),
    )
  })

  it('derives the exact lane and reverses its sealed credential lock order', async () => {
    const acquired = acquisition()
    const issued = createPlatformMutationAuthorityIssuer().emailSignIn({
      expectedEpoch: epoch(),
      emailDigest: 'email-digest',
      resolvedAccountUserIds: ['user-z', 'user-a'],
    })

    await createPlatformPrelockedSessionPort().withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().emailSignIn(issued),
      async () => undefined,
    )

    expect(acquireSubmittedEmailControl).toHaveBeenCalledOnce()
    expect(acquireSubmittedEmailControl).toHaveBeenCalledWith({})
    expect(acquireTrustedControl).not.toHaveBeenCalled()
    const calls: Array<readonly [unknown, readonly unknown[] | null]> =
      acquired.query.mock.calls.map(([statement, parameters]) => [
        statement,
        parameters ?? null,
      ])
    expect(calls).toEqual([
      [
        "SELECT set_config('lock_timeout', $1, false)",
        [expect.stringMatching(/^\d+ms$/)],
      ],
      [
        'SELECT pg_advisory_lock_shared(hashtextextended($1, 0))',
        ['indigo:credential-lifecycle:instance-fence'],
      ],
      [
        "SELECT set_config('lock_timeout', $1, false)",
        [expect.stringMatching(/^\d+ms$/)],
      ],
      [
        'SELECT pg_advisory_lock(hashtextextended($1, 0))',
        ['indigo:credential-lifecycle:email:email-digest'],
      ],
      [
        "SELECT set_config('lock_timeout', $1, false)",
        [expect.stringMatching(/^\d+ms$/)],
      ],
      [
        'SELECT pg_advisory_lock(hashtextextended($1, 0))',
        ['indigo:credential-lifecycle:account:user-a'],
      ],
      [
        "SELECT set_config('lock_timeout', $1, false)",
        [expect.stringMatching(/^\d+ms$/)],
      ],
      [
        'SELECT pg_advisory_lock(hashtextextended($1, 0))',
        ['indigo:credential-lifecycle:account:user-z'],
      ],
      [
        'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
        ['indigo:credential-lifecycle:account:user-z'],
      ],
      [
        'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
        ['indigo:credential-lifecycle:account:user-a'],
      ],
      [
        'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
        ['indigo:credential-lifecycle:email:email-digest'],
      ],
      [
        'SELECT pg_advisory_unlock_shared(hashtextextended($1, 0)) AS unlocked',
        ['indigo:credential-lifecycle:instance-fence'],
      ],
      ['RESET lock_timeout', null],
    ])
    const timeoutValues = calls
      .filter(([statement]) => String(statement).includes("set_config('lock_timeout'"))
      .map(([, parameters]) => Number.parseInt(String(parameters?.[0]), 10))
    expect(timeoutValues).toHaveLength(4)
    expect(timeoutValues.every((value) => value > 0 && value <= 5_000)).toBe(true)
    expect(timeoutValues).toEqual([...timeoutValues].sort((left, right) => right - left))
    expect(acquired.closedWith).toEqual([undefined])
  })

  it('rejects an external-host intent without a provider before application work', async () => {
    const port = createPlatformPrelockedSessionPort()
    const applicationWork = vi.fn(async () => 'must not run')
    const issued = ownerRecoveryIssueIssuance()

    await expect(
      port.withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().ownerRecoveryIssue(issued),
        applicationWork,
      ),
    ).rejects.toMatchObject({ code: 'uow.prelocked-session-invalid' })

    expect(applicationWork).not.toHaveBeenCalled()
    expect(acquireTrustedControl).not.toHaveBeenCalled()
    expect(acquireSubmittedEmailControl).not.toHaveBeenCalled()
    expect(port.activeLeaseScopeCount()).toBe(0)
  })

  it('rejects a wrong external invocation before locks and closes it once', async () => {
    const acquired = acquisition({ enqueue: false })
    const applicationWork = vi.fn(async () => 'must not run')
    const issued = ownerRecoveryIssueIssuance('expected-invocation')
    let port: ReturnType<typeof createPlatformPrelockedSessionPort> | undefined

    await expect(
      withPlatformExternalHostConnection(
        {
          hostInvocationId: 'wrong-invocation',
          client: acquired.client,
          close: async (error) => acquired.release(error),
          forceDestroy: acquired.forceDestroy,
        },
        async (externalHostConnection) => {
          port = createPlatformPrelockedSessionPort({ externalHostConnection })
          return port.withPrelockedSessionLease(
            createPlatformPrelockedSessionIntentFactory().ownerRecoveryIssue(issued),
            applicationWork,
          )
        },
      ),
    ).rejects.toMatchObject({ code: 'uow.prelocked-session-invalid' })

    expect(applicationWork).not.toHaveBeenCalled()
    expect(acquired.query).not.toHaveBeenCalled()
    expect(acquired.release).toHaveBeenCalledOnce()
    expect(acquired.closedWith).toEqual([
      expect.objectContaining({ code: 'uow.prelocked-session-invalid' }),
    ])
    expect(acquireTrustedControl).not.toHaveBeenCalled()
    expect(acquireSubmittedEmailControl).not.toHaveBeenCalled()
    expect(port?.activeLeaseScopeCount()).toBe(0)
  })

  it('owns an external-host error before provider consumption and fails closed', async () => {
    const acquired = acquisition({ enqueue: false })
    const connectionLost = new Error('external host failed before provider consumption')
    const applicationWork = vi.fn(async () => 'must not run')
    const issued = ownerRecoveryIssueIssuance()
    let port: ReturnType<typeof createPlatformPrelockedSessionPort> | undefined

    await expect(
      withPlatformExternalHostConnection(
        {
          hostInvocationId: 'host-invocation-1',
          client: acquired.client,
          close: async (error) => acquired.release(error),
          forceDestroy: acquired.forceDestroy,
        },
        async (externalHostConnection) => {
          port = createPlatformPrelockedSessionPort({ externalHostConnection })
          await new Promise<void>((resolve) => {
            process.nextTick(() => {
              ;(acquired.client as unknown as EventEmitter).emit('error', connectionLost)
              resolve()
            })
          })
          return port.withPrelockedSessionLease(
            createPlatformPrelockedSessionIntentFactory().ownerRecoveryIssue(issued),
            applicationWork,
          )
        },
      ),
    ).rejects.toMatchObject({ code: 'uow.connection-lost' })

    expect(applicationWork).not.toHaveBeenCalled()
    expect(acquired.query).not.toHaveBeenCalled()
    expect(acquired.release).toHaveBeenCalledOnce()
    expect(acquired.forceDestroy).not.toHaveBeenCalled()
    expect(acquired.closedWith).toEqual([
      expect.objectContaining({ code: 'uow.connection-lost' }),
    ])
    expect((acquired.client as unknown as EventEmitter).listenerCount('error')).toBe(0)
    expect(port?.activeLeaseScopeCount()).toBe(0)
  })

  it('force-destroys an unconsumed external client when graceful close rejects', async () => {
    const acquired = acquisition({ enqueue: false })
    const closeFailure = new Error('external graceful close failed')
    const close = vi.fn(async () => {
      throw closeFailure
    })

    await expect(
      withPlatformExternalHostConnection(
        {
          hostInvocationId: 'host-invocation-1',
          client: acquired.client,
          close,
          forceDestroy: acquired.forceDestroy,
        },
        async () => 'callback completed',
      ),
    ).rejects.toBe(closeFailure)

    expect(close).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledWith(undefined)
    expect(acquired.forceDestroy).toHaveBeenCalledOnce()
    expect(acquired.forceDestroy).toHaveBeenCalledWith(closeFailure)
    expect(acquired.release).toHaveBeenCalledOnce()
    expect(acquired.closedWith).toEqual([closeFailure])
    expect((acquired.client as unknown as EventEmitter).listenerCount('error')).toBe(0)
  })

  it('force-destroys after active-lease close rejection and preserves callback identity', async () => {
    const acquired = acquisition({ enqueue: false })
    const original = new Error('active lease callback failed')
    const closeFailure = new Error('active lease graceful close failed')
    const close = vi.fn(async () => {
      throw closeFailure
    })
    const issued = ownerRecoveryIssueIssuance()
    let port: ReturnType<typeof createPlatformPrelockedSessionPort> | undefined

    await expect(
      withPlatformExternalHostConnection(
        {
          hostInvocationId: 'host-invocation-1',
          client: acquired.client,
          close,
          forceDestroy: acquired.forceDestroy,
        },
        async (externalHostConnection) => {
          port = createPlatformPrelockedSessionPort({ externalHostConnection })
          return port.withPrelockedSessionLease(
            createPlatformPrelockedSessionIntentFactory().ownerRecoveryIssue(issued),
            async () => {
              throw original
            },
          )
        },
      ),
    ).rejects.toBe(original)

    expect(close).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledWith(undefined)
    expect(acquired.forceDestroy).toHaveBeenCalledOnce()
    expect(acquired.forceDestroy).toHaveBeenCalledWith(closeFailure)
    expect(acquired.release).toHaveBeenCalledOnce()
    expect(acquired.closedWith).toEqual([closeFailure])
    expect((acquired.client as unknown as EventEmitter).listenerCount('error')).toBe(0)
    expect(port?.activeLeaseScopeCount()).toBe(0)
  })

  it('bounds an unconsumed external close and observes its late rejection', async () => {
    const acquired = acquisition({ enqueue: false })
    const stalledClose = deferred<void>()
    const closeObserved = vi.spyOn(stalledClose.promise, 'then')
    const lateFailure = new Error('late unconsumed close rejection')
    const unhandledRejection = vi.fn()
    process.on('unhandledRejection', unhandledRejection)

    try {
      const startedAt = Date.now()
      await expect(
        withPlatformExternalHostConnection(
          {
            hostInvocationId: 'host-invocation-1',
            client: acquired.client,
            closeTimeoutMs: 5,
            close: vi.fn(() => stalledClose.promise),
            forceDestroy: acquired.forceDestroy,
          },
          async () => 'callback completed',
        ),
      ).rejects.toMatchObject({ code: 'uow.cleanup-failed' })
      expect(Date.now() - startedAt).toBeLessThan(250)

      expect(acquired.forceDestroy).toHaveBeenCalledOnce()
      expect(acquired.forceDestroy).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'uow.cleanup-failed' }),
      )
      expect(acquired.release).toHaveBeenCalledOnce()
      expect((acquired.client as unknown as EventEmitter).listenerCount('error')).toBe(0)
      expect(closeObserved).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Function),
      )

      stalledClose.reject(lateFailure)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandledRejection).not.toHaveBeenCalled()
    } finally {
      process.removeListener('unhandledRejection', unhandledRejection)
    }
  })

  it('bounds a consumed external close, revokes its scope, and preserves callback error identity', async () => {
    const acquired = acquisition({ enqueue: false })
    const stalledClose = deferred<void>()
    const closeObserved = vi.spyOn(stalledClose.promise, 'then')
    const original = new Error('active lease callback failed')
    const lateFailure = new Error('late consumed close rejection')
    const close = vi.fn(() => stalledClose.promise)
    const unhandledRejection = vi.fn()
    const issued = ownerRecoveryIssueIssuance()
    let port: ReturnType<typeof createPlatformPrelockedSessionPort> | undefined
    process.on('unhandledRejection', unhandledRejection)

    try {
      const startedAt = Date.now()
      await expect(
        withPlatformExternalHostConnection(
          {
            hostInvocationId: 'host-invocation-1',
            client: acquired.client,
            closeTimeoutMs: 5,
            close,
            forceDestroy: acquired.forceDestroy,
          },
          async (externalHostConnection) => {
            port = createPlatformPrelockedSessionPort({ externalHostConnection })
            return port.withPrelockedSessionLease(
              createPlatformPrelockedSessionIntentFactory().ownerRecoveryIssue(issued),
              async () => {
                throw original
              },
            )
          },
        ),
      ).rejects.toBe(original)
      expect(Date.now() - startedAt).toBeLessThan(250)

      expect(close).toHaveBeenCalledOnce()
      expect(acquired.forceDestroy).toHaveBeenCalledOnce()
      expect(acquired.forceDestroy).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'uow.cleanup-failed' }),
      )
      expect(acquired.release).toHaveBeenCalledOnce()
      expect((acquired.client as unknown as EventEmitter).listenerCount('error')).toBe(0)
      expect(port?.activeLeaseScopeCount()).toBe(0)
      expect(closeObserved).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Function),
      )

      stalledClose.reject(lateFailure)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandledRejection).not.toHaveBeenCalled()
    } finally {
      process.removeListener('unhandledRejection', unhandledRejection)
    }
  })

  it('rejects a forged asserted external provider before using the supplied host client', async () => {
    const acquired = acquisition({ enqueue: false })
    const applicationWork = vi.fn(async () => 'must not run')
    const issued = ownerRecoveryIssueIssuance()
    const forged = {} as unknown as PlatformExternalHostConnection
    const port = createPlatformPrelockedSessionPort({
      externalHostConnection: forged,
    })

    await expect(
      withPlatformExternalHostConnection(
        {
          hostInvocationId: 'host-invocation-1',
          client: acquired.client,
          close: async (error) => acquired.release(error),
          forceDestroy: acquired.forceDestroy,
        },
        async () =>
          port.withPrelockedSessionLease(
            createPlatformPrelockedSessionIntentFactory().ownerRecoveryIssue(issued),
            applicationWork,
          ),
      ),
    ).rejects.toMatchObject({ code: 'uow.prelocked-session-invalid' })

    expect(applicationWork).not.toHaveBeenCalled()
    expect(acquired.query).not.toHaveBeenCalled()
    expect(acquired.release).toHaveBeenCalledOnce()
    expect(acquired.closedWith).toEqual([
      expect.objectContaining({ code: 'uow.prelocked-session-invalid' }),
    ])
    expect(acquireTrustedControl).not.toHaveBeenCalled()
    expect(acquireSubmittedEmailControl).not.toHaveBeenCalled()
    expect(port.activeLeaseScopeCount()).toBe(0)
  })

  it('consumes an external provider once and rejects reuse before more locks or work', async () => {
    const acquired = acquisition({ enqueue: false })
    const firstWork = vi.fn(async () => 'first')
    const secondWork = vi.fn(async () => 'must not run')
    const firstIssued = ownerRecoveryIssueIssuance()
    const secondIssued = ownerRecoveryIssueIssuance()
    let firstPort: ReturnType<typeof createPlatformPrelockedSessionPort> | undefined
    let secondPort: ReturnType<typeof createPlatformPrelockedSessionPort> | undefined

    await withPlatformExternalHostConnection(
      {
        hostInvocationId: 'host-invocation-1',
        client: acquired.client,
        close: async (error) => acquired.release(error),
        forceDestroy: acquired.forceDestroy,
      },
      async (externalHostConnection) => {
        firstPort = createPlatformPrelockedSessionPort({ externalHostConnection })
        await expect(
          firstPort.withPrelockedSessionLease(
            createPlatformPrelockedSessionIntentFactory().ownerRecoveryIssue(firstIssued),
            firstWork,
          ),
        ).resolves.toBe('first')
        const firstQueryCount = acquired.query.mock.calls.length

        secondPort = createPlatformPrelockedSessionPort({ externalHostConnection })
        await expect(
          secondPort.withPrelockedSessionLease(
            createPlatformPrelockedSessionIntentFactory().ownerRecoveryIssue(
              secondIssued,
            ),
            secondWork,
          ),
        ).rejects.toMatchObject({ code: 'uow.prelocked-session-invalid' })
        expect(acquired.query).toHaveBeenCalledTimes(firstQueryCount)
      },
    )

    expect(firstWork).toHaveBeenCalledOnce()
    expect(secondWork).not.toHaveBeenCalled()
    expect(
      acquired.query.mock.calls.some(([statement]) =>
        String(statement).startsWith('BEGIN'),
      ),
    ).toBe(false)
    expect(acquired.release).toHaveBeenCalledOnce()
    expect(acquired.closedWith).toEqual([undefined])
    expect(acquireTrustedControl).not.toHaveBeenCalled()
    expect(acquireSubmittedEmailControl).not.toHaveBeenCalled()
    expect(firstPort?.activeLeaseScopeCount()).toBe(0)
    expect(secondPort?.activeLeaseScopeCount()).toBe(0)
  })

  it('keeps intent and lease opaque and preserves callback result identity', async () => {
    const acquired = acquisition()
    const factory = createPlatformPrelockedSessionIntentFactory()
    const port = createPlatformPrelockedSessionPort()
    const issued = checkedSignOutIssuance()
    const intent = factory.checkedSignOut(issued)
    const result = { committed: true }

    await expect(
      port.withPrelockedSessionLease(intent, async (lease) => {
        expect(Object.keys(intent)).toEqual([])
        expect(Object.keys(lease)).toEqual([])
        const intentConstructor = intent.constructor as unknown as Record<
          PropertyKey,
          unknown
        >
        const leaseConstructor = lease.constructor as unknown as Record<
          PropertyKey,
          unknown
        >
        expect(intentConstructor.consume).toBeUndefined()
        expect(leaseConstructor.state).toBeUndefined()
        expect(() => Reflect.construct(intent.constructor, [])).toThrow(
          expect.objectContaining({ code: 'uow.prelocked-session-invalid' }),
        )
        expect(() => Reflect.construct(lease.constructor, [])).toThrow(
          expect.objectContaining({ code: 'uow.prelocked-session-invalid' }),
        )
        const claim = consumedClaim(issued, lease, 'checked-sign-out')
        let committed = false
        try {
          const resolved = resolvePlatformPrelockedSession(
            lease,
            'checked-sign-out',
            claim.prelockedScope,
          )
          expect(resolved.client).toBe(acquired.client)
          resolved.finish()
          committed = true
        } finally {
          claim.finish({ committed })
        }
        return result
      }),
    ).resolves.toBe(result)

    expect(acquired.onCheckout).toHaveBeenCalledOnce()
    expect(acquired.release).toHaveBeenCalledOnce()
    expect(acquired.closedWith).toEqual([undefined])
    expect(port.activeLeaseScopeCount()).toBe(0)
  })

  it('permits only attempt-to-protected sequencing and rejects concurrent use', async () => {
    acquisition()
    const port = createPlatformPrelockedSessionPort()
    const issuedAttempt = instanceResetAttemptIssuance()

    await port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().instanceReset(issuedAttempt),
      async (lease) => {
        const attemptClaim = consumedClaim(issuedAttempt, lease, 'instance-reset')
        let protectedAuthority: MutationAuthority | undefined
        let attemptCommitted = false
        try {
          const attempt = resolvePlatformPrelockedSession(
            lease,
            'instance-reset',
            attemptClaim.prelockedScope,
          )
          expect(() =>
            resolvePlatformPrelockedSession(
              lease,
              'instance-reset',
              attemptClaim.prelockedScope,
            ),
          ).toThrow(expect.objectContaining({ code: 'uow.prelocked-session-invalid' }))
          protectedAuthority = attemptClaim.markReauthenticationSucceeded()
          attempt.finish()
          attemptCommitted = true
        } finally {
          attemptClaim.finish({ committed: attemptCommitted })
        }
        if (!protectedAuthority) throw new Error('attempt was not promoted')

        const protectedIssued = {
          authority: protectedAuthority,
          expectedEpoch: issuedAttempt.expectedEpoch,
        } as IssuedMutationAuthority<MutationAuthority>
        const protectedClaim = consumedClaim(protectedIssued, lease, 'instance-reset')
        let protectedCommitted = false
        try {
          const protectedMutation = resolvePlatformPrelockedSession(
            lease,
            'instance-reset',
            protectedClaim.prelockedScope,
          )
          protectedMutation.finish()
          protectedCommitted = true
        } finally {
          protectedClaim.finish({ committed: protectedCommitted })
        }
      },
    )
  })

  it('rejects a wrong-operation resolution without entering the lease', async () => {
    acquisition()
    const port = createPlatformPrelockedSessionPort()
    const issued = instanceResetAttemptIssuance()

    await port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().instanceReset(issued),
      async (lease) => {
        const claim = consumedClaim(issued, lease, 'instance-reset')
        try {
          expect(() =>
            resolvePlatformPrelockedSession(
              lease,
              'subject-deletion',
              claim.prelockedScope,
            ),
          ).toThrow(expect.objectContaining({ code: 'uow.prelocked-session-invalid' }))
          const resolved = resolvePlatformPrelockedSession(
            lease,
            'instance-reset',
            claim.prelockedScope,
          )
          resolved.finish()
        } finally {
          claim.finish({ committed: false })
        }
      },
    )
  })

  it('rejects a scope from another live lease without entering either lease', async () => {
    acquisition()
    acquisition()
    const port = createPlatformPrelockedSessionPort()
    const firstIssued = checkedSignOutIssuance()
    const secondIssued = checkedSignOutIssuance()
    const factory = createPlatformPrelockedSessionIntentFactory()

    await port.withPrelockedSessionLease(
      factory.checkedSignOut(firstIssued),
      async (firstLease) => {
        await port.withPrelockedSessionLease(
          factory.checkedSignOut(secondIssued),
          async (secondLease) => {
            const secondClaim = consumedClaim(
              secondIssued,
              secondLease,
              'checked-sign-out',
            )
            try {
              expect(() =>
                resolvePlatformPrelockedSession(
                  firstLease,
                  'checked-sign-out',
                  secondClaim.prelockedScope,
                ),
              ).toThrow(
                expect.objectContaining({ code: 'uow.prelocked-session-invalid' }),
              )
              const resolved = resolvePlatformPrelockedSession(
                secondLease,
                'checked-sign-out',
                secondClaim.prelockedScope,
              )
              resolved.finish()
            } finally {
              secondClaim.finish({ committed: false })
            }
          },
        )
      },
    )
  })

  it('rejects a retained lease and its in-flight claim after outer-scope revocation', async () => {
    acquisition()
    const port = createPlatformPrelockedSessionPort()
    const issued = checkedSignOutIssuance()
    let retainedLease: PrelockedSessionLease<'checked-sign-out'> | undefined
    let retainedClaim: ReturnType<typeof consumedClaim> | undefined
    let retainedScope: ReturnType<typeof consumedClaim>['prelockedScope'] | undefined

    await port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().checkedSignOut(issued),
      async (lease) => {
        retainedLease = lease
        retainedClaim = consumedClaim(issued, lease, 'checked-sign-out')
        retainedScope = retainedClaim.prelockedScope
      },
    )

    const revokedLease = retainedLease
    const revokedClaim = retainedClaim
    const revokedScope = retainedScope
    if (!revokedLease || !revokedClaim || !revokedScope) {
      throw new Error('scope was not retained')
    }
    try {
      expect(() =>
        resolvePlatformPrelockedSession(revokedLease, 'checked-sign-out', revokedScope),
      ).toThrow(expect.objectContaining({ code: 'uow.prelocked-session-invalid' }))
      expect(() => revokedClaim.assertActive()).toThrow(
        expect.objectContaining({ code: 'identity.authority-stale' }),
      )
    } finally {
      revokedClaim.finish({ committed: false })
    }
  })

  it('preserves callback error identity and consumes each intent once', async () => {
    const acquired = acquisition()
    const port = createPlatformPrelockedSessionPort()
    const issued = memberResetIssueAttemptIssuance()
    const intent = createPlatformPrelockedSessionIntentFactory().memberResetIssue(issued)
    const original = new Error('callback failed')

    await expect(
      port.withPrelockedSessionLease(intent, async () => {
        throw original
      }),
    ).rejects.toBe(original)
    await expect(
      port.withPrelockedSessionLease(intent, async () => 'never'),
    ).rejects.toMatchObject({ code: 'uow.prelocked-session-invalid' })
    expect(acquired.closedWith).toEqual([undefined])
  })

  it('destroys the outer session when inner state is uncertain', async () => {
    const acquired = acquisition({ enqueue: false })
    const destroyError = new Error('connection uncertain')
    const issued = ownerRecoveryIssueIssuance()

    await expect(
      withPlatformExternalHostConnection(
        {
          hostInvocationId: 'host-invocation-1',
          client: acquired.client,
          close: async (error) => acquired.release(error),
          forceDestroy: acquired.forceDestroy,
        },
        async (externalHostConnection) =>
          createPlatformPrelockedSessionPort({
            externalHostConnection,
          }).withPrelockedSessionLease(
            createPlatformPrelockedSessionIntentFactory().ownerRecoveryIssue(issued),
            async (lease) => {
              const claim = consumedClaim(issued, lease, 'owner-recovery-issue')
              try {
                const resolved = resolvePlatformPrelockedSession(
                  lease,
                  'owner-recovery-issue',
                  claim.prelockedScope,
                )
                resolved.destroy(destroyError)
                resolved.finish()
              } finally {
                claim.finish({ committed: false })
              }
            },
          ),
      ),
    ).rejects.toMatchObject({ code: 'uow.connection-lost' })

    expect(acquired.closedWith).toEqual([destroyError])
  })

  it('detects a UoW that outlives the outer credential scope', async () => {
    const acquired = acquisition()
    const port = createPlatformPrelockedSessionPort()
    const issued = subjectDeletionAttemptIssuance()

    await expect(
      port.withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().subjectDeletion(issued),
        async (lease) => {
          const claim = consumedClaim(issued, lease, 'subject-deletion')
          try {
            resolvePlatformPrelockedSession(
              lease,
              'subject-deletion',
              claim.prelockedScope,
            )
            return 'detached'
          } finally {
            claim.finish({ committed: false })
          }
        },
      ),
    ).rejects.toMatchObject({ code: 'uow.detached-work' })
    expect(acquired.closedWith).toEqual([
      expect.objectContaining({ code: 'uow.detached-work' }),
    ])
    expect(port.activeLeaseScopeCount()).toBe(0)
  })

  it('aborts and joins a bound detached execution before closing the lease', async () => {
    const acquired = acquisition()
    const port = createPlatformPrelockedSessionPort()
    let observedAbort = false
    const issued = subjectDeletionAttemptIssuance()

    await expect(
      port.withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().subjectDeletion(issued),
        async (lease) => {
          const claim = consumedClaim(issued, lease, 'subject-deletion')
          try {
            const resolved = resolvePlatformPrelockedSession(
              lease,
              'subject-deletion',
              claim.prelockedScope,
            )
            const execution = new Promise<never>((_resolve, reject) => {
              resolved.signal.addEventListener(
                'abort',
                () => {
                  observedAbort = true
                  resolved.finish()
                  reject(new Error('detached execution cancelled'))
                },
                { once: true },
              )
            })
            void bindPrelockedSessionExecution(lease, execution)
            return 'detached'
          } finally {
            claim.finish({ committed: false })
          }
        },
      ),
    ).rejects.toMatchObject({ code: 'uow.detached-work' })
    expect(observedAbort).toBe(true)
    expect(acquired.closedWith).toEqual([
      expect.objectContaining({ code: 'uow.detached-work' }),
    ])
    expect(port.activeLeaseScopeCount()).toBe(0)
  })

  it('bounds a detached execution that ignores cancellation before destroying', async () => {
    const acquired = acquisition()
    const port = createPlatformPrelockedSessionPort({ detachedDrainTimeoutMs: 5 })
    const issued = subjectDeletionAttemptIssuance()

    await expect(
      port.withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().subjectDeletion(issued),
        async (lease) => {
          const claim = consumedClaim(issued, lease, 'subject-deletion')
          try {
            resolvePlatformPrelockedSession(
              lease,
              'subject-deletion',
              claim.prelockedScope,
            )
            void bindPrelockedSessionExecution(lease, new Promise<never>(() => undefined))
            return 'detached'
          } finally {
            claim.finish({ committed: false })
          }
        },
      ),
    ).rejects.toMatchObject({ code: 'uow.detached-work' })
    expect(acquired.closedWith).toEqual([
      expect.objectContaining({ code: 'uow.detached-work' }),
    ])
    expect(port.activeLeaseScopeCount()).toBe(0)
  })

  it('owns connection errors for the full lease and closes an acquired cancellation', async () => {
    const connectionLost = new Error('control connection lost')
    const acquired = acquisition()
    const port = createPlatformPrelockedSessionPort()
    const checkedSignOut = checkedSignOutIssuance()
    await expect(
      port.withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().checkedSignOut(checkedSignOut),
        async () => {
          ;(acquired.client as unknown as EventEmitter).emit('error', connectionLost)
          return 'must not succeed'
        },
      ),
    ).rejects.toMatchObject({ code: 'uow.connection-lost' })
    expect(acquired.closedWith).toEqual([connectionLost])
    expect(port.activeLeaseScopeCount()).toBe(0)

    const cancelled = acquisition()
    const controller = new AbortController()
    cancelled.onCheckout.mockImplementationOnce(async () => {
      controller.abort()
    })
    const emailSignIn = emailSignInIssuance()
    await expect(
      createPlatformPrelockedSessionPort().withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().emailSignIn(emailSignIn),
        async () => 'never',
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'uow.cancelled' })
    expect(cancelled.closedWith).toEqual([undefined])
    expect(cancelled.query).not.toHaveBeenCalled()
  })

  it('owns a connection error emitted while the first acquisition SET is dispatched', async () => {
    const acquired = acquisition()
    const stalled = deferred<QueryResult>()
    const queryObserved = vi.spyOn(stalled.promise, 'then')
    const connectionLost = new Error('connection lost during first acquisition SET')
    acquired.stallNextQuery("set_config('lock_timeout'", stalled.promise, () => {
      ;(acquired.client as unknown as EventEmitter).emit('error', connectionLost)
    })
    const applicationWork = vi.fn(async () => 'must not run')
    const port = createPlatformPrelockedSessionPort({
      lockTimeoutMs: 1_000,
      queryTimeoutMs: 1_000,
    })
    const issued = checkedSignOutIssuance()

    await expect(
      port.withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().checkedSignOut(issued),
        applicationWork,
      ),
    ).rejects.toMatchObject({ code: 'uow.connection-lost' })

    expect(applicationWork).not.toHaveBeenCalled()
    expect(queryObserved).toHaveBeenCalledWith(expect.any(Function), expect.any(Function))
    expect(acquired.closedWith).toEqual([connectionLost])
    expect((acquired.client as unknown as EventEmitter).listenerCount('error')).toBe(0)
    expect(port.activeLeaseScopeCount()).toBe(0)

    stalled.resolve({ rows: [] })
    await Promise.resolve()
  })

  it('replays a connection error emitted between the final lock and lease callback', async () => {
    const acquired = acquisition()
    const finalLock = deferred<QueryResult>()
    const dispatched = deferred<void>()
    const connectionLost = new Error('connection lost during acquisition handoff')
    const handoffPromise = finalLock.promise.then((value) => {
      queueMicrotask(() => {
        ;(acquired.client as unknown as EventEmitter).emit('error', connectionLost)
      })
      return value
    })
    acquired.stallNextQuery('pg_advisory_lock(', handoffPromise, () =>
      dispatched.resolve(undefined),
    )
    const applicationWork = vi.fn(async () => 'must not run')
    const port = createPlatformPrelockedSessionPort({
      lockTimeoutMs: 1_000,
      queryTimeoutMs: 1_000,
    })
    const issued = checkedSignOutIssuance()

    const operation = port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().checkedSignOut(issued),
      applicationWork,
    )
    await dispatched.promise
    finalLock.resolve({ rows: [] })

    await expect(operation).rejects.toMatchObject({ code: 'uow.connection-lost' })
    expect(applicationWork).not.toHaveBeenCalled()
    expect(acquired.closedWith).toEqual([connectionLost])
    expect((acquired.client as unknown as EventEmitter).listenerCount('error')).toBe(0)
    expect(port.activeLeaseScopeCount()).toBe(0)
  })

  it('retires a connection lost between UoWs even while the outer callback remains pending', async () => {
    const acquired = acquisition()
    const port = createPlatformPrelockedSessionPort()
    const connectionLost = new Error('connection lost between transactions')
    let markEntered: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    let releaseCallback: () => void = () => undefined
    const callbackBarrier = new Promise<void>((resolve) => {
      releaseCallback = resolve
    })
    const issued = checkedSignOutIssuance()

    const result = port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().checkedSignOut(issued),
      async () => {
        markEntered()
        await callbackBarrier
        return 'late callback result'
      },
    )
    const outcome = result.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await entered
    ;(acquired.client as unknown as EventEmitter).emit('error', connectionLost)

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      error: { code: 'uow.connection-lost' },
    })
    expect(acquired.closedWith).toEqual([connectionLost])
    expect((acquired.client as unknown as EventEmitter).listenerCount('error')).toBe(0)
    expect(port.activeLeaseScopeCount()).toBe(0)
    releaseCallback()
  })

  it('turns an inner destruction into a lease-wide failure while the callback remains pending', async () => {
    const acquired = acquisition({ enqueue: false })
    let port: ReturnType<typeof createPlatformPrelockedSessionPort> | undefined
    const uncertainty = new Error('inner transaction state is uncertain')
    let releaseCallback: () => void = () => undefined
    const callbackBarrier = new Promise<void>((resolve) => {
      releaseCallback = resolve
    })
    const issued = ownerRecoveryIssueIssuance()

    const result = withPlatformExternalHostConnection(
      {
        hostInvocationId: 'host-invocation-1',
        client: acquired.client,
        close: async (error) => acquired.release(error),
        forceDestroy: acquired.forceDestroy,
      },
      async (externalHostConnection) => {
        port = createPlatformPrelockedSessionPort({
          externalHostConnection,
        })
        return port.withPrelockedSessionLease(
          createPlatformPrelockedSessionIntentFactory().ownerRecoveryIssue(issued),
          async (lease) => {
            const claim = consumedClaim(issued, lease, 'owner-recovery-issue')
            try {
              const resolved = resolvePlatformPrelockedSession(
                lease,
                'owner-recovery-issue',
                claim.prelockedScope,
              )
              resolved.destroy(uncertainty)
              resolved.finish()
            } finally {
              claim.finish({ committed: false })
            }
            await callbackBarrier
            return 'late callback result'
          },
        )
      },
    )
    const outcome = result.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      error: { code: 'uow.connection-lost' },
    })
    expect(acquired.closedWith).toEqual([uncertainty])
    expect(port?.activeLeaseScopeCount()).toBe(0)
    releaseCallback()
  })

  it('observes a connection loss that arrives during asynchronous lease cleanup', async () => {
    const acquired = acquisition()
    const port = createPlatformPrelockedSessionPort()
    const connectionLost = new Error('connection lost during close')
    let markCloseStarted: () => void = () => undefined
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve
    })
    let releaseClose: () => void = () => undefined
    const closeBarrier = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    acquired.pauseCleanupUntil(closeBarrier, markCloseStarted)
    const issued = checkedSignOutIssuance()

    const result = port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().checkedSignOut(issued),
      async () => 'callback complete',
    )
    const outcome = result.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await closeStarted
    ;(acquired.client as unknown as EventEmitter).emit('error', connectionLost)
    releaseClose()

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      error: { code: 'uow.connection-lost' },
    })
    expect(acquired.closedWith).toEqual([connectionLost])
    expect(port.activeLeaseScopeCount()).toBe(0)
  })

  it('cancels after callback entry and keeps the lease counted until close completes', async () => {
    const acquired = acquisition()
    const controller = new AbortController()
    const port = createPlatformPrelockedSessionPort()
    let markEntered: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    let markCloseStarted: () => void = () => undefined
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve
    })
    let finishClose: () => void = () => undefined
    const closeBarrier = new Promise<void>((resolve) => {
      finishClose = resolve
    })
    acquired.pauseCleanupUntil(closeBarrier, markCloseStarted)
    const issued = emailSignInIssuance()

    const result = port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().emailSignIn(issued),
      async () => {
        markEntered()
        return new Promise<never>(() => undefined)
      },
      { signal: controller.signal },
    )
    const outcome = result.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    await entered
    expect(port.activeLeaseScopeCount()).toBe(1)
    controller.abort()
    await closeStarted
    expect(port.activeLeaseScopeCount()).toBe(1)
    finishClose()

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      error: { code: 'uow.cancelled' },
    })
    expect(acquired.closedWith).toEqual([undefined])
    expect(port.activeLeaseScopeCount()).toBe(0)
  })

  it('destroys a client when cancellation follows a dispatched SET query', async () => {
    const acquired = acquisition()
    const stalled = deferred<QueryResult>()
    const queryObserved = vi.spyOn(stalled.promise, 'then')
    const dispatched = deferred<void>()
    acquired.stallNextQuery("set_config('lock_timeout'", stalled.promise, () =>
      dispatched.resolve(undefined),
    )
    const controller = new AbortController()
    const applicationWork = vi.fn(async () => 'must not run')
    const port = createPlatformPrelockedSessionPort({
      lockTimeoutMs: 1_000,
      queryTimeoutMs: 1_000,
    })
    const issued = checkedSignOutIssuance()

    const operation = port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().checkedSignOut(issued),
      applicationWork,
      { signal: controller.signal },
    )
    await dispatched.promise
    controller.abort()

    await expect(operation).rejects.toMatchObject({ code: 'uow.cancelled' })
    expect(applicationWork).not.toHaveBeenCalled()
    expect(acquired.query).toHaveBeenCalledOnce()
    expect(queryObserved).toHaveBeenCalledWith(expect.any(Function), expect.any(Function))
    expect(acquired.closedWith).toEqual([
      expect.objectContaining({ code: 'uow.cancelled' }),
    ])
    expect(port.activeLeaseScopeCount()).toBe(0)

    stalled.reject(new Error('late SET rejection'))
    await Promise.resolve()
  })

  it('destroys a client when a dispatched credential lock query stalls', async () => {
    const acquired = acquisition()
    const stalled = deferred<QueryResult>()
    const queryObserved = vi.spyOn(stalled.promise, 'then')
    const dispatched = deferred<void>()
    acquired.stallNextQuery('pg_advisory_lock', stalled.promise, () =>
      dispatched.resolve(undefined),
    )
    const applicationWork = vi.fn(async () => 'must not run')
    const port = createPlatformPrelockedSessionPort({
      lockTimeoutMs: 100,
      queryTimeoutMs: 10,
    })
    const issued = checkedSignOutIssuance()

    const operation = port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().checkedSignOut(issued),
      applicationWork,
    )
    await dispatched.promise

    await expect(operation).rejects.toMatchObject({ code: 'uow.lock-timeout' })
    expect(applicationWork).not.toHaveBeenCalled()
    expect(acquired.query).toHaveBeenCalledTimes(2)
    expect(
      acquired.query.mock.calls.some(([statement]) =>
        String(statement).startsWith('RESET'),
      ),
    ).toBe(false)
    expect(queryObserved).toHaveBeenCalledWith(expect.any(Function), expect.any(Function))
    expect(acquired.closedWith).toEqual([
      expect.objectContaining({ code: 'uow.lock-timeout' }),
    ])
    expect(port.activeLeaseScopeCount()).toBe(0)

    stalled.reject(new Error('late credential-lock rejection'))
    await Promise.resolve()
  })

  it('destroys a client when a dispatched credential unlock query stalls', async () => {
    const acquired = acquisition()
    const stalled = deferred<QueryResult>()
    const queryObserved = vi.spyOn(stalled.promise, 'then')
    const dispatched = deferred<void>()
    acquired.stallNextQuery('pg_advisory_unlock(', stalled.promise, () =>
      dispatched.resolve(undefined),
    )
    const applicationWork = vi.fn(async () => 'done')
    const port = createPlatformPrelockedSessionPort({ queryTimeoutMs: 10 })
    const issued = checkedSignOutIssuance()

    const operation = port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().checkedSignOut(issued),
      applicationWork,
    )
    await dispatched.promise

    await expect(operation).rejects.toMatchObject({ code: 'uow.cleanup-failed' })
    expect(applicationWork).toHaveBeenCalledOnce()
    expect(
      acquired.query.mock.calls.some(([statement]) =>
        String(statement).startsWith('RESET'),
      ),
    ).toBe(false)
    expect(queryObserved).toHaveBeenCalledWith(expect.any(Function), expect.any(Function))
    expect(acquired.release).toHaveBeenCalledOnce()
    expect(acquired.closedWith).toEqual([
      expect.objectContaining({ name: 'InFlightQueryUncertain' }),
    ])
    expect(port.activeLeaseScopeCount()).toBe(0)

    stalled.reject(new Error('late credential-unlock rejection'))
    await Promise.resolve()
  })

  it('destroys a client when a dispatched lock-timeout RESET query stalls', async () => {
    const acquired = acquisition()
    const stalled = deferred<QueryResult>()
    const queryObserved = vi.spyOn(stalled.promise, 'then')
    const dispatched = deferred<void>()
    acquired.stallNextQuery('RESET lock_timeout', stalled.promise, () =>
      dispatched.resolve(undefined),
    )
    const applicationWork = vi.fn(async () => 'done')
    const port = createPlatformPrelockedSessionPort({ queryTimeoutMs: 10 })
    const issued = checkedSignOutIssuance()

    const operation = port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().checkedSignOut(issued),
      applicationWork,
    )
    await dispatched.promise

    await expect(operation).rejects.toMatchObject({ code: 'uow.cleanup-failed' })
    expect(applicationWork).toHaveBeenCalledOnce()
    expect(
      acquired.query.mock.calls.filter(([statement]) =>
        String(statement).startsWith('RESET lock_timeout'),
      ),
    ).toHaveLength(1)
    expect(queryObserved).toHaveBeenCalledWith(expect.any(Function), expect.any(Function))
    expect(acquired.release).toHaveBeenCalledOnce()
    expect(acquired.closedWith).toEqual([
      expect.objectContaining({ name: 'InFlightQueryUncertain' }),
    ])
    expect(port.activeLeaseScopeCount()).toBe(0)

    stalled.reject(new Error('late RESET rejection'))
    await Promise.resolve()
  })

  it('fails before acquisition when cancellation is already signalled', async () => {
    const acquired = acquisition()
    const controller = new AbortController()
    controller.abort()
    const issued = emailSignInIssuance()

    await expect(
      createPlatformPrelockedSessionPort().withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().emailSignIn(issued),
        async () => 'never',
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'uow.cancelled' })
    expect(acquired.onCheckout).not.toHaveBeenCalled()
  })
})
