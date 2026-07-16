import { describe, expect, it } from 'vitest'
import type {
  MutationAuthority,
  PrelockedSessionOperation,
  UnitOfWorkRequest,
} from '@/application/coordination'
import { createInstallationMutationEpoch } from './lifecycle-values'
import {
  bindPlatformMutationAuthorityScope,
  consumePlatformCredentialPrelockPlan,
  consumePreparedMutationAuthority,
  createPlatformMutationAuthorityIssuer,
  type IssuedMutationAuthority,
  type PlatformCredentialPrelockPlan,
  prepareMutationAuthorityClaim,
  revokePlatformMutationAuthorityScope,
} from './mutation-authority'

const epochValue = '10000000-0000-4000-8000-000000000001'

function epoch() {
  return createInstallationMutationEpoch(epochValue)
}

function ordinaryRequest(
  issued: IssuedMutationAuthority<MutationAuthority>,
): UnitOfWorkRequest {
  return {
    authority: issued.authority,
    expectedEpoch: issued.expectedEpoch,
    session: { kind: 'ordinary' },
  } as unknown as UnitOfWorkRequest
}

function prelockedRequest(
  issued: IssuedMutationAuthority<MutationAuthority>,
): UnitOfWorkRequest {
  return {
    authority: issued.authority,
    expectedEpoch: issued.expectedEpoch,
    session: { kind: 'prelocked', lease: {} },
  } as unknown as UnitOfWorkRequest
}

function bindAndConsumePrelockPlan<Authority extends MutationAuthority>(
  issued: IssuedMutationAuthority<Authority>,
  operation: PrelockedSessionOperation,
) {
  const scope = bindPlatformMutationAuthorityScope(issued, operation)
  const plan = consumePlatformCredentialPrelockPlan(scope)
  return { scope, plan }
}

function expectedPrelockPlan(
  operation: PrelockedSessionOperation,
  overrides: Partial<Omit<PlatformCredentialPrelockPlan, 'operation'>> = {},
): PlatformCredentialPrelockPlan {
  return {
    operation,
    lane: 'trusted',
    instanceFence: 'shared',
    emailDigest: null,
    accountUserIds: [],
    unknownAccountEmailDigest: null,
    hostInvocationId: null,
    ...overrides,
  }
}

