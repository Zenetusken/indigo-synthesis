import type { QueryResult, QueryResultRow } from 'pg'
import type { IdentityRole } from '../application/actor'

const lifecycleValuePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const maximumIdentityBytes = 512
const maximumPrivateValueBytes = 16 * 1024

const subjectExportAuthorityStatement = `
  WITH installation AS MATERIALIZED (
    SELECT
      product_mutation_epoch::text AS product_mutation_epoch,
      owner_user_id AS installation_owner_user_id,
      bootstrap_closed_at
    FROM installation_state
    WHERE singleton = 1
  ),
  matched_sessions AS MATERIALIZED (
    SELECT
      candidate.id,
      candidate.user_id,
      candidate.expires_at,
      candidate.created_at,
      candidate.updated_at,
      candidate.expires_at > CURRENT_TIMESTAMP AS active
    FROM "session" AS candidate
    WHERE candidate.token = $1
    ORDER BY candidate.id COLLATE "C"
    LIMIT 2
  ),
  actors AS MATERIALIZED (
    SELECT
      candidate.id,
      candidate.name,
      candidate.email,
      candidate.email_verified,
      candidate.created_at,
      candidate.updated_at
    FROM "user" AS candidate
    WHERE candidate.id IN (SELECT user_id FROM matched_sessions)
    ORDER BY candidate.id COLLATE "C"
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
            'userId', candidate.user_id,
            'expiresAt', candidate.expires_at,
            'createdAt', candidate.created_at,
            'updatedAt', candidate.updated_at,
            'active', candidate.active
          )
          ORDER BY candidate.id COLLATE "C"
        )
        FROM matched_sessions AS candidate
      ),
      '[]'::jsonb
    ) AS session_rows,
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
        FROM actors AS candidate
      ),
      '[]'::jsonb
    ) AS actor_rows
  FROM installation
`

export type IdentitySubjectExportQuery = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

type SubjectExportCommandState = Readonly<{ verifiedSessionToken: string }>
const commandStates = new WeakMap<SubjectExportCommand, SubjectExportCommandState>()

/** Nominal, non-serializable export command issued only for a verified session cookie. */
export abstract class SubjectExportCommand {
  protected declare readonly subjectExportCommandNominal: never
}

class ConcreteSubjectExportCommand extends SubjectExportCommand {}

export class IdentitySubjectExportCommandError extends Error {
  constructor(message = 'Subject export command was not issued by Identity.') {
    super(message)
    this.name = 'IdentitySubjectExportCommandError'
  }
}

function privateValue(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumPrivateValueBytes
  ) {
    throw new IdentitySubjectExportCommandError(
      'Verified session token is not valid export authority.',
    )
  }
  return value
}

/** Identity-internal issuer used only after the server cookie has been verified. */
export function issueSubjectExportCommand(input: {
  readonly verifiedSessionToken: string
}): SubjectExportCommand {
  const command = new ConcreteSubjectExportCommand()
  commandStates.set(
    command,
    Object.freeze({ verifiedSessionToken: privateValue(input.verifiedSessionToken) }),
  )
  Object.freeze(command)
  return command
}

function commandState(command: SubjectExportCommand): SubjectExportCommandState {
  const state = commandStates.get(command)
  if (!state) throw new IdentitySubjectExportCommandError()
  return state
}

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
  createdAt: Date
  updatedAt: Date
  active: boolean
}>

type SubjectExportSnapshot = Readonly<{
  epoch: string
  ownerUserId: string
  bootstrapClosedAt: Date
  session: SessionSnapshot
  actor: UserSnapshot
  role: IdentityRole
}>

type SubjectExportCaptureState = Readonly<{
  command: SubjectExportCommandState
  snapshot: SubjectExportSnapshot
}>

const captureStates = new WeakMap<
  SubjectExportAuthorityCapture,
  SubjectExportCaptureState
>()

/** Nominal evidence for one coherent, verified-session export authority snapshot. */
export abstract class SubjectExportAuthorityCapture {
  protected declare readonly subjectExportAuthorityCaptureNominal: never
}

