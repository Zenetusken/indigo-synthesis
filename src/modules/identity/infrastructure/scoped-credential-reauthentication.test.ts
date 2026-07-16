import type { SQL } from 'drizzle-orm'
import { getTableName } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { QueryResult, QueryResultRow } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureLocalUserCreationMutation,
  captureMemberResetIssuanceMutation,
  type IdentityCredentialAdministrationQuery,
  localUserCreationMutationScope,
} from './credential-administration-mutation'
import {
  captureInstanceResetMutation,
  captureTraineeDataDeletionMutation,
  type IdentityDestructiveMutationQuery,
  type InstanceResetMutationCapture,
  issueInstanceResetMutationCommand,
  issueTraineeDataDeletionMutationCommand,
  TraineeDataDeletionMutationCapture,
} from './destructive-mutation'
import { destructiveReauthenticationPolicy } from './destructive-reauthentication'
import {
  createScopedInstanceResetReauthenticationGateway,
  createScopedLocalUserCreationReauthenticationGateway,
  createScopedMemberResetIssuanceReauthenticationGateway,
  createScopedSubjectDeletionReauthenticationGateway,
  ScopedCredentialReauthenticationInvariantError,
} from './scoped-credential-reauthentication'

const cryptoMocks = vi.hoisted(() => ({
  verifyPassword: vi.fn(),
}))

vi.mock('better-auth/crypto', () => ({
  verifyPassword: cryptoMocks.verifyPassword,
}))

const epoch = '123e4567-e89b-42d3-a456-426614174000'
const verifiedSessionToken = 'opaque-verified-token-never-forwarded-to-the-gateway'
const commandEnteredAt = new Date('2026-07-15T12:00:00.000Z')
const sessionExpiresAt = new Date('2026-07-15T13:00:00.000Z')
const createdAt = new Date('2026-01-01T00:00:00.000Z')
const updatedAt = new Date('2026-06-01T00:00:00.000Z')
const ownerUserId = 'actor-owner'
const targetUserId = 'target-member'

type SnapshotResultRow = QueryResultRow & Record<string, unknown>

function snapshotResult(row: SnapshotResultRow): QueryResult<SnapshotResultRow> {
  return {
    command: 'SELECT',
    rowCount: 1,
    oid: 0,
    fields: [],
    rows: [row],
  }
}

function credential(userId: string) {
  return {
    id: `credential-${userId}`,
    accountId: userId,
    userId,
    password: `capture-hash-${userId}`,
    createdAt,
    updatedAt,
  }
}

function snapshotRow(input: {
  readonly target: 'member' | 'member-without-credential' | 'owner' | 'missing'
}): SnapshotResultRow {
  const selectedTargetId = input.target === 'owner' ? ownerUserId : targetUserId
  const targetExists = input.target !== 'missing'
  return {
    product_mutation_epoch: epoch,
    installation_owner_user_id: ownerUserId,
    bootstrap_closed_at: new Date('2026-01-02T00:00:00.000Z'),
    session_id: 'provider-session-id',
    session_user_id: ownerUserId,
    session_expires_at: sessionExpiresAt,
    actor_user_id: ownerUserId,
    actor_name: 'Installation Owner',
    actor_email: 'owner@example.test',
    actor_email_verified: false,
    actor_created_at: createdAt,
    actor_updated_at: updatedAt,
    target_user_id: targetExists ? selectedTargetId : null,
    target_name: targetExists
      ? input.target === 'owner'
        ? 'Installation Owner'
        : 'Trainee'
      : null,
    target_email: targetExists
      ? input.target === 'owner'
        ? 'owner@example.test'
        : 'trainee@example.test'
      : null,
    target_email_verified: targetExists ? false : null,
    target_created_at: targetExists ? createdAt : null,
    target_updated_at: targetExists ? updatedAt : null,
    member_reset_target_user_id: null,
    member_reset_active_verification_id: null,
    member_reset_last_issued_at: null,
    member_reset_failed_attempts: null,
    member_reset_retry_after: null,
    member_reset_last_attempt_at: null,
    member_reset_created_at: null,
    member_reset_updated_at: null,
    submitted_email_user_ids: [],
    credential_rows:
      input.target === 'member'
        ? [credential(ownerUserId), credential(targetUserId)]
        : [credential(ownerUserId)],
    member_reset_verification_rows: [],
  }
}

