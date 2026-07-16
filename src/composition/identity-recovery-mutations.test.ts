import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoordinationError } from '@/application/coordination'
import { CredentialConnectionCapacityError } from '@/platform/db/credential-connections'

type RecordedRequest = Readonly<{
  operation: string
  authority: Readonly<{
    mutation: string
    captured: Record<string, unknown>
  }>
  session: Readonly<{ lease: object }>
  mode: Readonly<{ isolation: string; access: string }>
}>

const mocks = vi.hoisted(() => {
  const commandEnteredAt = new Date('2026-07-15T14:00:00.000Z')
  return {
    commandEnteredAt,
    events: [] as string[],
    requests: [] as RecordedRequest[],
    leases: [] as object[],
    captureError: null as unknown,
    prelockError: null as unknown,
    commitError: null as unknown,
    bindingAccepted: true,
    capturedAuthorityOverride: null as Record<string, unknown> | null,
    memberRecheck: { status: 'current' } as
      | { status: 'current' }
      | { status: 'stale'; reason: string },
    ownerRecheck: { status: 'current' } as
      | { status: 'current' }
      | { status: 'stale'; reason: string },
    memberOutcome: {
      kind: 'redeemed',
      targetUserId: 'member-1',
      revokedSessionCount: 2,
    } as
      | { kind: 'redeemed'; targetUserId: string; revokedSessionCount: number }
      | { kind: 'rejected'; persistence: 'unchanged' | 'committed' },
    ownerOutcome: {
      kind: 'redeemed',
      ownerUserId: 'owner-1',
      revokedSessionCount: 1,
    } as
      | { kind: 'redeemed'; ownerUserId: string; revokedSessionCount: number }
      | { kind: 'rejected'; persistence: 'unchanged' | 'committed' },
    memberCommand: {
      actionBinding: 'member-binding',
      email: ' Member@Example.test ',
      code: 'member-code',
      newPassword: 'replacement-password',
      confirmation: 'replacement-password',
      commandEnteredAt,
      requestContext: { channel: 'web' as const, clientAddress: '198.51.100.7' },
    },
    ownerCommand: {
      actionBinding: 'owner-binding',
      email: 'wrong-owner@example.test',
      code: 'owner-code',
      newPassword: 'replacement-password',
      confirmation: 'replacement-password',
      commandEnteredAt,
      requestContext: { channel: 'web' as const, clientAddress: '198.51.100.8' },
    },
    memberView: {
      purpose: 'member-reset-redemption',
      expectedEpoch: '11111111-1111-4111-8111-111111111111',
      installationState: 'claimed' as 'claimed' | 'open',
      commandEnteredAt,
      codeIdentity: 'member-identity',
      targetUserId: 'member-1' as string | null,
      targetState: 'member',
      targetCredential: 'present',
      activeVerification: {
        id: 'member-verification-1',
        expiresAt: new Date('2026-07-15T14:15:00.000Z'),
      },
    },
    ownerView: {
      purpose: 'owner-recovery-web-redemption',
      expectedEpoch: '11111111-1111-4111-8111-111111111111',
      installationState: 'claimed' as 'claimed' | 'open',
      commandEnteredAt,
      codeIdentity: 'owner-identity',
      ownerUserId: 'owner-1' as string | null,
      ownerEmailMatches: false,
      ownerCredential: 'present',
      activeVerification: {
        id: 'owner-verification-1',
        expiresAt: new Date('2026-07-15T14:15:00.000Z'),
      },
      hostInvocationId: null,
    },
  }
})

vi.mock('@/modules/identity/server/recovery-redemption-command', () => ({
  memberResetRedemptionMutationCommandView: vi.fn(() => mocks.memberCommand),
  ownerRecoveryRedemptionMutationCommandView: vi.fn(() => mocks.ownerCommand),
}))

