import { describe, expect, it } from 'vitest'
import type { MutationAuthority, UnitOfWorkRequest } from '@/application/coordination'
import { createInstallationMutationEpoch } from './lifecycle-values'
import {
  bindPlatformMutationAuthorityScope,
  consumePreparedMutationAuthority,
  createPlatformMutationAuthorityIssuer,
  type IssuedMutationAuthority,
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

describe('Platform mutation authority', () => {
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
    const scope = bindPlatformMutationAuthorityScope(issued, 'checked-sign-out')
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
    const scope = bindPlatformMutationAuthorityScope(attempt, 'member-reset-issue')
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
    const scope = bindPlatformMutationAuthorityScope(attempt, 'instance-reset')
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
    const scope = bindPlatformMutationAuthorityScope(issued, 'checked-sign-out')
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
    })
    const attemptScope = bindPlatformMutationAuthorityScope(
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
    })
    const protectedScope = bindPlatformMutationAuthorityScope(
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
    bindPlatformMutationAuthorityScope(attempt, 'subject-deletion')
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
        },
      },
      {
        issued: issuer.localUserCreateAttempt({
          authenticated: owner,
          targetUserId: 'member-3',
        }),
        operation: 'local-user-create' as const,
        expected: {
          actorUserId: 'owner-1',
          sessionId: 'owner-session',
          expectedRole: 'owner',
          purpose: 'local-user-create',
          targetUserId: 'member-3',
        },
      },
    ]

    for (const { issued, operation, expected } of cases) {
      const genericIssued = issued as IssuedMutationAuthority<MutationAuthority>
      bindPlatformMutationAuthorityScope(genericIssued, operation)
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

  it('fixes every credential, bootstrap, and host private binding by named method', () => {
    const issuer = createPlatformMutationAuthorityIssuer()
    const testCases = [
      {
        issued: issuer.emailSignIn({
          expectedEpoch: epoch(),
          emailDigest: 'email-digest',
          resolvedAccountUserIds: ['account-2', 'account-1'],
        }),
        operation: 'email-sign-in' as const,
        captured: {
          mutation: 'email-sign-in',
          emailDigest: 'email-digest',
          resolvedAccountUserIds: ['account-1', 'account-2'],
        },
      },
      {
        issued: issuer.memberResetRedemption({
          expectedEpoch: epoch(),
          codeIdentity: 'member-code-id',
          targetUserId: 'member-1',
        }),
        operation: 'member-reset-redemption' as const,
        captured: {
          mutation: 'member-reset-redemption',
          codeIdentity: 'member-code-id',
          targetUserId: 'member-1',
          channel: 'member',
        },
      },
      {
        issued: issuer.ownerRecoveryWebRedemption({
          expectedEpoch: epoch(),
          codeIdentity: 'web-code-id',
          expectedOwnerUserId: 'owner-1',
        }),
        operation: 'owner-recovery-web-redemption' as const,
        captured: {
          kind: 'credential-lifecycle',
          mutation: 'owner-recovery-web-redemption',
          codeIdentity: 'web-code-id',
          targetUserId: 'owner-1',
          channel: 'owner-web',
        },
      },
      {
        issued: issuer.ownerRecoveryCliRedemption({
          expectedEpoch: epoch(),
          codeIdentity: 'cli-code-id',
          expectedOwnerUserId: 'owner-1',
        }),
        operation: 'owner-recovery-cli-redemption' as const,
        captured: {
          kind: 'credential-lifecycle',
          mutation: 'owner-recovery-cli-redemption',
          codeIdentity: 'cli-code-id',
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
        }),
        operation: 'expired-session-maintenance' as const,
        captured: {
          kind: 'expired-session-maintenance',
          expectedOwnerUserId: 'owner-1',
          hostInvocationId: 'host-call-3',
          cursor: 'cursor-1',
          batchSize: 100,
        },
      },
    ]

    for (const { issued, operation, captured } of testCases) {
      const genericIssued = issued as IssuedMutationAuthority<MutationAuthority>
      bindPlatformMutationAuthorityScope(genericIssued, operation)
      const request = prelockedRequest(genericIssued)
      prepareMutationAuthorityClaim(request, operation)
      const claim = consumePreparedMutationAuthority(request)
      expect(claim.capturedAuthority).toMatchObject(captured)
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
})
