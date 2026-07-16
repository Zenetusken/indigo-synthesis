import type { QueryResult, QueryResultRow } from 'pg'
import { normalizeRecoveryEmail } from '../recovery/recovery-policy'

const lifecycleValuePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const maximumIdentityLength = 512

const credentialAdministrationSnapshotStatement = `
  SELECT
    installation.product_mutation_epoch::text AS product_mutation_epoch,
    installation.owner_user_id AS installation_owner_user_id,
    installation.bootstrap_closed_at AS bootstrap_closed_at,
    matched_session.id AS session_id,
    matched_session.user_id AS session_user_id,
    matched_session.expires_at AS session_expires_at,
    actor.id AS actor_user_id,
    actor.name AS actor_name,
    actor.email AS actor_email,
    actor.email_verified AS actor_email_verified,
    actor.created_at AS actor_created_at,
    actor.updated_at AS actor_updated_at,
    target.id AS target_user_id,
    target.name AS target_name,
    target.email AS target_email,
    target.email_verified AS target_email_verified,
    target.created_at AS target_created_at,
    target.updated_at AS target_updated_at,
    reset_state.target_user_id AS member_reset_target_user_id,
    reset_state.active_verification_id AS member_reset_active_verification_id,
    reset_state.last_issued_at AS member_reset_last_issued_at,
    reset_state.failed_attempts AS member_reset_failed_attempts,
    reset_state.retry_after AS member_reset_retry_after,
    reset_state.last_attempt_at AS member_reset_last_attempt_at,
    reset_state.created_at AS member_reset_created_at,
    reset_state.updated_at AS member_reset_updated_at,
    ARRAY(
      SELECT candidate.id
      FROM "user" AS candidate
      WHERE $3::text IS NOT NULL AND lower(candidate.email) = $3
      ORDER BY candidate.id COLLATE "C"
      LIMIT 2
    )::text[] AS submitted_email_user_ids,
    COALESCE(
      (
        SELECT jsonb_agg(
          candidate.row
          ORDER BY candidate.user_id COLLATE "C", candidate.id COLLATE "C"
        )
        FROM (
          SELECT
            credential.id,
            credential.user_id,
            jsonb_build_object(
              'id', credential.id,
              'accountId', credential.account_id,
              'userId', credential.user_id,
              'password', credential.password,
              'createdAt', credential.created_at,
              'updatedAt', credential.updated_at
            ) AS row
          FROM account AS credential
          WHERE credential.provider_id = 'credential'
            AND credential.user_id IN (matched_session.user_id, $2)
          ORDER BY credential.user_id COLLATE "C", credential.id COLLATE "C"
          LIMIT 3
        ) AS candidate
      ),
      '[]'::jsonb
    ) AS credential_rows,
    COALESCE(
      (
        SELECT jsonb_agg(candidate.row ORDER BY candidate.id COLLATE "C")
        FROM (
          SELECT
            pending.id,
            jsonb_build_object(
              'id', pending.id,
              'identifier', pending.identifier,
              'value', pending.value,
              'expiresAt', pending.expires_at,
              'createdAt', pending.created_at,
              'updatedAt', pending.updated_at
            ) AS row
          FROM verification AS pending
          WHERE pending.identifier = ('indigo:member-reset:' || $2)
          ORDER BY pending.id COLLATE "C"
          LIMIT 2
        ) AS candidate
      ),
      '[]'::jsonb
    ) AS member_reset_verification_rows
  FROM installation_state AS installation
  LEFT JOIN "session" AS matched_session
    ON matched_session.token = $1
  LEFT JOIN "user" AS actor
    ON actor.id = matched_session.user_id
  LEFT JOIN "user" AS target
    ON target.id = $2
  LEFT JOIN member_reset_state AS reset_state
    ON reset_state.target_user_id = $2
  WHERE installation.singleton = 1
`

export type IdentityCredentialAdministrationQuery = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

export type CredentialAdministrationPurpose = 'local-user-create' | 'member-reset-issue'

type UserSnapshot = Readonly<{
  id: string
  name: string
  email: string
  emailVerified: boolean
  createdAt: Date
  updatedAt: Date
}>

type SessionSnapshot = Readonly<{
  id: string
  actorUserId: string
  expiresAt: Date
}>

