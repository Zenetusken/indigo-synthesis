import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  captureInstanceResetMutation,
  captureTraineeDataDeletionMutation,
  IdentityDestructiveMutationAuthorityUnavailableError,
  IdentityDestructiveMutationCaptureInvariantError,
  IdentityDestructiveMutationCaptureStaleError,
  type IdentityDestructiveMutationQuery,
  InstanceResetMutationCapture,
  instanceResetMutationCaptureView,
  instanceResetMutationReauthenticationScope,
  issueInstanceResetMutationCommand,
  issueTraineeDataDeletionMutationCommand,
  recheckInstanceResetMutation,
  recheckTraineeDataDeletionMutation,
  TraineeDataDeletionMutationCapture,
  traineeDataDeletionMutationCaptureView,
  traineeDataDeletionMutationReauthenticationScope,
} from './destructive-mutation'

const epoch = '123e4567-e89b-42d3-a456-426614174000'
const nextEpoch = '223e4567-e89b-42d3-a456-426614174001'
const verifiedToken = 'opaque-cryptographically-verified-session-token'
const commandEnteredAt = new Date('2026-07-16T13:00:00.000Z')
const sessionExpiresAt = new Date('2026-07-16T14:00:00.000Z')
const createdAt = new Date('2026-01-01T00:00:00.000Z')
const updatedAt = new Date('2026-06-01T00:00:00.000Z')

type ResultRow = QueryResultRow & Record<string, unknown>

function resultRows(rows: ResultRow[]): QueryResult<ResultRow> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  }
}

function result(row: ResultRow): QueryResult<ResultRow> {
  return resultRows([row])
}

function querySequence(...rows: ResultRow[]): {
  readonly query: ReturnType<typeof vi.fn>
  readonly surface: IdentityDestructiveMutationQuery
} {
  const query = vi.fn()
  for (const row of rows) query.mockResolvedValueOnce(result(row))
  return { query, surface: { query } as unknown as IdentityDestructiveMutationQuery }
}

function userRow(id: string, overrides: Record<string, unknown> = {}) {
  const owner = id === 'owner-user'
  return {
    id,
    name: owner ? 'Installation Owner' : 'Trainee Member',
    email: owner ? 'owner@example.test' : 'member@example.test',
    emailVerified: false,
    createdAt,
    updatedAt,
    ...overrides,
  }
}

function sessionRow(actorUserId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'provider-session-id',
    userId: actorUserId,
    expiresAt: sessionExpiresAt,
    createdAt,
    updatedAt,
    active: true,
    ...overrides,
  }
}

function credentialRow(actorUserId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `credential-${actorUserId}`,
    accountId: actorUserId,
    userId: actorUserId,
    password: `password-hash-${actorUserId}`,
    createdAt,
    updatedAt,
    ...overrides,
  }
}

function snapshotRow(
  input: {
    readonly epoch?: string
    readonly ownerUserId?: string
    readonly bootstrapClosedAt?: Date
    readonly actorUserId?: string
    readonly sessions?: readonly Record<string, unknown>[]
    readonly actors?: readonly Record<string, unknown>[]
    readonly owners?: readonly Record<string, unknown>[]
    readonly credentials?: readonly Record<string, unknown>[]
  } = {},
): ResultRow {
  const ownerUserId = input.ownerUserId ?? 'owner-user'
  const actorUserId = input.actorUserId ?? 'member-user'
  return {
    product_mutation_epoch: input.epoch ?? epoch,
    installation_owner_user_id: ownerUserId,
    bootstrap_closed_at: input.bootstrapClosedAt ?? new Date('2026-01-02T00:00:00.000Z'),
    session_rows: input.sessions ?? [sessionRow(actorUserId)],
    actor_rows: input.actors ?? [userRow(actorUserId)],
    owner_rows: input.owners ?? [userRow(ownerUserId)],
    credential_rows: input.credentials ?? [credentialRow(actorUserId)],
  }
}

function commandInput(overrides: Record<string, unknown> = {}) {
  return {
    actionBinding: 'opaque-action-binding',
    planId: 'rendered-plan-id',
    planDigest: 'rendered-plan-digest',
    currentPassword: 'private-current-password',
    typedConfirmation: 'DELETE',
    acknowledged: true,
    commandEnteredAt,
    requestContext: { channel: 'web' as const, clientAddress: '192.0.2.17' },
    verifiedSessionToken: verifiedToken,
    ...overrides,
  }
}

function subjectCommand() {
  return issueTraineeDataDeletionMutationCommand(commandInput())
}

function resetCommand() {
  return issueInstanceResetMutationCommand(commandInput({ typedConfirmation: 'RESET' }))
}