describe('Platform mutation authority', () => {
  it('exposes only the closed named issuer surface', () => {
    expect(Object.keys(createPlatformMutationAuthorityIssuer()).sort()).toEqual([
      'authenticatedSession',
      'bootstrapIssuance',
      'bootstrapRedemption',
      'checkedSignOut',
      'emailSignIn',
      'expiredSessionMaintenance',
      'instanceResetAttempt',
      'localUserCreateAttempt',
      'memberResetIssueAttempt',
      'memberResetRedemption',
      'ownerRecoveryCliRedemption',
      'ownerRecoveryIssue',
      'ownerRecoveryWebRedemption',
      'traineeDataDeletionAttempt',
    ])
  })

  it('keeps every private issuer binding out of public keys and serialization', () => {
    const issuer = createPlatformMutationAuthorityIssuer()
    const owner = issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'owner-public-id',
      sessionId: 'hidden-owner-session-id',
      expectedRole: 'owner',
    })
    const member = issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'member-public-id',
      sessionId: 'hidden-member-session-id',
      expectedRole: 'member',
    })
    const cases = [
      {
        label: 'authenticated session',
        issued: member,
        opaqueKey: 'session',
        publicFields: {
          kind: 'authenticated-session',
          actorUserId: 'member-public-id',
          expectedRole: 'member',
        },
        hidden: ['hidden-member-session-id'],
      },
      {
        label: 'trainee data deletion',
        issued: issuer.traineeDataDeletionAttempt({ authenticated: member }),
        opaqueKey: 'attempt',
        publicFields: {
          kind: 'destructive-reauthentication-attempt',
          actorUserId: 'member-public-id',
          expectedRole: 'member',
          purpose: 'trainee-data-deletion',
          targetUserId: null,
          session: member.authority.session,
        },
        hidden: ['hidden-member-session-id'],
      },
      {
        label: 'instance reset',
        issued: issuer.instanceResetAttempt({ authenticated: owner }),
        opaqueKey: 'attempt',
        publicFields: {
          kind: 'destructive-reauthentication-attempt',
          actorUserId: 'owner-public-id',
          expectedRole: 'owner',
          purpose: 'instance-reset',
          targetUserId: null,
          session: owner.authority.session,
        },
        hidden: ['hidden-owner-session-id'],
      },
      {
        label: 'member reset issue',
        issued: issuer.memberResetIssueAttempt({
          authenticated: owner,
          targetUserId: 'member-reset-public-target',
        }),
        opaqueKey: 'attempt',
        publicFields: {
          kind: 'destructive-reauthentication-attempt',
          actorUserId: 'owner-public-id',
          expectedRole: 'owner',
          purpose: 'member-reset-issue',
          targetUserId: 'member-reset-public-target',
          session: owner.authority.session,
        },
        hidden: ['hidden-owner-session-id'],
      },
      {
        label: 'local user create',
        issued: issuer.localUserCreateAttempt({
          authenticated: owner,
          targetUserId: 'local-user-public-target',
          emailDigest: 'hidden-local-user-email-digest',
        }),
        opaqueKey: 'attempt',
        publicFields: {
          kind: 'destructive-reauthentication-attempt',
          actorUserId: 'owner-public-id',
          expectedRole: 'owner',
          purpose: 'local-user-create',
          targetUserId: 'local-user-public-target',
          session: owner.authority.session,
        },
        hidden: ['hidden-owner-session-id', 'hidden-local-user-email-digest'],
      },
      {
        label: 'email sign in',
        issued: issuer.emailSignIn({
          expectedEpoch: epoch(),
          emailDigest: 'hidden-sign-in-email-digest',
          resolvedAccountUserIds: ['hidden-sign-in-account-id'],
        }),
        opaqueKey: 'authority',
        publicFields: { kind: 'credential-lifecycle', mutation: 'email-sign-in' },
        hidden: ['hidden-sign-in-email-digest', 'hidden-sign-in-account-id'],
      },
      {
        label: 'checked sign out',
        issued: issuer.checkedSignOut({
          expectedEpoch: epoch(),
          signedTokenDigest: 'hidden-signed-token-digest',
          resolvedAccountUserId: 'hidden-sign-out-account-id',
        }),
        opaqueKey: 'authority',
        publicFields: { kind: 'credential-lifecycle', mutation: 'checked-sign-out' },
        hidden: ['hidden-signed-token-digest', 'hidden-sign-out-account-id'],
      },
      {
        label: 'member reset redemption',
        issued: issuer.memberResetRedemption({
          expectedEpoch: epoch(),
          codeIdentity: 'hidden-member-code-identity',
          emailDigest: 'hidden-member-email-digest',
          targetUserId: null,
        }),
        opaqueKey: 'authority',
        publicFields: {
          kind: 'credential-lifecycle',
          mutation: 'member-reset-redemption',
        },
        hidden: ['hidden-member-code-identity', 'hidden-member-email-digest'],
      },
      {
        label: 'owner recovery web redemption',
        issued: issuer.ownerRecoveryWebRedemption({
          expectedEpoch: epoch(),
          codeIdentity: 'hidden-owner-web-code-identity',
          emailDigest: 'hidden-owner-web-email-digest',
          expectedOwnerUserId: 'hidden-owner-web-account-id',
        }),
        opaqueKey: 'authority',
        publicFields: {
          kind: 'credential-lifecycle',
          mutation: 'owner-recovery-web-redemption',
        },
        hidden: [
          'hidden-owner-web-code-identity',
          'hidden-owner-web-email-digest',
          'hidden-owner-web-account-id',
        ],
      },
      {
        label: 'owner recovery CLI redemption',
        issued: issuer.ownerRecoveryCliRedemption({
          expectedEpoch: epoch(),
          codeIdentity: 'hidden-owner-cli-code-identity',
          expectedOwnerUserId: 'hidden-owner-cli-account-id',
          hostInvocationId: 'hidden-owner-cli-host-invocation',
        }),
        opaqueKey: 'authority',
        publicFields: {
          kind: 'credential-lifecycle',
          mutation: 'owner-recovery-cli-redemption',
        },
        hidden: [
          'hidden-owner-cli-code-identity',
          'hidden-owner-cli-account-id',
          'hidden-owner-cli-host-invocation',
        ],
      },
      {
        label: 'bootstrap issuance',
        issued: issuer.bootstrapIssuance({
          expectedEpoch: epoch(),
          capabilityIdentity: 'hidden-bootstrap-capability-identity',
          hostInvocationId: 'hidden-bootstrap-host-invocation',
        }),
        opaqueKey: 'authority',
        publicFields: { kind: 'host-bootstrap', mutation: 'issuance' },
        hidden: [
          'hidden-bootstrap-capability-identity',
          'hidden-bootstrap-host-invocation',
        ],
      },
      {
        label: 'bootstrap redemption',
        issued: issuer.bootstrapRedemption({
          expectedEpoch: epoch(),
          capabilityIdentity: 'hidden-bootstrap-redeem-capability',
          codeIdentity: 'hidden-bootstrap-code-identity',
          preallocatedOwnerUserId: 'hidden-bootstrap-owner-id',
          emailDigest: 'hidden-bootstrap-email-digest',
        }),
        opaqueKey: 'authority',
        publicFields: { kind: 'host-bootstrap', mutation: 'redemption' },
        hidden: [
          'hidden-bootstrap-redeem-capability',
          'hidden-bootstrap-code-identity',
          'hidden-bootstrap-owner-id',
          'hidden-bootstrap-email-digest',
        ],
      },
      {
        label: 'owner recovery issue',
        issued: issuer.ownerRecoveryIssue({
          expectedEpoch: epoch(),
          expectedOwnerUserId: 'owner-public-id',
          hostInvocationId: 'hidden-owner-issue-host-invocation',
        }),
        opaqueKey: 'invocation',
        publicFields: {
          kind: 'owner-recovery-issue',
          expectedOwnerUserId: 'owner-public-id',
        },
        hidden: ['hidden-owner-issue-host-invocation'],
      },
      {
        label: 'expired session maintenance',
        issued: issuer.expiredSessionMaintenance({
          expectedEpoch: epoch(),
          expectedOwnerUserId: 'hidden-maintenance-owner-id',
          hostInvocationId: 'hidden-maintenance-host-invocation',
          cursor: 'public-maintenance-cursor',
          batchSize: 2,
          resolvedAccountUserIds: [
            'hidden-expired-account-2',
            'hidden-expired-account-1',
          ],
        }),
        opaqueKey: 'invocation',
        publicFields: {
          kind: 'expired-session-maintenance',
          cursor: 'public-maintenance-cursor',
          batchSize: 2,
        },
        hidden: [
          'hidden-maintenance-owner-id',
          'hidden-maintenance-host-invocation',
          'hidden-expired-account-1',
          'hidden-expired-account-2',
        ],
      },
    ]

    for (const { label, issued, opaqueKey, publicFields, hidden } of cases) {
      const authority = issued.authority as unknown as Record<string, unknown>
      expect(authority, label).toMatchObject(publicFields)
      expect(Object.keys(authority).sort(), label).toEqual(
        [...Object.keys(publicFields), opaqueKey].sort(),
      )
      expect(Object.keys(authority[opaqueKey] as object), label).toEqual([])
      const serialized = JSON.stringify(authority)
      for (const privateValue of hidden) {
        expect(serialized, `${label}: ${privateValue}`).not.toContain(privateValue)
      }
    }
  })

  it('captures a reusable authenticated session without exposing its signed identity', () => {
    const issuer = createPlatformMutationAuthorityIssuer()
    const issued = issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'user-1',
      sessionId: 'session-secret-identity',
      expectedRole: 'member',
    })

    expect(issued.authority).toEqual({
      kind: 'authenticated-session',
      actorUserId: 'user-1',
      expectedRole: 'member',
      session: expect.any(Object),
    })
    expect(JSON.stringify(issued)).not.toContain('session-secret-identity')
    expect(Object.keys(issued.authority.session)).toEqual([])

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const request = ordinaryRequest(issued)
      prepareMutationAuthorityClaim(request, null)
      const claim = consumePreparedMutationAuthority(request)
      expect(claim.capturedAuthority).toMatchObject({
        kind: 'authenticated-session',
        actorUserId: 'user-1',
        sessionId: 'session-secret-identity',
        expectedRole: 'member',
      })
      claim.finish({ committed: true })
      expect(() => claim.assertActive()).toThrow(
        expect.objectContaining({ code: 'identity.authority-stale' }),
      )
    }
  })

  it('rejects forged, relabelled, and equal-wire epoch-swapped authorities', () => {
    const issuer = createPlatformMutationAuthorityIssuer()
    const issued = issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'owner-1',
      sessionId: 'session-1',
      expectedRole: 'owner',
    })
    const forged = {
      authority: {
        kind: 'authenticated-session',
        actorUserId: 'owner-1',
        expectedRole: 'owner',
        session: {},
      },
      expectedEpoch: issued.expectedEpoch,
    } as unknown as IssuedMutationAuthority<MutationAuthority>
    expect(() => prepareMutationAuthorityClaim(ordinaryRequest(forged), null)).toThrow(
      expect.objectContaining({ code: 'identity.authority-stale' }),
    )

    const relabelled = {
      ...issued,
      authority: { ...issued.authority, actorUserId: 'owner-2' },
    } as IssuedMutationAuthority<MutationAuthority>
    expect(() =>
      prepareMutationAuthorityClaim(ordinaryRequest(relabelled), null),
    ).toThrow(expect.objectContaining({ code: 'identity.authority-stale' }))

    const swappedEpoch = {
      ...issued,
      expectedEpoch: epoch(),
    } as IssuedMutationAuthority<MutationAuthority>
    expect(() =>
      prepareMutationAuthorityClaim(ordinaryRequest(swappedEpoch), null),
    ).toThrow(expect.objectContaining({ code: 'identity.authority-stale' }))
  })

  it('spends a direct lifecycle capability exactly once across competing preparations', () => {
    const issued = createPlatformMutationAuthorityIssuer().checkedSignOut({
      expectedEpoch: epoch(),
      signedTokenDigest: 'signed-token-digest',
      resolvedAccountUserId: 'user-1',
    })
    const { scope } = bindAndConsumePrelockPlan(issued, 'checked-sign-out')
    const firstRequest = prelockedRequest(issued)
    const secondRequest = prelockedRequest(issued)
    prepareMutationAuthorityClaim(firstRequest, 'checked-sign-out')
    prepareMutationAuthorityClaim(secondRequest, 'checked-sign-out')

    const first = consumePreparedMutationAuthority(firstRequest)
    expect(first.prelockedScope).toBe(scope)
    expect(first.capturedAuthority).toMatchObject({
      kind: 'credential-lifecycle',
      mutation: 'checked-sign-out',
      signedTokenDigest: 'signed-token-digest',
      resolvedAccountUserId: 'user-1',
    })
    expect(() => consumePreparedMutationAuthority(secondRequest)).toThrow(
      expect.objectContaining({ code: 'identity.authority-stale' }),
    )
    first.finish({ committed: true })

    const thirdRequest = prelockedRequest(issued)
    expect(() => prepareMutationAuthorityClaim(thirdRequest, 'checked-sign-out')).toThrow(
      expect.objectContaining({ code: 'identity.authority-stale' }),
    )
  })

  it('promotes destructive authority only after explicit success and certain commit', () => {
    const issuer = createPlatformMutationAuthorityIssuer()
    const authenticated = issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'owner-1',
      sessionId: 'session-1',
      expectedRole: 'owner',
    })
    const attempt = issuer.memberResetIssueAttempt({
      authenticated,
      targetUserId: 'member-1',
    })
    const { scope } = bindAndConsumePrelockPlan(attempt, 'member-reset-issue')
    const attemptRequest = prelockedRequest(attempt)
    prepareMutationAuthorityClaim(attemptRequest, 'member-reset-issue')
    const attemptClaim = consumePreparedMutationAuthority(attemptRequest)
    const protectedAuthority = attemptClaim.markReauthenticationSucceeded()

    const pendingRequest = prelockedRequest({
      authority: protectedAuthority,
      expectedEpoch: attempt.expectedEpoch,
    })
    expect(() =>
      prepareMutationAuthorityClaim(pendingRequest, 'member-reset-issue'),
    ).toThrow(expect.objectContaining({ code: 'identity.authority-stale' }))

    attemptClaim.finish({ committed: true })
    const protectedRequest = prelockedRequest({
      authority: protectedAuthority,
      expectedEpoch: attempt.expectedEpoch,
    })
    prepareMutationAuthorityClaim(protectedRequest, 'member-reset-issue')
    const protectedClaim = consumePreparedMutationAuthority(protectedRequest)
    expect(protectedClaim.prelockedScope).toBe(scope)
    expect(protectedClaim.capturedAuthority).toMatchObject({
      kind: 'authenticated-destructive',
      actorUserId: 'owner-1',
      sessionId: 'session-1',
      expectedRole: 'owner',
      purpose: 'member-reset-issue',
      targetUserId: 'member-1',
    })
    protectedClaim.finish({ committed: true })

    expect(() =>
      prepareMutationAuthorityClaim(
        prelockedRequest({
          authority: protectedAuthority,
          expectedEpoch: attempt.expectedEpoch,
        }),
        'member-reset-issue',
      ),
    ).toThrow(expect.objectContaining({ code: 'identity.authority-stale' }))
  })

  it('revokes pending promotion on rollback and every proof when the outer scope closes', () => {
    const issuer = createPlatformMutationAuthorityIssuer()
    const authenticated = issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'owner-1',
      sessionId: 'session-1',
      expectedRole: 'owner',
    })
    const attempt = issuer.instanceResetAttempt({ authenticated })
    const { scope } = bindAndConsumePrelockPlan(attempt, 'instance-reset')
    const request = prelockedRequest(attempt)
    prepareMutationAuthorityClaim(request, 'instance-reset')
    const claim = consumePreparedMutationAuthority(request)
    const protectedAuthority = claim.markReauthenticationSucceeded()
    claim.finish({ committed: false })

    expect(() =>
      prepareMutationAuthorityClaim(
        prelockedRequest({
          authority: protectedAuthority,
          expectedEpoch: attempt.expectedEpoch,
        }),
        'instance-reset',
      ),
    ).toThrow(expect.objectContaining({ code: 'identity.authority-stale' }))

    const freshAttempt = issuer.instanceResetAttempt({ authenticated })
    const freshScope = bindPlatformMutationAuthorityScope(freshAttempt, 'instance-reset')
    revokePlatformMutationAuthorityScope(freshScope)
    expect(() =>
      prepareMutationAuthorityClaim(prelockedRequest(freshAttempt), 'instance-reset'),
    ).toThrow(expect.objectContaining({ code: 'identity.authority-stale' }))
    revokePlatformMutationAuthorityScope(scope)
  })

  it('revokes an already-consumed claim when its outer scope closes', () => {
    const issued = createPlatformMutationAuthorityIssuer().checkedSignOut({
      expectedEpoch: epoch(),
      signedTokenDigest: 'signed-token-digest',
      resolvedAccountUserId: 'user-1',
    })
    const { scope } = bindAndConsumePrelockPlan(issued, 'checked-sign-out')
    const request = prelockedRequest(issued)
    prepareMutationAuthorityClaim(request, 'checked-sign-out')
    const claim = consumePreparedMutationAuthority(request)

    revokePlatformMutationAuthorityScope(scope)

    expect(() => claim.assertActive()).toThrow(
      expect.objectContaining({ code: 'identity.authority-stale' }),
    )
    expect(() => claim.capturedAuthority).toThrow(
      expect.objectContaining({ code: 'identity.authority-stale' }),
    )
    expect(() => claim.prelockedScope).toThrow(
      expect.objectContaining({ code: 'identity.authority-stale' }),
    )
    claim.finish({ committed: true })
  })

  it('revokes destructive attempts and protected claims while they are in flight', () => {
    const issuer = createPlatformMutationAuthorityIssuer()
    const authenticated = issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'owner-1',
      sessionId: 'session-1',
      expectedRole: 'owner',
    })

    const revokedAttempt = issuer.localUserCreateAttempt({
      authenticated,
      targetUserId: 'member-1',
      emailDigest: 'member-email-digest',
    })
    const { scope: attemptScope } = bindAndConsumePrelockPlan(
      revokedAttempt,
      'local-user-create',
    )
    const attemptRequest = prelockedRequest(revokedAttempt)
    prepareMutationAuthorityClaim(attemptRequest, 'local-user-create')
    const attemptClaim = consumePreparedMutationAuthority(attemptRequest)
    revokePlatformMutationAuthorityScope(attemptScope)
    expect(() => attemptClaim.markReauthenticationSucceeded()).toThrow(
      expect.objectContaining({ code: 'identity.authority-stale' }),
    )
    attemptClaim.finish({ committed: true })

    const promotedAttempt = issuer.localUserCreateAttempt({
      authenticated,
      targetUserId: 'member-1',
      emailDigest: 'member-email-digest',
    })
    const { scope: protectedScope } = bindAndConsumePrelockPlan(
      promotedAttempt,
      'local-user-create',
    )
    const promotedRequest = prelockedRequest(promotedAttempt)
    prepareMutationAuthorityClaim(promotedRequest, 'local-user-create')
    const promotedClaim = consumePreparedMutationAuthority(promotedRequest)
    const protectedAuthority = promotedClaim.markReauthenticationSucceeded()
    promotedClaim.finish({ committed: true })
    const protectedRequest = prelockedRequest({
      authority: protectedAuthority,
      expectedEpoch: promotedAttempt.expectedEpoch,
    })
    prepareMutationAuthorityClaim(protectedRequest, 'local-user-create')
    const protectedClaim = consumePreparedMutationAuthority(protectedRequest)
    revokePlatformMutationAuthorityScope(protectedScope)
    expect(() => protectedClaim.capturedAuthority).toThrow(
      expect.objectContaining({ code: 'identity.authority-stale' }),
    )
    protectedClaim.finish({ committed: true })
  })

  it('binds self-deletion authority to the actor subject lock', () => {
    const issuer = createPlatformMutationAuthorityIssuer()
    const authenticated = issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'member-1',
      sessionId: 'session-1',
      expectedRole: 'member',
    })
    const attempt = issuer.traineeDataDeletionAttempt({ authenticated })
    bindAndConsumePrelockPlan(attempt, 'subject-deletion')
    const attemptRequest = prelockedRequest(attempt)
    prepareMutationAuthorityClaim(attemptRequest, 'subject-deletion')
    const attemptClaim = consumePreparedMutationAuthority(attemptRequest)
    const protectedAuthority = attemptClaim.markReauthenticationSucceeded()
    attemptClaim.finish({ committed: true })

    const mismatchedRequest = {
      operation: 'subject-deletion',
      authority: protectedAuthority,
      session: { kind: 'prelocked', lease: {} },
      expectedEpoch: attempt.expectedEpoch,
      productFence: 'shared',
      subjectLock: { subjectUserId: 'member-2', mode: 'exclusive' },
      content: { kind: 'none' },
      mode: { isolation: 'serializable', access: 'read-write' },
    } as unknown as UnitOfWorkRequest

    expect(() =>
      prepareMutationAuthorityClaim(mismatchedRequest, 'subject-deletion'),
    ).toThrow(expect.objectContaining({ code: 'identity.authority-stale' }))
  })

  it('preserves exact bindings through all four destructive promotions', () => {
    const issuer = createPlatformMutationAuthorityIssuer()
    const owner = issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'owner-1',
      sessionId: 'owner-session',
      expectedRole: 'owner',
    })
    const member = issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'member-1',
      sessionId: 'member-session',
      expectedRole: 'member',
    })
    const cases = [
      {
        issued: issuer.traineeDataDeletionAttempt({ authenticated: member }),
        operation: 'subject-deletion' as const,
        expected: {
          actorUserId: 'member-1',
          sessionId: 'member-session',
          expectedRole: 'member',
          purpose: 'trainee-data-deletion',
          targetUserId: null,
          emailDigest: null,
        },
      },
      {
        issued: issuer.instanceResetAttempt({ authenticated: owner }),
        operation: 'instance-reset' as const,
        expected: {
          actorUserId: 'owner-1',
          sessionId: 'owner-session',
          expectedRole: 'owner',
          purpose: 'instance-reset',
          targetUserId: null,
          emailDigest: null,
        },
      },
      {
        issued: issuer.memberResetIssueAttempt({
          authenticated: owner,
          targetUserId: 'member-2',
        }),
        operation: 'member-reset-issue' as const,
        expected: {
          actorUserId: 'owner-1',
          sessionId: 'owner-session',
          expectedRole: 'owner',
          purpose: 'member-reset-issue',
          targetUserId: 'member-2',
          emailDigest: null,
        },
      },
      {
        issued: issuer.localUserCreateAttempt({
          authenticated: owner,
          targetUserId: 'member-3',
          emailDigest: 'member-3-email-digest',
        }),
        operation: 'local-user-create' as const,
        expected: {
          actorUserId: 'owner-1',
          sessionId: 'owner-session',
          expectedRole: 'owner',
          purpose: 'local-user-create',
          targetUserId: 'member-3',
          emailDigest: 'member-3-email-digest',
        },
      },
    ]

    for (const { issued, operation, expected } of cases) {
      const genericIssued = issued as IssuedMutationAuthority<MutationAuthority>
      bindAndConsumePrelockPlan(genericIssued, operation)
      const request = prelockedRequest(genericIssued)
      prepareMutationAuthorityClaim(request, operation)
      const attemptClaim = consumePreparedMutationAuthority(request)
      expect(attemptClaim.capturedAuthority).toEqual({
        kind: 'destructive-reauthentication-attempt',
        expectedEpoch: issued.expectedEpoch,
        ...expected,
      })
      const protectedAuthority = attemptClaim.markReauthenticationSucceeded()
      expect(() => attemptClaim.markReauthenticationSucceeded()).toThrow(
        expect.objectContaining({ code: 'identity.authority-stale' }),
      )
      attemptClaim.finish({ committed: true })

      const protectedRequest = prelockedRequest({
        authority: protectedAuthority,
        expectedEpoch: issued.expectedEpoch,
      })
      prepareMutationAuthorityClaim(protectedRequest, operation)
      const protectedClaim = consumePreparedMutationAuthority(protectedRequest)
      expect(protectedClaim.capturedAuthority).toEqual({
        kind: 'authenticated-destructive',
        expectedEpoch: issued.expectedEpoch,
        ...expected,
      })
      protectedClaim.finish({ committed: true })
    }
  })

  it('seals exact prelock plans and private bindings for all 13 operations', () => {
    const issuer = createPlatformMutationAuthorityIssuer()
    const owner = issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'owner-1',
      sessionId: 'owner-session',
      expectedRole: 'owner',
    })
    const member = issuer.authenticatedSession({
      expectedEpoch: epoch(),
      actorUserId: 'member-1',
      sessionId: 'member-session',
      expectedRole: 'member',
    })
    const testCases = [
      {
        issued: issuer.traineeDataDeletionAttempt({ authenticated: member }),
        operation: 'subject-deletion' as const,
        plan: expectedPrelockPlan('subject-deletion', {
          accountUserIds: ['member-1'],
        }),
        captured: {
          kind: 'destructive-reauthentication-attempt',
          purpose: 'trainee-data-deletion',
          actorUserId: 'member-1',
          emailDigest: null,
        },
      },
      {
        issued: issuer.instanceResetAttempt({ authenticated: owner }),
        operation: 'instance-reset' as const,
        plan: expectedPrelockPlan('instance-reset', {
          instanceFence: 'exclusive',
          accountUserIds: ['owner-1'],
        }),
        captured: {
          kind: 'destructive-reauthentication-attempt',
          purpose: 'instance-reset',
          actorUserId: 'owner-1',
          emailDigest: null,
        },
      },
      {
        issued: issuer.memberResetIssueAttempt({
          authenticated: owner,
          targetUserId: 'member-2',
        }),
        operation: 'member-reset-issue' as const,
        plan: expectedPrelockPlan('member-reset-issue', {
          accountUserIds: ['member-2', 'owner-1'],
        }),
        captured: {
          kind: 'destructive-reauthentication-attempt',
          purpose: 'member-reset-issue',
          targetUserId: 'member-2',
          emailDigest: null,
        },
      },
      {
        issued: issuer.localUserCreateAttempt({
          authenticated: owner,
          targetUserId: 'member-3',
          emailDigest: 'member-3-email-digest',
        }),
        operation: 'local-user-create' as const,
        plan: expectedPrelockPlan('local-user-create', {
          emailDigest: 'member-3-email-digest',
          accountUserIds: ['member-3', 'owner-1'],
        }),
        captured: {
          kind: 'destructive-reauthentication-attempt',
          purpose: 'local-user-create',
          targetUserId: 'member-3',
          emailDigest: 'member-3-email-digest',
        },
      },
      {
        issued: issuer.emailSignIn({
          expectedEpoch: epoch(),
          emailDigest: 'sign-in-email-digest',
          resolvedAccountUserIds: ['account-2', 'account-1'],
        }),
        operation: 'email-sign-in' as const,
        plan: expectedPrelockPlan('email-sign-in', {
          lane: 'submitted-email',
          emailDigest: 'sign-in-email-digest',
          accountUserIds: ['account-1', 'account-2'],
        }),
        captured: {
          mutation: 'email-sign-in',
          emailDigest: 'sign-in-email-digest',
          resolvedAccountUserIds: ['account-1', 'account-2'],
        },
      },
      {
        issued: issuer.checkedSignOut({
          expectedEpoch: epoch(),
          signedTokenDigest: 'signed-token-digest',
          resolvedAccountUserId: 'account-1',
        }),
        operation: 'checked-sign-out' as const,
        plan: expectedPrelockPlan('checked-sign-out', {
          accountUserIds: ['account-1'],
        }),
        captured: {
          mutation: 'checked-sign-out',
          signedTokenDigest: 'signed-token-digest',
          resolvedAccountUserId: 'account-1',
        },
      },
      {
        issued: issuer.memberResetRedemption({
          expectedEpoch: epoch(),
          codeIdentity: 'member-code-id',
          emailDigest: 'member-email-digest',
          targetUserId: null,
        }),
        operation: 'member-reset-redemption' as const,
        plan: expectedPrelockPlan('member-reset-redemption', {
          lane: 'submitted-email',
          emailDigest: 'member-email-digest',
          unknownAccountEmailDigest: 'member-email-digest',
        }),
        captured: {
          mutation: 'member-reset-redemption',
          codeIdentity: 'member-code-id',
          emailDigest: 'member-email-digest',
          hostInvocationId: null,
          targetUserId: null,
          channel: 'member',
        },
      },
      {
        issued: issuer.ownerRecoveryWebRedemption({
          expectedEpoch: epoch(),
          codeIdentity: 'web-code-id',
          emailDigest: 'owner-email-digest',
          expectedOwnerUserId: 'owner-1',
        }),
        operation: 'owner-recovery-web-redemption' as const,
        plan: expectedPrelockPlan('owner-recovery-web-redemption', {
          lane: 'submitted-email',
          emailDigest: 'owner-email-digest',
          accountUserIds: ['owner-1'],
        }),
        captured: {
          mutation: 'owner-recovery-web-redemption',
          codeIdentity: 'web-code-id',
          emailDigest: 'owner-email-digest',
          hostInvocationId: null,
          targetUserId: 'owner-1',
          channel: 'owner-web',
        },
      },
      {
        issued: issuer.ownerRecoveryCliRedemption({
          expectedEpoch: epoch(),
          codeIdentity: 'cli-code-id',
          expectedOwnerUserId: 'owner-1',
          hostInvocationId: 'host-call-cli',
        }),
        operation: 'owner-recovery-cli-redemption' as const,
        plan: expectedPrelockPlan('owner-recovery-cli-redemption', {
          lane: 'external-host',
          accountUserIds: ['owner-1'],
          hostInvocationId: 'host-call-cli',
        }),
        captured: {
          mutation: 'owner-recovery-cli-redemption',
          codeIdentity: 'cli-code-id',
          emailDigest: null,
          hostInvocationId: 'host-call-cli',
          targetUserId: 'owner-1',
          channel: 'owner-cli',
        },
      },
      {
        issued: issuer.bootstrapIssuance({
          expectedEpoch: epoch(),
          capabilityIdentity: 'bootstrap-capability',
          hostInvocationId: 'host-call-1',
        }),
        operation: 'bootstrap-issuance' as const,
        plan: expectedPrelockPlan('bootstrap-issuance', {
          lane: 'external-host',
          hostInvocationId: 'host-call-1',
        }),
        captured: {
          kind: 'host-bootstrap',
          mutation: 'issuance',
          capabilityIdentity: 'bootstrap-capability',
          hostInvocationId: 'host-call-1',
        },
      },
      {
        issued: issuer.bootstrapRedemption({
          expectedEpoch: epoch(),
          capabilityIdentity: 'bootstrap-capability',
          codeIdentity: 'bootstrap-code-id',
          preallocatedOwnerUserId: 'owner-1',
          emailDigest: 'owner-email-digest',
        }),
        operation: 'bootstrap-redemption' as const,
        plan: expectedPrelockPlan('bootstrap-redemption', {
          emailDigest: 'owner-email-digest',
          accountUserIds: ['owner-1'],
        }),
        captured: {
          kind: 'host-bootstrap',
          mutation: 'redemption',
          capabilityIdentity: 'bootstrap-capability',
          codeIdentity: 'bootstrap-code-id',
          preallocatedOwnerUserId: 'owner-1',
          emailDigest: 'owner-email-digest',
        },
      },
      {
        issued: issuer.ownerRecoveryIssue({
          expectedEpoch: epoch(),
          expectedOwnerUserId: 'owner-1',
          hostInvocationId: 'host-call-2',
        }),
        operation: 'owner-recovery-issue' as const,
        plan: expectedPrelockPlan('owner-recovery-issue', {
          lane: 'external-host',
          accountUserIds: ['owner-1'],
          hostInvocationId: 'host-call-2',
        }),
        captured: {
          kind: 'owner-recovery-issue',
          expectedOwnerUserId: 'owner-1',
          hostInvocationId: 'host-call-2',
        },
      },
      {
        issued: issuer.expiredSessionMaintenance({
          expectedEpoch: epoch(),
          expectedOwnerUserId: 'owner-1',
          hostInvocationId: 'host-call-3',
          cursor: 'cursor-1',
          batchSize: 100,
          resolvedAccountUserIds: ['account-2', 'account-1'],
        }),
        operation: 'expired-session-maintenance' as const,
        plan: expectedPrelockPlan('expired-session-maintenance', {
          lane: 'external-host',
          accountUserIds: ['account-1', 'account-2'],
          hostInvocationId: 'host-call-3',
        }),
        captured: {
          kind: 'expired-session-maintenance',
          expectedOwnerUserId: 'owner-1',
          hostInvocationId: 'host-call-3',
          cursor: 'cursor-1',
          batchSize: 100,
          resolvedAccountUserIds: ['account-1', 'account-2'],
        },
      },
    ]

    expect(testCases).toHaveLength(13)
    for (const { issued, operation, plan, captured } of testCases) {
      const genericIssued = issued as IssuedMutationAuthority<MutationAuthority>
      const consumed = bindAndConsumePrelockPlan(genericIssued, operation)
      expect(consumed.plan, operation).toEqual(plan)
      const request = prelockedRequest(genericIssued)
      prepareMutationAuthorityClaim(request, operation)
      const claim = consumePreparedMutationAuthority(request)
      expect(claim.capturedAuthority, operation).toMatchObject(captured)
      claim.finish({ committed: true })
    }
  })

  it('rejects the wrong prelocked operation and duplicate account identities', () => {
    const issuer = createPlatformMutationAuthorityIssuer()
    const signOut = issuer.checkedSignOut({
      expectedEpoch: epoch(),
      signedTokenDigest: 'token-digest',
      resolvedAccountUserId: 'user-1',
    })
    expect(() => bindPlatformMutationAuthorityScope(signOut, 'email-sign-in')).toThrow(
      expect.objectContaining({ code: 'uow.prelocked-session-invalid' }),
    )

    expect(() =>
      issuer.emailSignIn({
        expectedEpoch: epoch(),
        emailDigest: 'email-digest',
        resolvedAccountUserIds: ['user-1', 'user-1'],
      }),
    ).toThrow('Mutation authority input is invalid')
  })

  it('keeps only the maintenance cursor on its wider bounded base64url surface', () => {
    const issuer = createPlatformMutationAuthorityIssuer()
    expect(() =>
      issuer.expiredSessionMaintenance({
        expectedEpoch: epoch(),
        expectedOwnerUserId: 'owner-1',
        hostInvocationId: 'host-call-long-cursor',
        cursor: 'a'.repeat(8_192),
        batchSize: 1,
        resolvedAccountUserIds: ['account-1'],
      }),
    ).not.toThrow()
    for (const cursor of ['a'.repeat(8_193), 'not+base64url']) {
      expect(() =>
        issuer.expiredSessionMaintenance({
          expectedEpoch: epoch(),
          expectedOwnerUserId: 'owner-1',
          hostInvocationId: 'host-call-invalid-cursor',
          cursor,
          batchSize: 1,
          resolvedAccountUserIds: ['account-1'],
        }),
      ).toThrow('Mutation authority input is invalid')
    }
    expect(() =>
      issuer.ownerRecoveryIssue({
        expectedEpoch: epoch(),
        expectedOwnerUserId: 'owner-1',
        hostInvocationId: 'a'.repeat(301),
      }),
    ).toThrow('Mutation authority input is invalid')
  })
})
