import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoordinationError } from '@/application/coordination'
import { OwnerRecoveryError } from '@/modules/identity/recovery/owner-recovery-contract'

const mocks = vi.hoisted(() => ({
  now: new Date('2026-07-15T18:00:00.000Z'),
  epoch: '11111111-1111-4111-8111-111111111111',
  events: [] as string[],
  requests: [] as Record<string, unknown>[],
  options: [] as Record<string, unknown>[],
  preparedIssueInputs: [] as Record<string, unknown>[],
  issueCaptureGate: null as Promise<void> | null,
  capturedAuthorityOverride: null as Record<string, unknown> | null,
  commitError: null as unknown,
  cleanupError: null as unknown,
  issueRecheck: { status: 'current' } as
    | { status: 'current' }
    | { status: 'stale'; reason: string },
  redeemRecheck: { status: 'current' } as
    | { status: 'current' }
    | { status: 'stale'; reason: string },
  issueOutcome: { kind: 'issued' } as
    | { kind: 'issued' }
    | { kind: 'rejected'; reason: 'owner-mismatch' },
  redeemOutcome: {
    kind: 'redeemed',
    ownerUserId: 'owner-1',
    revokedSessionCount: 3,
  } as
    | { kind: 'redeemed'; ownerUserId: string; revokedSessionCount: number }
    | {
        kind: 'rejected'
        reason: 'owner-mismatch' | 'code-invalid' | 'credential-missing'
      },
  issueView: {
    purpose: 'owner-recovery-issue',
    expectedEpoch: '11111111-1111-4111-8111-111111111111',
    installationState: 'claimed' as 'claimed' | 'open',
    commandEnteredAt: new Date('2026-07-15T18:00:00.000Z'),
    ownerUserId: 'owner-1' as string | null,
    ownerEmailMatches: true,
    ownerCredential: 'present',
    activeVerification: null,
    hostInvocationId: 'host-invocation',
  },
  redeemView: {
    purpose: 'owner-recovery-cli-redemption',
    expectedEpoch: '11111111-1111-4111-8111-111111111111',
    installationState: 'claimed' as 'claimed' | 'open',
    commandEnteredAt: new Date('2026-07-15T18:00:00.000Z'),
    codeIdentity: 'code-identity',
    ownerUserId: 'owner-1' as string | null,
    ownerEmailMatches: true,
    ownerCredential: 'present',
    activeVerification: {
      id: 'recovery-1',
      expiresAt: new Date('2026-07-15T18:15:00.000Z'),
    },
    hostInvocationId: 'host-invocation',
  },
}))

vi.mock('@/modules/identity/infrastructure/recovery-mutation', () => ({
  captureOwnerRecoveryIssuance: vi.fn(async (_query, input) => {
    mocks.events.push(`capture:issue:${input.hostInvocationId}`)
    await mocks.issueCaptureGate
    return { kind: 'issue-capture' }
  }),
  captureOwnerRecoveryCliRedemption: vi.fn(async (_query, input) => {
    mocks.events.push(`capture:redeem:${input.codeIdentity}:${input.hostInvocationId}`)
    return { kind: 'redeem-capture' }
  }),
  ownerRecoveryIssuanceCaptureView: vi.fn(() => mocks.issueView),
  ownerRecoveryCliRedemptionCaptureView: vi.fn(() => mocks.redeemView),
  recheckOwnerRecoveryIssuance: vi.fn(async () => {
    mocks.events.push('query:recheck:issue')
    return mocks.issueRecheck
  }),
  recheckOwnerRecoveryCliRedemption: vi.fn(async () => {
    mocks.events.push('query:recheck:redeem')
    return mocks.redeemRecheck
  }),
}))

vi.mock('@/modules/identity/infrastructure/scoped-host-recovery', () => ({
  createScopedOwnerRecoveryIssuanceMutationGateway: vi.fn(() => {
    mocks.events.push('gateway:create:issue')
    return {
      issue: vi.fn(async () => {
        mocks.events.push('gateway:issue')
        return mocks.issueOutcome
      }),
    }
  }),
  createScopedOwnerRecoveryCliRedemptionMutationGateway: vi.fn(() => {
    mocks.events.push('gateway:create:redeem')
    return {
      redeem: vi.fn(async () => {
        mocks.events.push('gateway:redeem')
        return mocks.redeemOutcome
      }),
    }
  }),
}))

