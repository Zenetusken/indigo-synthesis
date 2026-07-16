import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoordinationError } from '@/application/coordination'

const mocks = vi.hoisted(() => ({
  epoch: '11111111-1111-4111-8111-111111111111',
  cutoff: new Date('2026-07-15T18:00:00.000Z'),
  expiry: '2026-07-14T18:00:00.000000Z',
  events: [] as string[],
  requests: [] as Record<string, unknown>[],
  captureInputs: [] as Record<string, unknown>[],
  options: [] as Record<string, unknown>[],
  capturedAuthorityOverride: null as Record<string, unknown> | null,
  commitError: null as unknown,
  cleanupError: null as unknown,
  recheck: { status: 'current' } as
    | { status: 'current' }
    | { status: 'stale'; reason: string },
  view: {
    purpose: 'expired-session-maintenance',
    expectedEpoch: '11111111-1111-4111-8111-111111111111',
    ownerUserId: 'owner-1' as string | null,
    hostInvocationId: 'host-invocation',
    authorityCursor: null as string | null,
    batchSize: 2,
    capturedSessionCount: 2,
    resolvedAccountUserIds: ['account-z', 'account-a'],
  },
  page: {
    deletedSessionCount: 2,
    complete: false,
    last: {
      expiresAt: '2026-07-14T18:00:00.000000Z',
      id: 'provider-session-not-a-uuid',
    },
  } as {
    deletedSessionCount: number
    complete: boolean
    last: { expiresAt: string; id: string } | null
  },
}))

vi.mock('@/modules/identity/infrastructure/expired-session-maintenance', () => ({
  captureExpiredSessionMaintenance: vi.fn(async (_query, input) => {
    mocks.events.push('capture')
    mocks.captureInputs.push(input)
    return { kind: 'maintenance-capture' }
  }),
  expiredSessionMaintenanceCaptureView: vi.fn(() => mocks.view),
  recheckExpiredSessionMaintenance: vi.fn(async () => {
    mocks.events.push('query:recheck')
    return mocks.recheck
  }),
}))

vi.mock('@/modules/identity/infrastructure/scoped-expired-session-maintenance', () => ({
  createScopedExpiredSessionMaintenanceMutationGateway: vi.fn(() => {
    mocks.events.push('gateway:create')
    return {
      deleteCapturedPage: vi.fn(async () => {
        mocks.events.push('gateway:delete')
        return mocks.page
      }),
    }
  }),
}))

vi.mock('@/platform/application-coordination/lifecycle-values', () => ({
  createInstallationMutationEpoch: vi.fn((raw: string) => ({ raw })),
  installationMutationEpochMatches: vi.fn(
    (epoch: { raw: string }, raw: string) => epoch.raw === raw,
  ),
}))

vi.mock('@/platform/application-coordination/mutation-authority', () => ({
  createPlatformMutationAuthorityIssuer: vi.fn(() => ({
    expiredSessionMaintenance: vi.fn((input) => {
      const resolvedAccountUserIds = [...input.resolvedAccountUserIds].sort()
      return {
        authority: {
          kind: 'expired-session-maintenance',
          cursor: input.cursor,
          batchSize: input.batchSize,
          captured: {
            kind: 'expired-session-maintenance',
            expectedEpoch: input.expectedEpoch,
            expectedOwnerUserId: input.expectedOwnerUserId,
            hostInvocationId: input.hostInvocationId,
            cursor: input.cursor,
            batchSize: input.batchSize,
            resolvedAccountUserIds,
          },
        },
      }
    }),
  })),
}))

vi.mock('@/platform/application-coordination/prelocked-session', () => ({
  createPlatformPrelockedSessionIntentFactory: vi.fn(() => ({
    expiredSessionMaintenance: vi.fn((issued) => ({ issued })),
  })),
}))

vi.mock('@/platform/application-coordination/runtime-unit-of-work', () => ({
  createRuntimePostgresUnitOfWork: vi.fn((createGatewayContext) => ({
    run: vi.fn(async (request, callback) => {
      mocks.requests.push(request)
      mocks.events.push('uow:begin')
      const context = createGatewayContext({
        client: { query: vi.fn() },
        request,
        capturedAuthority: mocks.capturedAuthorityOverride ?? request.authority.captured,
        markReauthenticationSucceeded: vi.fn(),
        requireWriteAuthorized: vi.fn(),
        exactReplayAuthorizer: null,
        newCommandAuthorizer: null,
      })
      try {
        await context.recheckIdentity()
        const result = await callback({
          gateways: { ...context.readGateways, ...context.writeGateways },
        })
        if (mocks.commitError) throw mocks.commitError
        mocks.events.push('uow:commit')
        return result
      } catch (error) {
        mocks.events.push('uow:rollback')
        throw error
      }
    }),
  })),
}))

