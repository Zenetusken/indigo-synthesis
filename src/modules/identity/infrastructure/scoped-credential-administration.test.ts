import { verifyPassword } from 'better-auth/crypto'
import type { QueryResult, QueryResultRow } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalUserInputError } from '@/modules/identity/application/local-users'
import { resetServerConfigForTests } from '@/platform/config/server'
import {
  account,
  auditEvents,
  memberResetStates,
  user,
  verification,
} from '@/platform/db/schema'
import type { WebCredentialContext } from '../recovery/credential-context'
import { prepareMemberResetIssuance } from '../recovery/recovery-preparation'
import {
  captureLocalUserCreationMutation,
  captureMemberResetIssuanceMutation,
  type IdentityCredentialAdministrationQuery,
} from './credential-administration-mutation'
import {
  createScopedLocalUserCreationMutationGateway,
  createScopedMemberResetIssuanceMutationGateway,
  type PreparedLocalUserCreation,
  prepareLocalUserCreation,
} from './scoped-credential-administration'

const epoch = '123e4567-e89b-42d3-a456-426614174000'
const verifiedToken = 'opaque-cryptographically-verified-session-token'
const targetUserId = '019bc1e0-6400-7000-8000-000000000001'
const commandEnteredAt = new Date('2026-07-15T12:00:00.000Z')
const sessionExpiresAt = new Date('2026-07-15T13:00:00.000Z')
const rowCreatedAt = new Date('2026-01-01T00:00:00.000Z')
const rowUpdatedAt = new Date('2026-06-01T00:00:00.000Z')
const requestContext = Object.freeze({
  channel: 'web',
  clientAddress: '192.0.2.17',
}) satisfies WebCredentialContext

const testEnvironment = {
  DATABASE_URL: 'postgresql://localhost/indigo_scoped_admin_test',
  BETTER_AUTH_SECRET: 'scoped-admin-test-secret-at-least-thirty-two-bytes',
  BETTER_AUTH_URL: 'http://127.0.0.1:3000',
  INDIGO_CONTENT_MODE: 'development',
  NODE_ENV: 'test',
} as const

const originalEnvironment = Object.fromEntries(
  Object.keys(testEnvironment).map((key) => [key, process.env[key]]),
)

type ResultRow = QueryResultRow & Record<string, unknown>

function queryResult(row: ResultRow): QueryResult<ResultRow> {
  return {
    command: 'SELECT',
    rowCount: 1,
    oid: 0,
    fields: [],
    rows: [row],
  }
}

function querySurface(row: ResultRow): IdentityCredentialAdministrationQuery {
  return {
    query: vi.fn().mockResolvedValue(queryResult(row)),
  } as unknown as IdentityCredentialAdministrationQuery
}

function credential(userId: string) {
  return {
    id: `credential-${userId}`,
    accountId: userId,
    userId,
    password: `hash-for-${userId}`,
    createdAt: rowCreatedAt,
    updatedAt: rowUpdatedAt,
  }
}