function captureQuery(row: SnapshotResultRow): IdentityCredentialAdministrationQuery {
  const query = vi.fn().mockResolvedValue(snapshotResult(row))
  return { query } as unknown as IdentityCredentialAdministrationQuery
}

async function localCapture() {
  return captureLocalUserCreationMutation(
    captureQuery(snapshotRow({ target: 'missing' })),
    {
      verifiedSessionToken,
      preallocatedTargetUserId: targetUserId,
      submittedEmail: 'new.member@example.test',
      commandEnteredAt,
    },
  )
}

async function memberCapture(
  target: 'member' | 'member-without-credential' | 'owner' | 'missing' = 'member',
) {
  const selectedTargetId = target === 'owner' ? ownerUserId : targetUserId
  return captureMemberResetIssuanceMutation(captureQuery(snapshotRow({ target })), {
    verifiedSessionToken,
    targetUserId: selectedTargetId,
    commandEnteredAt,
  })
}

function destructiveUser(userId: string) {
  const isOwner = userId === ownerUserId
  return {
    id: userId,
    name: isOwner ? 'Installation Owner' : 'Trainee',
    email: isOwner ? 'owner@example.test' : 'trainee@example.test',
    emailVerified: false,
    createdAt,
    updatedAt,
  }
}

function destructiveSnapshotRow(actorUserId: string): SnapshotResultRow {
  return {
    product_mutation_epoch: epoch,
    installation_owner_user_id: ownerUserId,
    bootstrap_closed_at: new Date('2026-01-02T00:00:00.000Z'),
    session_rows: [
      {
        id: `destructive-session-${actorUserId}`,
        userId: actorUserId,
        expiresAt: sessionExpiresAt,
        createdAt,
        updatedAt,
        active: true,
      },
    ],
    actor_rows: [destructiveUser(actorUserId)],
    owner_rows: [destructiveUser(ownerUserId)],
    credential_rows: [credential(actorUserId)],
  }
}

function destructiveCaptureQuery(
  row: SnapshotResultRow,
): IdentityDestructiveMutationQuery {
  const query = vi.fn().mockResolvedValue(snapshotResult(row))
  return { query } as unknown as IdentityDestructiveMutationQuery
}

function destructiveCommandInput(typedConfirmation: 'DELETE' | 'RESET') {
  return {
    actionBinding: 'opaque-render-bound-action',
    planId: 'rendered-plan-id',
    planDigest: 'rendered-plan-digest',
    currentPassword: 'captured-private-password',
    typedConfirmation,
    acknowledged: true,
    commandEnteredAt,
    requestContext: { channel: 'web' as const, clientAddress: '192.0.2.17' },
    verifiedSessionToken,
  }
}

function subjectDeletionCapture() {
  return captureTraineeDataDeletionMutation(
    destructiveCaptureQuery(destructiveSnapshotRow(targetUserId)),
    issueTraineeDataDeletionMutationCommand(destructiveCommandInput('DELETE')),
  )
}

function instanceResetCapture() {
  return captureInstanceResetMutation(
    destructiveCaptureQuery(destructiveSnapshotRow(ownerUserId)),
    issueInstanceResetMutationCommand(destructiveCommandInput('RESET')),
  )
}

type RecordedWrite = {
  readonly table: string
  readonly values?: Record<string, unknown>
  readonly where?: SQL
}

