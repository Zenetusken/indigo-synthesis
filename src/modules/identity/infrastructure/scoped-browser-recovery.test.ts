import type { QueryResult, QueryResultRow } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'
import {
  account,
  auditEvents,
  memberResetStates,
  session,
  verification,
} from '@/platform/db/schema'
import type { WebCredentialContext } from '../recovery/credential-context'
import {
  memberResetCodeIdentity,
  memberResetStoredValue,
  ownerRecoveryCodeIdentity,
  ownerRecoveryStoredValue,
  type ParsedRecoveryRedemptionInput,
  parseMemberResetRedemptionInput,
  parseOwnerRecoveryWebRedemptionInput,
} from '../recovery/recovery-preparation'
import {
  captureMemberResetRedemption,
  captureOwnerRecoveryWebRedemption,
  type IdentityRecoveryMutationQuery,
  type MemberResetRedemptionCapture,
  recheckMemberResetRedemption,
  recheckOwnerRecoveryWebRedemption,
} from './recovery-mutation'
import {
  createScopedMemberResetRedemptionMutationGateway,
  createScopedOwnerRecoveryWebRedemptionMutationGateway,
  ScopedBrowserRecoveryInvariantError,
} from './scoped-browser-recovery'

const rateMocks = vi.hoisted(() => ({
  admit: vi.fn(),
  hashPassword: vi.fn(),
}))

vi.mock('better-auth/crypto', () => ({
  hashPassword: rateMocks.hashPassword,
}))

vi.mock('./web-recovery-rate-limit', () => ({
  createScopedWebRecoveryRateLimitGateway: () => ({ admit: rateMocks.admit }),
}))

const epoch = '123e4567-e89b-42d3-a456-426614174000'
const commandEnteredAt = new Date('2026-07-15T12:00:00.000Z')
const createdAt = new Date('2026-01-01T00:00:00.000Z')
const updatedAt = new Date('2026-07-15T11:00:00.000Z')
const liveExpiry = new Date('2026-07-15T12:15:00.000Z')
const memberEmail = 'member@example.test'
const ownerEmail = 'owner@example.test'
const memberUserId = 'member-user'
const ownerUserId = 'owner-user'
const memberCredentialId = 'credential-member'
const ownerCredentialId = 'credential-owner'
const memberVerificationId = 'member-verification'
const ownerVerificationId = 'owner-verification'
const replacementPassword = 'replacement-password-value'
const requestContext = Object.freeze({
  channel: 'web',
  clientAddress: '198.51.100.77',
}) satisfies WebCredentialContext

