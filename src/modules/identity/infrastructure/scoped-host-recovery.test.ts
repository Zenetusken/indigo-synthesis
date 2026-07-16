import type { QueryResult, QueryResultRow } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'
import { account, auditEvents, session, verification } from '@/platform/db/schema'
import {
  ownerRecoveryCodeIdentity,
  ownerRecoveryStoredValue,
  type ParsedRecoveryRedemptionInput,
  type PreparedOwnerRecoveryIssuance,
  parseOwnerRecoveryHostRedemptionInput,
  prepareOwnerRecoveryIssuance,
} from '../recovery/recovery-preparation'
import {
  captureOwnerRecoveryCliRedemption,
  captureOwnerRecoveryIssuance,
  type IdentityRecoveryMutationQuery,
  OwnerRecoveryCliRedemptionCapture,
  type OwnerRecoveryIssuanceCapture,
  recheckOwnerRecoveryCliRedemption,
  recheckOwnerRecoveryIssuance,
} from './recovery-mutation'
import {
  createScopedOwnerRecoveryCliRedemptionMutationGateway,
  createScopedOwnerRecoveryIssuanceMutationGateway,
  ScopedHostRecoveryInvariantError,
} from './scoped-host-recovery'

const preparationMocks = vi.hoisted(() => ({ hashPassword: vi.fn() }))

vi.mock('better-auth/crypto', () => ({
  hashPassword: preparationMocks.hashPassword,
}))

const epoch = '123e4567-e89b-42d3-a456-426614174000'
const commandEnteredAt = new Date('2026-07-15T12:00:00.000Z')
const createdAt = new Date('2026-01-01T00:00:00.000Z')
const credentialUpdatedAt = new Date('2026-07-15T11:00:00.000Z')
const laterCredentialUpdatedAt = new Date('2026-07-15T12:02:00.000Z')
const liveExpiry = new Date('2026-07-15T12:15:00.000Z')
const ownerEmail = 'owner@example.test'
const wrongOwnerEmail = 'wrong-owner@example.test'
const ownerUserId = 'owner-user'
const ownerCredentialId = 'credential-owner'
const ownerVerificationId = 'owner-verification'
const hostInvocationId = 'host-invocation-1'
const replacementPassword = 'replacement-password-value'