describe('Identity destructive mutation capture repository', () => {
  it('coherently derives an exact active member authority without exposing its token', async () => {
    const { query, surface } = querySequence(snapshotRow())
    const capture = await captureTraineeDataDeletionMutation(surface, subjectCommand())

    expect(traineeDataDeletionMutationCaptureView(capture)).toEqual({
      purpose: 'trainee-data-deletion',
      expectedEpoch: epoch,
      sessionId: 'provider-session-id',
      sessionExpiresAt,
      actorUserId: 'member-user',
      actorEmail: 'member@example.test',
      actorName: 'Trainee Member',
      expectedRole: 'member',
      installationOwnerUserId: 'owner-user',
      installationState: 'claimed',
      actorCredential: 'present',
      planId: 'rendered-plan-id',
      planDigest: 'rendered-plan-digest',
    })
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[1]).toEqual([verifiedToken])
    expect(query.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('CURRENT_TIMESTAMP AS active'),
    )
    expect(query.mock.calls[0]?.[0]).toEqual(expect.stringContaining('LIMIT 2'))
    expect(JSON.stringify(capture)).toBe('{}')
    expect(JSON.stringify(traineeDataDeletionMutationCaptureView(capture))).not.toContain(
      verifiedToken,
    )

    const reauthentication = traineeDataDeletionMutationReauthenticationScope(capture)
    expect(reauthentication).toEqual({
      purpose: 'trainee-data-deletion',
      actorUserId: 'member-user',
      commandEnteredAt,
    })
    reauthentication.commandEnteredAt.setUTCFullYear(2099)
    expect(
      traineeDataDeletionMutationReauthenticationScope(capture).commandEnteredAt,
    ).toEqual(commandEnteredAt)
  })

  it('admits instance reset only for the coherently installed owner', async () => {
    const owner = snapshotRow({ actorUserId: 'owner-user' })
    const { surface } = querySequence(owner)
    const capture = await captureInstanceResetMutation(surface, resetCommand())

    expect(instanceResetMutationCaptureView(capture)).toMatchObject({
      purpose: 'instance-reset',
      actorUserId: 'owner-user',
      expectedRole: 'owner',
      installationOwnerUserId: 'owner-user',
    })
    expect(instanceResetMutationReauthenticationScope(capture)).toEqual({
      purpose: 'instance-reset',
      actorUserId: 'owner-user',
      commandEnteredAt,
    })
    expect(() =>
      traineeDataDeletionMutationReauthenticationScope(capture as never),
    ).toThrow('purpose does not match')

    const member = querySequence(snapshotRow())
    await expect(
      captureInstanceResetMutation(member.surface, resetCommand()),
    ).rejects.toBeInstanceOf(IdentityDestructiveMutationAuthorityUnavailableError)
  })

  it.each([
    ['epoch', snapshotRow({ epoch: nextEpoch }), 'installation-epoch-changed'],
    [
      'owner authority',
      snapshotRow({
        ownerUserId: 'replacement-owner',
        owners: [userRow('replacement-owner')],
      }),
      'installation-authority-changed',
    ],
    [
      'session identity',
      snapshotRow({
        sessions: [sessionRow('member-user', { id: 'replacement-session' })],
      }),
      'session-changed',
    ],
    [
      'actor identity',
      snapshotRow({ actors: [userRow('member-user', { name: 'Renamed Member' })] }),
      'actor-changed',
    ],
    [
      'credential',
      snapshotRow({
        credentials: [credentialRow('member-user', { password: 'replacement-hash' })],
      }),
      'credential-set-changed',
    ],
    ['actor disappearance', snapshotRow({ actors: [] }), 'actor-changed'],
    [
      'installed-owner disappearance',
      snapshotRow({ owners: [] }),
      'installation-authority-changed',
    ],
    [
      'credential disappearance',
      snapshotRow({ credentials: [] }),
      'credential-set-changed',
    ],
  ] as const)('rejects a changed %s on the first post-BEGIN recheck', async (_, changed, reason) => {
    const { surface } = querySequence(snapshotRow(), changed)
    const capture = await captureTraineeDataDeletionMutation(surface, subjectCommand())

    await expect(recheckTraineeDataDeletionMutation(surface, capture)).resolves.toEqual({
      status: 'stale',
      reason,
    })
  })

  it('rechecks the same owner snapshot as current for instance reset', async () => {
    const owner = snapshotRow({ actorUserId: 'owner-user' })
    const { query, surface } = querySequence(owner, owner)
    const capture = await captureInstanceResetMutation(surface, resetCommand())

    await expect(recheckInstanceResetMutation(surface, capture)).resolves.toEqual({
      status: 'current',
    })
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]?.[1]).toEqual([verifiedToken])
  })

  it('still rejects impossible duplicate rows during recheck instead of classifying corruption as ordinary staleness', async () => {
    const duplicateCredential = snapshotRow({
      credentials: [
        credentialRow('member-user'),
        credentialRow('member-user', { id: 'duplicate-credential' }),
      ],
    })
    const { surface } = querySequence(snapshotRow(), duplicateCredential)
    const capture = await captureTraineeDataDeletionMutation(surface, subjectCommand())

    await expect(
      recheckTraineeDataDeletionMutation(surface, capture),
    ).rejects.toBeInstanceOf(IdentityDestructiveMutationCaptureInvariantError)
  })

  it('maps an absent or expired session to unavailable capture and stale recheck', async () => {
    const absent = querySequence(snapshotRow({ sessions: [] }))
    await expect(
      captureTraineeDataDeletionMutation(absent.surface, subjectCommand()),
    ).rejects.toBeInstanceOf(IdentityDestructiveMutationAuthorityUnavailableError)

    const expired = querySequence(
      snapshotRow({ sessions: [sessionRow('member-user', { active: false })] }),
    )
    await expect(
      captureTraineeDataDeletionMutation(expired.surface, subjectCommand()),
    ).rejects.toBeInstanceOf(IdentityDestructiveMutationCaptureStaleError)

    const revoked = querySequence(snapshotRow(), snapshotRow({ sessions: [] }))
    const capture = await captureTraineeDataDeletionMutation(
      revoked.surface,
      subjectCommand(),
    )
    await expect(
      recheckTraineeDataDeletionMutation(revoked.surface, capture),
    ).resolves.toEqual({ status: 'stale', reason: 'session-changed' })
  })

  it('fails closed on duplicate and impossible relational shapes', async () => {
    const duplicateSession = querySequence(
      snapshotRow({
        sessions: [
          sessionRow('member-user'),
          sessionRow('member-user', { id: 'duplicate-session' }),
        ],
      }),
    )
    await expect(
      captureTraineeDataDeletionMutation(duplicateSession.surface, subjectCommand()),
    ).rejects.toBeInstanceOf(IdentityDestructiveMutationCaptureInvariantError)

    for (const row of [
      snapshotRow({ actors: [] }),
      snapshotRow({ owners: [] }),
      snapshotRow({ credentials: [] }),
      snapshotRow({
        credentials: [
          credentialRow('member-user'),
          credentialRow('member-user', { id: 'duplicate-credential' }),
        ],
      }),
      snapshotRow({
        credentials: [credentialRow('member-user', { accountId: 'other-user' })],
      }),
      snapshotRow({
        sessions: [sessionRow('other-user')],
        actors: [userRow('member-user')],
      }),
      snapshotRow({ owners: [userRow('different-owner')] }),
    ]) {
      const invalid = querySequence(row)
      await expect(
        captureTraineeDataDeletionMutation(invalid.surface, subjectCommand()),
      ).rejects.toBeInstanceOf(IdentityDestructiveMutationCaptureInvariantError)
    }
  })

  it('rejects missing installation cardinality, malformed plan input, and forged nominals', async () => {
    const missingInstallationQuery = vi.fn().mockResolvedValue(resultRows([]))
    await expect(
      captureTraineeDataDeletionMutation(
        {
          query: missingInstallationQuery,
        } as unknown as IdentityDestructiveMutationQuery,
        subjectCommand(),
      ),
    ).rejects.toBeInstanceOf(IdentityDestructiveMutationCaptureInvariantError)

    const malformed = querySequence(snapshotRow())
    await expect(
      captureTraineeDataDeletionMutation(
        malformed.surface,
        issueTraineeDataDeletionMutationCommand(commandInput({ planId: 'bad\0plan' })),
      ),
    ).rejects.toThrow('Plan id')
    expect(malformed.query).not.toHaveBeenCalled()

    await expect(
      captureTraineeDataDeletionMutation(malformed.surface, {} as never),
    ).rejects.toThrow('was not issued by Identity')

    const forgedSubject = Object.create(
      TraineeDataDeletionMutationCapture.prototype,
    ) as TraineeDataDeletionMutationCapture
    expect(() => traineeDataDeletionMutationCaptureView(forgedSubject)).toThrow(
      'was not issued by Identity',
    )
    const forgedReset = Object.create(
      InstanceResetMutationCapture.prototype,
    ) as InstanceResetMutationCapture
    expect(() => recheckInstanceResetMutation(malformed.surface, forgedReset)).toThrow(
      'was not issued by Identity',
    )
  })
})