const testEnvironment = {
  DATABASE_URL: 'postgresql://localhost/indigo_scoped_recovery_test',
  BETTER_AUTH_SECRET: 'scoped-recovery-test-secret-at-least-thirty-two-bytes',
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

function repeatedQuery(row: ResultRow): IdentityRecoveryMutationQuery {
  return {
    query: vi.fn().mockResolvedValue(queryResult(row)),
  } as unknown as IdentityRecoveryMutationQuery
}

function userRow(id: string, email: string) {
  return {
    id,
    name: id === ownerUserId ? 'Owner' : 'Member',
    email,
    emailVerified: false,
    createdAt,
    updatedAt,
  }
}

function credentialRow(id: string, userId: string) {
  return {
    id,
    accountId: userId,
    providerId: 'credential',
    userId,
    password: `private-current-hash-${userId}`,
    createdAt,
    updatedAt,
  }
}

function verificationRow(input: {
  readonly id: string
  readonly identifier: string
  readonly storedValue: string
  readonly expiresAt?: Date
}) {
  return {
    id: input.id,
    identifier: input.identifier,
    value: input.storedValue,
    expiresAt: input.expiresAt ?? liveExpiry,
    createdAt,
    updatedAt,
  }
}

function memberSnapshot(input: {
  readonly storedCode: string
  readonly target?: 'member' | 'owner' | 'missing'
  readonly credentialPresent?: boolean
  readonly expiresAt?: Date
  readonly failedAttempts?: number
  readonly retryAfter?: Date | null
  readonly lastAttemptAt?: Date | null
}): ResultRow {
  const target = input.target ?? 'member'
  const targetUserId = target === 'owner' ? ownerUserId : memberUserId
  const hasTarget = target !== 'missing'
  const hasState = hasTarget
  const pending = hasState
    ? verificationRow({
        id: memberVerificationId,
        identifier: `indigo:member-reset:${targetUserId}`,
        storedValue: memberResetStoredValue(input.storedCode),
        expiresAt: input.expiresAt,
      })
    : null
  return {
    product_mutation_epoch: epoch,
    installation_owner_user_id: ownerUserId,
    bootstrap_closed_at: createdAt,
    submitted_user_rows: hasTarget
      ? [userRow(targetUserId, target === 'owner' ? ownerEmail : memberEmail)]
      : [],
    credential_rows:
      hasTarget && (input.credentialPresent ?? true)
        ? [
            credentialRow(
              target === 'owner' ? ownerCredentialId : memberCredentialId,
              targetUserId,
            ),
          ]
        : [],
    member_reset_state_rows: hasState
      ? [
          {
            targetUserId,
            activeVerificationId: memberVerificationId,
            lastIssuedAt: updatedAt,
            failedAttempts: input.failedAttempts ?? 0,
            retryAfter: input.retryAfter ?? null,
            lastAttemptAt: input.lastAttemptAt ?? null,
            createdAt,
            updatedAt,
          },
        ]
      : [],
    member_reset_verification_rows: pending ? [pending] : [],
  }
}

function ownerSnapshot(input: {
  readonly storedCode: string
  readonly submittedEmailMatches?: boolean
  readonly ownerPresent?: boolean
  readonly credentialPresent?: boolean
  readonly expiresAt?: Date
}): ResultRow {
  const ownerPresent = input.ownerPresent ?? true
  const emailMatches = input.submittedEmailMatches ?? true
  return {
    product_mutation_epoch: epoch,
    installation_owner_user_id: ownerPresent ? ownerUserId : null,
    bootstrap_closed_at: ownerPresent ? createdAt : null,
    submitted_email_user_ids: ownerPresent && emailMatches ? [ownerUserId] : [],
    owner_user_rows: ownerPresent ? [userRow(ownerUserId, ownerEmail)] : [],
    credential_rows:
      ownerPresent && (input.credentialPresent ?? true)
        ? [credentialRow(ownerCredentialId, ownerUserId)]
        : [],
    owner_recovery_verification_rows: ownerPresent
      ? [
          verificationRow({
            id: ownerVerificationId,
            identifier: `indigo:owner-recovery:${ownerUserId}`,
            storedValue: ownerRecoveryStoredValue(input.storedCode),
            expiresAt: input.expiresAt,
          }),
        ]
      : [],
  }
}

type TableName =
  | 'account'
  | 'audit-event'
  | 'member-reset-state'
  | 'session'
  | 'verification'

type DatabaseOperation = Readonly<{
  kind: 'insert' | 'update' | 'delete'
  table: TableName
  values?: Record<string, unknown>
  condition?: unknown
}>

function tableName(table: unknown): TableName {
  if (table === account) return 'account'
  if (table === auditEvents) return 'audit-event'
  if (table === memberResetStates) return 'member-reset-state'
  if (table === session) return 'session'
  if (table === verification) return 'verification'
  throw new TypeError('Unexpected table in scoped browser recovery test.')
}

function fakeDatabase(input?: {
  readonly credentialId?: string
  readonly targetUserId?: string
  readonly verificationId?: string
  readonly sessionIds?: readonly string[]
}): { readonly database: never; readonly operations: DatabaseOperation[] } {
  const operations: DatabaseOperation[] = []
  const returningRows = (table: TableName) => {
    if (table === 'account')
      return input?.credentialId ? [{ id: input.credentialId }] : []
    if (table === 'member-reset-state') {
      return input?.targetUserId ? [{ targetUserId: input.targetUserId }] : []
    }
    if (table === 'verification') {
      return input?.verificationId ? [{ id: input.verificationId }] : []
    }
    if (table === 'session') {
      return (input?.sessionIds ?? []).map((id) => ({ id }))
    }
    return []
  }
  const database = {
    insert(table: unknown) {
      const name = tableName(table)
      return {
        values(values: Record<string, unknown>) {
          operations.push({ kind: 'insert', table: name, values })
          return Promise.resolve(undefined)
        },
      }
    },
    update(table: unknown) {
      const name = tableName(table)
      let values: Record<string, unknown> | undefined
      let condition: unknown
      const builder = {
        set(nextValues: Record<string, unknown>) {
          values = nextValues
          return builder
        },
        where(nextCondition: unknown) {
          condition = nextCondition
          operations.push({ kind: 'update', table: name, values, condition })
          return builder
        },
        returning() {
          return Promise.resolve(returningRows(name))
        },
      }
      return builder
    },
    delete(table: unknown) {
      const name = tableName(table)
      const builder = {
        where(condition: unknown) {
          operations.push({ kind: 'delete', table: name, condition })
          return builder
        },
        returning() {
          return Promise.resolve(returningRows(name))
        },
      }
      return builder
    },
  }
  return { database: database as never, operations }
}

type RedemptionFixture = ParsedRecoveryRedemptionInput &
  Readonly<{ codeIdentity: string; commandEnteredAt: Date }>

function preparedMember(input?: {
  readonly email?: unknown
  readonly code?: unknown
  readonly password?: unknown
}): RedemptionFixture {
  const parsed = parseMemberResetRedemptionInput({
    email: input?.email ?? memberEmail,
    code: input?.code ?? 'indigo_m1_valid-member-code',
    newPassword: input?.password ?? replacementPassword,
  })
  return Object.freeze({
    ...parsed,
    codeIdentity: memberResetCodeIdentity(parsed.submittedCode),
    commandEnteredAt,
  })
}

function preparedOwner(input?: {
  readonly email?: unknown
  readonly code?: unknown
  readonly password?: unknown
}): RedemptionFixture {
  const parsed = parseOwnerRecoveryWebRedemptionInput({
    ownerEmail: input?.email ?? ownerEmail,
    code: input?.code ?? 'indigo_r1_valid-owner-code',
    newPassword: input?.password ?? replacementPassword,
  })
  return Object.freeze({
    ...parsed,
    codeIdentity: ownerRecoveryCodeIdentity(parsed.submittedCode),
    commandEnteredAt,
  })
}

async function recheckedMemberCapture(
  prepared: RedemptionFixture,
  row: ResultRow,
): Promise<MemberResetRedemptionCapture> {
  const query = repeatedQuery(row)
  const capture = await captureMemberResetRedemption(query, {
    normalizedEmail: prepared.normalizedEmail,
    codeIdentity: prepared.codeIdentity,
    commandEnteredAt: prepared.commandEnteredAt,
  })
  await expect(recheckMemberResetRedemption(query, capture)).resolves.toEqual({
    status: 'current',
  })
  return capture
}

async function recheckedOwnerCapture(prepared: RedemptionFixture, row: ResultRow) {
  const query = repeatedQuery(row)
  const capture = await captureOwnerRecoveryWebRedemption(query, {
    normalizedEmail: prepared.normalizedEmail,
    codeIdentity: prepared.codeIdentity,
    commandEnteredAt: prepared.commandEnteredAt,
  })
  await expect(recheckOwnerRecoveryWebRedemption(query, capture)).resolves.toEqual({
    status: 'current',
  })
  return capture
}

function auditOperations(operations: readonly DatabaseOperation[]) {
  return operations.filter((operation) => operation.table === 'audit-event')
}

function redemptionInput(
  prepared: RedemptionFixture,
  context: WebCredentialContext = requestContext,
) {
  return Object.freeze({
    parsed: prepared,
    commandEnteredAt: prepared.commandEnteredAt,
    requestContext: context,
  })
}

describe('scoped browser recovery mutation gateways', () => {
  beforeEach(() => {
    Object.assign(process.env, testEnvironment)
    resetServerConfigForTests()
    rateMocks.admit.mockReset().mockResolvedValue({ admitted: true })
    rateMocks.hashPassword.mockReset().mockResolvedValue('prepared-password-hash')
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetServerConfigForTests()
  })

  it('requires a successful first-query recheck and spends the nominal capture once', async () => {
    const prepared = await preparedMember()
    const row = memberSnapshot({ storedCode: prepared.submittedCode })
    const query = repeatedQuery(row)
    const capture = await captureMemberResetRedemption(query, {
      normalizedEmail: prepared.normalizedEmail,
      codeIdentity: prepared.codeIdentity,
      commandEnteredAt: prepared.commandEnteredAt,
    })
    const database = fakeDatabase()

    expect(() =>
      createScopedMemberResetRedemptionMutationGateway(database.database, capture),
    ).toThrow('no longer fresh')
    await expect(recheckMemberResetRedemption(query, capture)).resolves.toEqual({
      status: 'current',
    })
    const gateway = createScopedMemberResetRedemptionMutationGateway(
      database.database,
      capture,
    )
    expect(() =>
      createScopedMemberResetRedemptionMutationGateway(database.database, capture),
    ).toThrow('no longer fresh')
    rateMocks.admit.mockResolvedValue({ admitted: false, scope: 'member-reset:email' })
    await expect(gateway.redeem(redemptionInput(prepared))).resolves.toEqual({
      kind: 'rejected',
      persistence: 'unchanged',
    })
    expect(rateMocks.hashPassword).not.toHaveBeenCalled()
    expect(() => gateway.redeem(redemptionInput(prepared))).toThrow(
      ScopedBrowserRecoveryInvariantError,
    )
  })

  it('cannot flatten a stale post-capture recheck into a domain rejection', async () => {
    const prepared = await preparedMember()
    const capturedRow = memberSnapshot({ storedCode: prepared.submittedCode })
    const staleRow = {
      ...capturedRow,
      product_mutation_epoch: '223e4567-e89b-42d3-a456-426614174001',
    }
    const query = {
      query: vi
        .fn()
        .mockResolvedValueOnce(queryResult(capturedRow))
        .mockResolvedValueOnce(queryResult(staleRow)),
    } as unknown as IdentityRecoveryMutationQuery
    const capture = await captureMemberResetRedemption(query, {
      normalizedEmail: prepared.normalizedEmail,
      codeIdentity: prepared.codeIdentity,
      commandEnteredAt: prepared.commandEnteredAt,
    })
    await expect(recheckMemberResetRedemption(query, capture)).resolves.toEqual({
      status: 'stale',
      reason: 'installation-epoch-changed',
    })
    const { database, operations } = fakeDatabase()

    expect(() =>
      createScopedMemberResetRedemptionMutationGateway(database, capture),
    ).toThrow('no longer fresh')
    expect(rateMocks.admit).not.toHaveBeenCalled()
    expect(rateMocks.hashPassword).not.toHaveBeenCalled()
    expect(operations).toEqual([])
  })

  it('redeems a member code atomically and returns only committed non-secret state', async () => {
    const prepared = await preparedMember()
    const capture = await recheckedMemberCapture(
      prepared,
      memberSnapshot({ storedCode: prepared.submittedCode }),
    )
    const { database, operations } = fakeDatabase({
      credentialId: memberCredentialId,
      targetUserId: memberUserId,
      verificationId: memberVerificationId,
      sessionIds: ['session-1', 'session-2'],
    })
    const gateway = createScopedMemberResetRedemptionMutationGateway(database, capture)

    await expect(gateway.redeem(redemptionInput(prepared))).resolves.toEqual({
      kind: 'redeemed',
      targetUserId: memberUserId,
      revokedSessionCount: 2,
    })
    expect(operations.map(({ kind, table }) => `${kind}:${table}`)).toEqual([
      'update:account',
      'update:member-reset-state',
      'delete:verification',
      'delete:session',
      'insert:audit-event',
    ])
    expect(rateMocks.hashPassword).toHaveBeenCalledOnce()
    expect(rateMocks.hashPassword).toHaveBeenCalledWith(replacementPassword)
    expect(auditOperations(operations)[0]?.values).toMatchObject({
      eventType: 'member-reset-redeemed',
      subjectUserId: memberUserId,
      entityId: memberVerificationId,
      metadata: {
        channel: 'web',
        clientAddress: '198.51.100.0/24',
        outcome: 'redeemed',
        sessionsRevoked: 2,
      },
    })
    const serialized = JSON.stringify(operations.map((operation) => operation.values))
    expect(serialized).not.toContain(prepared.submittedCode)
    expect(serialized).not.toContain(replacementPassword)
    expect(serialized).not.toContain(requestContext.clientAddress)
  })

  it('commits one wrong-code backoff without consuming the live member code', async () => {
    const prepared = await preparedMember({ code: 'indigo_m1_wrong-code' })
    const capture = await recheckedMemberCapture(
      prepared,
      memberSnapshot({ storedCode: 'indigo_m1_real-code' }),
    )
    const { database, operations } = fakeDatabase({ targetUserId: memberUserId })
    const gateway = createScopedMemberResetRedemptionMutationGateway(database, capture)

    await expect(gateway.redeem(redemptionInput(prepared))).resolves.toEqual({
      kind: 'rejected',
      persistence: 'committed',
    })
    expect(operations.map(({ kind, table }) => `${kind}:${table}`)).toEqual([
      'update:member-reset-state',
      'insert:audit-event',
    ])
    expect(operations[0]?.values).toMatchObject({
      failedAttempts: 1,
      lastAttemptAt: commandEnteredAt,
      retryAfter: new Date(commandEnteredAt.getTime() + 1_000),
    })
    expect(auditOperations(operations)[0]?.values?.metadata).toMatchObject({
      outcome: 'rejected',
      retryAfter: new Date(commandEnteredAt.getTime() + 1_000).toISOString(),
    })
    expect(rateMocks.hashPassword).toHaveBeenCalledOnce()
  })

  it('does no rate, audit, or domain DML during an active member-code backoff', async () => {
    const prepared = await preparedMember()
    const lastAttemptAt = new Date(commandEnteredAt.getTime() - 1)
    const capture = await recheckedMemberCapture(
      prepared,
      memberSnapshot({
        storedCode: prepared.submittedCode,
        failedAttempts: 1,
        lastAttemptAt,
        retryAfter: new Date(commandEnteredAt.getTime() + 999),
      }),
    )
    const { database, operations } = fakeDatabase()
    const gateway = createScopedMemberResetRedemptionMutationGateway(database, capture)

    await expect(gateway.redeem(redemptionInput(prepared))).resolves.toEqual({
      kind: 'rejected',
      persistence: 'unchanged',
    })
    expect(rateMocks.admit).not.toHaveBeenCalled()
    expect(rateMocks.hashPassword).not.toHaveBeenCalled()
    expect(operations).toEqual([])
  })

  it('does no audit or domain DML when durable web admission is already throttled', async () => {
    const prepared = await preparedMember()
    const capture = await recheckedMemberCapture(
      prepared,
      memberSnapshot({ storedCode: prepared.submittedCode }),
    )
    rateMocks.admit.mockResolvedValue({ admitted: false, scope: 'member-reset:email' })
    const { database, operations } = fakeDatabase()
    const gateway = createScopedMemberResetRedemptionMutationGateway(database, capture)

    await expect(gateway.redeem(redemptionInput(prepared))).resolves.toEqual({
      kind: 'rejected',
      persistence: 'unchanged',
    })
    expect(rateMocks.admit).toHaveBeenCalledOnce()
    expect(rateMocks.hashPassword).not.toHaveBeenCalled()
    expect(operations).toEqual([])
  })

  it('uses dummy preparation and comparison work for unresolved hostile input', async () => {
    const rawCode = 'c'.repeat(300)
    const rawPassword = 'p'.repeat(129)
    const prepared = await preparedMember({
      email: 'missing@example.test',
      code: rawCode,
      password: rawPassword,
    })
    expect(prepared.passwordIsValid).toBe(false)
    const capture = await recheckedMemberCapture(
      prepared,
      memberSnapshot({ storedCode: 'unused-real-code', target: 'missing' }),
    )
    const { database, operations } = fakeDatabase()
    const gateway = createScopedMemberResetRedemptionMutationGateway(database, capture)

    await expect(gateway.redeem(redemptionInput(prepared))).resolves.toEqual({
      kind: 'rejected',
      persistence: 'committed',
    })
    expect(operations.map(({ kind, table }) => `${kind}:${table}`)).toEqual([
      'insert:audit-event',
    ])
    expect(auditOperations(operations)[0]?.values).toMatchObject({
      subjectUserId: null,
      entityId: null,
      eventType: 'member-reset-rejected',
    })
    expect(rateMocks.hashPassword).toHaveBeenCalledOnce()
    expect(rateMocks.hashPassword).toHaveBeenCalledWith(prepared.passwordHashInput)
    expect(prepared.passwordHashInput).not.toBe(rawPassword)
    const serialized = JSON.stringify(operations.map((operation) => operation.values))
    expect(serialized).not.toContain(rawCode)
    expect(serialized).not.toContain(rawPassword)
  })

  it('hashes a dummy replacement but preserves a live code when only the password is invalid', async () => {
    const prepared = await preparedMember({ password: 'too-short' })
    expect(prepared.passwordIsValid).toBe(false)
    const capture = await recheckedMemberCapture(
      prepared,
      memberSnapshot({ storedCode: prepared.submittedCode }),
    )
    const { database, operations } = fakeDatabase()
    const gateway = createScopedMemberResetRedemptionMutationGateway(database, capture)

    await expect(gateway.redeem(redemptionInput(prepared))).resolves.toEqual({
      kind: 'rejected',
      persistence: 'committed',
    })
    expect(rateMocks.hashPassword).toHaveBeenCalledOnce()
    expect(rateMocks.hashPassword).toHaveBeenCalledWith(prepared.passwordHashInput)
    expect(operations.map(({ kind, table }) => `${kind}:${table}`)).toEqual([
      'insert:audit-event',
    ])
  })

  it('consumes an expired member code, clears attempt state, and commits rejection', async () => {
    const prepared = await preparedMember()
    const capture = await recheckedMemberCapture(
      prepared,
      memberSnapshot({
        storedCode: prepared.submittedCode,
        expiresAt: new Date(commandEnteredAt),
      }),
    )
    const { database, operations } = fakeDatabase({
      targetUserId: memberUserId,
      verificationId: memberVerificationId,
    })
    const gateway = createScopedMemberResetRedemptionMutationGateway(database, capture)

    await expect(gateway.redeem(redemptionInput(prepared))).resolves.toEqual({
      kind: 'rejected',
      persistence: 'committed',
    })
    expect(operations.map(({ kind, table }) => `${kind}:${table}`)).toEqual([
      'update:member-reset-state',
      'delete:verification',
      'insert:audit-event',
    ])
    expect(rateMocks.hashPassword).toHaveBeenCalledOnce()
  })

  it('redeems browser owner recovery with password replacement, code consumption, and session revocation', async () => {
    const prepared = await preparedOwner()
    const capture = await recheckedOwnerCapture(
      prepared,
      ownerSnapshot({ storedCode: prepared.submittedCode }),
    )
    const { database, operations } = fakeDatabase({
      credentialId: ownerCredentialId,
      verificationId: ownerVerificationId,
      sessionIds: ['owner-session'],
    })
    const gateway = createScopedOwnerRecoveryWebRedemptionMutationGateway(
      database,
      capture,
    )

    await expect(gateway.redeem(redemptionInput(prepared))).resolves.toEqual({
      kind: 'redeemed',
      ownerUserId,
      revokedSessionCount: 1,
    })
    expect(operations.map(({ kind, table }) => `${kind}:${table}`)).toEqual([
      'update:account',
      'delete:verification',
      'delete:session',
      'insert:audit-event',
    ])
    expect(auditOperations(operations)[0]?.values).toMatchObject({
      subjectUserId: ownerUserId,
      entityId: ownerVerificationId,
      eventType: 'owner-recovery-redeemed',
    })
  })

  it('minimizes a wrong-email owner rejection and preserves its live code', async () => {
    const prepared = await preparedOwner({ email: 'wrong-owner@example.test' })
    const capture = await recheckedOwnerCapture(
      prepared,
      ownerSnapshot({
        storedCode: prepared.submittedCode,
        submittedEmailMatches: false,
      }),
    )
    const { database, operations } = fakeDatabase()
    const gateway = createScopedOwnerRecoveryWebRedemptionMutationGateway(
      database,
      capture,
    )

    await expect(gateway.redeem(redemptionInput(prepared))).resolves.toEqual({
      kind: 'rejected',
      persistence: 'committed',
    })
    expect(operations.map(({ kind, table }) => `${kind}:${table}`)).toEqual([
      'insert:audit-event',
    ])
    expect(auditOperations(operations)[0]?.values).toMatchObject({
      subjectUserId: null,
      entityId: null,
      eventType: 'owner-recovery-rejected',
    })
  })

  it('does no owner audit, password hash, or domain DML under an active web throttle', async () => {
    const prepared = await preparedOwner()
    const capture = await recheckedOwnerCapture(
      prepared,
      ownerSnapshot({ storedCode: prepared.submittedCode }),
    )
    rateMocks.admit.mockResolvedValue({
      admitted: false,
      scope: 'owner-recovery:email',
    })
    const { database, operations } = fakeDatabase()
    const gateway = createScopedOwnerRecoveryWebRedemptionMutationGateway(
      database,
      capture,
    )

    await expect(gateway.redeem(redemptionInput(prepared))).resolves.toEqual({
      kind: 'rejected',
      persistence: 'unchanged',
    })
    expect(rateMocks.admit).toHaveBeenCalledOnce()
    expect(rateMocks.hashPassword).not.toHaveBeenCalled()
    expect(operations).toEqual([])
  })

  it('consumes an expired owner code only after admitted dummy-or-real work', async () => {
    const prepared = await preparedOwner()
    const capture = await recheckedOwnerCapture(
      prepared,
      ownerSnapshot({
        storedCode: prepared.submittedCode,
        expiresAt: new Date(commandEnteredAt),
      }),
    )
    const { database, operations } = fakeDatabase({
      verificationId: ownerVerificationId,
    })
    const gateway = createScopedOwnerRecoveryWebRedemptionMutationGateway(
      database,
      capture,
    )

    await expect(gateway.redeem(redemptionInput(prepared))).resolves.toEqual({
      kind: 'rejected',
      persistence: 'committed',
    })
    expect(rateMocks.hashPassword).toHaveBeenCalledOnce()
    expect(operations.map(({ kind, table }) => `${kind}:${table}`)).toEqual([
      'delete:verification',
      'insert:audit-event',
    ])
  })

  it('throws on a prepared/captured binding mismatch before rate or DML', async () => {
    const prepared = await preparedOwner()
    const capture = await recheckedOwnerCapture(
      prepared,
      ownerSnapshot({ storedCode: prepared.submittedCode }),
    )
    const { database, operations } = fakeDatabase()
    const gateway = createScopedOwnerRecoveryWebRedemptionMutationGateway(
      database,
      capture,
    )

    await expect(
      gateway.redeem({
        ...redemptionInput(prepared),
        parsed: Object.freeze({
          ...prepared,
          normalizedEmail: 'other@example.test',
        }),
      }),
    ).rejects.toBeInstanceOf(ScopedBrowserRecoveryInvariantError)
    expect(rateMocks.admit).not.toHaveBeenCalled()
    expect(operations).toEqual([])
  })
})