type CredentialSnapshot = Readonly<{
  id: string
  accountId: string
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

type MemberResetVerificationSnapshot = Readonly<{
  id: string
  identifier: string
  value: string
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}>

type AdministrationSnapshot = Readonly<{
  epoch: string
  ownerUserId: string
  bootstrapClosedAt: Date
  session: SessionSnapshot
  actor: UserSnapshot
  target: UserSnapshot | null
  submittedEmailUserIds: readonly string[]
  credentials: readonly CredentialSnapshot[]
  memberResetState: MemberResetStateSnapshot | null
  memberResetVerifications: readonly MemberResetVerificationSnapshot[]
}>

type LocalUserCreationCaptureState = Readonly<{
  purpose: 'local-user-create'
  verifiedSessionToken: string
  commandEnteredAt: Date
  normalizedEmail: string
  preallocatedTargetUserId: string
  snapshot: AdministrationSnapshot
}>

type MemberResetIssuanceCaptureState = Readonly<{
  purpose: 'member-reset-issue'
  verifiedSessionToken: string
  commandEnteredAt: Date
  targetUserId: string
  snapshot: AdministrationSnapshot
}>

const localUserCreationCaptures = new WeakMap<
  LocalUserCreationMutationCapture,
  LocalUserCreationCaptureState
>()
const memberResetIssuanceCaptures = new WeakMap<
  MemberResetIssuanceMutationCapture,
  MemberResetIssuanceCaptureState
>()

/** Nominal, non-serializable evidence for one local-user administration snapshot. */
export abstract class LocalUserCreationMutationCapture {
  protected constructor() {}
}

/** Nominal, non-serializable evidence for one member-reset issuance snapshot. */
export abstract class MemberResetIssuanceMutationCapture {
  protected constructor() {}
}

const captureConstructionToken = Object.freeze({})

class ConcreteLocalUserCreationMutationCapture extends LocalUserCreationMutationCapture {
  constructor(token: typeof captureConstructionToken) {
    super()
    if (token !== captureConstructionToken) throw staleCapture()
  }
}

class ConcreteMemberResetIssuanceMutationCapture extends MemberResetIssuanceMutationCapture {
  constructor(token: typeof captureConstructionToken) {
    super()
    if (token !== captureConstructionToken) throw staleCapture()
  }
}

export type CredentialPresence = 'present' | 'missing'

export type LocalUserCreationMutationCaptureView = Readonly<{
  purpose: 'local-user-create'
  expectedEpoch: string
  actorUserId: string
  sessionId: string
  sessionExpiresAt: Date
  expectedRole: 'owner'
  preallocatedTargetUserId: string
  submittedEmailUserIds: readonly string[]
  actorCredential: CredentialPresence
}>

export type MemberResetIssuanceMutationCaptureView = Readonly<{
  purpose: 'member-reset-issue'
  expectedEpoch: string
  actorUserId: string
  sessionId: string
  sessionExpiresAt: Date
  expectedRole: 'owner'
  targetUserId: string
  targetState: 'member' | 'owner' | 'missing'
  actorCredential: CredentialPresence
  targetCredential: CredentialPresence
}>

export type CredentialAdministrationMutationRecheck =
  | Readonly<{ status: 'current' }>
  | Readonly<{
      status: 'stale'
      reason:
        | 'installation-epoch-changed'
        | 'installation-authority-changed'
        | 'session-changed'
        | 'actor-changed'
        | 'target-state-changed'
        | 'submitted-email-set-changed'
        | 'credential-set-changed'
        | 'member-reset-state-changed'
    }>

export class CredentialAdministrationCaptureInvariantError extends Error {
  constructor() {
    super(
      'Identity credential-administration capture returned an invalid database shape.',
    )
    this.name = 'CredentialAdministrationCaptureInvariantError'
  }
}

export class CredentialAdministrationAuthorityUnavailableError extends Error {
  constructor() {
    super('The authenticated credential-administration authority is no longer current.')
    this.name = 'CredentialAdministrationAuthorityUnavailableError'
  }
}

type SnapshotRow = QueryResultRow & {
  readonly product_mutation_epoch?: unknown
  readonly installation_owner_user_id?: unknown
  readonly bootstrap_closed_at?: unknown
  readonly session_id?: unknown
  readonly session_user_id?: unknown
  readonly session_expires_at?: unknown
  readonly actor_user_id?: unknown
  readonly actor_name?: unknown
  readonly actor_email?: unknown
  readonly actor_email_verified?: unknown
  readonly actor_created_at?: unknown
  readonly actor_updated_at?: unknown
  readonly target_user_id?: unknown
  readonly target_name?: unknown
  readonly target_email?: unknown
  readonly target_email_verified?: unknown
  readonly target_created_at?: unknown
  readonly target_updated_at?: unknown
  readonly member_reset_target_user_id?: unknown
  readonly member_reset_active_verification_id?: unknown
  readonly member_reset_last_issued_at?: unknown
  readonly member_reset_failed_attempts?: unknown
  readonly member_reset_retry_after?: unknown
  readonly member_reset_last_attempt_at?: unknown
  readonly member_reset_created_at?: unknown
  readonly member_reset_updated_at?: unknown
  readonly submitted_email_user_ids?: unknown
  readonly credential_rows?: unknown
  readonly member_reset_verification_rows?: unknown
}

function invariant(): never {
  throw new CredentialAdministrationCaptureInvariantError()
}

function staleCapture(): TypeError {
  return new TypeError('Credential-administration capture was not issued by Identity.')
}

function authorityUnavailable(): never {
  throw new CredentialAdministrationAuthorityUnavailableError()
}

function identity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximumIdentityLength ||
    value.includes('\0')
  ) {
    return invariant()
  }
  return value
}

