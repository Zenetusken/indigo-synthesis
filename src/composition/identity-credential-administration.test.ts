import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalUserInputError } from '@/modules/identity/application/local-users'
import { CredentialAdministrationCaptureStaleError } from '@/modules/identity/infrastructure/credential-administration-mutation'
import { CredentialConnectionCapacityError } from '@/platform/db/credential-connections'

type RecordedRequest = Readonly<{
  operation: string
  authority: Readonly<{
    purpose: string
    captured?: Record<string, unknown>
    protectedCaptured?: Record<string, unknown>
  }>
  session: Readonly<{ lease: object }>
  mode: Readonly<{ isolation: string }>
}>

const mocks = vi.hoisted(() => {
  const commandEnteredAt = new Date('2026-07-15T14:00:00.000Z')
  return {
    commandEnteredAt,
    events: [] as string[],
    requests: [] as RecordedRequest[],
    leases: [] as object[],
    captureError: null as unknown,
    localActionBindingAccepted: true,
    memberActionBindingAccepted: true,
    localPreparationError: null as unknown,
    localRecheck: { status: 'current' } as
      | { status: 'current' }
      | { status: 'stale'; reason: 'installation-epoch-changed' | 'session-changed' },
    memberRecheck: { status: 'current' } as
      | { status: 'current' }
      | { status: 'stale'; reason: 'installation-epoch-changed' | 'session-changed' },
    localAttempt: 'succeeded' as 'succeeded' | 'failed' | 'locked',
    memberAttempt: 'succeeded' as 'succeeded' | 'failed' | 'locked' | 'target-invalid',
    localProtectedOutcome: {
      kind: 'created',
      user: { id: 'target-local', name: 'New Member', email: 'new@example.test' },
    } as
      | {
          kind: 'created'
          user: { id: string; name: string; email: string }
        }
      | { kind: 'email-conflict' },
    memberProtectedOutcome: {
      kind: 'issued',
      resetId: 'reset-1',
      code: 'indigo_m1_secret',
      expiresAt: new Date('2026-07-15T14:15:00.000Z'),
    } as
      | { kind: 'issued'; resetId: string; code: string; expiresAt: Date }
      | { kind: 'cooldown'; retryAfter: Date },
    localCommand: {
      actionBinding: 'local-binding',
      targetUserId: 'target-local',
      name: 'New Member',
      email: 'New@Example.test',
      initialPassword: 'initial-password',
      currentPassword: 'owner-password',
      verifiedSessionToken: 'signed-session-token',
      commandEnteredAt,
      requestContext: { channel: 'web', clientAddress: '127.0.0.1' },
    },
    memberCommand: {
      actionBinding: 'member-binding',
      targetUserId: 'target-member',
      currentPassword: 'owner-password',
      verifiedSessionToken: 'signed-session-token',
      commandEnteredAt,
      requestContext: { channel: 'web', clientAddress: '127.0.0.1' },
    },
    localView: {
      purpose: 'local-user-create',
      expectedEpoch: '11111111-1111-4111-8111-111111111111',
      actorUserId: 'owner-1',
      sessionId: 'session-1',
      sessionExpiresAt: new Date('2026-07-15T16:00:00.000Z'),
      expectedRole: 'owner',
      preallocatedTargetUserId: 'target-local',
      normalizedEmail: 'new@example.test',
      submittedEmailUserIds: [] as string[],
      actorCredential: 'present',
    },
    memberView: {
      purpose: 'member-reset-issue',
      expectedEpoch: '11111111-1111-4111-8111-111111111111',
      actorUserId: 'owner-1',
      sessionId: 'session-1',
      sessionExpiresAt: new Date('2026-07-15T16:00:00.000Z'),
      expectedRole: 'owner',
      targetUserId: 'target-member',
      targetState: 'member' as 'member' | 'owner' | 'missing',
      actorCredential: 'present',
      targetCredential: 'present' as 'present' | 'missing',
    },
  }
})

vi.mock('@/modules/identity/server/credential-administration-command', () => ({
  localUserCreationMutationCommandView: vi.fn(() => mocks.localCommand),
  memberResetIssuanceMutationCommandView: vi.fn(() => mocks.memberCommand),
}))

