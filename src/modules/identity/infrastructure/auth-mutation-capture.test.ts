import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  type CheckedSignOutMutationCapture,
  captureCheckedSignOutMutation,
  captureEmailSignInMutation,
  checkedSignOutMutationCaptureView,
  deleteCapturedCheckedSignOutSession,
  EmailSignInMutationCapture,
  emailSignInMutationCaptureView,
  IdentityAuthMutationCaptureInvariantError,
  type IdentityAuthMutationQuery,
  recheckCheckedSignOutMutation,
  recheckEmailSignInMutation,
} from './auth-mutation-capture'

const epoch = '123e4567-e89b-42d3-a456-426614174000'
const nextEpoch = '223e4567-e89b-42d3-a456-426614174001'

type ResultRow = QueryResultRow & Record<string, unknown>

function result(row: ResultRow): QueryResult<ResultRow> {
  return resultRows([row])
}

function resultRows(rows: ResultRow[]): QueryResult<ResultRow> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  }
}

function querySequence(...rows: ResultRow[]): {
  readonly query: ReturnType<typeof vi.fn>
  readonly surface: IdentityAuthMutationQuery
} {
  const query = vi.fn()
  for (const row of rows) query.mockResolvedValueOnce(result(row))
  return { query, surface: { query } as unknown as IdentityAuthMutationQuery }
}

function emailRow(
  input: {
    readonly epoch?: string
    readonly installationState?: 'bootstrap-open' | 'claimed'
    readonly ownerUserId?: string | null
    readonly userIds?: readonly string[]
  } = {},
): ResultRow {
  const installationState = input.installationState ?? 'claimed'
  return {
    product_mutation_epoch: input.epoch ?? epoch,
    installation_owner_user_id:
      input.ownerUserId === undefined
        ? installationState === 'claimed'
          ? 'owner-user'
          : null
        : input.ownerUserId,
    installation_state: installationState,
    resolved_account_user_ids: input.userIds ?? ['user-a'],
  }
}

function signOutRow(
  input: {
    readonly epoch?: string
    readonly installationState?: 'bootstrap-open' | 'claimed'
    readonly ownerUserId?: string | null
    readonly sessionId?: string | null
    readonly accountUserId?: string | null
    readonly sessionStatus?: 'active' | 'expired' | null
  } = {},
): ResultRow {
  const installationState = input.installationState ?? 'claimed'
  return {
    product_mutation_epoch: input.epoch ?? epoch,
    installation_owner_user_id:
      input.ownerUserId === undefined
        ? installationState === 'claimed'
          ? 'owner-user'
          : null
        : input.ownerUserId,
    installation_state: installationState,
    session_id: input.sessionId === undefined ? 'session-a' : input.sessionId,
    account_user_id: input.accountUserId === undefined ? 'user-a' : input.accountUserId,
    session_status: input.sessionStatus === undefined ? 'active' : input.sessionStatus,
  }
}