function validDate(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(identity(value))
  if (!Number.isFinite(parsed.getTime())) return invariant()
  return new Date(parsed.getTime())
}

function optionalIdentity(value: unknown): string | null {
  return value === null ? null : identity(value)
}

function optionalDate(value: unknown): Date | null {
  return value === null ? null : validDate(value)
}

function userSnapshot(row: SnapshotRow, prefix: 'actor' | 'target'): UserSnapshot | null {
  const fields = {
    id: row[`${prefix}_user_id`],
    name: row[`${prefix}_name`],
    email: row[`${prefix}_email`],
    emailVerified: row[`${prefix}_email_verified`],
    createdAt: row[`${prefix}_created_at`],
    updatedAt: row[`${prefix}_updated_at`],
  }
  if (Object.values(fields).every((value) => value === null)) return null
  if (Object.values(fields).some((value) => value === null || value === undefined)) {
    return invariant()
  }
  if (typeof fields.emailVerified !== 'boolean') return invariant()
  return Object.freeze({
    id: identity(fields.id),
    name: identity(fields.name),
    email: identity(fields.email),
    emailVerified: fields.emailVerified,
    createdAt: validDate(fields.createdAt),
    updatedAt: validDate(fields.updatedAt),
  })
}

function canonicalIdentities(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 2) return invariant()
  const values = value.map(identity)
  if (
    values.some(
      (candidate, index) =>
        index > 0 && compareIdentityBytes(candidate, values[index - 1] ?? '') <= 0,
    )
  ) {
    return invariant()
  }
  return Object.freeze(values)
}

function compareIdentityBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function credentialSnapshot(value: unknown): CredentialSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invariant()
  const row = value as Record<string, unknown>
  if (row.password !== null && typeof row.password !== 'string') return invariant()
  return Object.freeze({
    id: identity(row.id),
    accountId: identity(row.accountId),
    userId: identity(row.userId),
    password: row.password,
    createdAt: validDate(row.createdAt),
    updatedAt: validDate(row.updatedAt),
  })
}

function credentialSnapshots(
  value: unknown,
  actorUserId: string,
  targetUserId: string,
): readonly CredentialSnapshot[] {
  if (!Array.isArray(value) || value.length > 2) return invariant()
  const credentials = value.map(credentialSnapshot)
  for (const [index, credential] of credentials.entries()) {
    if (credential.userId !== actorUserId && credential.userId !== targetUserId) {
      return invariant()
    }
    const previous = credentials[index - 1]
    if (
      previous &&
      (compareIdentityBytes(previous.userId, credential.userId) > 0 ||
        (previous.userId === credential.userId &&
          compareIdentityBytes(previous.id, credential.id) >= 0))
    ) {
      return invariant()
    }
    if (
      credentials.some(
        (candidate, other) => other < index && candidate.id === credential.id,
      )
    ) {
      return invariant()
    }
  }
  const perUser = new Set(credentials.map((credential) => credential.userId))
  if (perUser.size !== credentials.length) return invariant()
  return Object.freeze(credentials)
}

