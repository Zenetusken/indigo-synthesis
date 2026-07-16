import type { QueryResult, QueryResultRow } from 'pg'
import type { IdentityRole } from '../application/actor'
import type { WebCredentialContext } from '../recovery/credential-context'

const lifecycleValuePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const maximumIdentityBytes = 512
const maximumPrivateValueBytes = 16 * 1024

const destructiveMutationSnapshotStatement = `
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
  ),
  installed_owners AS MATERIALIZED (
    SELECT
      candidate.id,
      candidate.name,
      candidate.email,
      candidate.email_verified,
      candidate.created_at,
      candidate.updated_at
    FROM "user" AS candidate
    JOIN installation ON installation.installation_owner_user_id = candidate.id
    ORDER BY candidate.id COLLATE "C"
    LIMIT 2
  ),
  actor_credentials AS MATERIALIZED (
    SELECT
      credential.id,
      credential.account_id,
      credential.user_id,
      credential.password,
      credential.created_at,
      credential.updated_at
    FROM account AS credential
    WHERE credential.provider_id = 'credential'
      AND credential.user_id IN (SELECT id FROM actors)
    ORDER BY credential.id COLLATE "C"
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
    ) AS actor_rows,
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
        FROM installed_owners AS candidate
      ),
      '[]'::jsonb
    ) AS owner_rows,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', credential.id,
            'accountId', credential.account_id,
            'userId', credential.user_id,
            'password', credential.password,
            'createdAt', credential.created_at,
            'updatedAt', credential.updated_at
          )
          ORDER BY credential.id COLLATE "C"
        )
        FROM actor_credentials AS credential
      ),
      '[]'::jsonb
    ) AS credential_rows
  FROM installation
`

export type IdentityDestructiveMutationQuery = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

export type DestructiveMutationPurpose = 'trainee-data-deletion' | 'instance-reset'

type DestructiveMutationCommandState = Readonly<{
  purpose: DestructiveMutationPurpose
  actionBinding: string
  planId: string
  planDigest: string
  currentPassword: string
  typedConfirmation: string
  acknowledged: boolean
  commandEnteredAt: Date
  requestContext: WebCredentialContext
  verifiedSessionToken: string
}>

const traineeDataDeletionCommands = new WeakMap<
  TraineeDataDeletionMutationCommand,
  DestructiveMutationCommandState
>()
const instanceResetCommands = new WeakMap<
  InstanceResetMutationCommand,
  DestructiveMutationCommandState
>()

/** Nominal, non-serializable trainee-data deletion command from one verified request. */
export abstract class TraineeDataDeletionMutationCommand {
  protected declare readonly traineeDataDeletionMutationCommandNominal: never
}

/** Nominal, non-serializable instance-reset command from one verified request. */
export abstract class InstanceResetMutationCommand {
  protected declare readonly instanceResetMutationCommandNominal: never
}

class ConcreteTraineeDataDeletionMutationCommand extends TraineeDataDeletionMutationCommand {}
class ConcreteInstanceResetMutationCommand extends InstanceResetMutationCommand {}

export type DestructiveMutationCommandView = Omit<
  DestructiveMutationCommandState,
  'verifiedSessionToken'
>

type VerifiedDestructiveMutationCommandInput = Omit<
  DestructiveMutationCommandState,
  'purpose'
>

function privateValue(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumPrivateValueBytes
  ) {
    throw new TypeError(`${label} is not a valid destructive-command value.`)
  }
  return value
}

function commandDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Destructive command-entry clock is invalid.')
  }
  return new Date(value.getTime())
}

function commandState(
  purpose: DestructiveMutationPurpose,
  input: VerifiedDestructiveMutationCommandInput,
): DestructiveMutationCommandState {
  const requestContext = input.requestContext
  if (
    requestContext?.channel !== 'web' ||
    typeof requestContext.clientAddress !== 'string' ||
    requestContext.clientAddress.length === 0
  ) {
    throw new TypeError('A trusted destructive-command request context is required.')
  }
  return Object.freeze({
    purpose,
    actionBinding: input.actionBinding,
    planId: input.planId,
    planDigest: input.planDigest,
    currentPassword: input.currentPassword,
    typedConfirmation: input.typedConfirmation,
    acknowledged: input.acknowledged === true,
    commandEnteredAt: commandDate(input.commandEnteredAt),
    requestContext: Object.freeze({ ...requestContext }),
    verifiedSessionToken: privateValue(
      input.verifiedSessionToken,
      'Verified session token',
    ),
  })
}