function databaseHarness(selectRows: readonly (readonly unknown[])[]) {
  let selectionIndex = 0
  const selectionWheres: SQL[] = []
  const selectionLocks: string[] = []
  const selectionLimits: number[] = []
  const inserts: RecordedWrite[] = []
  const updates: RecordedWrite[] = []
  const deletes: RecordedWrite[] = []
  const operations: string[] = []

  const database = {
    select: vi.fn(() => {
      const rows = selectRows[selectionIndex]
      selectionIndex += 1
      return {
        from: vi.fn(() => ({
          where: vi.fn((where: SQL) => {
            selectionWheres.push(where)
            return {
              for: vi.fn((lock: string) => {
                selectionLocks.push(lock)
                return {
                  limit: vi.fn(async (limit: number) => {
                    selectionLimits.push(limit)
                    operations.push(`select:${selectionIndex}`)
                    return rows ?? []
                  }),
                }
              }),
            }
          }),
        })),
      }
    }),
    insert: vi.fn((table: Parameters<typeof getTableName>[0]) => ({
      values: vi.fn(async (values: Record<string, unknown>) => {
        inserts.push({ table: getTableName(table), values })
        operations.push(`insert:${getTableName(table)}`)
      }),
    })),
    update: vi.fn((table: Parameters<typeof getTableName>[0]) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async (where: SQL) => {
          updates.push({ table: getTableName(table), values, where })
          operations.push(`update:${getTableName(table)}`)
        }),
      })),
    })),
    delete: vi.fn((table: Parameters<typeof getTableName>[0]) => ({
      where: vi.fn(async (where: SQL) => {
        deletes.push({ table: getTableName(table), where })
        operations.push(`delete:${getTableName(table)}`)
      }),
    })),
  } as unknown as NodePgDatabase<Record<string, unknown>>

  return {
    database,
    selectionWheres,
    selectionLocks,
    selectionLimits,
    inserts,
    updates,
    deletes,
    operations,
  }
}

function compiledWhere(where: SQL) {
  return new PgDialect().sqlToQuery(where)
}

function uuidV7Timestamp(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN
  return Number.parseInt(value.replaceAll('-', '').slice(0, 12), 16)
}

beforeEach(() => {
  cryptoMocks.verifyPassword.mockReset()
})