function memberResetStateSnapshot(
  row: SnapshotRow,
  targetUserId: string,
): MemberResetStateSnapshot | null {
  const required = [
    row.member_reset_target_user_id,
    row.member_reset_last_issued_at,
    row.member_reset_failed_attempts,
    row.member_reset_created_at,
    row.member_reset_updated_at,
  ]
  const optional = [
    row.member_reset_active_verification_id,
    row.member_reset_retry_after,
    row.member_reset_last_attempt_at,
  ]
  if ([...required, ...optional].every((value) => value === null)) return null
  if (required.some((value) => value === null || value === undefined)) {
    return invariant()
  }
  const stateTargetUserId = identity(row.member_reset_target_user_id)
  if (
    stateTargetUserId !== targetUserId ||
    !Number.isInteger(row.member_reset_failed_attempts) ||
    (row.member_reset_failed_attempts as number) < 0
  ) {
    return invariant()
  }
  return Object.freeze({
    targetUserId: stateTargetUserId,
    activeVerificationId: optionalIdentity(row.member_reset_active_verification_id),
    lastIssuedAt: validDate(row.member_reset_last_issued_at),
    failedAttempts: row.member_reset_failed_attempts as number,
    retryAfter: optionalDate(row.member_reset_retry_after),
    lastAttemptAt: optionalDate(row.member_reset_last_attempt_at),
    createdAt: validDate(row.member_reset_created_at),
    updatedAt: validDate(row.member_reset_updated_at),
  })
}

function memberResetVerificationSnapshot(
  value: unknown,
): MemberResetVerificationSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invariant()
  const row = value as Record<string, unknown>
  return Object.freeze({
    id: identity(row.id),
    identifier: identity(row.identifier),
    value: identity(row.value),
    expiresAt: validDate(row.expiresAt),
    createdAt: validDate(row.createdAt),
    updatedAt: validDate(row.updatedAt),
  })
}

function memberResetVerificationSnapshots(
  value: unknown,
  targetUserId: string,
): readonly MemberResetVerificationSnapshot[] {
  if (!Array.isArray(value) || value.length > 1) return invariant()
  const verifications = value.map(memberResetVerificationSnapshot)
  const expectedIdentifier = `indigo:member-reset:${targetUserId}`
  if (
    verifications.some((verification) => verification.identifier !== expectedIdentifier)
  ) {
    return invariant()
  }
  return Object.freeze(verifications)
}

function assertCoherentMemberResetState(
  state: MemberResetStateSnapshot | null,
  verifications: readonly MemberResetVerificationSnapshot[],
): void {
  if (!state) {
    if (verifications.length !== 0) invariant()
    return
  }
  if (state.activeVerificationId === null) {
    if (verifications.length !== 0) invariant()
    return
  }
  if (verifications.length !== 1 || verifications[0]?.id !== state.activeVerificationId) {
    invariant()
  }
}

function normalizedEmail(value: string): string {
  const normalized = normalizeRecoveryEmail(value)
  if (!normalized || normalized.includes('\0') || normalized.length > 254) {
    throw new TypeError('A valid submitted email is required for local-user capture.')
  }
  return normalized
}

function captureIdentity(value: string, label: string): string {
  try {
    return identity(value)
  } catch {
    throw new TypeError(`${label} is not a valid credential-administration identity.`)
  }
}

function verifiedSessionToken(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 4_096 ||
    value.includes('\0')
  ) {
    throw new TypeError('A cryptographically verified session token is required.')
  }
  return value
}

function commandEntryDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Credential-administration command-entry clock is invalid.')
  }
  return new Date(value.getTime())
}

