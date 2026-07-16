import type { QueryResult, QueryResultRow } from 'pg'
import { normalizeRecoveryEmail } from '../recovery/recovery-policy'

const lifecycleValuePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const maximumResolvedAccountCount = 1_000

const emailSignInCaptureStatement = `
  SELECT
    installation.product_mutation_epoch::text AS product_mutation_epoch,
    installation.owner_user_id AS installation_owner_user_id,
    CASE
      WHEN installation.owner_user_id IS NULL
        AND installation.bootstrap_closed_at IS NULL
        THEN 'bootstrap-open'
      WHEN installation.owner_user_id IS NOT NULL
        AND installation.bootstrap_closed_at IS NOT NULL
        THEN 'claimed'
      ELSE 'invalid'
    END AS installation_state,
    ARRAY(
      SELECT candidate.id
      FROM "user" AS candidate
      WHERE lower(candidate.email) = $1
      ORDER BY candidate.id COLLATE "C"
    )::text[] AS resolved_account_user_ids
  FROM installation_state AS installation
  WHERE installation.singleton = 1
`

const checkedSignOutCaptureStatement = `
  SELECT
    installation.product_mutation_epoch::text AS product_mutation_epoch,
    installation.owner_user_id AS installation_owner_user_id,
    CASE
      WHEN installation.owner_user_id IS NULL
        AND installation.bootstrap_closed_at IS NULL
        THEN 'bootstrap-open'
      WHEN installation.owner_user_id IS NOT NULL
        AND installation.bootstrap_closed_at IS NOT NULL
        THEN 'claimed'
      ELSE 'invalid'
    END AS installation_state,
    matched_session.id AS session_id,
    matched_session.user_id AS account_user_id,
    CASE
      WHEN matched_session.id IS NULL THEN NULL
      WHEN matched_session.expires_at > CURRENT_TIMESTAMP THEN 'active'
      ELSE 'expired'
    END AS session_status
  FROM installation_state AS installation
  LEFT JOIN "session" AS matched_session
    ON matched_session.token = $1
  WHERE installation.singleton = 1
`

const deleteCheckedSignOutSessionStatement = `
  DELETE FROM "session"
  WHERE token = $1
  RETURNING id AS session_id, user_id AS account_user_id
`

/**
 * The only database capability accepted by Identity's auth capture repository. It is
 * structurally compatible with both a reserved capture connection and the tracked UoW
 * transaction client, while withholding lifecycle and transaction methods.
 */
export type IdentityAuthMutationQuery = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

export type InstallationCaptureState = 'bootstrap-open' | 'claimed'
export type CheckedSignOutSessionStatus = 'active' | 'expired'

type InstallationSnapshot = Readonly<{
  epoch: string
  ownerUserId: string | null
  state: InstallationCaptureState
}>

type EmailSignInCaptureState = InstallationSnapshot &
  Readonly<{
    normalizedEmail: string
    resolvedAccountUserIds: readonly string[]
  }>

type CheckedSignOutSessionSnapshot = Readonly<{
  sessionId: string
  accountUserId: string
  status: CheckedSignOutSessionStatus
}>

type CheckedSignOutCaptureState = InstallationSnapshot &
  Readonly<{
    verifiedSessionToken: string
    session: CheckedSignOutSessionSnapshot | null
  }>

const emailSignInCaptures = new WeakMap<
  EmailSignInMutationCapture,
  EmailSignInCaptureState
>()
const checkedSignOutCaptures = new WeakMap<
  CheckedSignOutMutationCapture,
  CheckedSignOutCaptureState
>()

/** Nominal, non-serializable evidence returned by one coherent sign-in capture read. */
export abstract class EmailSignInMutationCapture {
  protected declare readonly emailSignInMutationCaptureNominal: never
}

/** Nominal, non-serializable evidence returned by one coherent checked-sign-out capture read. */
export abstract class CheckedSignOutMutationCapture {
  protected declare readonly checkedSignOutMutationCaptureNominal: never
}