vi.mock('@/platform/application-coordination/scoped-drizzle', () => ({
  createScopedDrizzleDatabase: vi.fn((client) => ({ client })),
}))

vi.mock('@/platform/db/external-host-command', () => ({
  withExternalHostCommand: vi.fn(async (options, capture, run) => {
    mocks.options.push(options)
    mocks.events.push('external:open')
    let result: unknown
    let failure: unknown
    try {
      const captured = await capture({ query: vi.fn() })
      const prelockedSessions = {
        withPrelockedSessionLease: vi.fn(async (_intent, callback) => {
          mocks.events.push('lease:acquired')
          try {
            return await callback({ lease: 'external-host' })
          } finally {
            mocks.events.push('lease:released')
          }
        }),
      }
      result = await run(captured, prelockedSessions)
    } catch (error) {
      failure = error
    }
    mocks.events.push('external:close')
    if (mocks.cleanupError) throw mocks.cleanupError
    if (failure) throw failure
    return result
  }),
}))

vi.mock('@/platform/ids/uuid-v7', () => ({
  newUuidV7: vi.fn(() => 'host-invocation'),
}))

import {
  cleanupExpiredSessions,
  cleanupExpiredSessionsFromHostCli,
} from './identity-session-maintenance'

function eventIndex(event: string): number {
  const index = mocks.events.indexOf(event)
  expect(index, `missing ${event}:\n${mocks.events.join('\n')}`).toBeGreaterThanOrEqual(0)
  return index
}