/** Identity-internal issuer used only after the server cookie has been verified. */
export function issueTraineeDataDeletionMutationCommand(
  input: VerifiedDestructiveMutationCommandInput,
): TraineeDataDeletionMutationCommand {
  const command = new ConcreteTraineeDataDeletionMutationCommand()
  traineeDataDeletionCommands.set(command, commandState('trainee-data-deletion', input))
  Object.freeze(command)
  return command
}

/** Identity-internal issuer used only after the server cookie has been verified. */
export function issueInstanceResetMutationCommand(
  input: VerifiedDestructiveMutationCommandInput,
): InstanceResetMutationCommand {
  const command = new ConcreteInstanceResetMutationCommand()
  instanceResetCommands.set(command, commandState('instance-reset', input))
  Object.freeze(command)
  return command
}

function stateForCommand(
  command: TraineeDataDeletionMutationCommand | InstanceResetMutationCommand,
): DestructiveMutationCommandState {
  const state =
    traineeDataDeletionCommands.get(command as TraineeDataDeletionMutationCommand) ??
    instanceResetCommands.get(command as InstanceResetMutationCommand)
  if (!state) throw new TypeError('Destructive command was not issued by Identity.')
  return state
}

function commandView(
  command: TraineeDataDeletionMutationCommand | InstanceResetMutationCommand,
): DestructiveMutationCommandView {
  const { verifiedSessionToken: _verifiedSessionToken, ...state } =
    stateForCommand(command)
  return Object.freeze({
    ...state,
    commandEnteredAt: new Date(state.commandEnteredAt.getTime()),
    requestContext: Object.freeze({ ...state.requestContext }),
  })
}

function commandPurposeMismatch(): never {
  throw new TypeError(
    'Destructive command purpose does not match the requested operation.',
  )
}

export function traineeDataDeletionMutationCommandView(
  command: TraineeDataDeletionMutationCommand,
): DestructiveMutationCommandView & Readonly<{ purpose: 'trainee-data-deletion' }> {
  const view = commandView(command)
  if (view.purpose !== 'trainee-data-deletion') return commandPurposeMismatch()
  return view as DestructiveMutationCommandView &
    Readonly<{ purpose: 'trainee-data-deletion' }>
}