async function readSnapshot(
  query: IdentityCredentialAdministrationQuery,
  input: {
    readonly verifiedSessionToken: string
    readonly targetUserId: string
    readonly normalizedEmail: string | null
  },
): Promise<AdministrationSnapshot> {
  const result = await query.query<SnapshotRow>(
    credentialAdministrationSnapshotStatement,
    [input.verifiedSessionToken, input.targetUserId, input.normalizedEmail],
  )
  if (result.rows.length !== 1) return invariant()
  const row = result.rows[0]
  if (!row) return invariant()

  const epoch = identity(row.product_mutation_epoch)
  if (!lifecycleValuePattern.test(epoch)) return invariant()
  const ownerUserId = optionalIdentity(row.installation_owner_user_id)
  const bootstrapClosedAt = optionalDate(row.bootstrap_closed_at)
  if (!ownerUserId && !bootstrapClosedAt) return authorityUnavailable()
  if (!ownerUserId || !bootstrapClosedAt) return invariant()

  const actor = userSnapshot(row, 'actor')
  const target = userSnapshot(row, 'target')
  const sessionId = optionalIdentity(row.session_id)
  const sessionUserId = optionalIdentity(row.session_user_id)
  const sessionExpiresAt = optionalDate(row.session_expires_at)
  if (!actor && !sessionId && !sessionUserId && !sessionExpiresAt) {
    return authorityUnavailable()
  }
  if (
    !actor ||
    ownerUserId !== actor.id ||
    !sessionId ||
    sessionUserId !== actor.id ||
    !sessionExpiresAt
  ) {
    return invariant()
  }
  if (target && target.id !== input.targetUserId) return invariant()

  const memberResetState = memberResetStateSnapshot(row, input.targetUserId)
  const memberResetVerifications = memberResetVerificationSnapshots(
    row.member_reset_verification_rows,
    input.targetUserId,
  )
  assertCoherentMemberResetState(memberResetState, memberResetVerifications)

  return Object.freeze({
    epoch,
    ownerUserId,
    bootstrapClosedAt,
    session: Object.freeze({
      id: sessionId,
      actorUserId: sessionUserId,
      expiresAt: sessionExpiresAt,
    }),
    actor,
    target,
    submittedEmailUserIds: canonicalIdentities(row.submitted_email_user_ids),
    credentials: credentialSnapshots(row.credential_rows, actor.id, input.targetUserId),
    memberResetState,
    memberResetVerifications,
  })
}

function credentialsFor(
  snapshot: AdministrationSnapshot,
  userId: string,
): readonly CredentialSnapshot[] {
  return snapshot.credentials.filter((credential) => credential.userId === userId)
}

function credentialPresence(
  snapshot: AdministrationSnapshot,
  userId: string,
): CredentialPresence {
  return credentialsFor(snapshot, userId).length === 1 ? 'present' : 'missing'
}

function assertActiveOwner(snapshot: AdministrationSnapshot, now: Date): void {
  if (!Number.isFinite(now.getTime())) throw new TypeError('Capture clock is invalid.')
  if (snapshot.session.expiresAt.getTime() <= now.getTime()) invariant()
  const actorCredentials = credentialsFor(snapshot, snapshot.actor.id)
  if (actorCredentials.length !== 1 || !actorCredentials[0]?.password) invariant()
}

function localState(capture: LocalUserCreationMutationCapture) {
  const state = localUserCreationCaptures.get(capture)
  if (!state) throw staleCapture()
  return state
}

function resetState(capture: MemberResetIssuanceMutationCapture) {
  const state = memberResetIssuanceCaptures.get(capture)
  if (!state) throw staleCapture()
  return state
}

export async function captureLocalUserCreationMutation(
  query: IdentityCredentialAdministrationQuery,
  input: {
    readonly verifiedSessionToken: string
    readonly preallocatedTargetUserId: string
    readonly submittedEmail: string
    readonly commandEnteredAt: Date
  },
): Promise<LocalUserCreationMutationCapture> {
  const commandEnteredAt = commandEntryDate(input.commandEnteredAt)
  const normalized = normalizedEmail(input.submittedEmail)
  const binding = {
    verifiedSessionToken: verifiedSessionToken(input.verifiedSessionToken),
    targetUserId: captureIdentity(input.preallocatedTargetUserId, 'Target user id'),
    normalizedEmail: normalized,
  }
  const snapshot = await readSnapshot(query, binding)
  assertActiveOwner(snapshot, commandEnteredAt)
  if (snapshot.actor.id === binding.targetUserId) {
    throw new TypeError('A preallocated target must differ from the authenticated actor.')
  }
  if (snapshot.target || credentialsFor(snapshot, binding.targetUserId).length > 0) {
    return invariant()
  }
  if (snapshot.memberResetState || snapshot.memberResetVerifications.length > 0) {
    return invariant()
  }
  if (snapshot.submittedEmailUserIds.length > 1) return invariant()

  const capture = new ConcreteLocalUserCreationMutationCapture(captureConstructionToken)
  localUserCreationCaptures.set(
    capture,
    Object.freeze({
      purpose: 'local-user-create',
      verifiedSessionToken: binding.verifiedSessionToken,
      commandEnteredAt,
      normalizedEmail: normalized,
      preallocatedTargetUserId: binding.targetUserId,
      snapshot,
    }),
  )
  Object.freeze(capture)
  return capture
}

