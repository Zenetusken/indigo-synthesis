import { describe, expect, it } from 'vitest'
import type {
  ContentLockPlanBindings,
  ContentLockPlanShape,
  DestructivePurpose,
  InstallationMutationEpoch,
} from '@/application/coordination'
import { createInstallationMutationEpoch } from './lifecycle-values'
import { captureUnitOfWorkRequest } from './request-matrix'

const epoch = createInstallationMutationEpoch('123e4567-e89b-42d3-a456-426614174000')
const opaque = (): object => ({})

function authenticated(expectedRole: 'member' | 'owner' = 'owner') {
  return {
    kind: 'authenticated-session',
    actorUserId: 'actor-1',
    expectedRole,
    session: opaque(),
  }
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

function destructiveAuthority(
  kind: 'authenticated-destructive' | 'destructive-reauthentication-attempt',
  purpose: DestructivePurpose,
) {
  const targetUserId =
    purpose === 'member-reset-issue' || purpose === 'local-user-create'
      ? 'target-1'
      : null
  const base = {
    kind,
    actorUserId: 'actor-1',
    expectedRole: 'owner',
    session: opaque(),
    purpose,
    targetUserId,
  }
  return kind === 'authenticated-destructive'
    ? { ...base, reauthenticationLease: opaque() }
    : { ...base, attempt: opaque() }
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

function credential(mutation: string, isolation: 'read-committed' | 'serializable') {
  return prelockedRequest({
    operation: 'credential-lifecycle-mutation',
    authority: { kind: 'credential-lifecycle', mutation, authority: opaque() },
    isolation,
  })
}

const validRequests: readonly (readonly [label: string, request: unknown])[] = [
  ['global product mutation', ordinaryProduct('global-product-mutation', 'none', null)],
  [
    'release revocation',
    ordinaryProduct('content-release-revocation', 'release-revocation', null),
  ],
  [
    'subject product mutation',
    ordinaryProduct('subject-product-mutation', 'none', 'subject-1'),
  ],
  [
    'initial publication',
    ordinaryProduct(
      'current-publication.initial',
      'current-publication.initial',
      'subject-1',
    ),
  ],
  [
    'existing publication',
    ordinaryProduct(
      'current-publication.existing',
      'current-publication.existing',
      'subject-1',
    ),
  ],
  [
    'stale regeneration',
    ordinaryProduct('stale-regeneration', 'stale-regeneration', 'subject-1'),
  ],
  [
    'correction closure',
    ordinaryProduct('correction-closure', 'correction-closure', 'subject-1'),
  ],
  [
    'subject export',
    {
      operation: 'subject-export',
      authority: authenticated('member'),
      session: { kind: 'ordinary' },
      expectedEpoch: epoch,
      productFence: 'shared',
      subjectLock: { subjectUserId: 'subject-1', mode: 'shared' },
      content: { kind: 'none' },
      mode: { isolation: 'repeatable-read', access: 'read-only' },
    },
  ],
  [
    'subject deletion',
    prelockedRequest({
      operation: 'subject-deletion',
      authority: destructiveAuthority(
        'authenticated-destructive',
        'trainee-data-deletion',
      ),
      isolation: 'serializable',
      subjectLock: { subjectUserId: 'subject-1', mode: 'exclusive' },
    }),
  ],
  [
    'instance reset',
    prelockedRequest({
      operation: 'instance-reset',
      authority: destructiveAuthority('authenticated-destructive', 'instance-reset'),
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
          authority: destructiveAuthority(
            'destructive-reauthentication-attempt',
            purpose,
          ),
          isolation,
        }),
      ] as const,
  ),
  [
    'member reset issue mutation',
    prelockedRequest({
      operation: 'destructive-identity-mutation',
      authority: destructiveAuthority('authenticated-destructive', 'member-reset-issue'),
      isolation: 'serializable',
    }),
  ],
  [
    'local user creation',
    prelockedRequest({
      operation: 'destructive-identity-mutation',
      authority: destructiveAuthority('authenticated-destructive', 'local-user-create'),
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
      authority: { kind: 'host-bootstrap', mutation: 'issuance', authority: opaque() },
      isolation: 'serializable',
    }),
  ],
  [
    'bootstrap redemption',
    prelockedRequest({
      operation: 'host-bootstrap-mutation',
      authority: {
        kind: 'host-bootstrap',
        mutation: 'redemption',
        authority: opaque(),
      },
      isolation: 'serializable',
    }),
  ],
  [
    'owner recovery issue',
    prelockedRequest({
      operation: 'host-maintenance',
      authority: {
        kind: 'owner-recovery-issue',
        expectedOwnerUserId: 'owner-1',
        invocation: opaque(),
      },
      isolation: 'serializable',
    }),
  ],
  [
    'expired session maintenance',
    prelockedRequest({
      operation: 'host-maintenance',
      authority: {
        kind: 'expired-session-maintenance',
        cursor: null,
        batchSize: 100,
        invocation: opaque(),
      },
      isolation: 'read-committed',
    }),
  ],
]

describe('Platform UnitOfWork request matrix', () => {
  it('captures all 25 legal runtime rows into frozen structural snapshots', () => {
    expect(validRequests).toHaveLength(25)
    for (const [, request] of validRequests) {
      const captured = captureUnitOfWorkRequest(request)
      expect(Object.isFrozen(captured)).toBe(true)
      expect(Object.isFrozen(captured.authority)).toBe(true)
      expect(Object.isFrozen(captured.session)).toBe(true)
      expect(Object.isFrozen(captured.mode)).toBe(true)
      expect(Object.isFrozen(captured.content)).toBe(true)
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
    const exportRequest = validRequests.find(([label]) => label === 'subject export')?.[1]
    const resetRequest = validRequests.find(([label]) => label === 'instance reset')?.[1]
    const signOut = validRequests.find(([label]) => label === 'checked sign out')?.[1]
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
            ...destructiveAuthority('authenticated-destructive', 'local-user-create'),
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
    const request = { ...(validRequests[7]?.[1] as object) }
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