vi.mock('@/modules/identity/infrastructure/action-binding', () => ({
  verifyMemberResetRedemptionActionBinding: vi.fn((_binding, _context, now) => {
    mocks.events.push(`binding:member:${now.toISOString()}`)
    return mocks.bindingAccepted
  }),
  verifyOwnerRecoveryRedemptionActionBinding: vi.fn((_binding, _context, now) => {
    mocks.events.push(`binding:owner:${now.toISOString()}`)
    return mocks.bindingAccepted
  }),
}))

vi.mock('@/modules/identity/infrastructure/credential-digests', () => ({
  credentialEmailLockDigest: vi.fn((email: string) => `digest:${email}`),
}))

vi.mock('@/modules/identity/infrastructure/recovery-mutation', () => ({
  captureMemberResetRedemption: vi.fn(async (_query, input) => {
    mocks.events.push(
      `capture:member:${input.normalizedEmail}:${input.codeIdentity}:${input.commandEnteredAt.toISOString()}`,
    )
    return { capture: 'member' }
  }),
  captureOwnerRecoveryWebRedemption: vi.fn(async (_query, input) => {
    mocks.events.push(
      `capture:owner:${input.normalizedEmail}:${input.codeIdentity}:${input.commandEnteredAt.toISOString()}`,
    )
    return { capture: 'owner' }
  }),
  memberResetRedemptionCaptureView: vi.fn(() => mocks.memberView),
  ownerRecoveryWebRedemptionCaptureView: vi.fn(() => mocks.ownerView),
  recheckMemberResetRedemption: vi.fn(async () => {
    mocks.events.push('query:recheck:member')
    return mocks.memberRecheck
  }),
  recheckOwnerRecoveryWebRedemption: vi.fn(async () => {
    mocks.events.push('query:recheck:owner')
    return mocks.ownerRecheck
  }),
}))

vi.mock('@/modules/identity/infrastructure/scoped-browser-recovery', () => ({
  createScopedMemberResetRedemptionMutationGateway: vi.fn(() => {
    mocks.events.push('gateway:create:member')
    return {
      redeem: vi.fn(async (input) => {
        mocks.events.push(
          `gateway:redeem:member:${input.parsed.normalizedEmail}:${input.parsed.passwordIsValid}`,
        )
        return mocks.memberOutcome
      }),
    }
  }),
  createScopedOwnerRecoveryWebRedemptionMutationGateway: vi.fn(() => {
    mocks.events.push('gateway:create:owner')
    return {
      redeem: vi.fn(async (input) => {
        mocks.events.push(
          `gateway:redeem:owner:${input.parsed.normalizedEmail}:${input.parsed.passwordIsValid}`,
        )
        return mocks.ownerOutcome
      }),
    }
  }),
}))

vi.mock('@/modules/identity/recovery/recovery-preparation', () => ({
  parseMemberResetRedemptionInput: vi.fn((input) => ({
    normalizedEmail: String(input.email).trim().toLowerCase(),
    submittedCode: String(input.code),
    passwordHashInput: input.newPassword || 'dummy-member-password',
    passwordIsValid: String(input.newPassword).length >= 12,
  })),
  parseOwnerRecoveryWebRedemptionInput: vi.fn((input) => ({
    normalizedEmail: String(input.ownerEmail).trim().toLowerCase(),
    submittedCode: String(input.code),
    passwordHashInput: input.newPassword || 'dummy-owner-password',
    passwordIsValid: String(input.newPassword).length >= 12,
  })),
  memberResetCodeIdentity: vi.fn((code: string) => `member-id:${code}`),
  ownerRecoveryCodeIdentity: vi.fn((code: string) => `owner-id:${code}`),
}))

vi.mock('@/platform/application-coordination/lifecycle-values', () => ({
  createInstallationMutationEpoch: vi.fn((raw: string) => ({ raw })),
  installationMutationEpochMatches: vi.fn(
    (epoch: { raw: string }, raw: string) => epoch.raw === raw,
  ),
}))