vi.mock('@/modules/identity/recovery/recovery-preparation', () => {
  class RecoveryPreparationError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  }
  return {
    RecoveryPreparationError,
    captureRecoveryCommandEntry: vi.fn((now: Date) => new Date(now.getTime())),
    parseOwnerRecoveryIssuanceInput: vi.fn((input) => ({
      normalizedOwnerEmail: input.ownerEmail.trim().toLowerCase(),
      ttlMinutes: input.ttlMinutes,
    })),
    prepareOwnerRecoveryIssuance: vi.fn((input) => {
      mocks.preparedIssueInputs.push(input)
      return {
        recoveryId: 'recovery-1',
        auditEventId: 'audit-1',
        ownerUserId: 'owner-1',
        normalizedOwnerEmail: 'owner@example.test',
        identifier: 'indigo:owner-recovery:owner-1',
        code: 'secret-recovery-code',
        storedValue: 'stored-recovery-code',
        commandEnteredAt: mocks.now,
        expiresAt: new Date('2026-07-15T18:15:00.000Z'),
        audit: {},
      }
    }),
    parseOwnerRecoveryHostRedemptionInput: vi.fn((input) => ({
      normalizedEmail: input.ownerEmail.trim().toLowerCase(),
      submittedCode: input.code,
      passwordHashInput: input.newPassword,
      passwordIsValid: true,
    })),
    ownerRecoveryCodeIdentity: vi.fn(() => 'code-identity'),
  }
})

vi.mock('@/platform/application-coordination/lifecycle-values', () => ({
  createInstallationMutationEpoch: vi.fn((raw: string) => ({ raw })),
  installationMutationEpochMatches: vi.fn(
    (epoch: { raw: string }, raw: string) => epoch.raw === raw,
  ),
}))

vi.mock('@/platform/application-coordination/mutation-authority', () => ({
  createPlatformMutationAuthorityIssuer: vi.fn(() => ({
    ownerRecoveryIssue: vi.fn((input) => ({
      authority: {
        kind: 'owner-recovery-issue',
        captured: {
          kind: 'owner-recovery-issue',
          expectedEpoch: input.expectedEpoch,
          expectedOwnerUserId: input.expectedOwnerUserId,
          hostInvocationId: input.hostInvocationId,
        },
      },
    })),
    ownerRecoveryCliRedemption: vi.fn((input) => ({
      authority: {
        mutation: 'owner-recovery-cli-redemption',
        captured: {
          kind: 'credential-lifecycle',
          mutation: 'owner-recovery-cli-redemption',
          expectedEpoch: input.expectedEpoch,
          targetUserId: input.expectedOwnerUserId,
          codeIdentity: input.codeIdentity,
          hostInvocationId: input.hostInvocationId,
          emailDigest: null,
          channel: 'owner-cli',
        },
      },
    })),
  })),
}))

