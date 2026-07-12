import { describe, expect, it, vi } from 'vitest'
import {
  isAuthorizedSupervisorRequest,
  RestartSupervisor,
  type SupervisorChild,
  type SupervisorLifecycle,
} from './restart-supervisor'

type FakeChild = SupervisorChild & { readonly label: string }

function lifecycle(
  overrides: Partial<SupervisorLifecycle<FakeChild>> = {},
): SupervisorLifecycle<FakeChild> {
  let nextPid = 100
  return {
    spawnChild: vi.fn(() => {
      nextPid += 1
      return { pid: nextPid, label: `child-${nextPid}` }
    }),
    waitUntilReady: vi.fn(async () => undefined),
    stopChild: vi.fn(async () => undefined),
    forceStopChild: vi.fn(),
    ...overrides,
  }
}

describe('RestartSupervisor', () => {
  it('reports a starting child and marks its generation ready only after readiness', async () => {
    const readiness = Promise.withResolvers<void>()
    const childLifecycle = lifecycle({
      waitUntilReady: vi.fn(() => readiness.promise),
    })
    const supervisor = new RestartSupervisor(childLifecycle)

    const started = supervisor.start()
    await vi.waitFor(() => {
      expect(supervisor.state()).toEqual({
        phase: 'starting',
        generation: 1,
        pid: 101,
      })
    })

    readiness.resolve()

    await expect(started).resolves.toEqual({
      phase: 'ready',
      generation: 1,
      pid: 101,
    })
  })

  it('serializes a deterministic stop, spawn, and readiness cycle on restart', async () => {
    const events: string[] = []
    let nextPid = 200
    const childLifecycle = lifecycle({
      spawnChild: vi.fn(() => {
        nextPid += 1
        events.push(`spawn:${nextPid}`)
        return { pid: nextPid, label: `child-${nextPid}` }
      }),
      waitUntilReady: vi.fn(async (child) => {
        events.push(`ready:${child.pid}`)
      }),
      stopChild: vi.fn(async (child) => {
        events.push(`stop:${child.pid}`)
      }),
    })
    const supervisor = new RestartSupervisor(childLifecycle)

    await supervisor.start()
    events.length = 0

    await expect(supervisor.restart()).resolves.toEqual({
      phase: 'ready',
      generation: 2,
      pid: 202,
    })
    expect(events).toEqual(['stop:201', 'spawn:202', 'ready:202'])
  })

  it('cleans up a child after failed readiness and during normal or emergency exit', async () => {
    const stopChild = vi.fn(async () => undefined)
    const forceStopChild = vi.fn()
    const failedLifecycle = lifecycle({
      waitUntilReady: vi.fn(async () => {
        throw new Error('readiness failed')
      }),
      stopChild,
      forceStopChild,
    })
    const failedSupervisor = new RestartSupervisor(failedLifecycle)

    await expect(failedSupervisor.start()).rejects.toThrow('readiness failed')
    expect(stopChild).toHaveBeenCalledWith(expect.objectContaining({ pid: 101 }))
    expect(failedSupervisor.state()).toEqual({
      phase: 'stopped',
      generation: 1,
      pid: null,
    })

    const runningLifecycle = lifecycle({ stopChild, forceStopChild })
    const runningSupervisor = new RestartSupervisor(runningLifecycle)
    await runningSupervisor.start()
    await runningSupervisor.stop()
    expect(runningSupervisor.state().phase).toBe('stopped')

    await runningSupervisor.start()
    runningSupervisor.forceStop()
    expect(forceStopChild).toHaveBeenCalledWith(expect.objectContaining({ pid: 102 }))
    expect(runningSupervisor.state().pid).toBeNull()
  })
})

describe('supervisor control authorization', () => {
  const token = 'a-test-token-that-is-long-enough-to-stay-secret'

  it.each([
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
  ])('accepts a matching bearer token from loopback %s', (remoteAddress) => {
    expect(
      isAuthorizedSupervisorRequest(
        { remoteAddress, authorization: `Bearer ${token}` },
        token,
      ),
    ).toBe(true)
  })

  it.each([
    ['192.0.2.10', `Bearer ${token}`],
    ['127.0.0.1', 'Bearer wrong-token'],
    ['127.0.0.1', undefined],
  ])('rejects remote or unauthenticated control access', (remoteAddress, authorization) => {
    expect(isAuthorizedSupervisorRequest({ remoteAddress, authorization }, token)).toBe(
      false,
    )
  })
})