vi.mock('@/modules/identity/infrastructure/action-binding', () => ({
  verifyLocalUserCreateActionBinding: vi.fn((binding, context, now) => {
    mocks.events.push(
      `binding:local:${binding}:${context.targetUserId}:${now.toISOString()}`,
    )
    return mocks.localActionBindingAccepted
  }),
  verifyMemberResetIssueActionBinding: vi.fn((binding, context, now) => {
    mocks.events.push(
      `binding:member:${binding}:${context.targetUserId}:${now.toISOString()}`,
    )
    return mocks.memberActionBindingAccepted
  }),
}))

vi.mock('@/modules/identity/infrastructure/credential-administration-mutation', () => {
  class CredentialAdministrationAuthorityUnavailableError extends Error {}
  class CredentialAdministrationCaptureStaleError extends Error {}
  return {
    CredentialAdministrationAuthorityUnavailableError,
    CredentialAdministrationCaptureStaleError,
    captureLocalUserCreationMutation: vi.fn(async (_query, input) => {
      mocks.events.push(
        `capture:local:${input.verifiedSessionToken}:${input.preallocatedTargetUserId}:${input.submittedEmail}:${input.commandEnteredAt.toISOString()}`,
      )
      return { kind: 'local-capture' }
    }),
    captureMemberResetIssuanceMutation: vi.fn(async (_query, input) => {
      mocks.events.push(
        `capture:member:${input.verifiedSessionToken}:${input.targetUserId}:${input.commandEnteredAt.toISOString()}`,
      )
      return { kind: 'member-capture' }
    }),
    localUserCreationMutationCaptureView: vi.fn(() => mocks.localView),
    memberResetIssuanceMutationCaptureView: vi.fn(() => mocks.memberView),
    recheckLocalUserCreationMutation: vi.fn(async () => {
      mocks.events.push('query:recheck:local')
      return mocks.localRecheck
    }),
    recheckMemberResetIssuanceMutation: vi.fn(async () => {
      mocks.events.push('query:recheck:member')
      return mocks.memberRecheck
    }),
  }
})

vi.mock('@/modules/identity/infrastructure/credential-digests', () => ({
  credentialEmailLockDigest: vi.fn(
    (email: string) => `digest:${email.trim().toLowerCase()}`,
  ),
}))

vi.mock('@/modules/identity/infrastructure/scoped-credential-administration', () => ({
  prepareLocalUserCreation: vi.fn(async (input) => {
    mocks.events.push('prepare:local')
    if (mocks.localPreparationError) throw mocks.localPreparationError
    return {
      targetUserId: input.targetUserId,
      accountId: 'account-1',
      auditEventId: 'audit-1',
      name: input.name,
      normalizedEmail: input.email.trim().toLowerCase(),
      passwordHash: 'password-hash',
      commandEnteredAt: input.commandEnteredAt,
    }
  }),
  createScopedLocalUserCreationMutationGateway: vi.fn(() => ({
    createLocalUser: vi.fn(async (_capture, _prepared, context) => {
      mocks.events.push(`gateway:protected:local:${context.channel}`)
      return mocks.localProtectedOutcome
    }),
  })),
  createScopedMemberResetIssuanceMutationGateway: vi.fn(() => ({
    issueMemberReset: vi.fn(async (_capture, _prepared, context) => {
      mocks.events.push(`gateway:protected:member:${context.channel}`)
      return mocks.memberProtectedOutcome
    }),
  })),
}))

vi.mock('@/modules/identity/infrastructure/scoped-credential-reauthentication', () => ({
  createScopedLocalUserCreationReauthenticationGateway: vi.fn(() => ({
    attempt: vi.fn(async (input) => {
      mocks.events.push('gateway:attempt:local')
      if (mocks.localAttempt === 'failed' || mocks.localAttempt === 'locked') {
        return { status: mocks.localAttempt }
      }
      return {
        status: 'succeeded',
        authority: input.markReauthenticationSucceeded(),
      }
    }),
    rejectPrecondition: vi.fn(async (input) => {
      mocks.events.push(`gateway:reject:local:${input.reason}`)
      return { status: 'precondition-rejected', reason: input.reason }
    }),
  })),
  createScopedMemberResetIssuanceReauthenticationGateway: vi.fn(() => ({
    attempt: vi.fn(async (input) => {
      mocks.events.push('gateway:attempt:member')
      if (mocks.memberAttempt === 'target-invalid') {
        return { status: 'precondition-rejected', reason: 'target-invalid' }
      }
      if (mocks.memberAttempt === 'failed' || mocks.memberAttempt === 'locked') {
        return { status: mocks.memberAttempt }
      }
      return {
        status: 'succeeded',
        authority: input.markReauthenticationSucceeded(),
      }
    }),
  })),
}))

