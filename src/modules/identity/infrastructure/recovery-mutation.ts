import type { QueryResult, QueryResultRow } from 'pg'
import { normalizeRecoveryEmail } from '../recovery/recovery-policy'

const lifecycleValuePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const codeIdentityPattern = /^[0-9a-f]{64}$/
const maximumIdentityBytes = 512
const maximumPrivateValueBytes = 16 * 1024
const invalidRecoveryEmail = 'invalid-email'

const memberRecoverySnapshotStatement = `
  WITH installation AS MATERIALIZED (
    SELECT
      product_mutation_epoch::text AS product_mutation_epoch,
      owner_user_id AS installation_owner_user_id,
      bootstrap_closed_at
    FROM installation_state
    WHERE singleton = 1
  ),
  submitted_users AS MATERIALIZED (
    SELECT
      candidate.id,
      candidate.name,
      candidate.email,
      candidate.email_verified,
      candidate.created_at,
      candidate.updated_at
    FROM "user" AS candidate
    WHERE $1::text <> 'invalid-email'
      AND lower(candidate.email) = $1
    ORDER BY candidate.id COLLATE "C"
    LIMIT 2
  ),
  submitted_credentials AS MATERIALIZED (
    SELECT
      credential.id,
      credential.account_id,
      credential.provider_id,
      credential.user_id,
      credential.password,
      credential.created_at,
      credential.updated_at
    FROM account AS credential
    WHERE credential.provider_id = 'credential'
      AND credential.user_id IN (SELECT id FROM submitted_users)
    ORDER BY credential.user_id COLLATE "C", credential.id COLLATE "C"
    LIMIT 2
  ),
  submitted_reset_states AS MATERIALIZED (
    SELECT
      state.target_user_id,
      state.active_verification_id,
      state.last_issued_at,
      state.failed_attempts,
      state.retry_after,
      state.last_attempt_at,
      state.created_at,
      state.updated_at
    FROM member_reset_state AS state
    WHERE state.target_user_id IN (SELECT id FROM submitted_users)
    ORDER BY state.target_user_id COLLATE "C"
    LIMIT 2
  ),
  submitted_verifications AS MATERIALIZED (
    SELECT
      pending.id,
      pending.identifier,
      pending.value,
      pending.expires_at,
      pending.created_at,
      pending.updated_at
    FROM verification AS pending
    WHERE pending.identifier IN (
        SELECT 'indigo:member-reset:' || id FROM submitted_users
      )
      OR pending.id IN (
        SELECT active_verification_id
        FROM submitted_reset_states
        WHERE active_verification_id IS NOT NULL
      )
    ORDER BY pending.identifier COLLATE "C", pending.id COLLATE "C"
    LIMIT 2
  )
  SELECT
    installation.product_mutation_epoch,
    installation.installation_owner_user_id,
    installation.bootstrap_closed_at,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', candidate.id,
            'name', candidate.name,
            'email', candidate.email,
            'emailVerified', candidate.email_verified,
            'createdAt', candidate.created_at,
            'updatedAt', candidate.updated_at
          )
          ORDER BY candidate.id COLLATE "C"
        )
        FROM submitted_users AS candidate
      ),
      '[]'::jsonb
    ) AS submitted_user_rows,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', credential.id,
            'accountId', credential.account_id,
            'providerId', credential.provider_id,
            'userId', credential.user_id,
            'password', credential.password,
            'createdAt', credential.created_at,
            'updatedAt', credential.updated_at
          )
          ORDER BY credential.user_id COLLATE "C", credential.id COLLATE "C"
        )
        FROM submitted_credentials AS credential
      ),
      '[]'::jsonb
    ) AS credential_rows,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'targetUserId', state.target_user_id,
            'activeVerificationId', state.active_verification_id,
            'lastIssuedAt', state.last_issued_at,
            'failedAttempts', state.failed_attempts,
            'retryAfter', state.retry_after,
            'lastAttemptAt', state.last_attempt_at,
            'createdAt', state.created_at,
            'updatedAt', state.updated_at
          )
          ORDER BY state.target_user_id COLLATE "C"
        )
        FROM submitted_reset_states AS state
      ),
      '[]'::jsonb
    ) AS member_reset_state_rows,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', pending.id,
            'identifier', pending.identifier,
            'value', pending.value,
            'expiresAt', pending.expires_at,
            'createdAt', pending.created_at,
            'updatedAt', pending.updated_at
          )
          ORDER BY pending.identifier COLLATE "C", pending.id COLLATE "C"
        )
        FROM submitted_verifications AS pending
      ),
      '[]'::jsonb
    ) AS member_reset_verification_rows
  FROM installation
`