class ConcreteSubjectExportAuthorityCapture extends SubjectExportAuthorityCapture {}

export type SubjectExportAuthorityView = Readonly<{
  expectedEpoch: string
  sessionId: string
  sessionExpiresAt: Date
  actorUserId: string
  expectedRole: IdentityRole
  installationOwnerUserId: string
  installationState: 'claimed'
}>

export type SubjectExportAuthorityRecheck =
  | Readonly<{ status: 'current' }>
  | Readonly<{
      status: 'stale'
      reason:
        | 'installation-epoch-changed'
        | 'installation-authority-changed'
        | 'session-changed'
        | 'actor-changed'
    }>

export class IdentitySubjectExportInvariantError extends Error {
  constructor() {
    super('Identity subject export authority returned an invalid database shape.')
    this.name = 'IdentitySubjectExportInvariantError'
  }
}

export class IdentitySubjectExportAuthorityUnavailableError extends Error {
  constructor() {
    super('The authenticated subject export authority is not available.')
    this.name = 'IdentitySubjectExportAuthorityUnavailableError'
  }
}

type SnapshotRow = QueryResultRow & {
  readonly product_mutation_epoch?: unknown
  readonly installation_owner_user_id?: unknown
  readonly bootstrap_closed_at?: unknown
  readonly session_rows?: unknown
  readonly actor_rows?: unknown
}

type SnapshotReadPhase = 'capture' | 'recheck'

class IdentitySubjectExportSnapshotChangedError extends Error {
  constructor(
    readonly reason: Exclude<
      SubjectExportAuthorityRecheck,
      { status: 'current' }
    >['reason'],
  ) {
    super('Identity subject export authority changed after capture.')
    this.name = 'IdentitySubjectExportSnapshotChangedError'
  }
}

function invalidShape(): never {
  throw new IdentitySubjectExportInvariantError()
}

function unavailable(): never {
  throw new IdentitySubjectExportAuthorityUnavailableError()
}

function identity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumIdentityBytes
  ) {
    return invalidShape()
  }
  return value
}

function date(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(identity(value))
  if (!Number.isFinite(parsed.getTime())) return invalidShape()
  return new Date(parsed.getTime())
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidShape()
  }
  return value as Record<string, unknown>
}

function exactRow(
  value: unknown,
  kind: 'session' | 'actor',
  phase: SnapshotReadPhase,
): Record<string, unknown> {
  if (!Array.isArray(value)) return invalidShape()
  if (value.length === 0) {
    if (phase === 'capture') return unavailable()
    throw new IdentitySubjectExportSnapshotChangedError(
      kind === 'session' ? 'session-changed' : 'actor-changed',
    )
  }
  if (value.length !== 1) return invalidShape()
  return record(value[0])
}

function user(value: unknown, phase: SnapshotReadPhase): UserSnapshot {
  const row = exactRow(value, 'actor', phase)
  if (typeof row.emailVerified !== 'boolean') return invalidShape()
  return Object.freeze({
    id: identity(row.id),
    name: identity(row.name),
    email: identity(row.email),
    emailVerified: row.emailVerified,
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
  })
}

function session(value: unknown, phase: SnapshotReadPhase): SessionSnapshot {
  const row = exactRow(value, 'session', phase)
  if (typeof row.active !== 'boolean') return invalidShape()
  const snapshot = Object.freeze({
    id: identity(row.id),
    actorUserId: identity(row.userId),
    expiresAt: date(row.expiresAt),
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
    active: row.active,
  })
  if (!snapshot.active) {
    if (phase === 'capture') return unavailable()
    throw new IdentitySubjectExportSnapshotChangedError('session-changed')
  }
  return snapshot
}