vi.mock('@/modules/identity/recovery/recovery-preparation', () => ({
  prepareMemberResetIssuance: vi.fn((input) => {
    mocks.events.push('prepare:member')
    return {
      resetId: 'reset-1',
      auditEventId: 'audit-2',
      targetUserId: input.targetUserId,
      identifier: `indigo:member-reset:${input.targetUserId}`,
      code: 'indigo_m1_secret',
      storedValue: 'stored-code',
      commandEnteredAt: input.commandEnteredAt,
      expiresAt: new Date(input.commandEnteredAt.getTime() + 15 * 60_000),
      audit: {
        eventType: 'member-reset-issued',
        entityType: 'member-reset',
        entityId: 'reset-1',
        outcome: 'issued',
        expiresAt: new Date(input.commandEnteredAt.getTime() + 15 * 60_000).toISOString(),
      },
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
    authenticatedSession: vi.fn((input) => ({
      expectedEpoch: input.expectedEpoch,
      input,
    })),
    localUserCreateAttempt: vi.fn((input) => {
      const captured = {
        kind: 'destructive-reauthentication-attempt',
        expectedEpoch: input.authenticated.expectedEpoch,
        actorUserId: input.authenticated.input.actorUserId,
        sessionId: input.authenticated.input.sessionId,
        expectedRole: 'owner',
        purpose: 'local-user-create',
        targetUserId: input.targetUserId,
        emailDigest: input.emailDigest,
      }
      return {
        expectedEpoch: input.authenticated.expectedEpoch,
        authority: { purpose: 'local-user-create', captured },
      }
    }),
    memberResetIssueAttempt: vi.fn((input) => {
      const captured = {
        kind: 'destructive-reauthentication-attempt',
        expectedEpoch: input.authenticated.expectedEpoch,
        actorUserId: input.authenticated.input.actorUserId,
        sessionId: input.authenticated.input.sessionId,
        expectedRole: 'owner',
        purpose: 'member-reset-issue',
        targetUserId: input.targetUserId,
        emailDigest: null,
      }
      return {
        expectedEpoch: input.authenticated.expectedEpoch,
        authority: { purpose: 'member-reset-issue', captured },
      }
    }),
  })),
}))