const ownerRecoverySnapshotStatement = `
  WITH installation AS MATERIALIZED (
    SELECT
      product_mutation_epoch::text AS product_mutation_epoch,
      owner_user_id AS installation_owner_user_id,
      bootstrap_closed_at
    FROM installation_state
    WHERE singleton = 1
  ),
  submitted_users AS MATERIALIZED (
    SELECT candidate.id
    FROM "user" AS candidate
    WHERE $1::text IS NOT NULL
      AND $1::text <> 'invalid-email'
      AND lower(candidate.email) = $1
    ORDER BY candidate.id COLLATE "C"
    LIMIT 2
  ),
  installed_owner AS MATERIALIZED (
    SELECT
      owner.id,
      owner.name,
      owner.email,
      owner.email_verified,
      owner.created_at,
      owner.updated_at
    FROM "user" AS owner
    JOIN installation
      ON installation.installation_owner_user_id = owner.id
  ),
  owner_credentials AS MATERIALIZED (
    SELECT
      credential.id,
      credential.account_id,
      credential.provider_id,
      credential.user_id,
      credential.password,
      credential.created_at,
      credential.updated_at
    FROM account AS credential
    WHERE credential.provider_id = 'credential'
      AND credential.user_id IN (SELECT id FROM installed_owner)
    ORDER BY credential.id COLLATE "C"
    LIMIT 2
  ),
  owner_verifications AS MATERIALIZED (
    SELECT
      pending.id,
      pending.identifier,
      pending.value,
      pending.expires_at,
      pending.created_at,
      pending.updated_at
    FROM verification AS pending
    WHERE pending.identifier IN (
      SELECT 'indigo:owner-recovery:' || id FROM installed_owner
    )
    ORDER BY pending.id COLLATE "C"
    LIMIT 2
  )
  SELECT
    installation.product_mutation_epoch,
    installation.installation_owner_user_id,
    installation.bootstrap_closed_at,
    ARRAY(
      SELECT candidate.id
      FROM submitted_users AS candidate
      ORDER BY candidate.id COLLATE "C"
    )::text[] AS submitted_email_user_ids,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', owner.id,
            'name', owner.name,
            'email', owner.email,
            'emailVerified', owner.email_verified,
            'createdAt', owner.created_at,
            'updatedAt', owner.updated_at
          )
          ORDER BY owner.id COLLATE "C"
        )
        FROM installed_owner AS owner
      ),
      '[]'::jsonb
    ) AS owner_user_rows,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', credential.id,
            'accountId', credential.account_id,
            'providerId', credential.provider_id,
            'userId', credential.user_id,
            'password', credential.password,
            'createdAt', credential.created_at,
            'updatedAt', credential.updated_at
          )
          ORDER BY credential.id COLLATE "C"
        )
        FROM owner_credentials AS credential
      ),
      '[]'::jsonb
    ) AS credential_rows,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', pending.id,
            'identifier', pending.identifier,
            'value', pending.value,
            'expiresAt', pending.expires_at,
            'createdAt', pending.created_at,
            'updatedAt', pending.updated_at
          )
          ORDER BY pending.id COLLATE "C"
        )
        FROM owner_verifications AS pending
      ),
      '[]'::jsonb
    ) AS owner_recovery_verification_rows
  FROM installation
`

export type IdentityRecoveryMutationQuery = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

type UserSnapshot = Readonly<{
  id: string
  name: string
  email: string
  emailVerified: boolean
  createdAt: Date
  updatedAt: Date
}>

type CredentialSnapshot = Readonly<{
  id: string
  accountId: string
  providerId: 'credential'
  userId: string
  password: string | null
  createdAt: Date
  updatedAt: Date
}>

type MemberResetStateSnapshot = Readonly<{
  targetUserId: string
  activeVerificationId: string | null
  lastIssuedAt: Date
  failedAttempts: number
  retryAfter: Date | null
  lastAttemptAt: Date | null
  createdAt: Date
  updatedAt: Date
}>

type VerificationSnapshot = Readonly<{
  id: string
  identifier: string
  value: string
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}>

type InstallationSnapshot = Readonly<{
  epoch: string
  ownerUserId: string | null
  bootstrapClosedAt: Date | null
}>

type MemberRecoverySnapshot = Readonly<{
  installation: InstallationSnapshot
  users: readonly UserSnapshot[]
  credentials: readonly CredentialSnapshot[]
  states: readonly MemberResetStateSnapshot[]
  verifications: readonly VerificationSnapshot[]
}>

type OwnerRecoverySnapshot = Readonly<{
  installation: InstallationSnapshot
  owner: UserSnapshot | null
  submittedEmailUserIds: readonly string[]
  credentials: readonly CredentialSnapshot[]
  verifications: readonly VerificationSnapshot[]
}>

type CaptureStatus = 'fresh' | 'in-use' | 'rechecked' | 'spent'

type MemberCaptureState = {
  status: CaptureStatus
  readonly normalizedEmail: string
  readonly codeIdentity: string
  readonly commandEnteredAt: Date
  readonly snapshot: MemberRecoverySnapshot
}

type OwnerRedemptionCaptureState = {
  status: CaptureStatus
  readonly normalizedEmail: string
  readonly codeIdentity: string
  readonly commandEnteredAt: Date
  readonly hostInvocationId: string | null
  readonly snapshot: OwnerRecoverySnapshot
}

type OwnerIssuanceCaptureState = {
  status: CaptureStatus
  readonly normalizedEmail: string
  readonly commandEnteredAt: Date
  readonly hostInvocationId: string
  readonly snapshot: OwnerRecoverySnapshot
}

const memberCaptures = new WeakMap<MemberResetRedemptionCapture, MemberCaptureState>()
const ownerWebCaptures = new WeakMap<
  OwnerRecoveryWebRedemptionCapture,
  OwnerRedemptionCaptureState
>()
const ownerCliCaptures = new WeakMap<
  OwnerRecoveryCliRedemptionCapture,
  OwnerRedemptionCaptureState
>()
const ownerIssuanceCaptures = new WeakMap<
  OwnerRecoveryIssuanceCapture,
  OwnerIssuanceCaptureState
>()

/** Nominal, process-local proof for one member recovery resolution snapshot. */
export abstract class MemberResetRedemptionCapture {
  protected constructor() {}
}

/** Nominal, process-local proof for one browser owner-recovery snapshot. */
export abstract class OwnerRecoveryWebRedemptionCapture {
  protected constructor() {}
}

/** Nominal, process-local proof for one host CLI owner-recovery snapshot. */
export abstract class OwnerRecoveryCliRedemptionCapture {
  protected constructor() {}
}

/** Nominal, process-local proof for one host owner-recovery issuance snapshot. */
export abstract class OwnerRecoveryIssuanceCapture {
  protected constructor() {}
}

const captureConstructionToken = Object.freeze({})

class ConcreteMemberResetRedemptionCapture extends MemberResetRedemptionCapture {
  constructor(token: typeof captureConstructionToken) {
    super()
    if (token !== captureConstructionToken) throw staleCapture()
  }
}

class ConcreteOwnerRecoveryWebRedemptionCapture extends OwnerRecoveryWebRedemptionCapture {
  constructor(token: typeof captureConstructionToken) {
    super()
    if (token !== captureConstructionToken) throw staleCapture()
  }
}

class ConcreteOwnerRecoveryCliRedemptionCapture extends OwnerRecoveryCliRedemptionCapture {
  constructor(token: typeof captureConstructionToken) {
    super()
    if (token !== captureConstructionToken) throw staleCapture()
  }
}

class ConcreteOwnerRecoveryIssuanceCapture extends OwnerRecoveryIssuanceCapture {
  constructor(token: typeof captureConstructionToken) {
    super()
    if (token !== captureConstructionToken) throw staleCapture()
  }
}