vi.mock('@/platform/application-coordination/mutation-authority', () => ({
  createPlatformMutationAuthorityIssuer: vi.fn(() => ({
    memberResetRedemption: vi.fn((input) => {
      const captured = {
        kind: 'credential-lifecycle',
        mutation: 'member-reset-redemption',
        expectedEpoch: input.expectedEpoch,
        codeIdentity: input.codeIdentity,
        emailDigest: input.emailDigest,
        targetUserId: input.targetUserId,
        hostInvocationId: null,
        channel: 'member',
      }
      return {
        authority: { mutation: 'member-reset-redemption', captured },
      }
    }),
    ownerRecoveryWebRedemption: vi.fn((input) => {
      const captured = {
        kind: 'credential-lifecycle',
        mutation: 'owner-recovery-web-redemption',
        expectedEpoch: input.expectedEpoch,
        codeIdentity: input.codeIdentity,
        emailDigest: input.emailDigest,
        targetUserId: input.expectedOwnerUserId,
        hostInvocationId: null,
        channel: 'owner-web',
      }
      return {
        authority: { mutation: 'owner-recovery-web-redemption', captured },
      }
    }),
  })),
}))

vi.mock('@/platform/application-coordination/prelocked-session', () => ({
  createPlatformPrelockedSessionIntentFactory: vi.fn(() => ({
    memberResetRedemption: vi.fn((issued) => ({ issued })),
    ownerRecoveryWebRedemption: vi.fn((issued) => ({ issued })),
  })),
  createPlatformPrelockedSessionPort: vi.fn(() => ({
    withPrelockedSessionLease: vi.fn(async (_intent, callback) => {
      if (mocks.prelockError) throw mocks.prelockError
      const lease = Object.freeze({ lease: mocks.leases.length + 1 })
      mocks.leases.push(lease)
      mocks.events.push('lease:acquired')
      try {
        return await callback(lease)
      } finally {
        mocks.events.push('lease:released')
      }
    }),
  })),
}))

