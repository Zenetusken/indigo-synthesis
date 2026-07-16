import { describe, expect, it } from 'vitest'
import {
  BoundedAdmissionController,
  ordinaryAdmissionQueueLimit,
  submittedEmailAdmissionQueueLimit,
  trustedAdmissionQueueLimit,
} from './admission'

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('BoundedAdmissionController', () => {
  it('admits ordinary work immediately up to capacity and preserves FIFO order', async () => {
    const admission = new BoundedAdmissionController({ capacity: 1, mode: 'fifo' })
    const active = await admission.acquire()
    const entered: string[] = []
    const first = admission.acquire().then((lease) => {
      entered.push('first')
      return lease
    })
    const second = admission.acquire().then((lease) => {
      entered.push('second')
      return lease
    })

    expect(admission.snapshot()).toEqual({
      active: 1,
      closed: false,
      queued: 2,
      queuedByPriority: { fifo: 2, 'submitted-email': 0, trusted: 0 },
    })

    active.release()
    await flushMicrotasks()
    expect(entered).toEqual(['first'])

    const firstLease = await first
    firstLease.release()
    await flushMicrotasks()
    expect(entered).toEqual(['first', 'second'])

    const secondLease = await second
    secondLease.release()
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0 })
  })

  it('caps the ordinary FIFO queue at 128 waiters', async () => {
    const admission = new BoundedAdmissionController({ capacity: 1, mode: 'fifo' })
    const active = await admission.acquire()
    const queued = Array.from({ length: ordinaryAdmissionQueueLimit }, () =>
      admission.acquire(),
    )

    expect(admission.snapshot().queued).toBe(ordinaryAdmissionQueueLimit)
    await expect(admission.acquire()).rejects.toMatchObject({
      code: 'uow.capacity',
      name: 'CoordinationError',
    })

    admission.close()
    expect(
      (await Promise.allSettled(queued)).every(
        (outcome) => outcome.status === 'rejected',
      ),
    ).toBe(true)
    active.release()
  })

  it('gives trusted work strict priority after current work and preserves FIFO per priority', async () => {
    const admission = new BoundedAdmissionController({ capacity: 1, mode: 'priority' })
    const active = await admission.acquire({ priority: 'submitted-email' })
    const entered: string[] = []
    const submittedFirst = admission
      .acquire({ priority: 'submitted-email' })
      .then((lease) => {
        entered.push('submitted-first')
        return lease
      })
    const trustedFirst = admission.acquire({ priority: 'trusted' }).then((lease) => {
      entered.push('trusted-first')
      return lease
    })
    const submittedSecond = admission
      .acquire({ priority: 'submitted-email' })
      .then((lease) => {
        entered.push('submitted-second')
        return lease
      })
    const trustedSecond = admission.acquire({ priority: 'trusted' }).then((lease) => {
      entered.push('trusted-second')
      return lease
    })

    active.release()
    await flushMicrotasks()
    expect(entered).toEqual(['trusted-first'])

    const trustedFirstLease = await trustedFirst
    trustedFirstLease.release()
    await flushMicrotasks()
    expect(entered).toEqual(['trusted-first', 'trusted-second'])

    const trustedSecondLease = await trustedSecond
    trustedSecondLease.release()
    await flushMicrotasks()
    expect(entered).toEqual(['trusted-first', 'trusted-second', 'submitted-first'])

    const submittedFirstLease = await submittedFirst
    submittedFirstLease.release()
    await flushMicrotasks()
    expect(entered).toEqual([
      'trusted-first',
      'trusted-second',
      'submitted-first',
      'submitted-second',
    ])

    const submittedSecondLease = await submittedSecond
    submittedSecondLease.release()
  })

  it('caps trusted and submitted-email queues independently at 64 waiters', async () => {
    const admission = new BoundedAdmissionController({ capacity: 1, mode: 'priority' })
    const active = await admission.acquire({ priority: 'trusted' })
    const trusted = Array.from({ length: trustedAdmissionQueueLimit }, () =>
      admission.acquire({ priority: 'trusted' }),
    )
    const submittedEmail = Array.from({ length: submittedEmailAdmissionQueueLimit }, () =>
      admission.acquire({ priority: 'submitted-email' }),
    )

    expect(admission.snapshot()).toMatchObject({
      active: 1,
      queued: trustedAdmissionQueueLimit + submittedEmailAdmissionQueueLimit,
      queuedByPriority: {
        'submitted-email': submittedEmailAdmissionQueueLimit,
        trusted: trustedAdmissionQueueLimit,
      },
    })
    await expect(admission.acquire({ priority: 'trusted' })).rejects.toMatchObject({
      code: 'uow.capacity',
      name: 'CoordinationError',
    })
    await expect(
      admission.acquire({ priority: 'submitted-email' }),
    ).rejects.toMatchObject({
      code: 'uow.capacity',
      name: 'CoordinationError',
    })

    admission.close()
    const outcomes = await Promise.allSettled([...trusted, ...submittedEmail])
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true)
    active.release()
  })

  it('removes an aborted waiter without disturbing FIFO order or leaking capacity', async () => {
    const admission = new BoundedAdmissionController({ capacity: 1, mode: 'fifo' })
    const active = await admission.acquire()
    const abortController = new AbortController()
    const cancelled = admission.acquire({ signal: abortController.signal })
    const remaining = admission.acquire()

    abortController.abort()
    await expect(cancelled).rejects.toMatchObject({
      code: 'uow.cancelled',
      name: 'CoordinationError',
    })
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 1 })

    active.release()
    const remainingLease = await remaining
    remainingLease.release()
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0 })
  })

  it('rejects an already-aborted request before consuming immediate capacity', async () => {
    const admission = new BoundedAdmissionController({ capacity: 1, mode: 'fifo' })
    const abortController = new AbortController()
    abortController.abort()

    await expect(
      admission.acquire({ signal: abortController.signal }),
    ).rejects.toMatchObject({
      code: 'uow.cancelled',
      name: 'CoordinationError',
    })
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0 })
  })

  it('makes lease release exactly once', async () => {
    const admission = new BoundedAdmissionController({ capacity: 1, mode: 'fifo' })
    const first = await admission.acquire()
    first.release()
    first.release()

    expect(admission.snapshot().active).toBe(0)
    const second = await admission.acquire()
    expect(admission.snapshot().active).toBe(1)
    second.release()
    second.release()
    expect(admission.snapshot().active).toBe(0)
  })

  it('closes idempotently, rejects queued and future work, and lets active work release', async () => {
    const admission = new BoundedAdmissionController({ capacity: 1, mode: 'fifo' })
    const active = await admission.acquire()
    const queued = admission.acquire()

    admission.close()
    admission.close()

    await expect(queued).rejects.toMatchObject({
      code: 'uow.capacity',
      name: 'CoordinationError',
    })
    await expect(admission.acquire()).rejects.toMatchObject({
      code: 'uow.capacity',
      name: 'CoordinationError',
    })
    expect(admission.snapshot()).toMatchObject({ active: 1, closed: true, queued: 0 })

    active.release()
    expect(admission.snapshot()).toMatchObject({ active: 0, closed: true, queued: 0 })
  })

  it('rejects invalid construction and missing or extraneous priorities', async () => {
    expect(() => new BoundedAdmissionController({ capacity: 0, mode: 'fifo' })).toThrow(
      'positive integer',
    )
    expect(() => new BoundedAdmissionController({ capacity: 1.5, mode: 'fifo' })).toThrow(
      'positive integer',
    )
    expect(
      () =>
        new BoundedAdmissionController({
          capacity: 1,
          mode: 'unknown' as 'fifo',
        }),
    ).toThrow('mode must be fifo or priority')

    const priority = new BoundedAdmissionController({ capacity: 1, mode: 'priority' })
    expect(() => priority.acquire()).toThrow('requires a priority')
    expect(() => priority.acquire({ priority: 'unknown' as 'trusted' })).toThrow(
      'priority must be trusted or submitted-email',
    )

    const fifo = new BoundedAdmissionController({ capacity: 1, mode: 'fifo' })
    expect(() => fifo.acquire({ priority: 'trusted' })).toThrow(
      'does not accept a priority',
    )
  })
})
