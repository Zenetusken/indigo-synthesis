import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  CredentialAdministrationCaptureInvariantError,
  captureLocalUserCreationMutation,
  captureMemberResetIssuanceMutation,
  type IdentityCredentialAdministrationQuery,
  LocalUserCreationMutationCapture,
  localUserCreationMutationCaptureView,
  MemberResetIssuanceMutationCapture,
  memberResetIssuanceMutationCaptureView,
  recheckLocalUserCreationMutation,
  recheckMemberResetIssuanceMutation,
} from './credential-administration-mutation'

const epoch = '123e4567-e89b-42d3-a456-426614174000'
const nextEpoch = '223e4567-e89b-42d3-a456-426614174001'
const verifiedToken = 'opaque-cryptographically-verified-session-token'
const commandEnteredAt = new Date('2026-07-15T12:00:00.000Z')
const sessionExpiresAt = new Date('2026-07-15T13:00:00.000Z')
const createdAt = new Date('2026-01-01T00:00:00.000Z')
const updatedAt = new Date('2026-06-01T00:00:00.000Z')

type ResultRow = QueryResultRow & Record<string, unknown>

function result(row: ResultRow): QueryResult<ResultRow> {
  return {
    command: 'SELECT',
    rowCount: 1,
    oid: 0,
    fields: [],
    rows: [row],
  }
}

function querySequence(...rows: ResultRow[]): {
  readonly query: ReturnType<typeof vi.fn>
  readonly surface: IdentityCredentialAdministrationQuery
} {
  const query = vi.fn()
  for (const row of rows) query.mockResolvedValueOnce(result(row))
  return {
    query,
    surface: { query } as unknown as IdentityCredentialAdministrationQuery,
  }
}

function credential(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `credential-${userId}`,
    accountId: userId,
    userId,
    password: `hash-for-${userId}`,
    createdAt,
    updatedAt,
    ...overrides,
  }
}

function snapshotRow(
  input: {
    readonly epoch?: string
    readonly bootstrapClosedAt?: Date
    readonly sessionId?: string | null
    readonly sessionUserId?: string | null
    readonly sessionExpiresAt?: Date | null
    readonly actorName?: string | null
    readonly target?: boolean
    readonly targetUserId?: string
    readonly targetEmail?: string
    readonly submittedEmailUserIds?: readonly string[]
    readonly credentials?: readonly Record<string, unknown>[]
    readonly memberResetState?:
      | false
      | Readonly<{
          activeVerificationId?: string | null
          lastIssuedAt?: Date
          failedAttempts?: number
          retryAfter?: Date | null
          lastAttemptAt?: Date | null
          updatedAt?: Date
        }>
    readonly memberResetVerifications?: readonly Record<string, unknown>[]
  } = {},
): ResultRow {
  const actorUserId = 'actor-owner'
  const targetUserId = input.targetUserId ?? 'target-member'
  const target = input.target ?? true
  const targetIsActor = targetUserId === actorUserId
  const resetState = input.memberResetState ?? false
  return {
    product_mutation_epoch: input.epoch ?? epoch,
    installation_owner_user_id: actorUserId,
    bootstrap_closed_at: input.bootstrapClosedAt ?? new Date('2026-01-02T00:00:00.000Z'),
    session_id: input.sessionId === undefined ? 'provider-session-id' : input.sessionId,
    session_user_id:
      input.sessionUserId === undefined ? actorUserId : input.sessionUserId,
    session_expires_at:
      input.sessionExpiresAt === undefined ? sessionExpiresAt : input.sessionExpiresAt,
    actor_user_id: input.actorName === null ? null : actorUserId,
    actor_name: input.actorName === undefined ? 'Installation Owner' : input.actorName,
    actor_email: input.actorName === null ? null : 'owner@example.test',
    actor_email_verified: input.actorName === null ? null : false,
    actor_created_at: input.actorName === null ? null : createdAt,
    actor_updated_at: input.actorName === null ? null : updatedAt,
    target_user_id: target ? targetUserId : null,
    target_name: target ? (targetIsActor ? 'Installation Owner' : 'Trainee') : null,
    target_email: target
      ? (input.targetEmail ??
        (targetIsActor ? 'owner@example.test' : 'trainee@example.test'))
      : null,
    target_email_verified: target ? false : null,
    target_created_at: target ? createdAt : null,
    target_updated_at: target ? updatedAt : null,
    member_reset_target_user_id: resetState ? targetUserId : null,
    member_reset_active_verification_id: resetState
      ? (resetState.activeVerificationId ?? 'verification-member-reset')
      : null,
    member_reset_last_issued_at: resetState
      ? (resetState.lastIssuedAt ?? updatedAt)
      : null,
    member_reset_failed_attempts: resetState ? (resetState.failedAttempts ?? 0) : null,
    member_reset_retry_after: resetState ? (resetState.retryAfter ?? null) : null,
    member_reset_last_attempt_at: resetState ? (resetState.lastAttemptAt ?? null) : null,
    member_reset_created_at: resetState ? createdAt : null,
    member_reset_updated_at: resetState ? (resetState.updatedAt ?? updatedAt) : null,
    submitted_email_user_ids: input.submittedEmailUserIds ?? [],
    credential_rows:
      input.credentials ??
      (target && targetUserId !== actorUserId
        ? [credential(actorUserId), credential(targetUserId)]
        : [credential(actorUserId)]),
    member_reset_verification_rows:
      input.memberResetVerifications ??
      (resetState && resetState.activeVerificationId !== null
        ? [
            {
              id: resetState.activeVerificationId ?? 'verification-member-reset',
              identifier: `indigo:member-reset:${targetUserId}`,
              value:
                'member-reset-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              expiresAt: sessionExpiresAt,
              createdAt,
              updatedAt: resetState.updatedAt ?? updatedAt,
            },
          ]
        : []),
  }
}