export async function captureMemberResetIssuanceMutation(
  query: IdentityCredentialAdministrationQuery,
  input: {
    readonly verifiedSessionToken: string
    readonly targetUserId: string
    readonly commandEnteredAt: Date
  },
): Promise<MemberResetIssuanceMutationCapture> {
  const commandEnteredAt = commandEntryDate(input.commandEnteredAt)
  const binding = {
    verifiedSessionToken: verifiedSessionToken(input.verifiedSessionToken),
    targetUserId: captureIdentity(input.targetUserId, 'Target user id'),
    normalizedEmail: null,
  }
  const snapshot = await readSnapshot(query, binding)
  assertActiveOwner(snapshot, commandEnteredAt)
  if (snapshot.submittedEmailUserIds.length !== 0) return invariant()
  if (credentialsFor(snapshot, binding.targetUserId).length > 1) return invariant()

  const capture = new ConcreteMemberResetIssuanceMutationCapture(captureConstructionToken)
  memberResetIssuanceCaptures.set(
    capture,
    Object.freeze({
      purpose: 'member-reset-issue',
      verifiedSessionToken: binding.verifiedSessionToken,
      commandEnteredAt,
      targetUserId: binding.targetUserId,
      snapshot,
    }),
  )
  Object.freeze(capture)
  return capture
}

export function localUserCreationMutationCaptureView(
  capture: LocalUserCreationMutationCapture,
): LocalUserCreationMutationCaptureView {
  const state = localState(capture)
  return Object.freeze({
    purpose: state.purpose,
    expectedEpoch: state.snapshot.epoch,
    actorUserId: state.snapshot.actor.id,
    sessionId: state.snapshot.session.id,
    sessionExpiresAt: new Date(state.snapshot.session.expiresAt.getTime()),
    expectedRole: 'owner',
    preallocatedTargetUserId: state.preallocatedTargetUserId,
    submittedEmailUserIds: Object.freeze([...state.snapshot.submittedEmailUserIds]),
    actorCredential: credentialPresence(state.snapshot, state.snapshot.actor.id),
  })
}

export function memberResetIssuanceMutationCaptureView(
  capture: MemberResetIssuanceMutationCapture,
): MemberResetIssuanceMutationCaptureView {
  const state = resetState(capture)
  const targetState = !state.snapshot.target
    ? 'missing'
    : state.snapshot.target.id === state.snapshot.ownerUserId
      ? 'owner'
      : 'member'
  return Object.freeze({
    purpose: state.purpose,
    expectedEpoch: state.snapshot.epoch,
    actorUserId: state.snapshot.actor.id,
    sessionId: state.snapshot.session.id,
    sessionExpiresAt: new Date(state.snapshot.session.expiresAt.getTime()),
    expectedRole: 'owner',
    targetUserId: state.targetUserId,
    targetState,
    actorCredential: credentialPresence(state.snapshot, state.snapshot.actor.id),
    targetCredential: credentialPresence(state.snapshot, state.targetUserId),
  })
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime()
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

function sameIdentities(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
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
        credential.userId === other.userId &&
        credential.password === other.password &&
        sameDate(credential.createdAt, other.createdAt) &&
        sameDate(credential.updatedAt, other.updatedAt)
      )
    })
  )
}

function sameOptionalDate(left: Date | null, right: Date | null): boolean {
  return left === null || right === null ? left === right : sameDate(left, right)
}

function sameMemberResetState(
  left: MemberResetStateSnapshot | null,
  right: MemberResetStateSnapshot | null,
): boolean {
  if (!left || !right) return left === right
  return (
    left.targetUserId === right.targetUserId &&
    left.activeVerificationId === right.activeVerificationId &&
    sameDate(left.lastIssuedAt, right.lastIssuedAt) &&
    left.failedAttempts === right.failedAttempts &&
    sameOptionalDate(left.retryAfter, right.retryAfter) &&
    sameOptionalDate(left.lastAttemptAt, right.lastAttemptAt) &&
    sameDate(left.createdAt, right.createdAt) &&
    sameDate(left.updatedAt, right.updatedAt)
  )
}

