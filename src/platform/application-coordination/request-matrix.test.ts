import { describe, expect, it } from 'vitest'
import type {
  AuthenticatedDestructiveAuthority,
  ContentLockPlanBindings,
  ContentLockPlanShape,
  DestructivePurpose,
  InstallationMutationEpoch,
  MutationAuthority,
  PrelockedSessionOperation,
} from '@/application/coordination'
import { createInstallationMutationEpoch } from './lifecycle-values'
import {
  bindPlatformMutationAuthorityScope,
  consumePlatformCredentialPrelockPlan,
  consumePreparedMutationAuthority,
  createPlatformMutationAuthorityIssuer,
  type IssuedMutationAuthority,
} from './mutation-authority'
import { captureUnitOfWorkRequest } from './request-matrix'
import { transactionLocalStateForRequest } from './transaction-local-state'

const epoch = createInstallationMutationEpoch('123e4567-e89b-42d3-a456-426614174000')
const opaque = (): object => ({})

function authenticated(expectedRole: 'member' | 'owner' = 'owner') {
  return createPlatformMutationAuthorityIssuer().authenticatedSession({
    expectedEpoch: epoch,
    actorUserId: 'actor-1',
    sessionId: 'session-1',
    expectedRole,
  }).authority
}

function boundAuthority<Authority extends MutationAuthority>(
  issued: IssuedMutationAuthority<Authority>,
  operation: PrelockedSessionOperation,
): Authority {
  const scope = bindPlatformMutationAuthorityScope(issued, operation)
  consumePlatformCredentialPrelockPlan(scope)
  return issued.authority
}

function planBindings(
  shape: ContentLockPlanShape,
  operation: string,
  subjectId: string | null,
): ContentLockPlanBindings {
  return {
    shape,
    purpose: operation,
    actorAccountId: 'actor-1',
    subjectId,
    formOrCommandId: 'command-1',
    sourceEntityIds: [],
    expectedEpoch: epoch,
    expectedGeneration: null,
  }
}

function ordinaryProduct(
  operation:
    | 'content-release-revocation'
    | 'correction-closure'
    | 'current-publication.existing'
    | 'current-publication.initial'
    | 'global-product-mutation'
    | 'stale-regeneration'
    | 'subject-product-mutation',
  shape: ContentLockPlanShape,
  subjectId: string | null,
) {
  return {
    operation,
    authority: authenticated(),
    session: { kind: 'ordinary' },
    workflowPurpose: operation,
    expectedEpoch: epoch,
    productFence: 'shared',
    subjectLock:
      subjectId === null ? null : { subjectUserId: subjectId, mode: 'exclusive' },
    content: {
      kind: 'verified',
      plan: opaque(),
      bindings: planBindings(shape, operation, subjectId),
    },
    mode: { isolation: 'read-committed', access: 'read-write' },
  }
}

function destructiveAttempt(purpose: DestructivePurpose) {
  const issuer = createPlatformMutationAuthorityIssuer()
  const authenticated = issuer.authenticatedSession({
    expectedEpoch: epoch,
    actorUserId: 'actor-1',
    sessionId: `session-${purpose}`,
    expectedRole: 'owner',
  })
  switch (purpose) {
    case 'trainee-data-deletion': {
      const issued = issuer.traineeDataDeletionAttempt({ authenticated })
      const scope = bindPlatformMutationAuthorityScope(issued, 'subject-deletion')
      consumePlatformCredentialPrelockPlan(scope)
      return issued
    }
    case 'instance-reset': {
      const issued = issuer.instanceResetAttempt({ authenticated })
      const scope = bindPlatformMutationAuthorityScope(issued, 'instance-reset')
      consumePlatformCredentialPrelockPlan(scope)
      return issued
    }
    case 'member-reset-issue': {
      const issued = issuer.memberResetIssueAttempt({
        authenticated,
        targetUserId: 'target-1',
      })
      const scope = bindPlatformMutationAuthorityScope(issued, 'member-reset-issue')
      consumePlatformCredentialPrelockPlan(scope)
      return issued
    }
    case 'local-user-create': {
      const issued = issuer.localUserCreateAttempt({
        authenticated,
        targetUserId: 'target-1',
        emailDigest: 'target-email-digest-1',
      })
      const scope = bindPlatformMutationAuthorityScope(issued, 'local-user-create')
      consumePlatformCredentialPrelockPlan(scope)
      return issued
    }
  }
}