describe('Identity authentication mutation capture repository', () => {
  it('coherently captures a canonical sorted normalized-email account set', async () => {
    const { query, surface } = querySequence(emailRow({ userIds: ['user-z', 'user-a'] }))

    const capture = await captureEmailSignInMutation(surface, '  Owner@Example.TEST  ')

    expect(emailSignInMutationCaptureView(capture)).toEqual({
      expectedEpoch: epoch,
      installationState: 'claimed',
      resolvedAccountUserIds: ['user-a', 'user-z'],
    })
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[1]).toEqual(['owner@example.test'])
    expect(query.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('installation_state'),
    )
    expect(query.mock.calls[0]?.[0]).toEqual(expect.stringContaining('FROM "user"'))
    expect(query.mock.calls[0]?.[0]).toEqual(expect.stringContaining('COLLATE "C"'))
    expect(JSON.stringify(capture)).toBe('{}')
    expect(Object.keys(capture)).toEqual([])
  })

  it('rechecks epoch, open state, and the exact account set with one new statement', async () => {
    const current = querySequence(
      emailRow({
        installationState: 'bootstrap-open',
        userIds: ['user-b', 'user-a'],
      }),
      emailRow({
        installationState: 'bootstrap-open',
        userIds: ['user-a', 'user-b'],
      }),
    )
    const currentCapture = await captureEmailSignInMutation(
      current.surface,
      'owner@example.test',
    )

    await expect(
      recheckEmailSignInMutation(current.surface, currentCapture),
    ).resolves.toEqual({ status: 'current' })
    expect(current.query).toHaveBeenCalledTimes(2)

    const changed = querySequence(
      emailRow({ userIds: ['user-a'] }),
      emailRow({ userIds: ['user-a', 'user-b'] }),
    )
    const changedCapture = await captureEmailSignInMutation(
      changed.surface,
      'owner@example.test',
    )
    await expect(
      recheckEmailSignInMutation(changed.surface, changedCapture),
    ).resolves.toEqual({
      status: 'stale',
      reason: 'resolved-account-set-changed',
    })
  })

  it.each([
    ['epoch', emailRow({ epoch: nextEpoch }), 'installation-epoch-changed'],
    [
      'installation state',
      emailRow({ installationState: 'bootstrap-open' }),
      'installation-state-changed',
    ],
    [
      'installation owner',
      emailRow({ ownerUserId: 'replacement-owner' }),
      'installation-state-changed',
    ],
  ] as const)('rejects a changed sign-in %s before provider work', async (_, changed, reason) => {
    const { surface } = querySequence(emailRow(), changed)
    const capture = await captureEmailSignInMutation(surface, 'owner@example.test')

    await expect(recheckEmailSignInMutation(surface, capture)).resolves.toEqual({
      status: 'stale',
      reason,
    })
  })

  it('rejects invalid installation/cardinality/account shapes instead of minting evidence', async () => {
    const invalidEpoch = querySequence(emailRow({ epoch: 'not-an-installation-epoch' }))
    await expect(
      captureEmailSignInMutation(invalidEpoch.surface, 'owner@example.test'),
    ).rejects.toBeInstanceOf(IdentityAuthMutationCaptureInvariantError)

    const duplicateAccount = querySequence(emailRow({ userIds: ['user-a', 'user-a'] }))
    await expect(
      captureEmailSignInMutation(duplicateAccount.surface, 'owner@example.test'),
    ).rejects.toBeInstanceOf(IdentityAuthMutationCaptureInvariantError)
  })

  it('keeps the verified session token out of the checked-sign-out capture view', async () => {
    const { query, surface } = querySequence(signOutRow())
    const verifiedToken = 'opaque-verified-session-token'

    const capture = await captureCheckedSignOutMutation(surface, verifiedToken)

    expect(checkedSignOutMutationCaptureView(capture)).toEqual({
      expectedEpoch: epoch,
      installationState: 'claimed',
      session: {
        sessionId: 'session-a',
        accountUserId: 'user-a',
        status: 'active',
      },
    })
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[1]).toEqual([verifiedToken])
    expect(query.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('FROM installation_state'),
    )
    expect(query.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('LEFT JOIN "session"'),
    )
    expect(JSON.stringify(capture)).toBe('{}')
    expect(JSON.stringify(checkedSignOutMutationCaptureView(capture))).not.toContain(
      verifiedToken,
    )
  })

  it('represents already-absent and expired sign-out sessions without inventing identity', async () => {
    const absent = querySequence(
      signOutRow({ sessionId: null, accountUserId: null, sessionStatus: null }),
    )
    const absentCapture = await captureCheckedSignOutMutation(
      absent.surface,
      'absent-token',
    )
    expect(checkedSignOutMutationCaptureView(absentCapture).session).toBeNull()

    const expired = querySequence(signOutRow({ sessionStatus: 'expired' }))
    const expiredCapture = await captureCheckedSignOutMutation(
      expired.surface,
      'expired-token',
    )
    expect(checkedSignOutMutationCaptureView(expiredCapture).session).toEqual({
      sessionId: 'session-a',
      accountUserId: 'user-a',
      status: 'expired',
    })
  })

  it('allows natural sign-out expiry but rejects changed token-resolved identity', async () => {
    const expiring = querySequence(signOutRow(), signOutRow({ sessionStatus: 'expired' }))
    const expiringCapture = await captureCheckedSignOutMutation(
      expiring.surface,
      'expiring-token',
    )
    await expect(
      recheckCheckedSignOutMutation(expiring.surface, expiringCapture),
    ).resolves.toEqual({ status: 'current', sessionStatus: 'expired' })

    const changed = querySequence(
      signOutRow(),
      signOutRow({ sessionId: 'session-b', accountUserId: 'user-b' }),
    )
    const changedCapture = await captureCheckedSignOutMutation(
      changed.surface,
      'changed-token',
    )
    await expect(
      recheckCheckedSignOutMutation(changed.surface, changedCapture),
    ).resolves.toEqual({ status: 'stale', reason: 'session-identity-changed' })
  })

  it('accepts a competing checked sign-out winner as transactionally proven absent', async () => {
    const alreadyAbsent = querySequence(
      signOutRow(),
      signOutRow({ sessionId: null, accountUserId: null, sessionStatus: null }),
    )
    const capture = await captureCheckedSignOutMutation(
      alreadyAbsent.surface,
      'concurrently-deleted-token',
    )

    await expect(
      recheckCheckedSignOutMutation(alreadyAbsent.surface, capture),
    ).resolves.toEqual({ status: 'current', sessionStatus: null })

    const newlyPresent = querySequence(
      signOutRow({ sessionId: null, accountUserId: null, sessionStatus: null }),
      signOutRow(),
    )
    const absentCapture = await captureCheckedSignOutMutation(
      newlyPresent.surface,
      'newly-present-token',
    )
    await expect(
      recheckCheckedSignOutMutation(newlyPresent.surface, absentCapture),
    ).resolves.toEqual({ status: 'stale', reason: 'session-identity-changed' })
  })

  it('requires DELETE RETURNING evidence and preserves the captured session identity', async () => {
    const { query, surface } = querySequence(signOutRow())
    const capture = await captureCheckedSignOutMutation(surface, 'checked-token')
    query.mockResolvedValueOnce(
      resultRows([{ session_id: 'session-a', account_user_id: 'user-a' }]),
    )

    await expect(deleteCapturedCheckedSignOutSession(surface, capture)).resolves.toEqual({
      status: 'deleted',
    })
    expect(query.mock.calls[1]?.[0]).toEqual(expect.stringContaining('DELETE FROM'))
    expect(query.mock.calls[1]?.[0]).toEqual(expect.stringContaining('RETURNING'))
    expect(query.mock.calls[1]?.[1]).toEqual(['checked-token'])

    const concurrentlyAbsent = querySequence(signOutRow())
    const absentAfterCapture = await captureCheckedSignOutMutation(
      concurrentlyAbsent.surface,
      'concurrent-token',
    )
    concurrentlyAbsent.query.mockResolvedValueOnce(resultRows([]))
    await expect(
      deleteCapturedCheckedSignOutSession(concurrentlyAbsent.surface, absentAfterCapture),
    ).resolves.toEqual({ status: 'already-absent' })
  })

  it('rejects changed DELETE RETURNING identity and an initially absent capture', async () => {
    const changed = querySequence(signOutRow())
    const changedCapture = await captureCheckedSignOutMutation(
      changed.surface,
      'changed-delete-token',
    )
    changed.query.mockResolvedValueOnce(
      resultRows([{ session_id: 'session-b', account_user_id: 'user-b' }]),
    )
    await expect(
      deleteCapturedCheckedSignOutSession(changed.surface, changedCapture),
    ).rejects.toBeInstanceOf(IdentityAuthMutationCaptureInvariantError)

    const absent = querySequence(
      signOutRow({ sessionId: null, accountUserId: null, sessionStatus: null }),
    )
    const absentCapture = await captureCheckedSignOutMutation(
      absent.surface,
      'absent-delete-token',
    )
    await expect(
      deleteCapturedCheckedSignOutSession(absent.surface, absentCapture),
    ).rejects.toThrow('account-bound session capture')
  })

  it('rejects forged nominal captures and malformed token/session shapes', async () => {
    const forged = Object.create(
      EmailSignInMutationCapture.prototype,
    ) as EmailSignInMutationCapture
    expect(() => emailSignInMutationCaptureView(forged)).toThrow(
      'was not issued by Identity',
    )

    const malformed = querySequence(
      signOutRow({ sessionId: null, accountUserId: 'user-a', sessionStatus: null }),
    )
    await expect(
      captureCheckedSignOutMutation(malformed.surface, 'verified-token'),
    ).rejects.toBeInstanceOf(IdentityAuthMutationCaptureInvariantError)

    await expect(
      captureCheckedSignOutMutation(malformed.surface, 'bad\0token'),
    ).rejects.toThrow('verified session token')

    const forgedSignOut = {} as CheckedSignOutMutationCapture
    expect(() => checkedSignOutMutationCaptureView(forgedSignOut)).toThrow(
      'was not issued by Identity',
    )
  })
})