function sameMemberResetVerifications(
  left: readonly MemberResetVerificationSnapshot[],
  right: readonly MemberResetVerificationSnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every((verification, index) => {
      const other = right[index]
      return (
        !!other &&
        verification.id === other.id &&
        verification.identifier === other.identifier &&
        verification.value === other.value &&
        sameDate(verification.expiresAt, other.expiresAt) &&
        sameDate(verification.createdAt, other.createdAt) &&
        sameDate(verification.updatedAt, other.updatedAt)
      )
    })
  )
}

function compareSnapshots(
  expected: AdministrationSnapshot,
  current: AdministrationSnapshot,
): CredentialAdministrationMutationRecheck {
  if (current.epoch !== expected.epoch) {
    return Object.freeze({ status: 'stale', reason: 'installation-epoch-changed' })
  }
  if (
    current.ownerUserId !== expected.ownerUserId ||
    !sameDate(current.bootstrapClosedAt, expected.bootstrapClosedAt)
  ) {
    return Object.freeze({ status: 'stale', reason: 'installation-authority-changed' })
  }
  if (
    current.session.id !== expected.session.id ||
    current.session.actorUserId !== expected.session.actorUserId ||
    !sameDate(current.session.expiresAt, expected.session.expiresAt)
  ) {
    return Object.freeze({ status: 'stale', reason: 'session-changed' })
  }
  if (!sameUser(current.actor, expected.actor)) {
    return Object.freeze({ status: 'stale', reason: 'actor-changed' })
  }
  if (!sameUser(current.target, expected.target)) {
    return Object.freeze({ status: 'stale', reason: 'target-state-changed' })
  }
  if (!sameIdentities(current.submittedEmailUserIds, expected.submittedEmailUserIds)) {
    return Object.freeze({ status: 'stale', reason: 'submitted-email-set-changed' })
  }
  if (!sameCredentials(current.credentials, expected.credentials)) {
    return Object.freeze({ status: 'stale', reason: 'credential-set-changed' })
  }
  if (
    !sameMemberResetState(current.memberResetState, expected.memberResetState) ||
    !sameMemberResetVerifications(
      current.memberResetVerifications,
      expected.memberResetVerifications,
    )
  ) {
    return Object.freeze({ status: 'stale', reason: 'member-reset-state-changed' })
  }
  return Object.freeze({ status: 'current' })
}

/** Must be the first query after BEGIN for a local-user-create attempt. */
export async function recheckLocalUserCreationMutation(
  query: IdentityCredentialAdministrationQuery,
  capture: LocalUserCreationMutationCapture,
): Promise<CredentialAdministrationMutationRecheck> {
  const expected = localState(capture)
  let current: AdministrationSnapshot
  try {
    current = await readSnapshot(query, {
      verifiedSessionToken: expected.verifiedSessionToken,
      targetUserId: expected.preallocatedTargetUserId,
      normalizedEmail: expected.normalizedEmail,
    })
  } catch (error) {
    if (error instanceof CredentialAdministrationAuthorityUnavailableError) {
      return Object.freeze({ status: 'stale', reason: 'session-changed' })
    }
    throw error
  }
  const comparison = compareSnapshots(expected.snapshot, current)
  if (comparison.status === 'stale') return comparison
  assertActiveOwner(current, expected.commandEnteredAt)
  return comparison
}

/** Must be the first query after BEGIN for a member-reset-issue attempt. */
export async function recheckMemberResetIssuanceMutation(
  query: IdentityCredentialAdministrationQuery,
  capture: MemberResetIssuanceMutationCapture,
): Promise<CredentialAdministrationMutationRecheck> {
  const expected = resetState(capture)
  let current: AdministrationSnapshot
  try {
    current = await readSnapshot(query, {
      verifiedSessionToken: expected.verifiedSessionToken,
      targetUserId: expected.targetUserId,
      normalizedEmail: null,
    })
  } catch (error) {
    if (error instanceof CredentialAdministrationAuthorityUnavailableError) {
      return Object.freeze({ status: 'stale', reason: 'session-changed' })
    }
    throw error
  }
  const comparison = compareSnapshots(expected.snapshot, current)
  if (comparison.status === 'stale') return comparison
  assertActiveOwner(current, expected.commandEnteredAt)
  return comparison
}