function prelockedRequest(input: {
  readonly access?: 'read-write'
  readonly authority: object
  readonly isolation: 'read-committed' | 'serializable'
  readonly operation: string
  readonly productFence?: 'exclusive' | 'shared'
  readonly subjectLock?: object | null
}) {
  return {
    operation: input.operation,
    authority: input.authority,
    session: { kind: 'prelocked', lease: opaque() },
    expectedEpoch: epoch,
    productFence: input.productFence ?? 'shared',
    subjectLock: input.subjectLock ?? null,
    content: { kind: 'none' },
    mode: {
      isolation: input.isolation,
      access: input.access ?? 'read-write',
    },
  }
}

function promotedDestructiveAuthority(
  purpose: DestructivePurpose,
): AuthenticatedDestructiveAuthority {
  const issued = destructiveAttempt(purpose)
  const attemptRequest = captureUnitOfWorkRequest(
    prelockedRequest({
      operation: 'destructive-reauthentication-attempt',
      authority: issued.authority,
      isolation: 'read-committed',
    }),
  )
  const claim = consumePreparedMutationAuthority(attemptRequest)
  const protectedAuthority = claim.markReauthenticationSucceeded()
  claim.finish({ committed: true })
  return protectedAuthority
}

function credential(mutation: string, isolation: 'read-committed' | 'serializable') {
  const issuer = createPlatformMutationAuthorityIssuer()
  switch (mutation) {
    case 'email-sign-in':
      return prelockedRequest({
        operation: 'credential-lifecycle-mutation',
        authority: boundAuthority(
          issuer.emailSignIn({
            expectedEpoch: epoch,
            emailDigest: 'email-digest-1',
            resolvedAccountUserIds: ['actor-1'],
          }),
          'email-sign-in',
        ),
        isolation,
      })
    case 'checked-sign-out':
      return prelockedRequest({
        operation: 'credential-lifecycle-mutation',
        authority: boundAuthority(
          issuer.checkedSignOut({
            expectedEpoch: epoch,
            signedTokenDigest: 'token-digest-1',
            resolvedAccountUserId: 'actor-1',
          }),
          'checked-sign-out',
        ),
        isolation,
      })
    case 'member-reset-redemption':
      return prelockedRequest({
        operation: 'credential-lifecycle-mutation',
        authority: boundAuthority(
          issuer.memberResetRedemption({
            expectedEpoch: epoch,
            codeIdentity: 'member-code-1',
            emailDigest: 'member-email-digest-1',
            targetUserId: null,
          }),
          'member-reset-redemption',
        ),
        isolation,
      })
    case 'owner-recovery-web-redemption':
      return prelockedRequest({
        operation: 'credential-lifecycle-mutation',
        authority: boundAuthority(
          issuer.ownerRecoveryWebRedemption({
            expectedEpoch: epoch,
            codeIdentity: 'owner-web-code-1',
            emailDigest: 'owner-email-digest-1',
            expectedOwnerUserId: 'owner-1',
          }),
          'owner-recovery-web-redemption',
        ),
        isolation,
      })
    case 'owner-recovery-cli-redemption':
      return prelockedRequest({
        operation: 'credential-lifecycle-mutation',
        authority: boundAuthority(
          issuer.ownerRecoveryCliRedemption({
            expectedEpoch: epoch,
            codeIdentity: 'owner-cli-code-1',
            expectedOwnerUserId: 'owner-1',
            hostInvocationId: 'owner-cli-host-invocation-1',
          }),
          'owner-recovery-cli-redemption',
        ),
        isolation,
      })
    default:
      throw new Error(`unsupported credential mutation: ${mutation}`)
  }
}