function snapshotRow(input?: {
  readonly localTargetAbsent?: boolean
  readonly submittedEmailUserIds?: readonly string[]
  readonly lastIssuedAt?: Date | null
}): ResultRow {
  const localTargetAbsent = input?.localTargetAbsent ?? false
  const hasResetState = input?.lastIssuedAt instanceof Date
  return {
    product_mutation_epoch: epoch,
    installation_owner_user_id: 'actor-owner',
    bootstrap_closed_at: new Date('2026-01-02T00:00:00.000Z'),
    session_id: 'provider-session-id',
    session_user_id: 'actor-owner',
    session_expires_at: sessionExpiresAt,
    actor_user_id: 'actor-owner',
    actor_name: 'Installation Owner',
    actor_email: 'owner@example.test',
    actor_email_verified: false,
    actor_created_at: rowCreatedAt,
    actor_updated_at: rowUpdatedAt,
    target_user_id: localTargetAbsent ? null : targetUserId,
    target_name: localTargetAbsent ? null : 'Trainee',
    target_email: localTargetAbsent ? null : 'trainee@example.test',
    target_email_verified: localTargetAbsent ? null : false,
    target_created_at: localTargetAbsent ? null : rowCreatedAt,
    target_updated_at: localTargetAbsent ? null : rowUpdatedAt,
    member_reset_target_user_id: hasResetState ? targetUserId : null,
    member_reset_active_verification_id: hasResetState ? 'old-reset-id' : null,
    member_reset_last_issued_at: hasResetState ? input?.lastIssuedAt : null,
    member_reset_failed_attempts: hasResetState ? 0 : null,
    member_reset_retry_after: null,
    member_reset_last_attempt_at: null,
    member_reset_created_at: hasResetState ? rowCreatedAt : null,
    member_reset_updated_at: hasResetState ? rowUpdatedAt : null,
    submitted_email_user_ids: input?.submittedEmailUserIds ?? [],
    credential_rows: localTargetAbsent
      ? [credential('actor-owner')]
      : [credential(targetUserId), credential('actor-owner')],
    member_reset_verification_rows: hasResetState
      ? [
          {
            id: 'old-reset-id',
            identifier: `indigo:member-reset:${targetUserId}`,
            value:
              'member-reset-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            expiresAt: sessionExpiresAt,
            createdAt: rowCreatedAt,
            updatedAt: rowUpdatedAt,
          },
        ]
      : [],
  }
}

type TableName = 'user' | 'account' | 'audit-event' | 'verification' | 'member-state'

type DatabaseOperation = {
  readonly kind: 'insert' | 'delete'
  readonly table: TableName
  readonly values?: Record<string, unknown>
  conflict?: 'do-nothing' | 'update'
  conflictSet?: Record<string, unknown>
  readonly condition?: unknown
}

function tableName(table: unknown): TableName {
  if (table === user) return 'user'
  if (table === account) return 'account'
  if (table === auditEvents) return 'audit-event'
  if (table === verification) return 'verification'
  if (table === memberResetStates) return 'member-state'
  throw new TypeError('Unexpected table in scoped gateway test.')
}

function fakeDatabase(input?: { readonly userConflict?: boolean }): {
  readonly database: never
  readonly operations: DatabaseOperation[]
} {
  const operations: DatabaseOperation[] = []
  const database = {
    insert(table: unknown) {
      const name = tableName(table)
      let operation: DatabaseOperation | undefined
      const builder = {
        values(values: Record<string, unknown>) {
          operation = { kind: 'insert', table: name, values }
          operations.push(operation)
          return name === 'user' || name === 'member-state'
            ? builder
            : Promise.resolve(undefined)
        },
        onConflictDoNothing() {
          if (!operation) throw new TypeError('Missing insert values.')
          operation.conflict = 'do-nothing'
          return builder
        },
        onConflictDoUpdate(config: { readonly set: Record<string, unknown> }) {
          if (!operation) throw new TypeError('Missing insert values.')
          operation.conflict = 'update'
          operation.conflictSet = config.set
          return builder
        },
        returning() {
          if (!operation) throw new TypeError('Missing insert values.')
          if (name !== 'user' || input?.userConflict) return Promise.resolve([])
          return Promise.resolve([
            {
              id: operation.values?.id,
              name: operation.values?.name,
              email: operation.values?.email,
            },
          ])
        },
      }
      return builder
    },
    delete(table: unknown) {
      const name = tableName(table)
      return {
        where(condition: unknown) {
          operations.push({ kind: 'delete', table: name, condition })
          return Promise.resolve(undefined)
        },
      }
    },
  }
  return { database: database as never, operations }
}

async function preparedLocal(): Promise<PreparedLocalUserCreation> {
  return prepareLocalUserCreation({
    targetUserId,
    name: '  New Member  ',
    email: '  New.Member@Example.TEST  ',
    initialPassword: 'correct horse battery staple',
    commandEnteredAt,
  })
}