describe('production expired-session maintenance composition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.events.length = 0
    mocks.requests.length = 0
    mocks.captureInputs.length = 0
    mocks.options.length = 0
    mocks.capturedAuthorityOverride = null
    mocks.commitError = null
    mocks.cleanupError = null
    mocks.recheck = { status: 'current' }
    mocks.view.ownerUserId = 'owner-1'
    mocks.view.hostInvocationId = 'host-invocation'
    mocks.view.authorityCursor = null
    mocks.view.batchSize = 2
    mocks.view.resolvedAccountUserIds = ['account-z', 'account-a']
    mocks.page = {
      deletedSessionCount: 2,
      complete: false,
      last: { expiresAt: mocks.expiry, id: 'provider-session-not-a-uuid' },
    }
  })

  it('commits one deterministic page before closing its external-host client', async () => {
    const result = await cleanupExpiredSessions({ batchSize: 2, now: mocks.cutoff })

    expect(result).toMatchObject({ status: 'continue', deletedCount: 2 })
    expect(mocks.captureInputs).toEqual([
      {
        hostInvocationId: 'host-invocation',
        authorityCursor: null,
        cutoff: mocks.cutoff,
        seek: null,
        batchSize: 2,
      },
    ])
    expect(mocks.options[0]).toEqual({
      hostInvocationId: 'host-invocation',
      allowTestWithoutInheritedLock: true,
    })
    expect(mocks.requests[0]).toMatchObject({
      operation: 'host-maintenance',
      authority: { kind: 'expired-session-maintenance', batchSize: 2 },
      productFence: 'shared',
      subjectLock: null,
      content: { kind: 'none' },
      mode: { isolation: 'read-committed', access: 'read-write' },
    })
    expect(eventIndex('capture')).toBeLessThan(eventIndex('lease:acquired'))
    expect(eventIndex('query:recheck')).toBeLessThan(eventIndex('gateway:create'))
    expect(eventIndex('gateway:delete')).toBeLessThan(eventIndex('uow:commit'))
    expect(eventIndex('uow:commit')).toBeLessThan(eventIndex('external:close'))
  })

  it('requires the inherited lock for the production CLI export', async () => {
    await cleanupExpiredSessionsFromHostCli({ batchSize: 2, now: mocks.cutoff })
    expect(mocks.options[0]).toMatchObject({
      hostInvocationId: 'host-invocation',
      allowTestWithoutInheritedLock: false,
    })
  })

  it('refuses an open installation before lease or gateway admission', async () => {
    mocks.view.ownerUserId = null
    await expect(
      cleanupExpiredSessions({ batchSize: 2, now: mocks.cutoff }),
    ).rejects.toMatchObject({
      code: 'expired-session-maintenance.instance-open',
    })
    expect(mocks.events).not.toContain('lease:acquired')
    expect(mocks.events).not.toContain('gateway:create')
    expect(mocks.events).toContain('external:close')
  })

  it('spends stale capture drift before creating or invoking a writer', async () => {
    mocks.recheck = { status: 'stale', reason: 'session-page-changed' }
    await expect(
      cleanupExpiredSessions({ batchSize: 2, now: mocks.cutoff }),
    ).rejects.toMatchObject({ code: 'expired-session-maintenance.stale' })
    expect(mocks.events).toContain('query:recheck')
    expect(mocks.events).not.toContain('gateway:create')
    expect(mocks.events).not.toContain('gateway:delete')
  })

  it('rejects every captured authority binding drift before the first Identity query', async () => {
    const canonicalAuthority = {
      kind: 'expired-session-maintenance',
      expectedEpoch: { raw: mocks.epoch },
      expectedOwnerUserId: 'owner-1',
      hostInvocationId: 'host-invocation',
      cursor: null,
      batchSize: 2,
      resolvedAccountUserIds: ['account-a', 'account-z'],
    }
    const drifts = [
      { expectedEpoch: { raw: '22222222-2222-4222-8222-222222222222' } },
      { expectedOwnerUserId: 'different-owner' },
      { hostInvocationId: 'different-invocation' },
      { cursor: 'different-cursor' },
      { batchSize: 3 },
      { resolvedAccountUserIds: ['account-a'] },
      { resolvedAccountUserIds: ['account-z', 'account-a'] },
    ]

    for (const drift of drifts) {
      mocks.events.length = 0
      mocks.capturedAuthorityOverride = { ...canonicalAuthority, ...drift }
      await expect(
        cleanupExpiredSessions({ batchSize: 2, now: mocks.cutoff }),
      ).rejects.toMatchObject({ code: 'expired-session-maintenance.stale' })
      expect(mocks.events).not.toContain('query:recheck')
      expect(mocks.events).not.toContain('gateway:create')
      expect(mocks.events).not.toContain('gateway:delete')
    }
  })

  it('builds the cursor inside the transaction and rolls back an unusable continuation', async () => {
    mocks.page.last = { expiresAt: mocks.expiry, id: 'x'.repeat(513) }
    await expect(
      cleanupExpiredSessions({ batchSize: 2, now: mocks.cutoff }),
    ).rejects.toMatchObject({
      code: 'expired-session-maintenance.cursor-unavailable',
    })
    expect(mocks.events.filter((event) => event === 'gateway:delete')).toHaveLength(1)
    expect(mocks.events).toContain('uow:rollback')
    expect(mocks.events).not.toContain('uow:commit')
    expect(mocks.events).toContain('external:close')
  })

  it('preserves commit uncertainty after exactly one page attempt', async () => {
    const uncertainty = new CoordinationError('uow.commit-outcome-unknown')
    mocks.commitError = uncertainty
    await expect(
      cleanupExpiredSessions({ batchSize: 2, now: mocks.cutoff }),
    ).rejects.toBe(uncertainty)
    expect(mocks.events.filter((event) => event === 'gateway:delete')).toHaveLength(1)
    expect(mocks.events).toContain('external:close')
  })

  it('does not expose a committed page when dedicated-client cleanup fails', async () => {
    const cleanup = new CoordinationError('uow.cleanup-failed')
    mocks.cleanupError = cleanup
    await expect(
      cleanupExpiredSessions({ batchSize: 2, now: mocks.cutoff }),
    ).rejects.toBe(cleanup)
    expect(mocks.events).toContain('uow:commit')
    expect(mocks.events).toContain('external:close')
  })

  it('keeps the lock-bypassing helper unavailable outside test processes', () => {
    const original = process.env.NODE_ENV
    Reflect.set(process.env, 'NODE_ENV', 'production')
    try {
      expect(() => cleanupExpiredSessions({ batchSize: 2, now: mocks.cutoff })).toThrow(
        'restricted to tests',
      )
      expect(mocks.events).toEqual([])
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV')
      else Reflect.set(process.env, 'NODE_ENV', original)
    }
  })
})