function validRequests(): readonly (readonly [label: string, request: unknown])[] {
  const issuer = createPlatformMutationAuthorityIssuer()
  return [
    ['global product mutation', ordinaryProduct('global-product-mutation', 'none', null)],
    [
      'release revocation',
      ordinaryProduct('content-release-revocation', 'release-revocation', null),
    ],
    [
      'subject product mutation',
      ordinaryProduct('subject-product-mutation', 'none', 'actor-1'),
    ],
    [
      'initial publication',
      ordinaryProduct(
        'current-publication.initial',
        'current-publication.initial',
        'actor-1',
      ),
    ],
    [
      'existing publication',
      ordinaryProduct(
        'current-publication.existing',
        'current-publication.existing',
        'actor-1',
      ),
    ],
    [
      'stale regeneration',
      ordinaryProduct('stale-regeneration', 'stale-regeneration', 'actor-1'),
    ],
    [
      'correction closure',
      ordinaryProduct('correction-closure', 'correction-closure', 'actor-1'),
    ],
    [
      'subject export',
      {
        operation: 'subject-export',
        authority: authenticated('member'),
        session: { kind: 'ordinary' },
        expectedEpoch: epoch,
        productFence: 'shared',
        subjectLock: { subjectUserId: 'actor-1', mode: 'shared' },
        content: { kind: 'none' },
        mode: { isolation: 'repeatable-read', access: 'read-only' },
      },
    ],
    [
      'subject deletion',
      prelockedRequest({
        operation: 'subject-deletion',
        authority: promotedDestructiveAuthority('trainee-data-deletion'),
        isolation: 'serializable',
        subjectLock: { subjectUserId: 'actor-1', mode: 'exclusive' },
      }),
    ],
    [
      'instance reset',
      prelockedRequest({
        operation: 'instance-reset',
        authority: promotedDestructiveAuthority('instance-reset'),
        isolation: 'serializable',
        productFence: 'exclusive',
      }),
    ],
    ...(
      [
        ['trainee-data-deletion', 'read-committed'],
        ['instance-reset', 'read-committed'],
        ['member-reset-issue', 'read-committed'],
        ['local-user-create', 'read-committed'],
      ] as const
    ).map(
      ([purpose, isolation]) =>
        [
          `reauthentication ${purpose}`,
          prelockedRequest({
            operation: 'destructive-reauthentication-attempt',
            authority: destructiveAttempt(purpose).authority,
            isolation,
          }),
        ] as const,
    ),
    [
      'member reset issue mutation',
      prelockedRequest({
        operation: 'destructive-identity-mutation',
        authority: promotedDestructiveAuthority('member-reset-issue'),
        isolation: 'serializable',
      }),
    ],
    [
      'local user creation',
      prelockedRequest({
        operation: 'destructive-identity-mutation',
        authority: promotedDestructiveAuthority('local-user-create'),
        isolation: 'read-committed',
      }),
    ],
    ['email sign in', credential('email-sign-in', 'read-committed')],
    ['checked sign out', credential('checked-sign-out', 'read-committed')],
    ['member reset redemption', credential('member-reset-redemption', 'serializable')],
    [
      'owner recovery web redemption',
      credential('owner-recovery-web-redemption', 'serializable'),
    ],
    [
      'owner recovery CLI redemption',
      credential('owner-recovery-cli-redemption', 'serializable'),
    ],
    [
      'bootstrap issuance',
      prelockedRequest({
        operation: 'host-bootstrap-mutation',
        authority: boundAuthority(
          issuer.bootstrapIssuance({
            expectedEpoch: epoch,
            capabilityIdentity: 'bootstrap-capability-1',
            hostInvocationId: 'host-invocation-1',
          }),
          'bootstrap-issuance',
        ),
        isolation: 'serializable',
      }),
    ],
    [
      'bootstrap redemption',
      prelockedRequest({
        operation: 'host-bootstrap-mutation',
        authority: boundAuthority(
          issuer.bootstrapRedemption({
            expectedEpoch: epoch,
            capabilityIdentity: 'bootstrap-capability-2',
            codeIdentity: 'bootstrap-code-1',
            preallocatedOwnerUserId: 'owner-1',
            emailDigest: 'owner-email-digest-1',
          }),
          'bootstrap-redemption',
        ),
        isolation: 'serializable',
      }),
    ],
    [
      'owner recovery issue',
      prelockedRequest({
        operation: 'host-maintenance',
        authority: boundAuthority(
          issuer.ownerRecoveryIssue({
            expectedEpoch: epoch,
            expectedOwnerUserId: 'owner-1',
            hostInvocationId: 'host-invocation-2',
          }),
          'owner-recovery-issue',
        ),
        isolation: 'serializable',
      }),
    ],
    [
      'expired session maintenance',
      prelockedRequest({
        operation: 'host-maintenance',
        authority: boundAuthority(
          issuer.expiredSessionMaintenance({
            expectedEpoch: epoch,
            expectedOwnerUserId: 'owner-1',
            hostInvocationId: 'host-invocation-3',
            cursor: 'a'.repeat(8_192),
            batchSize: 100,
            resolvedAccountUserIds: ['member-2', 'member-1'],
          }),
          'expired-session-maintenance',
        ),
        isolation: 'read-committed',
      }),
    ],
  ]
}