async function localCapture(
  surface: IdentityCredentialAdministrationQuery,
  enteredAt = commandEnteredAt,
) {
  return captureLocalUserCreationMutation(surface, {
    verifiedSessionToken: verifiedToken,
    preallocatedTargetUserId: 'target-member',
    submittedEmail: '  New.Member@Example.TEST  ',
    commandEnteredAt: enteredAt,
  })
}

async function resetCapture(
  surface: IdentityCredentialAdministrationQuery,
  targetUserId = 'target-member',
) {
  return captureMemberResetIssuanceMutation(surface, {
    verifiedSessionToken: verifiedToken,
    targetUserId,
    commandEnteredAt,
  })
}

describe('credential-administration mutation capture', () => {
  it('derives the exact owner/session from only a verified token and keeps secrets opaque', async () => {
    const { query, surface } = querySequence(snapshotRow({ target: false }))

    const capture = await localCapture(surface)
    const view = localUserCreationMutationCaptureView(capture)

    expect(view).toEqual({
      purpose: 'local-user-create',
      expectedEpoch: epoch,
      actorUserId: 'actor-owner',
      sessionId: 'provider-session-id',
      sessionExpiresAt,
      expectedRole: 'owner',
      preallocatedTargetUserId: 'target-member',
      submittedEmailUserIds: [],
      actorCredential: 'present',
    })
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[1]).toEqual([
      verifiedToken,
      'target-member',
      'new.member@example.test',
    ])
    expect(query.mock.calls[0]?.[0]).toContain('matched_session.token = $1')
    expect(query.mock.calls[0]?.[0]).toContain('actor.id = matched_session.user_id')
    expect(query.mock.calls[0]?.[0]).toContain('LIMIT 2')
    expect(query.mock.calls[0]?.[0]).toContain('LIMIT 3')
    expect(JSON.stringify(capture)).toBe('{}')
    expect(JSON.stringify(view)).not.toContain(verifiedToken)
    expect(JSON.stringify(view)).not.toContain('hash-for-actor-owner')
  })

  it('captures member target and credential presence without exposing credential rows', async () => {
    const { query, surface } = querySequence(snapshotRow())

    const capture = await resetCapture(surface)

    expect(memberResetIssuanceMutationCaptureView(capture)).toEqual({
      purpose: 'member-reset-issue',
      expectedEpoch: epoch,
      actorUserId: 'actor-owner',
      sessionId: 'provider-session-id',
      sessionExpiresAt,
      expectedRole: 'owner',
      targetUserId: 'target-member',
      targetState: 'member',
      actorCredential: 'present',
      targetCredential: 'present',
    })
    expect(query.mock.calls[0]?.[1]).toEqual([verifiedToken, 'target-member', null])
    expect(JSON.stringify(capture)).toBe('{}')
  })

  it('rechecks the exact snapshot with one statement and reuses command-entry time', async () => {
    const enteredAt = new Date(commandEnteredAt)
    const row = snapshotRow({ target: false })
    const { query, surface } = querySequence(row, row)
    const capture = await localCapture(surface, enteredAt)
    enteredAt.setUTCFullYear(2099)

    await expect(recheckLocalUserCreationMutation(surface, capture)).resolves.toEqual({
      status: 'current',
    })
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]?.[1]).toEqual([
      verifiedToken,
      'target-member',
      'new.member@example.test',
    ])
  })

  it('snapshots caller-owned command time before the capture query can yield', async () => {
    let settleQuery: ((value: QueryResult<ResultRow>) => void) | undefined
    const query = vi.fn(
      () =>
        new Promise<QueryResult<ResultRow>>((resolve) => {
          settleQuery = resolve
        }),
    )
    const enteredAt = new Date(commandEnteredAt)
    const capturePromise = captureMemberResetIssuanceMutation(
      { query } as unknown as IdentityCredentialAdministrationQuery,
      {
        verifiedSessionToken: verifiedToken,
        targetUserId: 'target-member',
        commandEnteredAt: enteredAt,
      },
    )
    enteredAt.setTime(sessionExpiresAt.getTime() + 1)
    settleQuery?.(result(snapshotRow()))

    await expect(capturePromise).resolves.toBeInstanceOf(
      MemberResetIssuanceMutationCapture,
    )
  })

  it('classifies the installed owner as a normal invalid reset target', async () => {
    const { surface } = querySequence(snapshotRow({ targetUserId: 'actor-owner' }))

    const capture = await resetCapture(surface, 'actor-owner')

    expect(memberResetIssuanceMutationCaptureView(capture).targetState).toBe('owner')
  })

  it.each([
    ['epoch', snapshotRow({ epoch: nextEpoch }), 'installation-epoch-changed'],
    [
      'installation authority',
      snapshotRow({ bootstrapClosedAt: new Date('2026-02-02T00:00:00.000Z') }),
      'installation-authority-changed',
    ],
    [
      'session expiry',
      snapshotRow({ sessionExpiresAt: new Date('2026-07-15T14:00:00.000Z') }),
      'session-changed',
    ],
    [
      'session expiry shortened past command entry',
      snapshotRow({ sessionExpiresAt: new Date('2026-07-15T11:59:59.999Z') }),
      'session-changed',
    ],
    ['actor row', snapshotRow({ actorName: 'Renamed Owner' }), 'actor-changed'],
    [
      'target row',
      snapshotRow({ targetEmail: 'changed@example.test' }),
      'target-state-changed',
    ],
    [
      'credential row',
      snapshotRow({
        credentials: [
          credential('actor-owner', { password: 'replacement-hash' }),
          credential('target-member'),
        ],
      }),
      'credential-set-changed',
    ],
    [
      'actor credential removal',
      snapshotRow({ credentials: [credential('target-member')] }),
      'credential-set-changed',
    ],
    [
      'member reset state',
      snapshotRow({ memberResetState: {} }),
      'member-reset-state-changed',
    ],
  ] as const)('fails closed when the %s changes while queued', async (_, changed, reason) => {
    const { surface } = querySequence(snapshotRow(), changed)
    const capture = await resetCapture(surface)

    await expect(recheckMemberResetIssuanceMutation(surface, capture)).resolves.toEqual({
      status: 'stale',
      reason,
    })
  })

  it('detects a submitted-email account appearing while local creation waits', async () => {
    const { surface } = querySequence(
      snapshotRow({ target: false }),
      snapshotRow({ target: false, submittedEmailUserIds: ['competing-user'] }),
    )
    const capture = await localCapture(surface)

    await expect(recheckLocalUserCreationMutation(surface, capture)).resolves.toEqual({
      status: 'stale',
      reason: 'submitted-email-set-changed',
    })
  })

  it('classifies a session revoked while queued as stale authority', async () => {
    const { surface } = querySequence(
      snapshotRow(),
      snapshotRow({
        actorName: null,
        sessionId: null,
        sessionUserId: null,
        sessionExpiresAt: null,
      }),
    )
    const capture = await resetCapture(surface)

    await expect(recheckMemberResetIssuanceMutation(surface, capture)).resolves.toEqual({
      status: 'stale',
      reason: 'session-changed',
    })
  })

  it('fails closed on ambiguous account sets, duplicate credentials, and missing owner proof', async () => {
    const ambiguousEmail = querySequence(
      snapshotRow({
        target: false,
        submittedEmailUserIds: ['candidate-a', 'candidate-b'],
      }),
    )
    await expect(localCapture(ambiguousEmail.surface)).rejects.toBeInstanceOf(
      CredentialAdministrationCaptureInvariantError,
    )

    const duplicateCredential = querySequence(
      snapshotRow({
        credentials: [
          credential('actor-owner'),
          credential('actor-owner', { id: 'credential-owner-second' }),
        ],
      }),
    )
    await expect(resetCapture(duplicateCredential.surface)).rejects.toBeInstanceOf(
      CredentialAdministrationCaptureInvariantError,
    )

    const missingOwnerCredential = querySequence(
      snapshotRow({ credentials: [credential('target-member')] }),
    )
    await expect(resetCapture(missingOwnerCredential.surface)).rejects.toBeInstanceOf(
      CredentialAdministrationCaptureInvariantError,
    )

    const duplicateVerification = querySequence(
      snapshotRow({
        memberResetState: {},
        memberResetVerifications: [
          {
            id: 'verification-member-reset',
            identifier: 'indigo:member-reset:target-member',
            value:
              'member-reset-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            expiresAt: sessionExpiresAt,
            createdAt,
            updatedAt,
          },
          {
            id: 'verification-member-reset-duplicate',
            identifier: 'indigo:member-reset:target-member',
            value:
              'member-reset-v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            expiresAt: sessionExpiresAt,
            createdAt,
            updatedAt,
          },
        ],
      }),
    )
    await expect(resetCapture(duplicateVerification.surface)).rejects.toBeInstanceOf(
      CredentialAdministrationCaptureInvariantError,
    )
  })

  it('rejects expired or mismatched sessions, malformed tokens, and forged captures', async () => {
    const expired = querySequence(
      snapshotRow({ sessionExpiresAt: new Date('2026-07-15T11:59:59.999Z') }),
    )
    await expect(resetCapture(expired.surface)).rejects.toBeInstanceOf(
      CredentialAdministrationCaptureInvariantError,
    )

    const mismatched = querySequence(snapshotRow({ sessionUserId: 'other-user' }))
    await expect(resetCapture(mismatched.surface)).rejects.toBeInstanceOf(
      CredentialAdministrationCaptureInvariantError,
    )

    const malformed = querySequence(snapshotRow())
    await expect(
      captureMemberResetIssuanceMutation(malformed.surface, {
        verifiedSessionToken: 'bad\0token',
        targetUserId: 'target-member',
        commandEnteredAt,
      }),
    ).rejects.toThrow('cryptographically verified session token')
    expect(malformed.query).not.toHaveBeenCalled()

    const forgedLocal = Object.create(
      LocalUserCreationMutationCapture.prototype,
    ) as LocalUserCreationMutationCapture
    expect(() => localUserCreationMutationCaptureView(forgedLocal)).toThrow(
      'was not issued by Identity',
    )
    const forgedReset = Object.create(
      MemberResetIssuanceMutationCapture.prototype,
    ) as MemberResetIssuanceMutationCapture
    await expect(
      recheckMemberResetIssuanceMutation(malformed.surface, forgedReset),
    ).rejects.toThrow('was not issued by Identity')
  })

  it('rejects database rows that are not in the promised stable lexical order', async () => {
    const unorderedCredentials = querySequence(
      snapshotRow({
        credentials: [credential('target-member'), credential('actor-owner')],
      }),
    )
    await expect(resetCapture(unorderedCredentials.surface)).rejects.toBeInstanceOf(
      CredentialAdministrationCaptureInvariantError,
    )

    const unorderedEmailSet = querySequence(
      snapshotRow({
        target: false,
        submittedEmailUserIds: ['candidate-b', 'candidate-a'],
      }),
    )
    await expect(localCapture(unorderedEmailSet.surface)).rejects.toBeInstanceOf(
      CredentialAdministrationCaptureInvariantError,
    )
  })
})