export type RecoveryCredentialPresence = 'present' | 'missing'
export type RecoveryInstallationState = 'open' | 'claimed'

export type MemberResetRedemptionCaptureView = Readonly<{
  purpose: 'member-reset-redemption'
  expectedEpoch: string
  installationState: RecoveryInstallationState
  commandEnteredAt: Date
  codeIdentity: string
  targetUserId: string | null
  targetState: 'member' | 'owner' | 'missing'
  targetCredential: RecoveryCredentialPresence
  activeVerification: Readonly<{ id: string; expiresAt: Date }> | null
}>

export type OwnerRecoveryRedemptionCaptureView = Readonly<{
  purpose: 'owner-recovery-web-redemption' | 'owner-recovery-cli-redemption'
  expectedEpoch: string
  installationState: RecoveryInstallationState
  commandEnteredAt: Date
  codeIdentity: string
  ownerUserId: string | null
  ownerEmailMatches: boolean
  ownerCredential: RecoveryCredentialPresence
  activeVerification: Readonly<{ id: string; expiresAt: Date }> | null
  hostInvocationId: string | null
}>

export type OwnerRecoveryIssuanceCaptureView = Readonly<{
  purpose: 'owner-recovery-issue'
  expectedEpoch: string
  installationState: RecoveryInstallationState
  commandEnteredAt: Date
  ownerUserId: string | null
  ownerEmailMatches: boolean
  ownerCredential: RecoveryCredentialPresence
  activeVerification: Readonly<{ id: string; expiresAt: Date }> | null
  hostInvocationId: string
}>

/**
 * Capture-private member redemption material. The runtime import boundary permits
 * only the purpose-narrow scoped recovery gateway to resolve this projection.
 */
export type MemberResetRedemptionMutationScope = Readonly<{
  purpose: 'member-reset-redemption'
  normalizedEmail: string
  codeIdentity: string
  commandEnteredAt: Date
  targetUserId: string | null
  targetState: 'member' | 'owner' | 'missing'
  credentialId: string | null
  state: Readonly<{
    activeVerificationId: string | null
    lastIssuedAt: Date
    failedAttempts: number
    retryAfter: Date | null
    lastAttemptAt: Date | null
  }> | null
  verification: Readonly<{
    id: string
    storedValue: string
    expiresAt: Date
  }> | null
}>

/**
 * Capture-private browser owner-recovery material. Submitted email and stored
 * capability material never cross the scoped recovery gateway boundary.
 */
export type OwnerRecoveryWebRedemptionMutationScope = Readonly<{
  purpose: 'owner-recovery-web-redemption'
  normalizedEmail: string
  codeIdentity: string
  commandEnteredAt: Date
  ownerUserId: string | null
  ownerEmailMatches: boolean
  credentialId: string | null
  verification: Readonly<{
    id: string
    storedValue: string
    expiresAt: Date
  }> | null
}>

export type RecoveryMutationRecheck =
  | Readonly<{ status: 'current' }>
  | Readonly<{
      status: 'stale'
      reason:
        | 'installation-epoch-changed'
        | 'installation-authority-changed'
        | 'resolved-account-set-changed'
        | 'owner-state-changed'
        | 'credential-set-changed'
        | 'member-reset-state-changed'
        | 'member-reset-verification-set-changed'
        | 'owner-recovery-state-changed'
    }>

export class RecoveryMutationCaptureInvariantError extends Error {
  constructor() {
    super('Identity recovery capture returned an invalid database shape.')
    this.name = 'RecoveryMutationCaptureInvariantError'
  }
}

type MemberSnapshotRow = QueryResultRow & {
  readonly product_mutation_epoch?: unknown
  readonly installation_owner_user_id?: unknown
  readonly bootstrap_closed_at?: unknown
  readonly submitted_user_rows?: unknown
  readonly credential_rows?: unknown
  readonly member_reset_state_rows?: unknown
  readonly member_reset_verification_rows?: unknown
}

type OwnerSnapshotRow = QueryResultRow & {
  readonly product_mutation_epoch?: unknown
  readonly installation_owner_user_id?: unknown
  readonly bootstrap_closed_at?: unknown
  readonly submitted_email_user_ids?: unknown
  readonly owner_user_rows?: unknown
  readonly credential_rows?: unknown
  readonly owner_recovery_verification_rows?: unknown
}

function invariant(): never {
  throw new RecoveryMutationCaptureInvariantError()
}

function staleCapture(): TypeError {
  return new TypeError('Recovery mutation capture was not issued or is no longer fresh.')
}

function boundedText(value: unknown, maximumBytes = maximumIdentityBytes): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    return invariant()
  }
  return value
}

function optionalPrivateText(value: unknown): string | null {
  if (value === null) return null
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumPrivateValueBytes
  ) {
    return invariant()
  }
  return value
}

function dateValue(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(boundedText(value))
  if (!Number.isFinite(parsed.getTime())) return invariant()
  return new Date(parsed.getTime())
}

function optionalDate(value: unknown): Date | null {
  return value === null ? null : dateValue(value)
}

function optionalIdentity(value: unknown): string | null {
  return value === null ? null : boundedText(value)
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invariant()
  return value as Record<string, unknown>
}

function compareIdentityBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function assertCanonicalOrder<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (
      previous === undefined ||
      current === undefined ||
      compare(previous, current) >= 0
    ) {
      invariant()
    }
  }
}

function userSnapshot(value: unknown): UserSnapshot {
  const row = recordValue(value)
  if (typeof row.emailVerified !== 'boolean') return invariant()
  return Object.freeze({
    id: boundedText(row.id),
    name: boundedText(row.name),
    email: boundedText(row.email),
    emailVerified: row.emailVerified,
    createdAt: dateValue(row.createdAt),
    updatedAt: dateValue(row.updatedAt),
  })
}

function userSnapshots(value: unknown, maximum: number): readonly UserSnapshot[] {
  if (!Array.isArray(value) || value.length > maximum) return invariant()
  const users = value.map(userSnapshot)
  assertCanonicalOrder(users, (left, right) => compareIdentityBytes(left.id, right.id))
  return Object.freeze(users)
}