class ConcreteEmailSignInMutationCapture extends EmailSignInMutationCapture {}
class ConcreteCheckedSignOutMutationCapture extends CheckedSignOutMutationCapture {}

export type EmailSignInMutationCaptureView = Readonly<{
  expectedEpoch: string
  installationState: InstallationCaptureState
  resolvedAccountUserIds: readonly string[]
}>

export type CheckedSignOutMutationCaptureView = Readonly<{
  expectedEpoch: string
  installationState: InstallationCaptureState
  session: Readonly<{
    sessionId: string
    accountUserId: string
    status: CheckedSignOutSessionStatus
  }> | null
}>

export type EmailSignInMutationRecheck =
  | Readonly<{ status: 'current' }>
  | Readonly<{
      status: 'stale'
      reason:
        | 'installation-epoch-changed'
        | 'installation-state-changed'
        | 'resolved-account-set-changed'
    }>

export type CheckedSignOutMutationRecheck =
  | Readonly<{
      status: 'current'
      sessionStatus: CheckedSignOutSessionStatus | null
    }>
  | Readonly<{
      status: 'stale'
      reason:
        | 'installation-epoch-changed'
        | 'installation-state-changed'
        | 'session-identity-changed'
    }>

export class IdentityAuthMutationCaptureInvariantError extends Error {
  constructor() {
    super('Identity authentication mutation capture returned an invalid database shape.')
    this.name = 'IdentityAuthMutationCaptureInvariantError'
  }
}

type InstallationRow = QueryResultRow & {
  readonly installation_owner_user_id?: unknown
  readonly product_mutation_epoch?: unknown
  readonly installation_state?: unknown
}

type EmailSignInCaptureRow = InstallationRow & {
  readonly resolved_account_user_ids?: unknown
}

type CheckedSignOutCaptureRow = InstallationRow & {
  readonly session_id?: unknown
  readonly account_user_id?: unknown
  readonly session_status?: unknown
}

type DeletedCheckedSignOutSessionRow = QueryResultRow & {
  readonly session_id?: unknown
  readonly account_user_id?: unknown
}

function invalidCaptureShape(): never {
  throw new IdentityAuthMutationCaptureInvariantError()
}

function installationSnapshot(row: InstallationRow | undefined): InstallationSnapshot {
  if (
    !row ||
    typeof row.product_mutation_epoch !== 'string' ||
    !lifecycleValuePattern.test(row.product_mutation_epoch) ||
    (row.installation_state !== 'bootstrap-open' && row.installation_state !== 'claimed')
  ) {
    return invalidCaptureShape()
  }
  const ownerUserId =
    row.installation_owner_user_id === null
      ? null
      : canonicalIdentity(row.installation_owner_user_id)
  if (
    (row.installation_state === 'bootstrap-open' && ownerUserId !== null) ||
    (row.installation_state === 'claimed' && ownerUserId === null)
  ) {
    return invalidCaptureShape()
  }
  return Object.freeze({
    epoch: row.product_mutation_epoch,
    ownerUserId,
    state: row.installation_state,
  })
}

function canonicalIdentity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 300 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 31 || code === 127
    })
  ) {
    return invalidCaptureShape()
  }
  return value
}

function canonicalAccountUserIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumResolvedAccountCount) {
    return invalidCaptureShape()
  }
  const userIds = value.map(canonicalIdentity).sort()
  if (userIds.some((userId, index) => index > 0 && userId === userIds[index - 1])) {
    return invalidCaptureShape()
  }
  return Object.freeze(userIds)
}

function normalizedEmail(value: string): string {
  const normalized = normalizeRecoveryEmail(value)
  return normalized.includes('\0') ? 'invalid-email' : normalized
}

function verifiedSessionToken(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.includes('\0')) {
    throw new TypeError(
      'A verified session token is required for checked sign-out capture.',
    )
  }
  return value
}