const testEnvironment = {
  DATABASE_URL: 'postgresql://localhost/indigo_scoped_host_recovery_test',
  BETTER_AUTH_SECRET: 'host-recovery-test-secret-at-least-thirty-two-bytes',
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

function userRow() {
  return {
    id: ownerUserId,
    name: 'Owner',
    email: ownerEmail,
    emailVerified: false,
    createdAt,
    updatedAt: credentialUpdatedAt,
  }
}

function credentialRow(updatedAt = credentialUpdatedAt) {
  return {
    id: ownerCredentialId,
    accountId: ownerUserId,
    providerId: 'credential',
    userId: ownerUserId,
    password: 'private-current-password-hash',
    createdAt,
    updatedAt,
  }
}

function verificationRow(input: {
  readonly storedCode: string
  readonly expiresAt?: Date
}) {
  return {
    id: ownerVerificationId,
    identifier: `indigo:owner-recovery:${ownerUserId}`,
    value: ownerRecoveryStoredValue(input.storedCode),
    expiresAt: input.expiresAt ?? liveExpiry,
    createdAt,
    updatedAt: credentialUpdatedAt,
  }
}

function ownerSnapshot(input?: {
  readonly storedCode?: string
  readonly pendingPresent?: boolean
  readonly credentialPresent?: boolean
  readonly credentialTimestamp?: Date
  readonly expiresAt?: Date
}): ResultRow {
  const pendingPresent = input?.pendingPresent ?? true
  return {
    product_mutation_epoch: epoch,
    installation_owner_user_id: ownerUserId,
    bootstrap_closed_at: createdAt,
    submitted_email_user_ids: [],
    owner_user_rows: [userRow()],
    credential_rows:
      input?.credentialPresent === false
        ? []
        : [credentialRow(input?.credentialTimestamp)],
    owner_recovery_verification_rows: pendingPresent
      ? [
          verificationRow({
            storedCode: input?.storedCode ?? 'indigo_r1_real-code',
            expiresAt: input?.expiresAt,
          }),
        ]
      : [],
  }
}

type TableName = 'account' | 'audit-event' | 'session' | 'verification'

type DatabaseOperation = Readonly<{
  kind: 'insert' | 'update' | 'delete'
  table: TableName
  values?: Record<string, unknown>
  condition?: unknown
}>

function tableName(table: unknown): TableName {
  if (table === account) return 'account'
  if (table === auditEvents) return 'audit-event'
  if (table === session) return 'session'
  if (table === verification) return 'verification'
  throw new TypeError('Unexpected table in scoped host recovery test.')
}

function fakeDatabase(input?: {
  readonly credentialId?: string
  readonly verificationId?: string
  readonly sessionIds?: readonly string[]
}): { readonly database: never; readonly operations: DatabaseOperation[] } {
  const operations: DatabaseOperation[] = []
  const database = {
    insert(table: unknown) {
      const name = tableName(table)
      return {
        values(values: Record<string, unknown>) {
          operations.push({ kind: 'insert', table: name, values })
          if (name !== 'verification') return Promise.resolve(undefined)
          return {
            returning() {
              return Promise.resolve(
                typeof values.id === 'string' ? [{ id: values.id }] : [],
              )
            },
          }
        },
      }
    },
    update(table: unknown) {
      const name = tableName(table)
      let values: Record<string, unknown> | undefined
      const builder = {
        set(nextValues: Record<string, unknown>) {
          values = nextValues
          return builder
        },
        where(condition: unknown) {
          operations.push({ kind: 'update', table: name, values, condition })
          return builder
        },
        returning() {
          return Promise.resolve(
            name === 'account' && input?.credentialId ? [{ id: input.credentialId }] : [],
          )
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
          if (name === 'verification' && input?.verificationId) {
            return Promise.resolve([{ id: input.verificationId }])
          }
          if (name === 'session') {
            return Promise.resolve((input?.sessionIds ?? []).map((id) => ({ id })))
          }
          return Promise.resolve([])
        },
      }
      return builder
    },
  }
  return { database: database as never, operations }
}

function parsedCli(input?: {
  readonly email?: string
  readonly code?: string
  readonly password?: string
}): ParsedRecoveryRedemptionInput {
  return parseOwnerRecoveryHostRedemptionInput({
    ownerEmail: input?.email ?? ownerEmail,
    code: input?.code ?? 'indigo_r1_real-code',
    newPassword: input?.password ?? replacementPassword,
  })
}

async function recheckedCliCapture(
  parsed: ParsedRecoveryRedemptionInput,
  row: ResultRow,
) {
  const query = repeatedQuery(row)
  const capture = await captureOwnerRecoveryCliRedemption(query, {
    normalizedEmail: parsed.normalizedEmail,
    codeIdentity: ownerRecoveryCodeIdentity(parsed.submittedCode),
    commandEnteredAt,
    hostInvocationId,
  })
  await expect(recheckOwnerRecoveryCliRedemption(query, capture)).resolves.toEqual({
    status: 'current',
  })
  return capture
}

async function recheckedIssuanceCapture(email: string, row: ResultRow) {
  const query = repeatedQuery(row)
  const capture = await captureOwnerRecoveryIssuance(query, {
    normalizedOwnerEmail: email,
    commandEnteredAt,
    hostInvocationId,
  })
  await expect(recheckOwnerRecoveryIssuance(query, capture)).resolves.toEqual({
    status: 'current',
  })
  return capture
}

function preparedIssuance(email = ownerEmail): PreparedOwnerRecoveryIssuance {
  return prepareOwnerRecoveryIssuance({
    ownerUserId,
    ownerEmail: email,
    ttlMinutes: 15,
    commandEnteredAt,
  })
}

function operationKinds(operations: readonly DatabaseOperation[]) {
  return operations.map(({ kind, table }) => `${kind}:${table}`)
}

function auditValues(operations: readonly DatabaseOperation[]) {
  return operations.filter((operation) => operation.table === 'audit-event')[0]?.values
}

describe('scoped host owner recovery mutation gateways', () => {
  beforeEach(() => {
    Object.assign(process.env, testEnvironment)
    resetServerConfigForTests()
    preparationMocks.hashPassword.mockReset().mockResolvedValue('prepared-password-hash')
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetServerConfigForTests()
  })

  it('requires a post-recheck issuance claim and rejects forged, cross-purpose, and second-use authority before more DML', async () => {
    const row = ownerSnapshot({ pendingPresent: false })
    const query = repeatedQuery(row)
    const capture = await captureOwnerRecoveryIssuance(query, {
      normalizedOwnerEmail: ownerEmail,
      commandEnteredAt,
      hostInvocationId,
    })
    const { database, operations } = fakeDatabase()

    expect(() =>
      createScopedOwnerRecoveryIssuanceMutationGateway(database, capture),
    ).toThrow('no longer fresh')
    expect(operations).toEqual([])
    await expect(recheckOwnerRecoveryIssuance(query, capture)).resolves.toEqual({
      status: 'current',
    })

    const forged = Object.create(
      (capture as object).constructor.prototype,
    ) as OwnerRecoveryIssuanceCapture
    expect(() =>
      createScopedOwnerRecoveryIssuanceMutationGateway(database, forged),
    ).toThrow('no longer fresh')

    const cliParsed = parsedCli()
    const cliCapture = await recheckedCliCapture(cliParsed, row)
    expect(() =>
      createScopedOwnerRecoveryIssuanceMutationGateway(
        database,
        cliCapture as unknown as OwnerRecoveryIssuanceCapture,
      ),
    ).toThrow('no longer fresh')

    const gateway = createScopedOwnerRecoveryIssuanceMutationGateway(database, capture)
    await expect(gateway.issue(preparedIssuance())).resolves.toEqual({ kind: 'issued' })
    const operationCount = operations.length
    expect(() => gateway.issue(preparedIssuance())).toThrow(
      ScopedHostRecoveryInvariantError,
    )
    expect(operations).toHaveLength(operationCount)
  })

  it('atomically replaces an existing owner code and emits only redacted host audit metadata', async () => {
    const prepared = preparedIssuance()
    const capture = await recheckedIssuanceCapture(
      ownerEmail,
      ownerSnapshot({ storedCode: 'indigo_r1_old-code' }),
    )
    const { database, operations } = fakeDatabase({
      verificationId: ownerVerificationId,
    })
    const gateway = createScopedOwnerRecoveryIssuanceMutationGateway(database, capture)

    await expect(gateway.issue(prepared)).resolves.toEqual({ kind: 'issued' })
    expect(operationKinds(operations)).toEqual([
      'delete:verification',
      'insert:verification',
      'insert:audit-event',
    ])
    expect(operations[1]?.values).toEqual({
      id: prepared.recoveryId,
      identifier: prepared.identifier,
      value: prepared.storedValue,
      expiresAt: prepared.expiresAt,
      createdAt: commandEnteredAt,
      updatedAt: commandEnteredAt,
    })
    expect(auditValues(operations)).toMatchObject({
      subjectUserId: ownerUserId,
      entityId: prepared.recoveryId,
      eventType: 'owner-recovery-issued',
      metadata: {
        channel: 'host-local-cli',
        outcome: 'issued',
        expiresAt: prepared.expiresAt.toISOString(),
      },
    })
    const serializedAudit = JSON.stringify(auditValues(operations))
    expect(serializedAudit).not.toContain(prepared.code)
    expect(serializedAudit).not.toContain(prepared.storedValue)
    expect(serializedAudit).not.toContain(ownerEmail)
    expect(serializedAudit).not.toContain(hostInvocationId)
  })

  it('commits a wrong-email issuance rejection without replacing the prior code', async () => {
    const prepared = preparedIssuance(wrongOwnerEmail)
    const capture = await recheckedIssuanceCapture(
      wrongOwnerEmail,
      ownerSnapshot({ storedCode: 'indigo_r1_prior-code' }),
    )
    const { database, operations } = fakeDatabase()
    const gateway = createScopedOwnerRecoveryIssuanceMutationGateway(database, capture)

    await expect(gateway.issue(prepared)).resolves.toEqual({
      kind: 'rejected',
      reason: 'owner-mismatch',
    })
    expect(operationKinds(operations)).toEqual(['insert:audit-event'])
    expect(auditValues(operations)).toMatchObject({
      subjectUserId: ownerUserId,
      entityId: null,
      metadata: { channel: 'host-local-cli', outcome: 'rejected' },
    })
  })

  it('rejects internally incoherent issuance preparations before DML', async () => {
    const mutations = [
      (prepared: PreparedOwnerRecoveryIssuance) => ({
        ...prepared,
        ownerUserId: 'another-owner',
      }),
      (prepared: PreparedOwnerRecoveryIssuance) => ({
        ...prepared,
        normalizedOwnerEmail: wrongOwnerEmail,
      }),
      (prepared: PreparedOwnerRecoveryIssuance) => ({
        ...prepared,
        commandEnteredAt: new Date(commandEnteredAt.getTime() + 1),
      }),
      (prepared: PreparedOwnerRecoveryIssuance) => ({
        ...prepared,
        storedValue: 'owner-recovery-v1:forged',
      }),
    ]

    for (const mutate of mutations) {
      const capture = await recheckedIssuanceCapture(
        ownerEmail,
        ownerSnapshot({ pendingPresent: false }),
      )
      const { database, operations } = fakeDatabase()
      const gateway = createScopedOwnerRecoveryIssuanceMutationGateway(database, capture)
      await expect(
        gateway.issue(mutate(preparedIssuance()) as PreparedOwnerRecoveryIssuance),
      ).rejects.toBeInstanceOf(ScopedHostRecoveryInvariantError)
      expect(operations).toEqual([])
    }
  })

  it('redeems a CLI code with exact credential, code, session, and audit mutations', async () => {
    const parsed = parsedCli()
    const capture = await recheckedCliCapture(
      parsed,
      ownerSnapshot({
        storedCode: parsed.submittedCode,
        credentialTimestamp: laterCredentialUpdatedAt,
      }),
    )
    const { database, operations } = fakeDatabase({
      credentialId: ownerCredentialId,
      verificationId: ownerVerificationId,
      sessionIds: ['session-1', 'session-2'],
    })
    const gateway = createScopedOwnerRecoveryCliRedemptionMutationGateway(
      database,
      capture,
    )

    await expect(gateway.redeem({ parsed, commandEnteredAt })).resolves.toEqual({
      kind: 'redeemed',
      ownerUserId,
      revokedSessionCount: 2,
    })
    expect(preparationMocks.hashPassword).toHaveBeenCalledOnce()
    expect(preparationMocks.hashPassword).toHaveBeenCalledWith(replacementPassword)
    expect(operationKinds(operations)).toEqual([
      'update:account',
      'delete:verification',
      'delete:session',
      'insert:audit-event',
    ])
    expect(operations[0]?.values).toEqual({
      password: 'prepared-password-hash',
      updatedAt: laterCredentialUpdatedAt,
    })
    expect(auditValues(operations)).toMatchObject({
      subjectUserId: ownerUserId,
      entityId: ownerVerificationId,
      eventType: 'owner-recovery-redeemed',
      metadata: {
        channel: 'host-local-cli',
        outcome: 'redeemed',
        sessionsRevoked: 2,
      },
    })
    const serializedAudit = JSON.stringify(auditValues(operations))
    expect(serializedAudit).not.toContain(parsed.submittedCode)
    expect(serializedAudit).not.toContain(replacementPassword)
    expect(serializedAudit).not.toContain(ownerEmail)
    expect(serializedAudit).not.toContain(hostInvocationId)
  })

  it('hashes before a wrong-email rejection and preserves the live code', async () => {
    const parsed = parsedCli({ email: wrongOwnerEmail })
    const capture = await recheckedCliCapture(
      parsed,
      ownerSnapshot({ storedCode: parsed.submittedCode }),
    )
    const { database, operations } = fakeDatabase()
    const gateway = createScopedOwnerRecoveryCliRedemptionMutationGateway(
      database,
      capture,
    )

    await expect(gateway.redeem({ parsed, commandEnteredAt })).resolves.toEqual({
      kind: 'rejected',
      reason: 'owner-mismatch',
    })
    expect(preparationMocks.hashPassword).toHaveBeenCalledOnce()
    expect(operationKinds(operations)).toEqual(['insert:audit-event'])
    expect(auditValues(operations)).toMatchObject({
      subjectUserId: ownerUserId,
      entityId: null,
      metadata: { channel: 'host-local-cli', outcome: 'rejected' },
    })
  })

  it('hashes and constant-time rejects a wrong live code without consuming it', async () => {
    const parsed = parsedCli({ code: 'indigo_r1_wrong-code' })
    const capture = await recheckedCliCapture(
      parsed,
      ownerSnapshot({ storedCode: 'indigo_r1_real-code' }),
    )
    const { database, operations } = fakeDatabase()
    const gateway = createScopedOwnerRecoveryCliRedemptionMutationGateway(
      database,
      capture,
    )

    await expect(gateway.redeem({ parsed, commandEnteredAt })).resolves.toEqual({
      kind: 'rejected',
      reason: 'code-invalid',
    })
    expect(preparationMocks.hashPassword).toHaveBeenCalledOnce()
    expect(operationKinds(operations)).toEqual(['insert:audit-event'])
    expect(auditValues(operations)?.entityId).toBe(ownerVerificationId)
  })

  it('hashes, consumes an expired code, and commits a code-invalid rejection', async () => {
    const parsed = parsedCli()
    const capture = await recheckedCliCapture(
      parsed,
      ownerSnapshot({
        storedCode: parsed.submittedCode,
        expiresAt: new Date(commandEnteredAt),
      }),
    )
    const { database, operations } = fakeDatabase({
      verificationId: ownerVerificationId,
    })
    const gateway = createScopedOwnerRecoveryCliRedemptionMutationGateway(
      database,
      capture,
    )

    await expect(gateway.redeem({ parsed, commandEnteredAt })).resolves.toEqual({
      kind: 'rejected',
      reason: 'code-invalid',
    })
    expect(preparationMocks.hashPassword).toHaveBeenCalledOnce()
    expect(operationKinds(operations)).toEqual([
      'delete:verification',
      'insert:audit-event',
    ])
  })

  it('hashes before reporting a missing credential and retains the valid code', async () => {
    const parsed = parsedCli()
    const capture = await recheckedCliCapture(
      parsed,
      ownerSnapshot({
        storedCode: parsed.submittedCode,
        credentialPresent: false,
      }),
    )
    const { database, operations } = fakeDatabase()
    const gateway = createScopedOwnerRecoveryCliRedemptionMutationGateway(
      database,
      capture,
    )

    await expect(gateway.redeem({ parsed, commandEnteredAt })).resolves.toEqual({
      kind: 'rejected',
      reason: 'credential-missing',
    })
    expect(preparationMocks.hashPassword).toHaveBeenCalledOnce()
    expect(operationKinds(operations)).toEqual(['insert:audit-event'])
    expect(auditValues(operations)?.entityId).toBe(ownerVerificationId)
  })

  it('performs dummy hash/compare work when no code exists before rejecting', async () => {
    const parsed = parsedCli()
    const capture = await recheckedCliCapture(
      parsed,
      ownerSnapshot({ pendingPresent: false }),
    )
    const { database, operations } = fakeDatabase()
    const gateway = createScopedOwnerRecoveryCliRedemptionMutationGateway(
      database,
      capture,
    )

    await expect(gateway.redeem({ parsed, commandEnteredAt })).resolves.toEqual({
      kind: 'rejected',
      reason: 'code-invalid',
    })
    expect(preparationMocks.hashPassword).toHaveBeenCalledOnce()
    expect(operationKinds(operations)).toEqual(['insert:audit-event'])
    expect(auditValues(operations)?.entityId).toBeNull()
  })

  it('rejects pre-recheck, forged, cross-purpose, mismatched, and second-use CLI authority before DML', async () => {
    const parsed = parsedCli()
    const row = ownerSnapshot({ storedCode: parsed.submittedCode })
    const query = repeatedQuery(row)
    const capture = await captureOwnerRecoveryCliRedemption(query, {
      normalizedEmail: parsed.normalizedEmail,
      codeIdentity: ownerRecoveryCodeIdentity(parsed.submittedCode),
      commandEnteredAt,
      hostInvocationId,
    })
    const { database, operations } = fakeDatabase()

    expect(() =>
      createScopedOwnerRecoveryCliRedemptionMutationGateway(database, capture),
    ).toThrow('no longer fresh')
    await expect(recheckOwnerRecoveryCliRedemption(query, capture)).resolves.toEqual({
      status: 'current',
    })

    const forged = Object.create(
      OwnerRecoveryCliRedemptionCapture.prototype,
    ) as OwnerRecoveryCliRedemptionCapture
    expect(() =>
      createScopedOwnerRecoveryCliRedemptionMutationGateway(database, forged),
    ).toThrow('no longer fresh')

    const issueCapture = await recheckedIssuanceCapture(ownerEmail, row)
    expect(() =>
      createScopedOwnerRecoveryCliRedemptionMutationGateway(
        database,
        issueCapture as unknown as OwnerRecoveryCliRedemptionCapture,
      ),
    ).toThrow('no longer fresh')

    const gateway = createScopedOwnerRecoveryCliRedemptionMutationGateway(
      database,
      capture,
    )
    await expect(
      gateway.redeem({
        parsed: Object.freeze({ ...parsed, normalizedEmail: wrongOwnerEmail }),
        commandEnteredAt,
      }),
    ).rejects.toBeInstanceOf(ScopedHostRecoveryInvariantError)
    expect(preparationMocks.hashPassword).not.toHaveBeenCalled()
    expect(operations).toEqual([])
    expect(() => gateway.redeem({ parsed, commandEnteredAt })).toThrow(
      ScopedHostRecoveryInvariantError,
    )
    expect(operations).toEqual([])
  })
})