function canonicalIdentities(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 2) return invariant()
  const identities = value.map((candidate) => boundedText(candidate))
  assertCanonicalOrder(identities, compareIdentityBytes)
  return Object.freeze(identities)
}

function credentialSnapshot(value: unknown): CredentialSnapshot {
  const row = recordValue(value)
  if (row.providerId !== 'credential') return invariant()
  return Object.freeze({
    id: boundedText(row.id),
    accountId: boundedText(row.accountId),
    providerId: row.providerId,
    userId: boundedText(row.userId),
    password: optionalPrivateText(row.password),
    createdAt: dateValue(row.createdAt),
    updatedAt: dateValue(row.updatedAt),
  })
}

function credentialSnapshots(value: unknown): readonly CredentialSnapshot[] {
  if (!Array.isArray(value) || value.length > 2) return invariant()
  const credentials = value.map(credentialSnapshot)
  assertCanonicalOrder(credentials, (left, right) => {
    const userOrder = compareIdentityBytes(left.userId, right.userId)
    return userOrder === 0 ? compareIdentityBytes(left.id, right.id) : userOrder
  })
  return Object.freeze(credentials)
}

function resetStateSnapshot(value: unknown): MemberResetStateSnapshot {
  const row = recordValue(value)
  if (!Number.isInteger(row.failedAttempts) || (row.failedAttempts as number) < 0) {
    return invariant()
  }
  return Object.freeze({
    targetUserId: boundedText(row.targetUserId),
    activeVerificationId: optionalIdentity(row.activeVerificationId),
    lastIssuedAt: dateValue(row.lastIssuedAt),
    failedAttempts: row.failedAttempts as number,
    retryAfter: optionalDate(row.retryAfter),
    lastAttemptAt: optionalDate(row.lastAttemptAt),
    createdAt: dateValue(row.createdAt),
    updatedAt: dateValue(row.updatedAt),
  })
}

function resetStateSnapshots(value: unknown): readonly MemberResetStateSnapshot[] {
  if (!Array.isArray(value) || value.length > 2) return invariant()
  const states = value.map(resetStateSnapshot)
  assertCanonicalOrder(states, (left, right) =>
    compareIdentityBytes(left.targetUserId, right.targetUserId),
  )
  return Object.freeze(states)
}

function verificationSnapshot(value: unknown): VerificationSnapshot {
  const row = recordValue(value)
  return Object.freeze({
    id: boundedText(row.id),
    identifier: boundedText(row.identifier),
    value: boundedText(row.value, maximumPrivateValueBytes),
    expiresAt: dateValue(row.expiresAt),
    createdAt: dateValue(row.createdAt),
    updatedAt: dateValue(row.updatedAt),
  })
}

function verificationSnapshots(
  value: unknown,
  order: 'identifier-id' | 'id',
): readonly VerificationSnapshot[] {
  if (!Array.isArray(value) || value.length > 2) return invariant()
  const verifications = value.map(verificationSnapshot)
  assertCanonicalOrder(verifications, (left, right) => {
    if (order === 'id') return compareIdentityBytes(left.id, right.id)
    const identifierOrder = compareIdentityBytes(left.identifier, right.identifier)
    return identifierOrder === 0
      ? compareIdentityBytes(left.id, right.id)
      : identifierOrder
  })
  return Object.freeze(verifications)
}

function installationSnapshot(row: {
  readonly product_mutation_epoch?: unknown
  readonly installation_owner_user_id?: unknown
  readonly bootstrap_closed_at?: unknown
}): InstallationSnapshot {
  const epoch = boundedText(row.product_mutation_epoch)
  if (!lifecycleValuePattern.test(epoch)) return invariant()
  return Object.freeze({
    epoch,
    ownerUserId: optionalIdentity(row.installation_owner_user_id),
    bootstrapClosedAt: optionalDate(row.bootstrap_closed_at),
  })
}

async function readMemberSnapshot(
  query: IdentityRecoveryMutationQuery,
  normalizedEmail: string,
): Promise<MemberRecoverySnapshot> {
  const result = await query.query<MemberSnapshotRow>(memberRecoverySnapshotStatement, [
    normalizedEmail,
  ])
  if (result.rows.length !== 1) return invariant()
  const row = result.rows[0]
  if (!row) return invariant()
  const users = userSnapshots(row.submitted_user_rows, 2)
  if (
    users.some(
      (candidate) =>
        candidate.email.toLowerCase() !== normalizedEmail ||
        normalizedEmail === invalidRecoveryEmail,
    )
  ) {
    return invariant()
  }
  const credentials = credentialSnapshots(row.credential_rows)
  const states = resetStateSnapshots(row.member_reset_state_rows)
  const verifications = verificationSnapshots(
    row.member_reset_verification_rows,
    'identifier-id',
  )
  const userIds = new Set(users.map((candidate) => candidate.id))
  if (
    credentials.some((credential) => !userIds.has(credential.userId)) ||
    states.some((state) => !userIds.has(state.targetUserId))
  ) {
    return invariant()
  }
  const identifiers = new Set(
    users.map((candidate) => `indigo:member-reset:${candidate.id}`),
  )
  const activeIds = new Set(
    states.flatMap((state) =>
      state.activeVerificationId === null ? [] : [state.activeVerificationId],
    ),
  )
  if (
    verifications.some(
      (pending) => !identifiers.has(pending.identifier) && !activeIds.has(pending.id),
    )
  ) {
    return invariant()
  }
  return Object.freeze({
    installation: installationSnapshot(row),
    users,
    credentials,
    states,
    verifications,
  })
}

async function readOwnerSnapshot(
  query: IdentityRecoveryMutationQuery,
  normalizedEmail: string | null,
): Promise<OwnerRecoverySnapshot> {
  const result = await query.query<OwnerSnapshotRow>(ownerRecoverySnapshotStatement, [
    normalizedEmail,
  ])
  if (result.rows.length !== 1) return invariant()
  const row = result.rows[0]
  if (!row) return invariant()
  const ownerRows = userSnapshots(row.owner_user_rows, 1)
  const owner = ownerRows[0] ?? null
  const parsedSubmittedEmailUserIds = canonicalIdentities(row.submitted_email_user_ids)
  const submittedEmailUserIds =
    normalizedEmail === null ? Object.freeze([]) : parsedSubmittedEmailUserIds
  const credentials = credentialSnapshots(row.credential_rows)
  const verifications = verificationSnapshots(row.owner_recovery_verification_rows, 'id')
  const ownerUserId = owner?.id
  if (
    credentials.some((credential) => credential.userId !== ownerUserId) ||
    verifications.some(
      (pending) => pending.identifier !== `indigo:owner-recovery:${ownerUserId}`,
    )
  ) {
    return invariant()
  }
  return Object.freeze({
    installation: installationSnapshot(row),
    owner,
    submittedEmailUserIds,
    credentials,
    verifications,
  })
}