vi.mock('@/platform/application-coordination/prelocked-session', () => ({
  createPlatformPrelockedSessionIntentFactory: vi.fn(() => ({
    localUserCreate: vi.fn((attempt) => ({ attempt })),
    memberResetIssue: vi.fn((attempt) => ({ attempt })),
  })),
  createPlatformPrelockedSessionPort: vi.fn(() => ({
    withPrelockedSessionLease: vi.fn(async (_intent, callback) => {
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
      const phase =
        request.operation === 'destructive-reauthentication-attempt'
          ? 'attempt'
          : 'protected'
      mocks.events.push(
        `uow:begin:${phase}:${request.authority.purpose}:${request.mode.isolation}`,
      )
      const capturedAuthority =
        request.authority.captured ?? request.authority.protectedCaptured
      const context = createGatewayContext({
        client: { query: vi.fn() },
        request,
        capturedAuthority,
        markReauthenticationSucceeded: () => {
          mocks.events.push(`authority:promoted:${request.authority.purpose}`)
          const protectedCaptured = {
            ...capturedAuthority,
            kind: 'authenticated-destructive',
          }
          return {
            kind: 'authenticated-destructive',
            purpose: request.authority.purpose,
            protectedCaptured,
          }
        },
        requireWriteAuthorized: vi.fn(),
        exactReplayAuthorizer: null,
        newCommandAuthorizer: null,
      })
      try {
        mocks.events.push(`uow:recheck:${phase}`)
        await context.recheckIdentity()
        const result = await callback({
          gateways: { ...context.readGateways, ...context.writeGateways },
        })
        mocks.events.push(`uow:commit:${phase}`)
        return result
      } catch (error) {
        mocks.events.push(`uow:rollback:${phase}`)
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
    withTrustedCredentialCapture: vi.fn(async (callback) => {
      mocks.events.push('capture:lease')
      if (mocks.captureError) throw mocks.captureError
      return callback({ query: vi.fn() })
    }),
  }
})

import { getProductionIdentityCredentialAdministrationMutationPort } from './identity-credential-administration'

function eventIndex(event: string): number {
  const index = mocks.events.indexOf(event)
  expect(
    index,
    `missing event: ${event}\n${mocks.events.join('\n')}`,
  ).toBeGreaterThanOrEqual(0)
  return index
}

describe('production credential-administration composition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.events.length = 0
    mocks.requests.length = 0
    mocks.leases.length = 0
    mocks.captureError = null
    mocks.localActionBindingAccepted = true
    mocks.memberActionBindingAccepted = true
    mocks.localView.normalizedEmail = 'new@example.test'
    mocks.localPreparationError = null
    mocks.localRecheck = { status: 'current' }
    mocks.memberRecheck = { status: 'current' }
    mocks.localAttempt = 'succeeded'
    mocks.memberAttempt = 'succeeded'
    mocks.localProtectedOutcome = {
      kind: 'created',
      user: { id: 'target-local', name: 'New Member', email: 'new@example.test' },
    }
    mocks.memberProtectedOutcome = {
      kind: 'issued',
      resetId: 'reset-1',
      code: 'indigo_m1_secret',
      expiresAt: new Date('2026-07-15T14:15:00.000Z'),
    }
    mocks.memberView.targetState = 'member'
    mocks.memberView.targetCredential = 'present'
  })

  it('creates a local user only after two rechecks and the protected commit on one lease', async () => {
    const result =
      await getProductionIdentityCredentialAdministrationMutationPort().createLocalUser(
        {} as never,
      )

    expect(result).toEqual({ kind: 'created', email: 'new@example.test' })
    expect(mocks.leases).toHaveLength(1)
    expect(mocks.requests).toHaveLength(2)
    expect(mocks.requests[0]?.session.lease).toBe(mocks.leases[0])
    expect(mocks.requests[1]?.session.lease).toBe(mocks.leases[0])
    expect(
      mocks.requests.map(({ operation, mode }) => [operation, mode.isolation]),
    ).toEqual([
      ['destructive-reauthentication-attempt', 'read-committed'],
      ['destructive-identity-mutation', 'read-committed'],
    ])
    expect(mocks.requests[0]?.authority.captured).toMatchObject({
      actorUserId: 'owner-1',
      sessionId: 'session-1',
      targetUserId: 'target-local',
      emailDigest: 'digest:new@example.test',
    })
    expect(eventIndex('query:recheck:local')).toBeLessThan(
      eventIndex('gateway:attempt:local'),
    )
    expect(eventIndex('uow:commit:attempt')).toBeLessThan(
      eventIndex('uow:begin:protected:local-user-create:read-committed'),
    )
    expect(eventIndex('uow:recheck:protected')).toBeLessThan(
      eventIndex('gateway:protected:local:web'),
    )
    expect(eventIndex('gateway:protected:local:web')).toBeLessThan(
      eventIndex('uow:commit:protected'),
    )
    expect(eventIndex('uow:commit:protected')).toBeLessThan(eventIndex('lease:released'))
  })

  it('commits a validation-rejection audit without attempting a password or entering the protected phase', async () => {
    mocks.localPreparationError = new LocalUserInputError(['email: invalid'])
    mocks.localView.normalizedEmail = 'indigo:invalid-local-user-email'

    const result =
      await getProductionIdentityCredentialAdministrationMutationPort().createLocalUser(
        {} as never,
      )

    expect(result).toEqual({ kind: 'input-rejected', issues: ['email: invalid'] })
    expect(mocks.events).toContain('gateway:reject:local:validation-rejected')
    expect(mocks.events).toContain('uow:commit:attempt')
    expect(mocks.events).not.toContain('gateway:attempt:local')
    expect(mocks.events.some((event) => event.includes('uow:begin:protected'))).toBe(
      false,
    )
    expect(mocks.events).not.toContain('authority:promoted:local-user-create')
    expect(mocks.requests[0]?.authority.captured).toMatchObject({
      emailDigest: 'digest:indigo:invalid-local-user-email',
    })
  })

  it.each([
    ['failed', 'reauthentication-failed'],
    ['locked', 'reauthentication-locked'],
  ] as const)('commits and maps a %s local password attempt', async (attempt, kind) => {
    mocks.localAttempt = attempt

    await expect(
      getProductionIdentityCredentialAdministrationMutationPort().createLocalUser(
        {} as never,
      ),
    ).resolves.toEqual({ kind })
    expect(mocks.events).toContain('uow:commit:attempt')
    expect(mocks.events.some((event) => event.includes('uow:begin:protected'))).toBe(
      false,
    )
  })

  it('commits the tagged invalid-target member outcome without generating or returning a code', async () => {
    mocks.memberView.targetState = 'missing'
    mocks.memberView.targetCredential = 'missing'
    mocks.memberAttempt = 'target-invalid'

    const result =
      await getProductionIdentityCredentialAdministrationMutationPort().issueMemberReset(
        {} as never,
      )

    expect(result).toEqual({ kind: 'target-invalid' })
    expect(mocks.events).not.toContain('prepare:member')
    expect(mocks.events).toContain('gateway:attempt:member')
    expect(mocks.events).toContain('uow:commit:attempt')
    expect(mocks.events.some((event) => event.includes('uow:begin:protected'))).toBe(
      false,
    )
  })

  it('issues a member code only after the serializable protected transaction commits', async () => {
    const result =
      await getProductionIdentityCredentialAdministrationMutationPort().issueMemberReset(
        {} as never,
      )

    expect(result).toEqual({
      kind: 'issued',
      targetUserId: 'target-member',
      code: 'indigo_m1_secret',
      expiresAt: new Date('2026-07-15T14:15:00.000Z'),
    })
    expect(mocks.leases).toHaveLength(1)
    expect(
      mocks.requests.map(({ operation, mode }) => [operation, mode.isolation]),
    ).toEqual([
      ['destructive-reauthentication-attempt', 'read-committed'],
      ['destructive-identity-mutation', 'serializable'],
    ])
    expect(mocks.requests[1]?.authority.protectedCaptured).toMatchObject({
      kind: 'authenticated-destructive',
      actorUserId: 'owner-1',
      sessionId: 'session-1',
      targetUserId: 'target-member',
      emailDigest: null,
    })
    expect(eventIndex('uow:commit:attempt')).toBeLessThan(
      eventIndex('uow:begin:protected:member-reset-issue:serializable'),
    )
    expect(eventIndex('gateway:protected:member:web')).toBeLessThan(
      eventIndex('uow:commit:protected'),
    )
  })

  it('maps a protected-phase identity recheck change to stale without invoking DML', async () => {
    let rechecks = 0
    mocks.memberRecheck = {
      get status() {
        rechecks += 1
        return rechecks === 1 ? 'current' : 'stale'
      },
      get reason() {
        return 'session-changed' as const
      },
    } as never

    await expect(
      getProductionIdentityCredentialAdministrationMutationPort().issueMemberReset(
        {} as never,
      ),
    ).resolves.toEqual({ kind: 'stale' })
    expect(mocks.events).not.toContain('gateway:protected:member:web')
    expect(mocks.events).toContain('uow:rollback:protected')
  })

  it('rejects an invalid action binding before authority issuance or queueing', async () => {
    mocks.localActionBindingAccepted = false

    await expect(
      getProductionIdentityCredentialAdministrationMutationPort().createLocalUser(
        {} as never,
      ),
    ).resolves.toEqual({ kind: 'rejected' })
    expect(mocks.events).not.toContain('lease:acquired')
    expect(mocks.requests).toHaveLength(0)
  })

  it('maps credential-capture capacity exhaustion to an unavailable result', async () => {
    mocks.captureError = new CredentialConnectionCapacityError({} as never)

    await expect(
      getProductionIdentityCredentialAdministrationMutationPort().issueMemberReset(
        {} as never,
      ),
    ).resolves.toEqual({ kind: 'unavailable' })
    expect(mocks.events).not.toContain('lease:acquired')
  })

  it('maps an expired session or consumed render target to stale before queueing', async () => {
    mocks.captureError = new CredentialAdministrationCaptureStaleError()

    await expect(
      getProductionIdentityCredentialAdministrationMutationPort().createLocalUser(
        {} as never,
      ),
    ).resolves.toEqual({ kind: 'stale' })
    expect(mocks.events).not.toContain('lease:acquired')
  })
})
