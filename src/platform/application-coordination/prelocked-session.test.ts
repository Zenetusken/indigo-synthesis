import { EventEmitter } from 'node:events'
import type { PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  bindPrelockedSessionExecution,
  createPlatformPrelockedSessionIntentFactory,
  createPlatformPrelockedSessionPort,
  resolvePlatformPrelockedSession,
} from './prelocked-session'

function acquisition() {
  const closedWith: (Error | undefined)[] = []
  const close = vi.fn(async (destroyError: () => Error | undefined) => {
    closedWith.push(destroyError())
  })
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(),
  }) as unknown as PoolClient
  const acquire = vi.fn(async () => ({ client, close }))
  return { acquire, client, close, closedWith }
}

describe('Platform prelocked sessions', () => {
  it('keeps intent and lease opaque and preserves callback result identity', async () => {
    const acquired = acquisition()
    const factory = createPlatformPrelockedSessionIntentFactory()
    const port = createPlatformPrelockedSessionPort()
    const intent = factory.checkedSignOut(acquired.acquire)
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
        const resolved = resolvePlatformPrelockedSession(lease, 'checked-sign-out')
        expect(resolved.client).toBe(acquired.client)
        resolved.finish()
        return result
      }),
    ).resolves.toBe(result)

    expect(acquired.acquire).toHaveBeenCalledOnce()
    expect(acquired.close).toHaveBeenCalledOnce()
    expect(acquired.closedWith).toEqual([undefined])
    expect(port.activeLeaseScopeCount()).toBe(0)
  })

  it('supports sequential UoWs but rejects concurrent, wrong-purpose, and retained use', async () => {
    const acquired = acquisition()
    const port = createPlatformPrelockedSessionPort()
    let retained: Parameters<typeof resolvePlatformPrelockedSession>[0] | undefined

    await port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().instanceReset(acquired.acquire),
      async (lease) => {
        retained = lease
        expect(() => resolvePlatformPrelockedSession(lease, 'subject-deletion')).toThrow(
          expect.objectContaining({ code: 'uow.prelocked-session-invalid' }),
        )
        const first = resolvePlatformPrelockedSession(lease, 'instance-reset')
        expect(() => resolvePlatformPrelockedSession(lease, 'instance-reset')).toThrow(
          expect.objectContaining({ code: 'uow.prelocked-session-invalid' }),
        )
        first.finish()
        const second = resolvePlatformPrelockedSession(lease, 'instance-reset')
        second.finish()
      },
    )

    const revoked = retained
    if (!revoked) throw new Error('lease was not retained')
    expect(() => resolvePlatformPrelockedSession(revoked, 'instance-reset')).toThrow(
      expect.objectContaining({ code: 'uow.prelocked-session-invalid' }),
    )
  })

  it('preserves callback error identity and consumes each intent once', async () => {
    const acquired = acquisition()
    const port = createPlatformPrelockedSessionPort()
    const intent = createPlatformPrelockedSessionIntentFactory().memberResetIssue(
      acquired.acquire,
    )
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
    const acquired = acquisition()
    const port = createPlatformPrelockedSessionPort()
    const destroyError = new Error('connection uncertain')

    await expect(
      port.withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().ownerRecoveryIssue(
          acquired.acquire,
        ),
        async (lease) => {
          const resolved = resolvePlatformPrelockedSession(lease, 'owner-recovery-issue')
          resolved.destroy(destroyError)
          resolved.finish()
        },
      ),
    ).rejects.toMatchObject({ code: 'uow.connection-lost' })

    expect(acquired.closedWith).toEqual([destroyError])
  })

  it('detects a UoW that outlives the outer credential scope', async () => {
    const acquired = acquisition()
    const port = createPlatformPrelockedSessionPort()

    await expect(
      port.withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().subjectDeletion(acquired.acquire),
        async (lease) => {
          resolvePlatformPrelockedSession(lease, 'subject-deletion')
          return 'detached'
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

    await expect(
      port.withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().subjectDeletion(acquired.acquire),
        async (lease) => {
          const resolved = resolvePlatformPrelockedSession(lease, 'subject-deletion')
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

    await expect(
      port.withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().subjectDeletion(acquired.acquire),
        async (lease) => {
          resolvePlatformPrelockedSession(lease, 'subject-deletion')
          void bindPrelockedSessionExecution(lease, new Promise<never>(() => undefined))
          return 'detached'
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
    await expect(
      port.withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().checkedSignOut(acquired.acquire),
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
    cancelled.acquire.mockImplementationOnce(async () => {
      controller.abort()
      return { client: cancelled.client, close: cancelled.close }
    })
    await expect(
      createPlatformPrelockedSessionPort().withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().emailSignIn(cancelled.acquire),
        async () => 'never',
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'uow.cancelled' })
    expect(cancelled.closedWith).toEqual([
      expect.objectContaining({ code: 'uow.cancelled' }),
    ])
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
    let markCloseStarted: () => void = () => undefined
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve
    })
    let releaseClose: () => void = () => undefined
    const closeBarrier = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    acquired.close.mockImplementationOnce(async (destroyError) => {
      markCloseStarted()
      await closeBarrier
      acquired.closedWith.push(destroyError())
    })

    const result = port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().checkedSignOut(acquired.acquire),
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
    await closeStarted
    expect(port.activeLeaseScopeCount()).toBe(1)
    releaseClose()

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
    const acquired = acquisition()
    const port = createPlatformPrelockedSessionPort()
    const uncertainty = new Error('inner transaction state is uncertain')
    let releaseCallback: () => void = () => undefined
    const callbackBarrier = new Promise<void>((resolve) => {
      releaseCallback = resolve
    })

    const result = port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().ownerRecoveryIssue(acquired.acquire),
      async (lease) => {
        const resolved = resolvePlatformPrelockedSession(lease, 'owner-recovery-issue')
        resolved.destroy(uncertainty)
        resolved.finish()
        await callbackBarrier
        return 'late callback result'
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
    expect(port.activeLeaseScopeCount()).toBe(0)
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
    acquired.close.mockImplementationOnce(async (destroyError) => {
      markCloseStarted()
      await closeBarrier
      acquired.closedWith.push(destroyError())
    })

    const result = port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().checkedSignOut(acquired.acquire),
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
    acquired.close.mockImplementationOnce(async (destroyError) => {
      markCloseStarted()
      await closeBarrier
      acquired.closedWith.push(destroyError())
    })

    const result = port.withPrelockedSessionLease(
      createPlatformPrelockedSessionIntentFactory().emailSignIn(acquired.acquire),
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

  it('fails before acquisition when cancellation is already signalled', async () => {
    const acquired = acquisition()
    const controller = new AbortController()
    controller.abort()

    await expect(
      createPlatformPrelockedSessionPort().withPrelockedSessionLease(
        createPlatformPrelockedSessionIntentFactory().emailSignIn(acquired.acquire),
        async () => 'never',
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'uow.cancelled' })
    expect(acquired.acquire).not.toHaveBeenCalled()
  })
})