function assertInstallationCoherent(
  installation: InstallationSnapshot,
  owner: UserSnapshot | null,
): void {
  const isOpen =
    installation.ownerUserId === null && installation.bootstrapClosedAt === null
  const isClaimed =
    installation.ownerUserId !== null && installation.bootstrapClosedAt !== null
  if (!isOpen && !isClaimed) invariant()
  if (isOpen ? owner !== null : owner?.id !== installation.ownerUserId) invariant()
}

function assertMemberSnapshotCoherent(snapshot: MemberRecoverySnapshot): void {
  if (
    (snapshot.installation.ownerUserId === null) !==
    (snapshot.installation.bootstrapClosedAt === null)
  ) {
    invariant()
  }
  if (snapshot.users.length > 1) invariant()
  const target = snapshot.users[0] ?? null
  if (!target) {
    if (
      snapshot.credentials.length !== 0 ||
      snapshot.states.length !== 0 ||
      snapshot.verifications.length !== 0
    ) {
      invariant()
    }
    return
  }
  if (snapshot.credentials.length > 1 || snapshot.states.length > 1) invariant()
  const state = snapshot.states[0] ?? null
  const verification = snapshot.verifications[0] ?? null
  if (snapshot.verifications.length > 1) invariant()
  if (!state || state.activeVerificationId === null) {
    if (verification) invariant()
    return
  }
  if (
    !verification ||
    verification.id !== state.activeVerificationId ||
    verification.identifier !== `indigo:member-reset:${target.id}`
  ) {
    invariant()
  }
}

function assertOwnerSnapshotCoherent(snapshot: OwnerRecoverySnapshot): void {
  assertInstallationCoherent(snapshot.installation, snapshot.owner)
  if (!snapshot.owner) {
    if (snapshot.credentials.length !== 0 || snapshot.verifications.length !== 0) {
      invariant()
    }
    return
  }
  if (snapshot.credentials.length > 1 || snapshot.verifications.length > 1) {
    invariant()
  }
}

function assertOwnerWebResolutionCoherent(
  snapshot: OwnerRecoverySnapshot,
  normalizedEmail: string,
): void {
  if (snapshot.submittedEmailUserIds.length > 1) invariant()
  const matches = ownerEmailMatches(snapshot, normalizedEmail)
  if (
    matches &&
    (snapshot.submittedEmailUserIds.length !== 1 ||
      snapshot.submittedEmailUserIds[0] !== snapshot.owner?.id)
  ) {
    invariant()
  }
  if (
    !matches &&
    snapshot.owner &&
    snapshot.submittedEmailUserIds.includes(snapshot.owner.id)
  ) {
    invariant()
  }
}

function canonicalNormalizedEmail(value: string): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    normalizeRecoveryEmail(value) !== value
  ) {
    throw new TypeError('Recovery capture requires a normalized email value.')
  }
  return value
}

function canonicalCodeIdentity(value: string): string {
  if (!codeIdentityPattern.test(value)) {
    throw new TypeError('Recovery capture requires a purpose-bound code identity.')
  }
  return value
}

function canonicalHostInvocationId(value: string): string {
  try {
    return boundedText(value)
  } catch {
    throw new TypeError('Recovery capture requires a host invocation identity.')
  }
}

function commandEntryDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Recovery capture command-entry clock is invalid.')
  }
  return new Date(value.getTime())
}

function newCapture<T extends object, State extends { status: CaptureStatus }>(
  capture: T,
  map: WeakMap<T, State>,
  state: State,
): T {
  map.set(capture, state)
  Object.freeze(capture)
  return capture
}

export async function captureMemberResetRedemption(
  query: IdentityRecoveryMutationQuery,
  input: {
    readonly normalizedEmail: string
    readonly codeIdentity: string
    readonly commandEnteredAt: Date
  },
): Promise<MemberResetRedemptionCapture> {
  const normalizedEmail = canonicalNormalizedEmail(input.normalizedEmail)
  const codeIdentity = canonicalCodeIdentity(input.codeIdentity)
  const commandEnteredAt = commandEntryDate(input.commandEnteredAt)
  const snapshot = await readMemberSnapshot(query, normalizedEmail)
  assertMemberSnapshotCoherent(snapshot)
  return newCapture(
    new ConcreteMemberResetRedemptionCapture(captureConstructionToken),
    memberCaptures,
    { status: 'fresh', normalizedEmail, codeIdentity, commandEnteredAt, snapshot },
  )
}

async function captureOwnerRedemption<StateCapture extends object>(
  query: IdentityRecoveryMutationQuery,
  input: {
    readonly normalizedEmail: string
    readonly codeIdentity: string
    readonly commandEnteredAt: Date
    readonly hostInvocationId: string | null
  },
  capture: StateCapture,
  map: WeakMap<StateCapture, OwnerRedemptionCaptureState>,
): Promise<StateCapture> {
  const normalizedEmail = canonicalNormalizedEmail(input.normalizedEmail)
  const codeIdentity = canonicalCodeIdentity(input.codeIdentity)
  const commandEnteredAt = commandEntryDate(input.commandEnteredAt)
  const hostInvocationId =
    input.hostInvocationId === null
      ? null
      : canonicalHostInvocationId(input.hostInvocationId)
  const snapshot = await readOwnerSnapshot(
    query,
    hostInvocationId === null ? normalizedEmail : null,
  )
  assertOwnerSnapshotCoherent(snapshot)
  if (hostInvocationId === null) {
    assertOwnerWebResolutionCoherent(snapshot, normalizedEmail)
  }
  return newCapture(capture, map, {
    status: 'fresh',
    normalizedEmail,
    codeIdentity,
    commandEnteredAt,
    hostInvocationId,
    snapshot,
  })
}