async function localCapture(
  prepared: PreparedLocalUserCreation,
  submittedEmailUserIds: readonly string[] = [],
) {
  return captureLocalUserCreationMutation(
    querySurface(
      snapshotRow({
        localTargetAbsent: true,
        submittedEmailUserIds,
      }),
    ),
    {
      verifiedSessionToken: verifiedToken,
      preallocatedTargetUserId: prepared.targetUserId,
      submittedEmail: prepared.normalizedEmail,
      commandEnteredAt: prepared.commandEnteredAt,
    },
  )
}

async function memberCapture(lastIssuedAt: Date | null) {
  return captureMemberResetIssuanceMutation(querySurface(snapshotRow({ lastIssuedAt })), {
    verifiedSessionToken: verifiedToken,
    targetUserId,
    commandEnteredAt,
  })
}

function auditOperations(operations: readonly DatabaseOperation[]) {
  return operations.filter((operation) => operation.table === 'audit-event')
}

function uuidTimestamp(uuid: string): number {
  return Number.parseInt(uuid.replaceAll('-', '').slice(0, 12), 16)
}

describe('scoped credential-administration mutation gateways', () => {
  beforeEach(() => {
    Object.assign(process.env, testEnvironment)
    resetServerConfigForTests()
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetServerConfigForTests()
  })

  it('prepares normalized, prehashed local-user data against the render-bound target', async () => {
    const callerDate = new Date(commandEnteredAt)
    const preparation = prepareLocalUserCreation({
      targetUserId,
      name: '  New Member  ',
      email: '  New.Member@Example.TEST  ',
      initialPassword: 'correct horse battery staple',
      commandEnteredAt: callerDate,
    })
    callerDate.setUTCFullYear(2099)

    const prepared = await preparation

    expect(prepared.targetUserId).toBe(targetUserId)
    expect(prepared.name).toBe('New Member')
    expect(prepared.normalizedEmail).toBe('new.member@example.test')
    expect(prepared.commandEnteredAt).toEqual(commandEnteredAt)
    expect(
      new Set([prepared.targetUserId, prepared.accountId, prepared.auditEventId]).size,
    ).toBe(3)
    expect(uuidTimestamp(prepared.accountId)).toBe(commandEnteredAt.getTime())
    expect(uuidTimestamp(prepared.auditEventId)).toBe(commandEnteredAt.getTime())
    expect(prepared.passwordHash).not.toContain('correct horse battery staple')
    expect(
      await verifyPassword({
        hash: prepared.passwordHash,
        password: 'correct horse battery staple',
      }),
    ).toBe(true)
    expect(JSON.stringify(prepared)).not.toContain('correct horse battery staple')
  })

  it('rejects invalid local inputs and malformed preallocated targets before hashing', async () => {
    await expect(
      prepareLocalUserCreation({
        targetUserId,
        name: '',
        email: 'not-an-email',
        initialPassword: 'short',
        commandEnteredAt,
      }),
    ).rejects.toBeInstanceOf(LocalUserInputError)
    await expect(
      prepareLocalUserCreation({
        targetUserId: 'bad\0target',
        name: 'Member',
        email: 'member@example.test',
        initialPassword: 'correct horse battery staple',
        commandEnteredAt,
      }),
    ).rejects.toThrow('preallocated local-user target identity')
  })

  it('creates one local credential and one secret-free success audit atomically', async () => {
    const prepared = await preparedLocal()
    const capture = await localCapture(prepared)
    const { database, operations } = fakeDatabase()

    await expect(
      createScopedLocalUserCreationMutationGateway(database).createLocalUser(
        capture,
        prepared,
        requestContext,
      ),
    ).resolves.toEqual({
      kind: 'created',
      user: {
        id: targetUserId,
        name: 'New Member',
        email: 'new.member@example.test',
      },
    })

    expect(operations.map(({ kind, table }) => `${kind}:${table}`)).toEqual([
      'insert:user',
      'insert:account',
      'insert:audit-event',
    ])
    expect(operations[0]?.conflict).toBe('do-nothing')
    expect(operations[1]?.values).toMatchObject({
      id: prepared.accountId,
      accountId: targetUserId,
      providerId: 'credential',
      userId: targetUserId,
      password: prepared.passwordHash,
    })
    expect(auditOperations(operations)).toEqual([
      expect.objectContaining({
        kind: 'insert',
        table: 'audit-event',
        values: {
          id: prepared.auditEventId,
          actorUserId: 'actor-owner',
          subjectUserId: targetUserId,
          eventType: 'local-user-created',
          entityType: 'local-user',
          entityId: targetUserId,
          metadata: {
            channel: 'web',
            clientAddress: '192.0.2.0/24',
            outcome: 'created',
          },
          createdAt: commandEnteredAt,
        },
      }),
    ])
    expect(JSON.stringify(auditOperations(operations))).not.toContain('password')
    expect(JSON.stringify(auditOperations(operations))).not.toContain(
      prepared.passwordHash,
    )
  })

  it('returns one audited email-conflict when the case-fold capture already matched', async () => {
    const prepared = await preparedLocal()
    const capture = await localCapture(prepared, ['uppercase-existing-user'])
    const { database, operations } = fakeDatabase()

    await expect(
      createScopedLocalUserCreationMutationGateway(database).createLocalUser(
        capture,
        prepared,
        requestContext,
      ),
    ).resolves.toEqual({ kind: 'email-conflict' })

    expect(operations.map(({ kind, table }) => `${kind}:${table}`)).toEqual([
      'insert:audit-event',
    ])
    expect(auditOperations(operations)[0]?.values).toMatchObject({
      actorUserId: 'actor-owner',
      subjectUserId: null,
      eventType: 'local-user-create-rejected',
      entityId: targetUserId,
      metadata: { outcome: 'email-conflict' },
    })
  })

  it('returns the same audited conflict on the concurrent unique-email defense', async () => {
    const prepared = await preparedLocal()
    const capture = await localCapture(prepared)
    const { database, operations } = fakeDatabase({ userConflict: true })

    await expect(
      createScopedLocalUserCreationMutationGateway(database).createLocalUser(
        capture,
        prepared,
        requestContext,
      ),
    ).resolves.toEqual({ kind: 'email-conflict' })

    expect(operations.map(({ kind, table }) => `${kind}:${table}`)).toEqual([
      'insert:user',
      'insert:audit-event',
    ])
    expect(operations[0]?.conflict).toBe('do-nothing')
    expect(auditOperations(operations)).toHaveLength(1)
  })

  it('rejects a prepared local target that differs from the nominal capture', async () => {
    const prepared = await preparedLocal()
    const capture = await localCapture(prepared)
    const mismatched = Object.freeze({
      ...prepared,
      targetUserId: '019bc1e0-6400-7000-8000-000000000099',
    })
    const { database, operations } = fakeDatabase()

    await expect(
      createScopedLocalUserCreationMutationGateway(database).createLocalUser(
        capture,
        mismatched,
        requestContext,
      ),
    ).rejects.toThrow('does not match its nominal capture')
    expect(operations).toEqual([])
  })

  it('commits a tagged cooldown audit without replacing the old member code at 29,999ms', async () => {
    const lastIssuedAt = new Date(commandEnteredAt.getTime() - 29_999)
    const capture = await memberCapture(lastIssuedAt)
    const prepared = prepareMemberResetIssuance({
      targetUserId,
      commandEnteredAt,
    })
    const { database, operations } = fakeDatabase()

    const result = await createScopedMemberResetIssuanceMutationGateway(
      database,
    ).issueMemberReset(capture, prepared, requestContext)

    expect(result).toEqual({
      kind: 'cooldown',
      retryAfter: new Date(lastIssuedAt.getTime() + 30_000),
    })
    expect(operations.map(({ kind, table }) => `${kind}:${table}`)).toEqual([
      'insert:audit-event',
    ])
    expect(auditOperations(operations)[0]?.values).toEqual({
      id: prepared.auditEventId,
      actorUserId: 'actor-owner',
      subjectUserId: targetUserId,
      eventType: 'member-reset-rejected',
      entityType: 'member-reset',
      entityId: 'old-reset-id',
      metadata: {
        channel: 'web',
        clientAddress: '192.0.2.0/24',
        outcome: 'cooldown',
        retryAfter: new Date(lastIssuedAt.getTime() + 30_000).toISOString(),
      },
      createdAt: commandEnteredAt,
    })
    const auditJson = JSON.stringify(auditOperations(operations))
    expect(auditJson).not.toContain(prepared.code)
    expect(auditJson).not.toContain(prepared.storedValue)
  })

  it('replaces the exact member identifier and emits one success audit at 30,000ms', async () => {
    const capture = await memberCapture(new Date(commandEnteredAt.getTime() - 30_000))
    const prepared = prepareMemberResetIssuance({
      targetUserId,
      commandEnteredAt,
    })
    const { database, operations } = fakeDatabase()

    await expect(
      createScopedMemberResetIssuanceMutationGateway(database).issueMemberReset(
        capture,
        prepared,
        requestContext,
      ),
    ).resolves.toEqual({
      kind: 'issued',
      resetId: prepared.resetId,
      code: prepared.code,
      expiresAt: prepared.expiresAt,
    })

    expect(operations.map(({ kind, table }) => `${kind}:${table}`)).toEqual([
      'delete:verification',
      'insert:verification',
      'insert:member-state',
      'insert:audit-event',
    ])
    expect(operations[1]?.values).toEqual({
      id: prepared.resetId,
      identifier: prepared.identifier,
      value: prepared.storedValue,
      expiresAt: prepared.expiresAt,
      createdAt: commandEnteredAt,
      updatedAt: commandEnteredAt,
    })
    expect(operations[2]?.conflict).toBe('update')
    expect(operations[2]?.conflictSet).toEqual({
      activeVerificationId: prepared.resetId,
      lastIssuedAt: commandEnteredAt,
      failedAttempts: 0,
      retryAfter: null,
      lastAttemptAt: null,
      updatedAt: commandEnteredAt,
    })
    expect(auditOperations(operations)).toHaveLength(1)
    expect(auditOperations(operations)[0]?.values).toMatchObject({
      id: prepared.auditEventId,
      actorUserId: 'actor-owner',
      subjectUserId: targetUserId,
      eventType: 'member-reset-issued',
      entityType: 'member-reset',
      entityId: prepared.resetId,
      metadata: {
        channel: 'web',
        clientAddress: '192.0.2.0/24',
        outcome: 'issued',
        expiresAt: prepared.expiresAt.toISOString(),
      },
    })
    expect(JSON.stringify(auditOperations(operations))).not.toContain(prepared.code)
    expect(JSON.stringify(auditOperations(operations))).not.toContain(
      prepared.storedValue,
    )
  })

  it('rejects member preparation that is not bound to its nominal target', async () => {
    const capture = await memberCapture(null)
    const prepared = prepareMemberResetIssuance({
      targetUserId,
      commandEnteredAt,
    })
    const mismatched = Object.freeze({
      ...prepared,
      targetUserId: 'different-member',
    })
    const { database, operations } = fakeDatabase()

    await expect(
      createScopedMemberResetIssuanceMutationGateway(database).issueMemberReset(
        capture,
        mismatched,
        requestContext,
      ),
    ).rejects.toThrow('does not match its nominal capture')
    expect(operations).toEqual([])
  })
})