export function instanceResetMutationCommandView(
  command: InstanceResetMutationCommand,
): DestructiveMutationCommandView & Readonly<{ purpose: 'instance-reset' }> {
  const view = commandView(command)
  if (view.purpose !== 'instance-reset') return commandPurposeMismatch()
  return view as DestructiveMutationCommandView & Readonly<{ purpose: 'instance-reset' }>
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

type CredentialSnapshot = Readonly<{
  id: string
  accountId: string
  actorUserId: string
  password: string
  createdAt: Date
  updatedAt: Date
}>

type DestructiveMutationSnapshot = Readonly<{
  epoch: string
  ownerUserId: string
  bootstrapClosedAt: Date
  session: SessionSnapshot
  actor: UserSnapshot
  owner: UserSnapshot
  role: IdentityRole
  credential: CredentialSnapshot
}>

type DestructiveMutationCaptureState = Readonly<{
  purpose: DestructiveMutationPurpose
  command: DestructiveMutationCommandState
  snapshot: DestructiveMutationSnapshot
}>

const traineeDataDeletionCaptures = new WeakMap<
  TraineeDataDeletionMutationCapture,
  DestructiveMutationCaptureState
>()
const instanceResetCaptures = new WeakMap<
  InstanceResetMutationCapture,
  DestructiveMutationCaptureState
>()

/** Nominal evidence for one coherent trainee-data deletion Identity snapshot. */
export abstract class TraineeDataDeletionMutationCapture {
  protected declare readonly traineeDataDeletionMutationCaptureNominal: never
}

/** Nominal evidence for one coherent instance-reset Identity snapshot. */
export abstract class InstanceResetMutationCapture {
  protected declare readonly instanceResetMutationCaptureNominal: never
}

class ConcreteTraineeDataDeletionMutationCapture extends TraineeDataDeletionMutationCapture {}
class ConcreteInstanceResetMutationCapture extends InstanceResetMutationCapture {}

export type DestructiveMutationCaptureView = Readonly<{
  purpose: DestructiveMutationPurpose
  expectedEpoch: string
  sessionId: string
  sessionExpiresAt: Date
  actorUserId: string
  actorEmail: string
  actorName: string
  expectedRole: IdentityRole
  installationOwnerUserId: string
  installationState: 'claimed'
  actorCredential: 'present'
  planId: string
  planDigest: string
}>

export type DestructiveMutationReauthenticationScope<
  Purpose extends DestructiveMutationPurpose,
> = Readonly<{
  purpose: Purpose
  actorUserId: string
  commandEnteredAt: Date
}>

export type DestructiveMutationRecheck =
  | Readonly<{ status: 'current' }>
  | Readonly<{
      status: 'stale'
      reason:
        | 'installation-epoch-changed'
        | 'installation-authority-changed'
        | 'session-changed'
        | 'actor-changed'
        | 'credential-set-changed'
    }>

export class IdentityDestructiveMutationCaptureInvariantError extends Error {
  constructor() {
    super('Identity destructive mutation capture returned an invalid database shape.')
    this.name = 'IdentityDestructiveMutationCaptureInvariantError'
  }
}

export class IdentityDestructiveMutationAuthorityUnavailableError extends Error {
  constructor() {
    super('The authenticated destructive mutation authority is not available.')
    this.name = 'IdentityDestructiveMutationAuthorityUnavailableError'
  }
}

export class IdentityDestructiveMutationCaptureStaleError extends Error {
  constructor() {
    super('The authenticated destructive mutation session is no longer active.')
    this.name = 'IdentityDestructiveMutationCaptureStaleError'
  }
}

type SnapshotRow = QueryResultRow & {
  readonly product_mutation_epoch?: unknown
  readonly installation_owner_user_id?: unknown
  readonly bootstrap_closed_at?: unknown
  readonly session_rows?: unknown
  readonly actor_rows?: unknown
  readonly owner_rows?: unknown
  readonly credential_rows?: unknown
}

type SnapshotReadPhase = 'capture' | 'recheck'

class IdentityDestructiveMutationSnapshotChangedError extends Error {
  constructor(
    readonly reason: Exclude<DestructiveMutationRecheck, { status: 'current' }>['reason'],
  ) {
    super('Identity destructive mutation state changed after capture.')
    this.name = 'IdentityDestructiveMutationSnapshotChangedError'
  }
}

function invalidShape(): never {
  throw new IdentityDestructiveMutationCaptureInvariantError()
}

function authorityUnavailable(): never {
  throw new IdentityDestructiveMutationAuthorityUnavailableError()
}

function captureStale(): never {
  throw new IdentityDestructiveMutationCaptureStaleError()
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

function missingSnapshotRow(
  kind: 'session' | 'actor' | 'owner' | 'credential',
  phase: SnapshotReadPhase,
): never {
  if (phase === 'recheck') {
    const reason =
      kind === 'session'
        ? 'session-changed'
        : kind === 'actor'
          ? 'actor-changed'
          : kind === 'owner'
            ? 'installation-authority-changed'
            : 'credential-set-changed'
    throw new IdentityDestructiveMutationSnapshotChangedError(reason)
  }
  if (kind === 'session') return authorityUnavailable()
  return invalidShape()
}

function exactRow(
  value: unknown,
  kind: 'session' | 'actor' | 'owner' | 'credential',
  phase: SnapshotReadPhase,
) {
  if (!Array.isArray(value)) return invalidShape()
  if (value.length === 0) return missingSnapshotRow(kind, phase)
  if (value.length !== 1) return invalidShape()
  return record(value[0])
}

function user(
  value: unknown,
  kind: 'actor' | 'owner',
  phase: SnapshotReadPhase,
): UserSnapshot {
  const row = exactRow(value, kind, phase)
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
  return Object.freeze({
    id: identity(row.id),
    actorUserId: identity(row.userId),
    expiresAt: date(row.expiresAt),
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
    active: row.active,
  })
}

function credential(
  value: unknown,
  actorUserId: string,
  phase: SnapshotReadPhase,
): CredentialSnapshot {
  const row = exactRow(value, 'credential', phase)
  const credentialActorUserId = identity(row.userId)
  const accountId = identity(row.accountId)
  if (credentialActorUserId !== actorUserId || accountId !== actorUserId) {
    return invalidShape()
  }
  return Object.freeze({
    id: identity(row.id),
    accountId,
    actorUserId: credentialActorUserId,
    password: privateValue(row.password as string, 'Credential password'),
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
  })
}

async function readSnapshot(
  query: IdentityDestructiveMutationQuery,
  verifiedSessionToken: string,
  phase: SnapshotReadPhase,
): Promise<DestructiveMutationSnapshot> {
  const result = await query.query<SnapshotRow>(destructiveMutationSnapshotStatement, [
    verifiedSessionToken,
  ])
  if (result.rows.length !== 1) return invalidShape()
  const row = result.rows[0]
  if (!row) return invalidShape()
  const epoch = identity(row.product_mutation_epoch)
  if (!lifecycleValuePattern.test(epoch)) return invalidShape()
  const ownerUserId = identity(row.installation_owner_user_id)
  const bootstrapClosedAt = date(row.bootstrap_closed_at)
  const capturedSession = session(row.session_rows, phase)
  const actor = user(row.actor_rows, 'actor', phase)
  const owner = user(row.owner_rows, 'owner', phase)
  if (
    capturedSession.actorUserId !== actor.id ||
    owner.id !== ownerUserId ||
    (actor.id === ownerUserId && !sameUser(actor, owner))
  ) {
    return invalidShape()
  }
  if (!capturedSession.active) return captureStale()
  const actorCredential = credential(row.credential_rows, actor.id, phase)
  return Object.freeze({
    epoch,
    ownerUserId,
    bootstrapClosedAt,
    session: capturedSession,
    actor,
    owner,
    role: actor.id === ownerUserId ? 'owner' : 'member',
    credential: actorCredential,
  })
}

function captureState(
  capture: TraineeDataDeletionMutationCapture | InstanceResetMutationCapture,
): DestructiveMutationCaptureState {
  const state =
    traineeDataDeletionCaptures.get(capture as TraineeDataDeletionMutationCapture) ??
    instanceResetCaptures.get(capture as InstanceResetMutationCapture)
  if (!state) throw new TypeError('Destructive capture was not issued by Identity.')
  return state
}

function planIdentity(value: string, label: string): string {
  try {
    return identity(value)
  } catch {
    throw new TypeError(`${label} is not a valid destructive preview identity.`)
  }
}

async function captureMutation(
  query: IdentityDestructiveMutationQuery,
  command: TraineeDataDeletionMutationCommand | InstanceResetMutationCommand,
  expectedPurpose: DestructiveMutationPurpose,
): Promise<DestructiveMutationCaptureState> {
  const submitted = stateForCommand(command)
  if (submitted.purpose !== expectedPurpose) return commandPurposeMismatch()
  planIdentity(submitted.planId, 'Plan id')
  planIdentity(submitted.planDigest, 'Plan digest')
  const snapshot = await readSnapshot(query, submitted.verifiedSessionToken, 'capture')
  if (expectedPurpose === 'instance-reset' && snapshot.role !== 'owner') {
    return authorityUnavailable()
  }
  return Object.freeze({ purpose: expectedPurpose, command: submitted, snapshot })
}

export async function captureTraineeDataDeletionMutation(
  query: IdentityDestructiveMutationQuery,
  command: TraineeDataDeletionMutationCommand,
): Promise<TraineeDataDeletionMutationCapture> {
  const state = await captureMutation(query, command, 'trainee-data-deletion')
  const capture = new ConcreteTraineeDataDeletionMutationCapture()
  traineeDataDeletionCaptures.set(capture, state)
  Object.freeze(capture)
  return capture
}

export async function captureInstanceResetMutation(
  query: IdentityDestructiveMutationQuery,
  command: InstanceResetMutationCommand,
): Promise<InstanceResetMutationCapture> {
  const state = await captureMutation(query, command, 'instance-reset')
  const capture = new ConcreteInstanceResetMutationCapture()
  instanceResetCaptures.set(capture, state)
  Object.freeze(capture)
  return capture
}

function captureView(
  capture: TraineeDataDeletionMutationCapture | InstanceResetMutationCapture,
): DestructiveMutationCaptureView {
  const state = captureState(capture)
  return Object.freeze({
    purpose: state.purpose,
    expectedEpoch: state.snapshot.epoch,
    sessionId: state.snapshot.session.id,
    sessionExpiresAt: new Date(state.snapshot.session.expiresAt.getTime()),
    actorUserId: state.snapshot.actor.id,
    actorEmail: state.snapshot.actor.email,
    actorName: state.snapshot.actor.name,
    expectedRole: state.snapshot.role,
    installationOwnerUserId: state.snapshot.ownerUserId,
    installationState: 'claimed',
    actorCredential: 'present',
    planId: state.command.planId,
    planDigest: state.command.planDigest,
  })
}

export function traineeDataDeletionMutationCaptureView(
  capture: TraineeDataDeletionMutationCapture,
): DestructiveMutationCaptureView & Readonly<{ purpose: 'trainee-data-deletion' }> {
  const view = captureView(capture)
  if (view.purpose !== 'trainee-data-deletion') return invalidShape()
  return view as DestructiveMutationCaptureView &
    Readonly<{ purpose: 'trainee-data-deletion' }>
}

export function instanceResetMutationCaptureView(
  capture: InstanceResetMutationCapture,
): DestructiveMutationCaptureView & Readonly<{ purpose: 'instance-reset' }> {
  const view = captureView(capture)
  if (view.purpose !== 'instance-reset') return invalidShape()
  return view as DestructiveMutationCaptureView & Readonly<{ purpose: 'instance-reset' }>
}

function reauthenticationScope<Purpose extends DestructiveMutationPurpose>(
  capture: TraineeDataDeletionMutationCapture | InstanceResetMutationCapture,
  expectedPurpose: Purpose,
): DestructiveMutationReauthenticationScope<Purpose> {
  const state = captureState(capture)
  if (state.purpose !== expectedPurpose) {
    throw new TypeError(
      'Destructive capture purpose does not match the reauthentication gateway.',
    )
  }
  return Object.freeze({
    purpose: expectedPurpose,
    actorUserId: state.snapshot.actor.id,
    commandEnteredAt: new Date(state.command.commandEnteredAt.getTime()),
  })
}

/** Identity-internal binding for the subject-deletion password-attempt gateway. */
export function traineeDataDeletionMutationReauthenticationScope(
  capture: TraineeDataDeletionMutationCapture,
): DestructiveMutationReauthenticationScope<'trainee-data-deletion'> {
  return reauthenticationScope(capture, 'trainee-data-deletion')
}

/** Identity-internal binding for the instance-reset password-attempt gateway. */
export function instanceResetMutationReauthenticationScope(
  capture: InstanceResetMutationCapture,
): DestructiveMutationReauthenticationScope<'instance-reset'> {
  return reauthenticationScope(capture, 'instance-reset')
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

function sameCredential(left: CredentialSnapshot, right: CredentialSnapshot): boolean {
  return (
    left.id === right.id &&
    left.accountId === right.accountId &&
    left.actorUserId === right.actorUserId &&
    left.password === right.password &&
    sameDate(left.createdAt, right.createdAt) &&
    sameDate(left.updatedAt, right.updatedAt)
  )
}

function compareSnapshots(
  expected: DestructiveMutationSnapshot,
  current: DestructiveMutationSnapshot,
): DestructiveMutationRecheck {
  if (current.epoch !== expected.epoch) {
    return Object.freeze({ status: 'stale', reason: 'installation-epoch-changed' })
  }
  if (
    current.ownerUserId !== expected.ownerUserId ||
    !sameDate(current.bootstrapClosedAt, expected.bootstrapClosedAt) ||
    !sameUser(current.owner, expected.owner)
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
  if (!sameCredential(current.credential, expected.credential)) {
    return Object.freeze({ status: 'stale', reason: 'credential-set-changed' })
  }
  return Object.freeze({ status: 'current' })
}

async function recheckMutation(
  query: IdentityDestructiveMutationQuery,
  state: DestructiveMutationCaptureState,
): Promise<DestructiveMutationRecheck> {
  let current: DestructiveMutationSnapshot
  try {
    current = await readSnapshot(query, state.command.verifiedSessionToken, 'recheck')
  } catch (error) {
    if (error instanceof IdentityDestructiveMutationSnapshotChangedError) {
      return Object.freeze({ status: 'stale', reason: error.reason })
    }
    if (
      error instanceof IdentityDestructiveMutationAuthorityUnavailableError ||
      error instanceof IdentityDestructiveMutationCaptureStaleError
    ) {
      return Object.freeze({ status: 'stale', reason: 'session-changed' })
    }
    throw error
  }
  return compareSnapshots(state.snapshot, current)
}

/** Must be the first Identity query after BEGIN for subject deletion. */
export function recheckTraineeDataDeletionMutation(
  query: IdentityDestructiveMutationQuery,
  capture: TraineeDataDeletionMutationCapture,
): Promise<DestructiveMutationRecheck> {
  const state = captureState(capture)
  if (state.purpose !== 'trainee-data-deletion') invalidShape()
  return recheckMutation(query, state)
}

/** Must be the first Identity query after BEGIN for instance reset. */
export function recheckInstanceResetMutation(
  query: IdentityDestructiveMutationQuery,
  capture: InstanceResetMutationCapture,
): Promise<DestructiveMutationRecheck> {
  const state = captureState(capture)
  if (state.purpose !== 'instance-reset') invalidShape()
  return recheckMutation(query, state)
}