export function captureOwnerRecoveryWebRedemption(
  query: IdentityRecoveryMutationQuery,
  input: {
    readonly normalizedEmail: string
    readonly codeIdentity: string
    readonly commandEnteredAt: Date
  },
): Promise<OwnerRecoveryWebRedemptionCapture> {
  return captureOwnerRedemption(
    query,
    { ...input, hostInvocationId: null },
    new ConcreteOwnerRecoveryWebRedemptionCapture(captureConstructionToken),
    ownerWebCaptures,
  )
}

export function captureOwnerRecoveryCliRedemption(
  query: IdentityRecoveryMutationQuery,
  input: {
    readonly normalizedEmail: string
    readonly codeIdentity: string
    readonly commandEnteredAt: Date
    readonly hostInvocationId: string
  },
): Promise<OwnerRecoveryCliRedemptionCapture> {
  return captureOwnerRedemption(
    query,
    input,
    new ConcreteOwnerRecoveryCliRedemptionCapture(captureConstructionToken),
    ownerCliCaptures,
  )
}

export async function captureOwnerRecoveryIssuance(
  query: IdentityRecoveryMutationQuery,
  input: {
    readonly normalizedOwnerEmail: string
    readonly hostInvocationId: string
    readonly commandEnteredAt: Date
  },
): Promise<OwnerRecoveryIssuanceCapture> {
  const normalizedEmail = canonicalNormalizedEmail(input.normalizedOwnerEmail)
  const hostInvocationId = canonicalHostInvocationId(input.hostInvocationId)
  const commandEnteredAt = commandEntryDate(input.commandEnteredAt)
  const snapshot = await readOwnerSnapshot(query, null)
  assertOwnerSnapshotCoherent(snapshot)
  return newCapture(
    new ConcreteOwnerRecoveryIssuanceCapture(captureConstructionToken),
    ownerIssuanceCaptures,
    { status: 'fresh', normalizedEmail, hostInvocationId, commandEnteredAt, snapshot },
  )
}

function freshState<State extends { status: CaptureStatus }>(
  state: State | undefined,
): State {
  if (state?.status !== 'fresh') throw staleCapture()
  return state
}

function installationState(snapshot: InstallationSnapshot): RecoveryInstallationState {
  return snapshot.ownerUserId === null ? 'open' : 'claimed'
}

function credentialPresence(
  credentials: readonly CredentialSnapshot[],
): RecoveryCredentialPresence {
  return credentials.length === 1 ? 'present' : 'missing'
}

function activeVerificationView(
  verification: VerificationSnapshot | undefined,
): Readonly<{ id: string; expiresAt: Date }> | null {
  return verification
    ? Object.freeze({
        id: verification.id,
        expiresAt: new Date(verification.expiresAt.getTime()),
      })
    : null
}

function ownerEmailMatches(snapshot: OwnerRecoverySnapshot, normalizedEmail: string) {
  return (
    normalizedEmail !== invalidRecoveryEmail &&
    snapshot.owner?.email.toLowerCase() === normalizedEmail
  )
}

export function memberResetRedemptionCaptureView(
  capture: MemberResetRedemptionCapture,
): MemberResetRedemptionCaptureView {
  const state = freshState(memberCaptures.get(capture))
  const target = state.snapshot.users[0] ?? null
  return Object.freeze({
    purpose: 'member-reset-redemption',
    expectedEpoch: state.snapshot.installation.epoch,
    installationState: installationState(state.snapshot.installation),
    commandEnteredAt: new Date(state.commandEnteredAt.getTime()),
    codeIdentity: state.codeIdentity,
    targetUserId: target?.id ?? null,
    targetState: !target
      ? 'missing'
      : target.id === state.snapshot.installation.ownerUserId
        ? 'owner'
        : 'member',
    targetCredential: credentialPresence(state.snapshot.credentials),
    activeVerification: activeVerificationView(state.snapshot.verifications[0]),
  })
}

function ownerRedemptionView(
  state: OwnerRedemptionCaptureState,
  purpose: 'owner-recovery-web-redemption' | 'owner-recovery-cli-redemption',
): OwnerRecoveryRedemptionCaptureView {
  return Object.freeze({
    purpose,
    expectedEpoch: state.snapshot.installation.epoch,
    installationState: installationState(state.snapshot.installation),
    commandEnteredAt: new Date(state.commandEnteredAt.getTime()),
    codeIdentity: state.codeIdentity,
    ownerUserId: state.snapshot.owner?.id ?? null,
    ownerEmailMatches: ownerEmailMatches(state.snapshot, state.normalizedEmail),
    ownerCredential: credentialPresence(state.snapshot.credentials),
    activeVerification: activeVerificationView(state.snapshot.verifications[0]),
    hostInvocationId: state.hostInvocationId,
  })
}

export function ownerRecoveryWebRedemptionCaptureView(
  capture: OwnerRecoveryWebRedemptionCapture,
): OwnerRecoveryRedemptionCaptureView {
  return ownerRedemptionView(
    freshState(ownerWebCaptures.get(capture)),
    'owner-recovery-web-redemption',
  )
}

export function ownerRecoveryCliRedemptionCaptureView(
  capture: OwnerRecoveryCliRedemptionCapture,
): OwnerRecoveryRedemptionCaptureView {
  return ownerRedemptionView(
    freshState(ownerCliCaptures.get(capture)),
    'owner-recovery-cli-redemption',
  )
}

export function ownerRecoveryIssuanceCaptureView(
  capture: OwnerRecoveryIssuanceCapture,
): OwnerRecoveryIssuanceCaptureView {
  const state = freshState(ownerIssuanceCaptures.get(capture))
  return Object.freeze({
    purpose: 'owner-recovery-issue',
    expectedEpoch: state.snapshot.installation.epoch,
    installationState: installationState(state.snapshot.installation),
    commandEnteredAt: new Date(state.commandEnteredAt.getTime()),
    ownerUserId: state.snapshot.owner?.id ?? null,
    ownerEmailMatches: ownerEmailMatches(state.snapshot, state.normalizedEmail),
    ownerCredential: credentialPresence(state.snapshot.credentials),
    activeVerification: activeVerificationView(state.snapshot.verifications[0]),
    hostInvocationId: state.hostInvocationId,
  })
}