vi.mock('@/platform/application-coordination/prelocked-session', () => ({
  createPlatformPrelockedSessionIntentFactory: vi.fn(() => ({
    ownerRecoveryIssue: vi.fn((issued) => ({ issued, purpose: 'issue' })),
    ownerRecoveryCliRedemption: vi.fn((issued) => ({ issued, purpose: 'redeem' })),
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
        mocks.events.push('uow:failure')
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
  issueOwnerRecovery,
  issueOwnerRecoveryFromHostCli,
  redeemOwnerRecovery,
} from './identity-host-recovery-mutations'

function indexOf(event: string): number {
  const index = mocks.events.indexOf(event)
  expect(index, `missing ${event}:\n${mocks.events.join('\n')}`).toBeGreaterThanOrEqual(0)
  return index
}

describe('production host owner-recovery composition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.events.length = 0
    mocks.requests.length = 0
    mocks.options.length = 0
    mocks.preparedIssueInputs.length = 0
    mocks.issueCaptureGate = null
    mocks.capturedAuthorityOverride = null
    mocks.commitError = null
    mocks.cleanupError = null
    mocks.issueRecheck = { status: 'current' }
    mocks.redeemRecheck = { status: 'current' }
    mocks.issueOutcome = { kind: 'issued' }
    mocks.redeemOutcome = {
      kind: 'redeemed',
      ownerUserId: 'owner-1',
      revokedSessionCount: 3,
    }
    mocks.issueView.installationState = 'claimed'
    mocks.issueView.ownerUserId = 'owner-1'
    mocks.issueView.hostInvocationId = 'host-invocation'
    mocks.redeemView.installationState = 'claimed'
    mocks.redeemView.ownerUserId = 'owner-1'
    mocks.redeemView.hostInvocationId = 'host-invocation'
  })

  it('issues on one external-host lifecycle after exact recheck and commit', async () => {
    await expect(
      issueOwnerRecovery({
        ownerEmail: 'Owner@Example.test',
        ttlMinutes: 15,
        now: mocks.now,
      }),
    ).resolves.toEqual({
      recoveryId: 'recovery-1',
      code: 'secret-recovery-code',
      expiresAt: new Date('2026-07-15T18:15:00.000Z'),
    })

    expect(mocks.options[0]).toMatchObject({
      hostInvocationId: 'host-invocation',
      allowTestWithoutInheritedLock: true,
    })
    expect(mocks.requests[0]).toMatchObject({
      operation: 'host-maintenance',
      productFence: 'shared',
      mode: { isolation: 'serializable', access: 'read-write' },
    })
    expect(indexOf('capture:issue:host-invocation')).toBeLessThan(
      indexOf('lease:acquired'),
    )
    expect(indexOf('query:recheck:issue')).toBeLessThan(indexOf('gateway:create:issue'))
    expect(indexOf('gateway:issue')).toBeLessThan(indexOf('uow:commit'))
    expect(indexOf('uow:commit')).toBeLessThan(indexOf('external:close'))
  })

  it('requires the inherited host lock for the production export', async () => {
    await issueOwnerRecoveryFromHostCli({
      ownerEmail: 'owner@example.test',
      ttlMinutes: 15,
      now: mocks.now,
    })
    expect(mocks.options[0]).toMatchObject({
      hostInvocationId: 'host-invocation',
      allowTestWithoutInheritedLock: false,
    })
  })

  it('binds issuance preparation to the values parsed at command entry', async () => {
    let releaseCapture: (() => void) | undefined
    mocks.issueCaptureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve
    })
    const input = {
      ownerEmail: 'Owner@Example.test',
      ttlMinutes: 15,
      now: mocks.now,
    }

    const issuing = issueOwnerRecovery(input)
    await vi.waitFor(() =>
      expect(mocks.events).toContain('capture:issue:host-invocation'),
    )
    input.ownerEmail = 'changed@example.test'
    input.ttlMinutes = 60
    releaseCapture?.()

    await expect(issuing).resolves.toMatchObject({ recoveryId: 'recovery-1' })
    expect(mocks.preparedIssueInputs).toEqual([
      {
        ownerUserId: 'owner-1',
        ownerEmail: 'owner@example.test',
        ttlMinutes: 15,
        commandEnteredAt: mocks.now,
      },
    ])
  })

  it('commits a wrong-email issuance rejection before returning its detailed error', async () => {
    mocks.issueOutcome = { kind: 'rejected', reason: 'owner-mismatch' }

    await expect(
      issueOwnerRecovery({
        ownerEmail: 'wrong@example.test',
        ttlMinutes: 15,
        now: mocks.now,
      }),
    ).rejects.toMatchObject({ code: 'owner-recovery.owner-mismatch' })
    expect(indexOf('gateway:issue')).toBeLessThan(indexOf('uow:commit'))
    expect(indexOf('uow:commit')).toBeLessThan(indexOf('external:close'))
  })

  it('redeems through the owner-only external lane without web admission', async () => {
    await expect(
      redeemOwnerRecovery({
        ownerEmail: 'owner@example.test',
        code: 'recovery-code',
        newPassword: 'replacement-password',
        now: mocks.now,
      }),
    ).resolves.toEqual({ ownerUserId: 'owner-1', revokedSessionCount: 3 })

    expect(mocks.requests[0]).toMatchObject({
      operation: 'credential-lifecycle-mutation',
      authority: {
        mutation: 'owner-recovery-cli-redemption',
        captured: {
          targetUserId: 'owner-1',
          codeIdentity: 'code-identity',
          hostInvocationId: 'host-invocation',
          emailDigest: null,
          channel: 'owner-cli',
        },
      },
      mode: { isolation: 'serializable', access: 'read-write' },
    })
    expect(indexOf('query:recheck:redeem')).toBeLessThan(indexOf('gateway:create:redeem'))
    expect(indexOf('uow:commit')).toBeLessThan(indexOf('external:close'))
  })

  it.each([
    ['owner-mismatch', 'owner-recovery.owner-mismatch'],
    ['code-invalid', 'owner-recovery.code-invalid'],
    ['credential-missing', 'owner-recovery.credential-missing'],
  ] as const)('maps committed %s only after commit', async (reason, code) => {
    mocks.redeemOutcome = { kind: 'rejected', reason }

    await expect(
      redeemOwnerRecovery({
        ownerEmail: 'owner@example.test',
        code: 'recovery-code',
        newPassword: 'replacement-password',
        now: mocks.now,
      }),
    ).rejects.toMatchObject({ code })
    expect(indexOf('uow:commit')).toBeLessThan(indexOf('external:close'))
  })

  it('rejects an open instance before authority, lease, or gateway admission', async () => {
    mocks.issueView.installationState = 'open'
    mocks.issueView.ownerUserId = null

    await expect(
      issueOwnerRecovery({
        ownerEmail: 'owner@example.test',
        ttlMinutes: 15,
        now: mocks.now,
      }),
    ).rejects.toMatchObject({ code: 'owner-recovery.instance-open' })
    expect(mocks.events).not.toContain('lease:acquired')
    expect(mocks.events).not.toContain('gateway:create:issue')
    expect(mocks.events).toContain('external:close')
  })

  it('does not claim a gateway after transactional capture drift', async () => {
    mocks.redeemRecheck = { status: 'stale', reason: 'owner-recovery-state-changed' }

    await expect(
      redeemOwnerRecovery({
        ownerEmail: 'owner@example.test',
        code: 'recovery-code',
        newPassword: 'replacement-password',
        now: mocks.now,
      }),
    ).rejects.toMatchObject({ code: 'identity.authority-stale' })
    expect(mocks.events).not.toContain('gateway:create:redeem')
  })

  it('rejects captured-authority drift before the first transaction query', async () => {
    mocks.capturedAuthorityOverride = {
      kind: 'credential-lifecycle',
      mutation: 'owner-recovery-cli-redemption',
      expectedEpoch: { raw: mocks.epoch },
      targetUserId: 'different-owner',
      codeIdentity: 'code-identity',
      hostInvocationId: 'host-invocation',
      emailDigest: null,
      channel: 'owner-cli',
    }

    await expect(
      redeemOwnerRecovery({
        ownerEmail: 'owner@example.test',
        code: 'recovery-code',
        newPassword: 'replacement-password',
        now: mocks.now,
      }),
    ).rejects.toMatchObject({ code: 'identity.authority-stale' })
    expect(mocks.events).not.toContain('query:recheck:redeem')
    expect(mocks.events).not.toContain('gateway:create:redeem')
  })

  it('propagates commit uncertainty unchanged after exactly one gateway call', async () => {
    const uncertainty = new CoordinationError('uow.commit-outcome-unknown')
    mocks.commitError = uncertainty

    await expect(
      redeemOwnerRecovery({
        ownerEmail: 'owner@example.test',
        code: 'recovery-code',
        newPassword: 'replacement-password',
        now: mocks.now,
      }),
    ).rejects.toBe(uncertainty)
    expect(mocks.events.filter((event) => event === 'gateway:redeem')).toHaveLength(1)
    expect(mocks.events).toContain('external:close')
  })

  it('does not expose a committed result when dedicated-client cleanup fails', async () => {
    const cleanup = new CoordinationError('uow.cleanup-failed')
    mocks.cleanupError = cleanup

    await expect(
      issueOwnerRecovery({
        ownerEmail: 'owner@example.test',
        ttlMinutes: 15,
        now: mocks.now,
      }),
    ).rejects.toBe(cleanup)
    expect(mocks.events).toContain('uow:commit')
    expect(mocks.events).toContain('external:close')
  })

  it('preserves the stable database-free operator error class', () => {
    const error = new OwnerRecoveryError('owner-recovery.code-invalid', 'invalid')
    expect(error).toMatchObject({ name: 'OwnerRecoveryError' })
  })
})