vi.mock('@/platform/application-coordination/runtime-unit-of-work', () => ({
  createRuntimePostgresUnitOfWork: vi.fn((createGatewayContext) => ({
    run: vi.fn(async (request, callback) => {
      mocks.requests.push(request)
      mocks.events.push(`uow:begin:${request.authority.mutation}`)
      const capturedAuthority =
        mocks.capturedAuthorityOverride ?? request.authority.captured
      const context = createGatewayContext({
        client: { query: vi.fn() },
        request,
        capturedAuthority,
        markReauthenticationSucceeded: vi.fn(),
        requireWriteAuthorized: vi.fn(),
        exactReplayAuthorizer: null,
        newCommandAuthorizer: null,
      })
      try {
        mocks.events.push('uow:recheck')
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

vi.mock('@/platform/db/credential-connections', () => {
  class CredentialConnectionCapacityError extends Error {}
  return {
    CredentialConnectionCapacityError,
    withSubmittedEmailCredentialCapture: vi.fn(async (callback) => {
      mocks.events.push('capture:lease')
      if (mocks.captureError) throw mocks.captureError
      return callback({ query: vi.fn() })
    }),
  }
})

import { getProductionIdentityRecoveryMutationPort } from './identity-recovery-mutations'

function eventIndex(event: string): number {
  const index = mocks.events.indexOf(event)
  expect(
    index,
    `missing event: ${event}\n${mocks.events.join('\n')}`,
  ).toBeGreaterThanOrEqual(0)
  return index
}

describe('production browser-recovery composition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.events.length = 0
    mocks.requests.length = 0
    mocks.leases.length = 0
    mocks.captureError = null
    mocks.prelockError = null
    mocks.commitError = null
    mocks.bindingAccepted = true
    mocks.capturedAuthorityOverride = null
    mocks.memberRecheck = { status: 'current' }
    mocks.ownerRecheck = { status: 'current' }
    mocks.memberView.installationState = 'claimed'
    mocks.ownerView.installationState = 'claimed'
    mocks.ownerView.ownerUserId = 'owner-1'
    mocks.memberCommand.confirmation = mocks.memberCommand.newPassword
    mocks.ownerCommand.confirmation = mocks.ownerCommand.newPassword
    mocks.memberOutcome = {
      kind: 'redeemed',
      targetUserId: 'member-1',
      revokedSessionCount: 2,
    }
    mocks.ownerOutcome = {
      kind: 'redeemed',
      ownerUserId: 'owner-1',
      revokedSessionCount: 1,
    }
  })

  it('redeems a member only after the first-query recheck and serializable commit', async () => {
    await expect(
      getProductionIdentityRecoveryMutationPort().redeemMemberReset({} as never),
    ).resolves.toEqual({
      kind: 'redeemed',
      targetUserId: 'member-1',
      revokedSessionCount: 2,
    })

    expect(mocks.requests).toHaveLength(1)
    expect(mocks.requests[0]).toMatchObject({
      operation: 'credential-lifecycle-mutation',
      mode: { isolation: 'serializable', access: 'read-write' },
      authority: {
        mutation: 'member-reset-redemption',
        captured: {
          emailDigest: 'digest:member@example.test',
          targetUserId: 'member-1',
          channel: 'member',
        },
      },
    })
    expect(mocks.requests[0]?.session.lease).toBe(mocks.leases[0])
    expect(eventIndex('query:recheck:member')).toBeLessThan(
      eventIndex('gateway:create:member'),
    )
    expect(eventIndex('gateway:redeem:member:member@example.test:true')).toBeLessThan(
      eventIndex('uow:commit'),
    )
    expect(eventIndex('uow:commit')).toBeLessThan(eventIndex('lease:released'))
  })

  it('locks the installed owner even when the submitted owner email does not match', async () => {
    mocks.ownerOutcome = { kind: 'rejected', persistence: 'committed' }

    await expect(
      getProductionIdentityRecoveryMutationPort().redeemOwnerRecovery({} as never),
    ).resolves.toEqual({
      kind: 'rejected',
      message: 'The email, code, or password was not accepted.',
    })
    expect(mocks.requests[0]?.authority.captured).toMatchObject({
      emailDigest: 'digest:wrong-owner@example.test',
      targetUserId: 'owner-1',
      channel: 'owner-web',
    })
    expect(eventIndex('query:recheck:owner')).toBeLessThan(
      eventIndex('gateway:create:owner'),
    )
    expect(mocks.events).toContain('uow:commit')
  })

  it.each([
    'member',
    'owner',
  ] as const)('returns stale for an invalid %s binding before authority or prelock admission', async (purpose) => {
    mocks.bindingAccepted = false
    const port = getProductionIdentityRecoveryMutationPort()
    const result =
      purpose === 'member'
        ? port.redeemMemberReset({} as never)
        : port.redeemOwnerRecovery({} as never)

    await expect(result).resolves.toEqual({ kind: 'stale' })
    expect(mocks.leases).toHaveLength(0)
    expect(mocks.requests).toHaveLength(0)
    expect(mocks.events[0]).toBe('capture:lease')
  })

  it('maps submitted-email capture capacity to the canonical failure', async () => {
    mocks.captureError = new CredentialConnectionCapacityError({} as never)

    await expect(
      getProductionIdentityRecoveryMutationPort().redeemMemberReset({} as never),
    ).resolves.toEqual({
      kind: 'rejected',
      message: 'The email, code, or password was not accepted.',
    })
    expect(mocks.leases).toHaveLength(0)
  })

  it.each([
    'uow.capacity',
    'uow.lock-timeout',
  ] as const)('maps prelock %s admission to the canonical failure', async (code) => {
    mocks.prelockError = new CoordinationError(code)

    await expect(
      getProductionIdentityRecoveryMutationPort().redeemOwnerRecovery({} as never),
    ).resolves.toEqual({
      kind: 'rejected',
      message: 'The email, code, or password was not accepted.',
    })
    expect(mocks.requests).toHaveLength(0)
  })

  it('surfaces a post-entry lock timeout after one invocation', async () => {
    const lockTimeout = new CoordinationError('uow.lock-timeout')
    mocks.ownerOutcome = {
      get kind(): never {
        throw lockTimeout
      },
    } as never

    await expect(
      getProductionIdentityRecoveryMutationPort().redeemOwnerRecovery({} as never),
    ).rejects.toBe(lockTimeout)
    expect(
      mocks.events.filter(
        (event) => event === 'gateway:redeem:owner:wrong-owner@example.test:true',
      ),
    ).toHaveLength(1)
    expect(mocks.events).toContain('lease:acquired')
    expect(mocks.events).toContain('uow:failure')
  })

  it('surfaces post-binding recheck drift without invoking or claiming the gateway', async () => {
    mocks.memberRecheck = {
      status: 'stale',
      reason: 'member-reset-state-changed',
    }

    await expect(
      getProductionIdentityRecoveryMutationPort().redeemMemberReset({} as never),
    ).rejects.toMatchObject({ code: 'identity.authority-stale' })
    expect(mocks.events).not.toContain('gateway:create:member')
    expect(mocks.events).toContain('uow:failure')
  })

  it('surfaces captured-authority mismatches before the first transactional query', async () => {
    mocks.capturedAuthorityOverride = {
      kind: 'credential-lifecycle',
      mutation: 'owner-recovery-web-redemption',
      expectedEpoch: { raw: mocks.ownerView.expectedEpoch },
      codeIdentity: mocks.ownerView.codeIdentity,
      emailDigest: 'digest:wrong-owner@example.test',
      targetUserId: 'different-owner',
      hostInvocationId: null,
      channel: 'owner-web',
    }

    await expect(
      getProductionIdentityRecoveryMutationPort().redeemOwnerRecovery({} as never),
    ).rejects.toMatchObject({ code: 'identity.authority-stale' })
    expect(mocks.events).not.toContain('query:recheck:owner')
    expect(mocks.events).not.toContain('gateway:create:owner')
  })

  it('does not flatten or retry a transaction failure after the gateway starts', async () => {
    const serializationFailure = Object.assign(new Error('serialization failure'), {
      code: '40001',
    })
    mocks.memberOutcome = {
      get kind(): never {
        throw serializationFailure
      },
    } as never

    await expect(
      getProductionIdentityRecoveryMutationPort().redeemMemberReset({} as never),
    ).rejects.toBe(serializationFailure)
    expect(
      mocks.events.filter(
        (event) => event === 'gateway:redeem:member:member@example.test:true',
      ),
    ).toHaveLength(1)
  })

  it('surfaces commit uncertainty after one invocation instead of returning success', async () => {
    mocks.commitError = new CoordinationError('uow.commit-outcome-unknown')

    await expect(
      getProductionIdentityRecoveryMutationPort().redeemOwnerRecovery({} as never),
    ).rejects.toBe(mocks.commitError)
    expect(
      mocks.events.filter(
        (event) => event === 'gateway:redeem:owner:wrong-owner@example.test:true',
      ),
    ).toHaveLength(1)
    expect(mocks.events).not.toContain('uow:commit')
  })

  it('turns a password confirmation mismatch into bounded dummy work', async () => {
    mocks.memberCommand.confirmation = 'different-password'
    mocks.memberOutcome = { kind: 'rejected', persistence: 'committed' }

    await expect(
      getProductionIdentityRecoveryMutationPort().redeemMemberReset({} as never),
    ).resolves.toMatchObject({ kind: 'rejected' })
    expect(mocks.events).toContain('gateway:redeem:member:member@example.test:false')
  })
})