function emailSignInState(capture: EmailSignInMutationCapture): EmailSignInCaptureState {
  const state = emailSignInCaptures.get(capture)
  if (!state) {
    throw new TypeError('Email sign-in capture was not issued by Identity.')
  }
  return state
}

function checkedSignOutState(
  capture: CheckedSignOutMutationCapture,
): CheckedSignOutCaptureState {
  const state = checkedSignOutCaptures.get(capture)
  if (!state) {
    throw new TypeError('Checked sign-out capture was not issued by Identity.')
  }
  return state
}

function checkedSignOutSession(
  row: CheckedSignOutCaptureRow,
): CheckedSignOutSessionSnapshot | null {
  if (
    row.session_id === null &&
    row.account_user_id === null &&
    row.session_status === null
  ) {
    return null
  }
  if (row.session_status !== 'active' && row.session_status !== 'expired') {
    return invalidCaptureShape()
  }
  return Object.freeze({
    sessionId: canonicalIdentity(row.session_id),
    accountUserId: canonicalIdentity(row.account_user_id),
    status: row.session_status,
  })
}

async function readEmailSignInSnapshot(
  query: IdentityAuthMutationQuery,
  email: string,
): Promise<EmailSignInCaptureState> {
  const result = await query.query<EmailSignInCaptureRow>(emailSignInCaptureStatement, [
    email,
  ])
  if (result.rows.length !== 1) return invalidCaptureShape()
  const row = result.rows[0]
  const installation = installationSnapshot(row)
  return Object.freeze({
    ...installation,
    normalizedEmail: email,
    resolvedAccountUserIds: canonicalAccountUserIds(row.resolved_account_user_ids),
  })
}

async function readCheckedSignOutSnapshot(
  query: IdentityAuthMutationQuery,
  token: string,
): Promise<CheckedSignOutCaptureState> {
  const result = await query.query<CheckedSignOutCaptureRow>(
    checkedSignOutCaptureStatement,
    [token],
  )
  if (result.rows.length !== 1) return invalidCaptureShape()
  const row = result.rows[0]
  const installation = installationSnapshot(row)
  return Object.freeze({
    ...installation,
    verifiedSessionToken: token,
    session: checkedSignOutSession(row),
  })
}

/**
 * Captures the installation generation/open state and exact normalized-email account set in
 * one statement snapshot. The normalized email is retained only in private capture state.
 */
export async function captureEmailSignInMutation(
  query: IdentityAuthMutationQuery,
  submittedEmail: string,
): Promise<EmailSignInMutationCapture> {
  const state = await readEmailSignInSnapshot(query, normalizedEmail(submittedEmail))
  const capture = new ConcreteEmailSignInMutationCapture()
  emailSignInCaptures.set(capture, state)
  Object.freeze(capture)
  return capture
}

/**
 * Returns only the non-credential authority bindings needed by the outer composition root.
 */
export function emailSignInMutationCaptureView(
  capture: EmailSignInMutationCapture,
): EmailSignInMutationCaptureView {
  const state = emailSignInState(capture)
  return Object.freeze({
    expectedEpoch: state.epoch,
    installationState: state.state,
    resolvedAccountUserIds: state.resolvedAccountUserIds,
  })
}

/**
 * Must be the first Identity query after BEGIN. It compares the post-lock snapshot with the
 * exact pre-queue epoch, installation state, and normalized-email account set.
 */
export async function recheckEmailSignInMutation(
  query: IdentityAuthMutationQuery,
  capture: EmailSignInMutationCapture,
): Promise<EmailSignInMutationRecheck> {
  const expected = emailSignInState(capture)
  const current = await readEmailSignInSnapshot(query, expected.normalizedEmail)
  if (current.epoch !== expected.epoch) {
    return Object.freeze({ status: 'stale', reason: 'installation-epoch-changed' })
  }
  if (current.state !== expected.state || current.ownerUserId !== expected.ownerUserId) {
    return Object.freeze({ status: 'stale', reason: 'installation-state-changed' })
  }
  if (
    current.resolvedAccountUserIds.length !== expected.resolvedAccountUserIds.length ||
    current.resolvedAccountUserIds.some(
      (userId, index) => userId !== expected.resolvedAccountUserIds[index],
    )
  ) {
    return Object.freeze({ status: 'stale', reason: 'resolved-account-set-changed' })
  }
  return Object.freeze({ status: 'current' })
}