function claimRecheckedState<State extends { status: CaptureStatus }>(
  state: State | undefined,
): State {
  if (state?.status !== 'rechecked') throw staleCapture()
  state.status = 'spent'
  return state
}

/**
 * Consumes a successfully rechecked capture and exposes only the private DML
 * bindings required by member reset redemption. This projection is one-use.
 */
export function claimMemberResetRedemptionMutationScope(
  capture: MemberResetRedemptionCapture,
): MemberResetRedemptionMutationScope {
  const state = claimRecheckedState(memberCaptures.get(capture))
  const target = state.snapshot.users[0] ?? null
  const credential = state.snapshot.credentials[0] ?? null
  const reset = state.snapshot.states[0] ?? null
  const pending = state.snapshot.verifications[0] ?? null
  return Object.freeze({
    purpose: 'member-reset-redemption',
    normalizedEmail: state.normalizedEmail,
    codeIdentity: state.codeIdentity,
    commandEnteredAt: new Date(state.commandEnteredAt.getTime()),
    targetUserId: target?.id ?? null,
    targetState: !target
      ? 'missing'
      : target.id === state.snapshot.installation.ownerUserId
        ? 'owner'
        : 'member',
    credentialId: credential?.id ?? null,
    state: reset
      ? Object.freeze({
          activeVerificationId: reset.activeVerificationId,
          lastIssuedAt: new Date(reset.lastIssuedAt.getTime()),
          failedAttempts: reset.failedAttempts,
          retryAfter:
            reset.retryAfter === null ? null : new Date(reset.retryAfter.getTime()),
          lastAttemptAt:
            reset.lastAttemptAt === null ? null : new Date(reset.lastAttemptAt.getTime()),
        })
      : null,
    verification: pending
      ? Object.freeze({
          id: pending.id,
          storedValue: pending.value,
          expiresAt: new Date(pending.expiresAt.getTime()),
        })
      : null,
  })
}

/**
 * Consumes a successfully rechecked capture and exposes only the private DML
 * bindings required by browser owner recovery. This projection is one-use.
 */
export function claimOwnerRecoveryWebRedemptionMutationScope(
  capture: OwnerRecoveryWebRedemptionCapture,
): OwnerRecoveryWebRedemptionMutationScope {
  const state = claimRecheckedState(ownerWebCaptures.get(capture))
  const credential = state.snapshot.credentials[0] ?? null
  const pending = state.snapshot.verifications[0] ?? null
  return Object.freeze({
    purpose: 'owner-recovery-web-redemption',
    normalizedEmail: state.normalizedEmail,
    codeIdentity: state.codeIdentity,
    commandEnteredAt: new Date(state.commandEnteredAt.getTime()),
    ownerUserId: state.snapshot.owner?.id ?? null,
    ownerEmailMatches: ownerEmailMatches(state.snapshot, state.normalizedEmail),
    credentialId: credential?.id ?? null,
    verification: pending
      ? Object.freeze({
          id: pending.id,
          storedValue: pending.value,
          expiresAt: new Date(pending.expiresAt.getTime()),
        })
      : null,
  })
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime()
}

function sameOptionalDate(left: Date | null, right: Date | null): boolean {
  return left === null || right === null ? left === right : sameDate(left, right)
}

function sameUser(left: UserSnapshot | null, right: UserSnapshot | null): boolean {
  if (!left || !right) return left === right
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.email === right.email &&
    left.emailVerified === right.emailVerified &&
    sameDate(left.createdAt, right.createdAt) &&
    sameDate(left.updatedAt, right.updatedAt)
  )
}

function sameUsers(
  left: readonly UserSnapshot[],
  right: readonly UserSnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every((candidate, index) => sameUser(candidate, right[index] ?? null))
  )
}

function sameCredentials(
  left: readonly CredentialSnapshot[],
  right: readonly CredentialSnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every((credential, index) => {
      const other = right[index]
      return (
        !!other &&
        credential.id === other.id &&
        credential.accountId === other.accountId &&
        credential.providerId === other.providerId &&
        credential.userId === other.userId &&
        credential.password === other.password &&
        sameDate(credential.createdAt, other.createdAt) &&
        sameDate(credential.updatedAt, other.updatedAt)
      )
    })
  )
}

function sameResetStates(
  left: readonly MemberResetStateSnapshot[],
  right: readonly MemberResetStateSnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every((state, index) => {
      const other = right[index]
      return (
        !!other &&
        state.targetUserId === other.targetUserId &&
        state.activeVerificationId === other.activeVerificationId &&
        sameDate(state.lastIssuedAt, other.lastIssuedAt) &&
        state.failedAttempts === other.failedAttempts &&
        sameOptionalDate(state.retryAfter, other.retryAfter) &&
        sameOptionalDate(state.lastAttemptAt, other.lastAttemptAt) &&
        sameDate(state.createdAt, other.createdAt) &&
        sameDate(state.updatedAt, other.updatedAt)
      )
    })
  )
}

function sameVerifications(
  left: readonly VerificationSnapshot[],
  right: readonly VerificationSnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every((pending, index) => {
      const other = right[index]
      return (
        !!other &&
        pending.id === other.id &&
        pending.identifier === other.identifier &&
        pending.value === other.value &&
        sameDate(pending.expiresAt, other.expiresAt) &&
        sameDate(pending.createdAt, other.createdAt) &&
        sameDate(pending.updatedAt, other.updatedAt)
      )
    })
  )
}

function sameInstallationAuthority(
  left: InstallationSnapshot,
  right: InstallationSnapshot,
): boolean {
  return (
    left.ownerUserId === right.ownerUserId &&
    sameOptionalDate(left.bootstrapClosedAt, right.bootstrapClosedAt)
  )
}

function sameIdentities(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  )
}