describe('scoped credential reauthentication gateways', () => {
  it('derives a local-user denial entirely from capture and commits one redacted event', async () => {
    cryptoMocks.verifyPassword.mockResolvedValue(false)
    const capture = await localCapture()
    const harness = databaseHarness([
      [{ id: 'owner-credential-id', password: 'database-owner-hash' }],
      [],
    ])
    const marker = vi.fn(() => Symbol('protected-authority'))
    const gateway = createScopedLocalUserCreationReauthenticationGateway(
      harness.database,
      capture,
    )
    const projectedScope = localUserCreationMutationScope(capture)
    projectedScope.commandEnteredAt.setUTCFullYear(2099)

    const outcome = await gateway.attempt({
      currentPassword: 'wrong-owner-password',
      requestContext: { channel: 'web', clientAddress: '203.0.113.42' },
      markReauthenticationSucceeded: marker,
    })

    expect(outcome).toEqual({ status: 'failed' })
    expect(marker).not.toHaveBeenCalled()
    expect(cryptoMocks.verifyPassword).toHaveBeenCalledWith({
      hash: 'database-owner-hash',
      password: 'wrong-owner-password',
    })
    expect(harness.selectionLocks).toEqual(['update', 'update'])
    expect(harness.selectionLimits).toEqual([1, 1])
    expect(compiledWhere(harness.selectionWheres[0] as SQL)).toMatchObject({
      sql: '("account"."user_id" = $1 and "account"."provider_id" = $2)',
      params: [ownerUserId, 'credential'],
    })
    expect(compiledWhere(harness.selectionWheres[1] as SQL)).toMatchObject({
      sql: '("destructive_reauthentication_state"."account_id" = $1 and "destructive_reauthentication_state"."purpose" = $2)',
      params: ['owner-credential-id', 'local-user-create'],
    })

    expect(harness.inserts.map(({ table }) => table)).toEqual([
      'destructive_reauthentication_state',
      'audit_event',
    ])
    expect(harness.inserts[0]?.values).toMatchObject({
      accountId: 'owner-credential-id',
      purpose: 'local-user-create',
      failedAttempts: 1,
      windowStartedAt: commandEnteredAt,
      lockedUntil: null,
    })
    expect(harness.inserts[1]?.values).toMatchObject({
      actorUserId: ownerUserId,
      subjectUserId: null,
      eventType: 'local-user-create-rejected',
      entityType: 'local-user',
      entityId: targetUserId,
      metadata: {
        channel: 'web',
        clientAddress: '203.0.113.0/24',
        purpose: 'local-user-create',
        outcome: 'failed',
        attemptsInWindow: 1,
      },
    })
    expect(uuidV7Timestamp(harness.inserts[0]?.values?.id)).toBe(
      commandEnteredAt.getTime(),
    )
    expect(uuidV7Timestamp(harness.inserts[1]?.values?.id)).toBe(
      commandEnteredAt.getTime(),
    )
    const persisted = JSON.stringify(harness.inserts)
    expect(persisted).not.toContain('wrong-owner-password')
    expect(persisted).not.toContain('database-owner-hash')
    expect(persisted).not.toContain(verifiedSessionToken)
    expect(persisted).not.toContain('new.member@example.test')
    expect(persisted).not.toContain('203.0.113.42')
  })

  it('locks the fifth member-reset denial and uses only the captured member target', async () => {
    cryptoMocks.verifyPassword.mockResolvedValue(false)
    const capture = await memberCapture()
    const windowStartedAt = new Date('2026-07-15T12:00:00.000Z')
    const priorLastAttemptAt = new Date('2026-07-15T12:03:00.000Z')
    const harness = databaseHarness([
      [{ id: 'owner-credential-id', password: 'database-owner-hash' }],
      [
        {
          id: 'member-reset-reauth-state',
          accountId: 'owner-credential-id',
          purpose: 'member-reset-issue',
          windowStartedAt,
          failedAttempts: 4,
          lockedUntil: null,
          lastAttemptAt: priorLastAttemptAt,
        },
      ],
    ])

    const outcome = await createScopedMemberResetIssuanceReauthenticationGateway(
      harness.database,
      capture,
    ).attempt({
      currentPassword: 'still-wrong',
      requestContext: { channel: 'web', clientAddress: '198.51.100.77' },
      markReauthenticationSucceeded: vi.fn(),
    })

    const expectedLockedUntil = new Date(
      priorLastAttemptAt.getTime() +
        destructiveReauthenticationPolicy.lockoutMilliseconds,
    )
    expect(outcome).toEqual({ status: 'locked' })
    expect(harness.updates).toHaveLength(1)
    expect(harness.updates[0]?.values).toMatchObject({
      failedAttempts: 5,
      windowStartedAt,
      lockedUntil: expectedLockedUntil,
      lastAttemptAt: priorLastAttemptAt,
    })
    expect(harness.inserts).toHaveLength(1)
    expect(harness.inserts[0]?.values).toMatchObject({
      actorUserId: ownerUserId,
      subjectUserId: targetUserId,
      eventType: 'member-reset-rejected',
      entityType: 'member-reset',
      entityId: null,
      metadata: {
        channel: 'web',
        clientAddress: '198.51.100.0/24',
        purpose: 'member-reset-issue',
        outcome: 'locked',
        attemptsInWindow: 5,
        windowStartedAt: windowStartedAt.toISOString(),
        lockedUntil: expectedLockedUntil.toISOString(),
      },
    })
  })

  it('returns an active lockout without password work, state DML, audit, or promotion', async () => {
    const capture = await localCapture()
    const harness = databaseHarness([
      [{ id: 'owner-credential-id', password: 'database-owner-hash' }],
      [
        {
          id: 'active-lockout-state',
          accountId: 'owner-credential-id',
          purpose: 'local-user-create',
          windowStartedAt: new Date('2026-07-15T12:00:00.000Z'),
          failedAttempts: 5,
          lockedUntil: new Date('2026-07-15T12:20:00.000Z'),
          lastAttemptAt: new Date('2026-07-15T12:05:00.000Z'),
        },
      ],
    ])
    const marker = vi.fn()

    await expect(
      createScopedLocalUserCreationReauthenticationGateway(
        harness.database,
        capture,
      ).attempt({
        currentPassword: 'not-even-checked',
        requestContext: { channel: 'web', clientAddress: '203.0.113.42' },
        markReauthenticationSucceeded: marker,
      }),
    ).resolves.toEqual({ status: 'locked' })
    expect(cryptoMocks.verifyPassword).not.toHaveBeenCalled()
    expect(marker).not.toHaveBeenCalled()
    expect(harness.inserts).toEqual([])
    expect(harness.updates).toEqual([])
    expect(harness.deletes).toEqual([])
  })

  it('deletes prior denial state before promoting a successful password proof', async () => {
    cryptoMocks.verifyPassword.mockResolvedValue(true)
    const capture = await memberCapture()
    const harness = databaseHarness([
      [{ id: 'owner-credential-id', password: 'database-owner-hash' }],
      [
        {
          id: 'prior-denial-state',
          accountId: 'owner-credential-id',
          purpose: 'member-reset-issue',
          windowStartedAt: new Date('2026-07-15T12:00:00.000Z'),
          failedAttempts: 2,
          lockedUntil: null,
          lastAttemptAt: new Date('2026-07-15T12:02:00.000Z'),
        },
      ],
    ])
    const protectedAuthority = Object.freeze({ kind: 'protected-test-authority' })
    const marker = vi.fn(() => {
      expect(harness.operations.at(-1)).toBe('delete:destructive_reauthentication_state')
      return protectedAuthority
    })

    const outcome = await createScopedMemberResetIssuanceReauthenticationGateway(
      harness.database,
      capture,
    ).attempt({
      currentPassword: 'accepted-owner-password',
      requestContext: { channel: 'web', clientAddress: '203.0.113.42' },
      markReauthenticationSucceeded: marker,
    })

    expect(outcome).toEqual({ status: 'succeeded', authority: protectedAuthority })
    expect(marker).toHaveBeenCalledOnce()
    expect(cryptoMocks.verifyPassword).toHaveBeenCalledBefore(marker)
    expect(harness.deletes).toHaveLength(1)
    expect(compiledWhere(harness.deletes[0]?.where as SQL)).toMatchObject({
      params: ['prior-denial-state', 'owner-credential-id', 'member-reset-issue'],
    })
    expect(harness.inserts).toEqual([])
    expect(harness.updates).toEqual([])
  })

  it('starts a fresh window once the prior attempt window has expired', async () => {
    cryptoMocks.verifyPassword.mockResolvedValue(false)
    const capture = await localCapture()
    const harness = databaseHarness([
      [{ id: 'owner-credential-id', password: 'database-owner-hash' }],
      [
        {
          id: 'expired-window-state',
          accountId: 'owner-credential-id',
          purpose: 'local-user-create',
          windowStartedAt: new Date(
            commandEnteredAt.getTime() -
              destructiveReauthenticationPolicy.attemptWindowMilliseconds,
          ),
          failedAttempts: 4,
          lockedUntil: null,
          lastAttemptAt: new Date(
            commandEnteredAt.getTime() -
              destructiveReauthenticationPolicy.attemptWindowMilliseconds,
          ),
        },
      ],
    ])

    await expect(
      createScopedLocalUserCreationReauthenticationGateway(
        harness.database,
        capture,
      ).attempt({
        currentPassword: 'wrong-again',
        requestContext: { channel: 'web', clientAddress: '203.0.113.42' },
        markReauthenticationSucceeded: vi.fn(),
      }),
    ).resolves.toEqual({ status: 'failed' })
    expect(harness.updates[0]?.values).toMatchObject({
      failedAttempts: 1,
      windowStartedAt: commandEnteredAt,
      lockedUntil: null,
    })
  })

  it('keeps attempt state monotonic when a later-entered denial wins the lock first', async () => {
    cryptoMocks.verifyPassword.mockResolvedValue(false)
    const capture = await localCapture()
    const laterCommittedAt = new Date(commandEnteredAt.getTime() + 60_000)
    const harness = databaseHarness([
      [{ id: 'owner-credential-id', password: 'database-owner-hash' }],
      [
        {
          id: 'later-denial-state',
          accountId: 'owner-credential-id',
          purpose: 'local-user-create',
          windowStartedAt: laterCommittedAt,
          failedAttempts: 1,
          lockedUntil: null,
          lastAttemptAt: laterCommittedAt,
        },
      ],
    ])

    await expect(
      createScopedLocalUserCreationReauthenticationGateway(
        harness.database,
        capture,
      ).attempt({
        currentPassword: 'earlier-request-wrong-password',
        requestContext: { channel: 'web', clientAddress: '203.0.113.42' },
        markReauthenticationSucceeded: vi.fn(),
      }),
    ).resolves.toEqual({ status: 'failed' })

    expect(harness.updates[0]?.values).toMatchObject({
      failedAttempts: 2,
      windowStartedAt: laterCommittedAt,
      lastAttemptAt: laterCommittedAt,
      updatedAt: laterCommittedAt,
      lockedUntil: null,
    })
    expect(harness.inserts).toHaveLength(1)
    expect(harness.inserts[0]?.values).toMatchObject({
      createdAt: commandEnteredAt,
      metadata: {
        windowStartedAt: laterCommittedAt.toISOString(),
        attemptsInWindow: 2,
      },
    })
    expect(uuidV7Timestamp(harness.inserts[0]?.values?.id)).toBe(
      commandEnteredAt.getTime(),
    )
  })

  it.each([
    ['owner', ownerUserId],
    ['missing', null],
    ['member-without-credential', targetUserId],
  ] as const)('commits one target-invalid audit for a %s target without comparing a password', async (target, expectedSubjectUserId) => {
    const harness = databaseHarness([])
    const capture = await memberCapture(target)
    const marker = vi.fn()

    await expect(
      createScopedMemberResetIssuanceReauthenticationGateway(
        harness.database,
        capture,
      ).attempt({
        currentPassword: 'must-not-be-compared',
        requestContext: { channel: 'web', clientAddress: '203.0.113.42' },
        markReauthenticationSucceeded: marker,
      }),
    ).resolves.toEqual({
      status: 'precondition-rejected',
      reason: 'target-invalid',
    })
    expect(cryptoMocks.verifyPassword).not.toHaveBeenCalled()
    expect(marker).not.toHaveBeenCalled()
    expect(harness.selectionWheres).toEqual([])
    expect(harness.updates).toEqual([])
    expect(harness.deletes).toEqual([])
    expect(harness.inserts).toHaveLength(1)
    expect(harness.inserts[0]?.values).toMatchObject({
      actorUserId: ownerUserId,
      subjectUserId: expectedSubjectUserId,
      eventType: 'member-reset-rejected',
      entityType: 'member-reset',
      entityId: null,
      metadata: {
        channel: 'web',
        clientAddress: '203.0.113.0/24',
        outcome: 'target-invalid',
      },
      createdAt: commandEnteredAt,
    })
    expect(JSON.stringify(harness.inserts)).not.toContain('must-not-be-compared')
  })

  it('offers a purpose-narrow local validation rejection without password or state work', async () => {
    const harness = databaseHarness([])
    const capture = await localCapture()

    await expect(
      createScopedLocalUserCreationReauthenticationGateway(
        harness.database,
        capture,
      ).rejectPrecondition({
        reason: 'validation-rejected',
        requestContext: { channel: 'web', clientAddress: '198.51.100.77' },
      }),
    ).resolves.toEqual({
      status: 'precondition-rejected',
      reason: 'validation-rejected',
    })
    expect(cryptoMocks.verifyPassword).not.toHaveBeenCalled()
    expect(harness.selectionWheres).toEqual([])
    expect(harness.inserts).toHaveLength(1)
    expect(harness.inserts[0]?.values).toMatchObject({
      actorUserId: ownerUserId,
      subjectUserId: null,
      eventType: 'local-user-create-rejected',
      entityType: 'local-user',
      entityId: targetUserId,
      metadata: {
        channel: 'web',
        clientAddress: '198.51.100.0/24',
        outcome: 'validation-rejected',
      },
      createdAt: commandEnteredAt,
    })
  })

  it('rejects a target-invalid path on a valid member capture', async () => {
    const harness = databaseHarness([])
    const capture = await memberCapture()

    await expect(
      createScopedMemberResetIssuanceReauthenticationGateway(
        harness.database,
        capture,
      ).rejectPrecondition({
        reason: 'target-invalid',
        requestContext: { channel: 'web', clientAddress: '203.0.113.42' },
      }),
    ).rejects.toBeInstanceOf(ScopedCredentialReauthenticationInvariantError)
    expect(harness.inserts).toEqual([])
  })

  it('preserves the default subject-deletion denial contract and binds the audit to the generated state ID', async () => {
    cryptoMocks.verifyPassword.mockResolvedValue(false)
    const capture = await subjectDeletionCapture()
    const harness = databaseHarness([
      [{ id: 'member-credential-id', password: 'database-member-hash' }],
      [],
    ])

    await expect(
      createScopedSubjectDeletionReauthenticationGateway(
        harness.database,
        capture,
      ).attempt({
        currentPassword: 'wrong-member-password',
        requestContext: { channel: 'web', clientAddress: '203.0.113.42' },
        markReauthenticationSucceeded: vi.fn(),
      }),
    ).resolves.toEqual({ status: 'failed' })

    expect(compiledWhere(harness.selectionWheres[0] as SQL)).toMatchObject({
      params: [targetUserId, 'credential'],
    })
    expect(compiledWhere(harness.selectionWheres[1] as SQL)).toMatchObject({
      params: ['member-credential-id', 'trainee-data-deletion'],
    })
    expect(harness.inserts.map(({ table }) => table)).toEqual([
      'destructive_reauthentication_state',
      'audit_event',
    ])
    const stateId = harness.inserts[0]?.values?.id
    expect(stateId).toEqual(expect.any(String))
    expect(harness.inserts[0]?.values).toMatchObject({
      id: stateId,
      accountId: 'member-credential-id',
      purpose: 'trainee-data-deletion',
      failedAttempts: 1,
      createdAt: commandEnteredAt,
    })
    expect(harness.inserts[1]?.values).toMatchObject({
      actorUserId: null,
      subjectUserId: null,
      eventType: 'destructive-reauthentication-denied',
      entityType: 'destructive-reauthentication-state',
      entityId: stateId,
      createdAt: commandEnteredAt,
    })
    expect(harness.inserts[1]?.values?.metadata).toEqual({
      purpose: 'trainee-data-deletion',
      outcome: 'failed',
      attemptsInWindow: 1,
      windowStartedAt: commandEnteredAt.toISOString(),
      lockedUntil: null,
    })
    expect(uuidV7Timestamp(stateId)).toBe(commandEnteredAt.getTime())
    const persisted = JSON.stringify(harness.inserts)
    expect(persisted).not.toContain('wrong-member-password')
    expect(persisted).not.toContain('database-member-hash')
    expect(persisted).not.toContain('captured-private-password')
    expect(persisted).not.toContain(verifiedSessionToken)
    expect(persisted).not.toContain('203.0.113.42')
  })

  it('keeps an instance-reset denial attached to its existing attempt-state ID', async () => {
    cryptoMocks.verifyPassword.mockResolvedValue(false)
    const capture = await instanceResetCapture()
    const priorLastAttemptAt = new Date(commandEnteredAt.getTime() + 30_000)
    const harness = databaseHarness([
      [{ id: 'owner-credential-id', password: 'database-owner-hash' }],
      [
        {
          id: 'existing-instance-reset-state',
          accountId: 'owner-credential-id',
          purpose: 'instance-reset',
          windowStartedAt: commandEnteredAt,
          failedAttempts: 2,
          lockedUntil: null,
          lastAttemptAt: priorLastAttemptAt,
        },
      ],
    ])

    await expect(
      createScopedInstanceResetReauthenticationGateway(harness.database, capture).attempt(
        {
          currentPassword: 'wrong-owner-password',
          requestContext: { channel: 'web', clientAddress: '198.51.100.77' },
          markReauthenticationSucceeded: vi.fn(),
        },
      ),
    ).resolves.toEqual({ status: 'failed' })

    expect(harness.updates).toHaveLength(1)
    expect(harness.updates[0]?.values).toMatchObject({
      failedAttempts: 3,
      lastAttemptAt: priorLastAttemptAt,
      updatedAt: priorLastAttemptAt,
    })
    expect(harness.inserts).toHaveLength(1)
    expect(harness.inserts[0]?.values).toMatchObject({
      actorUserId: null,
      subjectUserId: null,
      eventType: 'destructive-reauthentication-denied',
      entityType: 'destructive-reauthentication-state',
      entityId: 'existing-instance-reset-state',
      metadata: {
        purpose: 'instance-reset',
        outcome: 'failed',
        attemptsInWindow: 3,
      },
    })
  })

  it('rejects forged and cross-purpose captures and spends each destructive gateway once', async () => {
    cryptoMocks.verifyPassword.mockResolvedValue(true)
    const subjectCapture = await subjectDeletionCapture()
    const resetCapture = await instanceResetCapture()
    const harness = databaseHarness([
      [{ id: 'member-credential-id', password: 'database-member-hash' }],
      [],
    ])

    expect(() =>
      createScopedSubjectDeletionReauthenticationGateway(
        harness.database,
        resetCapture as unknown as TraineeDataDeletionMutationCapture,
      ),
    ).toThrow('purpose does not match')
    expect(() =>
      createScopedInstanceResetReauthenticationGateway(
        harness.database,
        subjectCapture as unknown as InstanceResetMutationCapture,
      ),
    ).toThrow('purpose does not match')

    const forged = Object.create(
      TraineeDataDeletionMutationCapture.prototype,
    ) as TraineeDataDeletionMutationCapture
    expect(() =>
      createScopedSubjectDeletionReauthenticationGateway(harness.database, forged),
    ).toThrow('was not issued by Identity')
    expect(harness.selectionWheres).toEqual([])

    const authority = Object.freeze({ kind: 'subject-deletion-authority' })
    const gateway = createScopedSubjectDeletionReauthenticationGateway(
      harness.database,
      subjectCapture,
    )
    expect(Object.keys(gateway)).toEqual(['attempt'])
    expect(Object.isFrozen(gateway)).toBe(true)
    await expect(
      gateway.attempt({
        currentPassword: 'accepted-member-password',
        requestContext: { channel: 'web', clientAddress: '192.0.2.17' },
        markReauthenticationSucceeded: () => authority,
      }),
    ).resolves.toEqual({ status: 'succeeded', authority })
    const operationCount = harness.operations.length
    expect(() =>
      gateway.attempt({
        currentPassword: 'accepted-member-password',
        requestContext: { channel: 'web', clientAddress: '192.0.2.17' },
        markReauthenticationSucceeded: () => authority,
      }),
    ).toThrow(ScopedCredentialReauthenticationInvariantError)
    expect(harness.operations).toHaveLength(operationCount)
  })
})