/**
 * Captures the installation generation/open state and token-resolved session/account identity
 * in one statement. Cookie signature verification belongs to Better Auth before this call; the
 * verified token remains private capture state and is never included in a public view.
 */
export async function captureCheckedSignOutMutation(
  query: IdentityAuthMutationQuery,
  verifiedToken: string,
): Promise<CheckedSignOutMutationCapture> {
  const token = verifiedSessionToken(verifiedToken)
  const state = await readCheckedSignOutSnapshot(query, token)
  const capture = new ConcreteCheckedSignOutMutationCapture()
  checkedSignOutCaptures.set(capture, state)
  Object.freeze(capture)
  return capture
}

/** Returns session/account identity without exposing the verified session token. */
export function checkedSignOutMutationCaptureView(
  capture: CheckedSignOutMutationCapture,
): CheckedSignOutMutationCaptureView {
  const state = checkedSignOutState(capture)
  return Object.freeze({
    expectedEpoch: state.epoch,
    installationState: state.state,
    session: state.session,
  })
}

/**
 * Must be the first Identity query after BEGIN. Natural active-to-expired progression and an
 * already-absent row remain current for sign-out: a competing checked sign-out may have won the
 * same captured account lock. A newly present or changed non-null session/account identity is
 * stale and must prevent provider mutation.
 */
export async function recheckCheckedSignOutMutation(
  query: IdentityAuthMutationQuery,
  capture: CheckedSignOutMutationCapture,
): Promise<CheckedSignOutMutationRecheck> {
  const expected = checkedSignOutState(capture)
  const current = await readCheckedSignOutSnapshot(query, expected.verifiedSessionToken)
  if (current.epoch !== expected.epoch) {
    return Object.freeze({ status: 'stale', reason: 'installation-epoch-changed' })
  }
  if (current.state !== expected.state || current.ownerUserId !== expected.ownerUserId) {
    return Object.freeze({ status: 'stale', reason: 'installation-state-changed' })
  }
  if (
    current.session !== null &&
    (current.session.sessionId !== expected.session?.sessionId ||
      current.session.accountUserId !== expected.session?.accountUserId)
  ) {
    return Object.freeze({ status: 'stale', reason: 'session-identity-changed' })
  }
  return Object.freeze({
    status: 'current',
    sessionStatus: current.session?.status ?? null,
  })
}

/**
 * Performs the checked deletion with row evidence instead of relying on Better Auth's
 * void-returning generic delete adapter. The provider endpoint still re-verifies the signed
 * cookie and stages its exact expiry headers afterward on the same scoped transaction.
 */
export async function deleteCapturedCheckedSignOutSession(
  query: IdentityAuthMutationQuery,
  capture: CheckedSignOutMutationCapture,
): Promise<Readonly<{ status: 'deleted' | 'already-absent' }>> {
  const expected = checkedSignOutState(capture)
  if (!expected.session) {
    throw new TypeError(
      'An account-bound session capture is required for checked deletion.',
    )
  }
  const result = await query.query<DeletedCheckedSignOutSessionRow>(
    deleteCheckedSignOutSessionStatement,
    [expected.verifiedSessionToken],
  )
  if (result.rows.length === 0) {
    return Object.freeze({ status: 'already-absent' })
  }
  if (result.rows.length !== 1) return invalidCaptureShape()
  const deleted = result.rows[0]
  if (
    canonicalIdentity(deleted?.session_id) !== expected.session.sessionId ||
    canonicalIdentity(deleted?.account_user_id) !== expected.session.accountUserId
  ) {
    return invalidCaptureShape()
  }
  return Object.freeze({ status: 'deleted' })
}