function compareMemberSnapshots(
  expected: MemberRecoverySnapshot,
  current: MemberRecoverySnapshot,
): RecoveryMutationRecheck {
  if (current.installation.epoch !== expected.installation.epoch) {
    return Object.freeze({ status: 'stale', reason: 'installation-epoch-changed' })
  }
  if (!sameInstallationAuthority(current.installation, expected.installation)) {
    return Object.freeze({ status: 'stale', reason: 'installation-authority-changed' })
  }
  if (!sameUsers(current.users, expected.users)) {
    return Object.freeze({ status: 'stale', reason: 'resolved-account-set-changed' })
  }
  if (!sameCredentials(current.credentials, expected.credentials)) {
    return Object.freeze({ status: 'stale', reason: 'credential-set-changed' })
  }
  if (!sameResetStates(current.states, expected.states)) {
    return Object.freeze({ status: 'stale', reason: 'member-reset-state-changed' })
  }
  if (!sameVerifications(current.verifications, expected.verifications)) {
    return Object.freeze({
      status: 'stale',
      reason: 'member-reset-verification-set-changed',
    })
  }
  return Object.freeze({ status: 'current' })
}

function compareOwnerSnapshots(
  expected: OwnerRecoverySnapshot,
  current: OwnerRecoverySnapshot,
): RecoveryMutationRecheck {
  const base = compareOwnerBase(expected, current)
  if (base.status === 'stale') return base
  if (!sameCredentials(current.credentials, expected.credentials)) {
    return Object.freeze({ status: 'stale', reason: 'credential-set-changed' })
  }
  if (!sameVerifications(current.verifications, expected.verifications)) {
    return Object.freeze({ status: 'stale', reason: 'owner-recovery-state-changed' })
  }
  return Object.freeze({ status: 'current' })
}

function compareOwnerBase(
  expected: OwnerRecoverySnapshot,
  current: OwnerRecoverySnapshot,
): RecoveryMutationRecheck {
  if (current.installation.epoch !== expected.installation.epoch) {
    return Object.freeze({ status: 'stale', reason: 'installation-epoch-changed' })
  }
  if (!sameInstallationAuthority(current.installation, expected.installation)) {
    return Object.freeze({ status: 'stale', reason: 'installation-authority-changed' })
  }
  if (!sameUser(current.owner, expected.owner)) {
    return Object.freeze({ status: 'stale', reason: 'owner-state-changed' })
  }
  return Object.freeze({ status: 'current' })
}

function compareOwnerWebSnapshots(
  expected: OwnerRecoverySnapshot,
  current: OwnerRecoverySnapshot,
): RecoveryMutationRecheck {
  const base = compareOwnerBase(expected, current)
  if (base.status === 'stale') return base
  if (!sameIdentities(current.submittedEmailUserIds, expected.submittedEmailUserIds)) {
    return Object.freeze({ status: 'stale', reason: 'resolved-account-set-changed' })
  }
  if (!sameCredentials(current.credentials, expected.credentials)) {
    return Object.freeze({ status: 'stale', reason: 'credential-set-changed' })
  }
  if (!sameVerifications(current.verifications, expected.verifications)) {
    return Object.freeze({ status: 'stale', reason: 'owner-recovery-state-changed' })
  }
  return Object.freeze({ status: 'current' })
}

async function recheck<State extends { status: CaptureStatus }, Snapshot>(
  state: State | undefined,
  read: (claimed: State) => Promise<Snapshot>,
  compare: (expected: Snapshot, current: Snapshot) => RecoveryMutationRecheck,
  coherent: (snapshot: Snapshot) => void,
  expected: (claimed: State) => Snapshot,
): Promise<RecoveryMutationRecheck> {
  if (state?.status !== 'fresh') throw staleCapture()
  state.status = 'in-use'
  try {
    const current = await read(state)
    const result = compare(expected(state), current)
    if (result.status === 'stale') {
      state.status = 'spent'
      return result
    }
    coherent(current)
    state.status = 'rechecked'
    return result
  } catch (error) {
    state.status = 'spent'
    throw error
  }
}

/** Must be the first transactional query after BEGIN for member redemption. */
export function recheckMemberResetRedemption(
  query: IdentityRecoveryMutationQuery,
  capture: MemberResetRedemptionCapture,
): Promise<RecoveryMutationRecheck> {
  const state = memberCaptures.get(capture)
  return recheck(
    state,
    (claimed) => readMemberSnapshot(query, claimed.normalizedEmail),
    compareMemberSnapshots,
    assertMemberSnapshotCoherent,
    (claimed) => claimed.snapshot,
  )
}

function recheckOwnerRedemption(
  query: IdentityRecoveryMutationQuery,
  state: OwnerRedemptionCaptureState | undefined,
  channel: 'web' | 'cli',
): Promise<RecoveryMutationRecheck> {
  return recheck(
    state,
    (claimed) =>
      readOwnerSnapshot(query, channel === 'web' ? claimed.normalizedEmail : null),
    channel === 'web' ? compareOwnerWebSnapshots : compareOwnerSnapshots,
    (snapshot) => {
      assertOwnerSnapshotCoherent(snapshot)
      if (channel === 'web' && state) {
        assertOwnerWebResolutionCoherent(snapshot, state.normalizedEmail)
      }
    },
    (claimed) => claimed.snapshot,
  )
}

/** Must be the first transactional query after BEGIN for browser owner recovery. */
export function recheckOwnerRecoveryWebRedemption(
  query: IdentityRecoveryMutationQuery,
  capture: OwnerRecoveryWebRedemptionCapture,
): Promise<RecoveryMutationRecheck> {
  return recheckOwnerRedemption(query, ownerWebCaptures.get(capture), 'web')
}

/** Must be the first transactional query after BEGIN for CLI owner recovery. */
export function recheckOwnerRecoveryCliRedemption(
  query: IdentityRecoveryMutationQuery,
  capture: OwnerRecoveryCliRedemptionCapture,
): Promise<RecoveryMutationRecheck> {
  return recheckOwnerRedemption(query, ownerCliCaptures.get(capture), 'cli')
}

/** Must be the first transactional query after BEGIN for host recovery issuance. */
export function recheckOwnerRecoveryIssuance(
  query: IdentityRecoveryMutationQuery,
  capture: OwnerRecoveryIssuanceCapture,
): Promise<RecoveryMutationRecheck> {
  const state = ownerIssuanceCaptures.get(capture)
  return recheck(
    state,
    () => readOwnerSnapshot(query, null),
    compareOwnerSnapshots,
    assertOwnerSnapshotCoherent,
    (claimed) => claimed.snapshot,
  )
}