async function readSnapshot(
  query: IdentitySubjectExportQuery,
  verifiedSessionToken: string,
  phase: SnapshotReadPhase,
): Promise<SubjectExportSnapshot> {
  const result = await query.query<SnapshotRow>(subjectExportAuthorityStatement, [
    verifiedSessionToken,
  ])
  if (result.rows.length === 0) {
    if (phase === 'capture') return unavailable()
    throw new IdentitySubjectExportSnapshotChangedError('installation-authority-changed')
  }
  if (result.rows.length !== 1) return invalidShape()
  const row = result.rows[0]
  if (!row) return invalidShape()
  const epoch = identity(row.product_mutation_epoch)
  if (!lifecycleValuePattern.test(epoch)) return invalidShape()
  const ownerUserId = identity(row.installation_owner_user_id)
  const bootstrapClosedAt = date(row.bootstrap_closed_at)
  const capturedSession = session(row.session_rows, phase)
  const actor = user(row.actor_rows, phase)
  if (capturedSession.actorUserId !== actor.id) return invalidShape()
  return Object.freeze({
    epoch,
    ownerUserId,
    bootstrapClosedAt,
    session: capturedSession,
    actor,
    role: actor.id === ownerUserId ? 'owner' : 'member',
  })
}

function captureState(capture: SubjectExportAuthorityCapture): SubjectExportCaptureState {
  const state = captureStates.get(capture)
  if (!state)
    throw new TypeError('Subject export authority was not captured by Identity.')
  return state
}

export async function captureSubjectExportAuthority(
  query: IdentitySubjectExportQuery,
  command: SubjectExportCommand,
): Promise<SubjectExportAuthorityCapture> {
  const commandSnapshot = commandState(command)
  const snapshot = await readSnapshot(
    query,
    commandSnapshot.verifiedSessionToken,
    'capture',
  )
  const capture = new ConcreteSubjectExportAuthorityCapture()
  captureStates.set(capture, Object.freeze({ command: commandSnapshot, snapshot }))
  Object.freeze(capture)
  return capture
}

export function subjectExportAuthorityView(
  capture: SubjectExportAuthorityCapture,
): SubjectExportAuthorityView {
  const { snapshot } = captureState(capture)
  return Object.freeze({
    expectedEpoch: snapshot.epoch,
    sessionId: snapshot.session.id,
    sessionExpiresAt: new Date(snapshot.session.expiresAt.getTime()),
    actorUserId: snapshot.actor.id,
    expectedRole: snapshot.role,
    installationOwnerUserId: snapshot.ownerUserId,
    installationState: 'claimed',
  })
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime()
}

function sameUser(left: UserSnapshot, right: UserSnapshot): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.email === right.email &&
    left.emailVerified === right.emailVerified &&
    sameDate(left.createdAt, right.createdAt) &&
    sameDate(left.updatedAt, right.updatedAt)
  )
}

function compareSnapshots(
  expected: SubjectExportSnapshot,
  current: SubjectExportSnapshot,
): SubjectExportAuthorityRecheck {
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
    !sameDate(current.session.expiresAt, expected.session.expiresAt) ||
    !sameDate(current.session.createdAt, expected.session.createdAt) ||
    !sameDate(current.session.updatedAt, expected.session.updatedAt) ||
    !current.session.active
  ) {
    return Object.freeze({ status: 'stale', reason: 'session-changed' })
  }
  if (!sameUser(current.actor, expected.actor) || current.role !== expected.role) {
    return Object.freeze({ status: 'stale', reason: 'actor-changed' })
  }
  return Object.freeze({ status: 'current' })
}

/** Must be the first Identity query after BEGIN for a subject export. */
export async function recheckSubjectExportAuthority(
  query: IdentitySubjectExportQuery,
  capture: SubjectExportAuthorityCapture,
): Promise<SubjectExportAuthorityRecheck> {
  const state = captureState(capture)
  try {
    const current = await readSnapshot(
      query,
      state.command.verifiedSessionToken,
      'recheck',
    )
    return compareSnapshots(state.snapshot, current)
  } catch (error) {
    if (error instanceof IdentitySubjectExportSnapshotChangedError) {
      return Object.freeze({ status: 'stale', reason: error.reason })
    }
    if (error instanceof IdentitySubjectExportAuthorityUnavailableError) {
      return Object.freeze({ status: 'stale', reason: 'session-changed' })
    }
    throw error
  }
}