describe('Platform UnitOfWork request matrix', () => {
  it('captures all 25 legal runtime rows into frozen structural snapshots', () => {
    const requests = validRequests()
    expect(requests).toHaveLength(25)
    for (const [, request] of requests) {
      const captured = captureUnitOfWorkRequest(request)
      expect(Object.isFrozen(captured)).toBe(true)
      expect(Object.isFrozen(captured.authority)).toBe(true)
      expect(Object.isFrozen(captured.session)).toBe(true)
      expect(Object.isFrozen(captured.mode)).toBe(true)
      expect(Object.isFrozen(captured.content)).toBe(true)
    }
  })

  it('maps all 25 captured rows onto the closed two-setting privilege matrix', () => {
    const requests = validRequests()
    expect(requests).toHaveLength(25)
    for (const [label, request] of requests) {
      const state = transactionLocalStateForRequest(captureUnitOfWorkRequest(request))
      const expected =
        label === 'subject deletion'
          ? { userCreationMode: '', deletionMode: 'trainee-data' }
          : label === 'instance reset'
            ? { userCreationMode: '', deletionMode: 'instance-reset' }
            : label === 'local user creation'
              ? { userCreationMode: 'owner-admin', deletionMode: '' }
              : label === 'bootstrap redemption'
                ? { userCreationMode: 'bootstrap-owner', deletionMode: '' }
                : { userCreationMode: '', deletionMode: '' }
      expect(state, label).toEqual(expected)
    }
  })

  it('does not conflate the 64-key correction limit with source binding count', () => {
    const request = ordinaryProduct('global-product-mutation', 'none', null)
    const sourceEntityIds = Array.from(
      { length: 65 },
      (_value, index) => `source-${String(index).padStart(2, '0')}`,
    )
    const captured = captureUnitOfWorkRequest({
      ...request,
      content: {
        ...request.content,
        bindings: { ...request.content.bindings, sourceEntityIds },
      },
    })
    if (captured.content.kind !== 'verified') {
      throw new Error('expected verified content')
    }
    expect(captured.content.bindings.sourceEntityIds).toHaveLength(65)
  })

  it('rejects every high-risk forged cross-product before it becomes a canonical request', () => {
    const requests = validRequests()
    const exportRequest = requests.find(([label]) => label === 'subject export')?.[1]
    const resetRequest = requests.find(([label]) => label === 'instance reset')?.[1]
    const signOut = requests.find(([label]) => label === 'checked sign out')?.[1]
    if (!exportRequest || !resetRequest || !signOut) throw new Error('missing fixtures')

    const forgedEpoch = {} as InstallationMutationEpoch
    const hostile = [
      { ...exportRequest, mode: { isolation: 'read-committed', access: 'read-write' } },
      {
        ...ordinaryProduct('global-product-mutation', 'none', null),
        content: { kind: 'none' },
      },
      {
        ...ordinaryProduct('subject-product-mutation', 'none', 'subject-1'),
        subjectLock: { subjectUserId: 'subject-1', mode: 'shared' },
      },
      { ...resetRequest, productFence: 'shared' },
      { ...signOut, authority: { kind: 'credential-lifecycle', mutation: 'unknown' } },
      { ...resetRequest, operation: 'unknown-operation' },
      { ...exportRequest, content: { kind: 'unknown' } },
      { ...exportRequest, mode: { isolation: 'unknown', access: 'read-only' } },
      { ...exportRequest, expectedEpoch: forgedEpoch },
      {
        ...prelockedRequest({
          operation: 'destructive-identity-mutation',
          authority: {
            ...promotedDestructiveAuthority('local-user-create'),
            purpose: 'unknown',
          },
          isolation: 'read-committed',
        }),
      },
    ]
    for (const request of hostile) {
      expect(() => captureUnitOfWorkRequest(request)).toThrow('closed runtime matrix')
    }
  })

  it('rejects accessor-backed structure without invoking a caller getter', () => {
    const request = { ...(validRequests()[7]?.[1] as object) }
    let reads = 0
    Object.defineProperty(request, 'mode', {
      enumerable: true,
      get() {
        reads += 1
        return { isolation: 'repeatable-read', access: 'read-only' }
      },
    })

    expect(() => captureUnitOfWorkRequest(request)).toThrow('closed runtime matrix')
    expect(reads).toBe(0)
  })
})
