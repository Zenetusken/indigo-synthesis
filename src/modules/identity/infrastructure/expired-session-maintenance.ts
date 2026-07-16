import type { QueryResult, QueryResultRow } from 'pg'

const lifecycleValuePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const postgresTimestampPattern =
  /^((?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/
const maximumIdentityBytes = 512
const maximumAuthorityCursorBytes = 8_192
export const maximumExpiredSessionMaintenanceBatchSize = 1_000

const expiredSessionMaintenanceSnapshotStatement = `
  WITH installation AS MATERIALIZED (
    SELECT
      product_mutation_epoch::text AS product_mutation_epoch,
      owner_user_id AS installation_owner_user_id
    FROM installation_state
    WHERE singleton = 1
  ), expired_session_page AS MATERIALIZED (
    SELECT
      candidate.id,
      candidate.user_id,
      candidate.expires_at
    FROM "session" AS candidate
    WHERE candidate.expires_at <= $1::timestamptz
      AND (
        $2::timestamptz IS NULL
        OR (candidate.expires_at, candidate.id COLLATE "C")
          > ($2::timestamptz, $3::text COLLATE "C")
      )
    ORDER BY candidate.expires_at, candidate.id COLLATE "C"
    LIMIT $4
  )
  SELECT
    installation.product_mutation_epoch,
    installation.installation_owner_user_id,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', candidate.id,
            'accountUserId', candidate.user_id,
            'expiresAt', to_char(
              candidate.expires_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            )
          )
          ORDER BY candidate.expires_at, candidate.id COLLATE "C"
        )
        FROM expired_session_page AS candidate
      ),
      '[]'::jsonb
    ) AS expired_session_rows
  FROM installation
`

export type IdentityExpiredSessionMaintenanceQuery = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

export type ExpiredSessionMaintenanceSeek = Readonly<{
  /** Exact PostgreSQL microsecond timestamp, normalized to UTC. */
  expiresAt: string
  id: string
}>

type ExpiredSessionSnapshot = Readonly<{
  id: string
  accountUserId: string
  expiresAt: string
}>

type MaintenanceSnapshot = Readonly<{
  epoch: string
  ownerUserId: string | null
  sessions: readonly ExpiredSessionSnapshot[]
}>

type CaptureStatus = 'fresh' | 'in-use' | 'rechecked' | 'spent'

type MaintenanceCaptureState = {
  status: CaptureStatus
  readonly hostInvocationId: string
  readonly authorityCursor: string | null
  readonly cutoff: Date
  readonly seek: ExpiredSessionMaintenanceSeek | null
  readonly batchSize: number
  readonly snapshot: MaintenanceSnapshot
}

const maintenanceCaptures = new WeakMap<
  ExpiredSessionMaintenanceCapture,
  MaintenanceCaptureState
>()

/** Nominal, process-local proof for one coherent expired-session maintenance page. */
export abstract class ExpiredSessionMaintenanceCapture {
  protected constructor() {}
}

const captureConstructionToken = Object.freeze({})

class ConcreteExpiredSessionMaintenanceCapture extends ExpiredSessionMaintenanceCapture {
  constructor(token: typeof captureConstructionToken) {
    super()
    if (token !== captureConstructionToken) throw staleCapture()
  }
}

export type ExpiredSessionMaintenanceCaptureView = Readonly<{
  purpose: 'expired-session-maintenance'
  expectedEpoch: string
  ownerUserId: string | null
  hostInvocationId: string
  authorityCursor: string | null
  batchSize: number
  capturedSessionCount: number
  resolvedAccountUserIds: readonly string[]
}>

/** Capture-private bindings available only after the first-query recheck. */
export type ExpiredSessionMaintenanceMutationScope = Readonly<{
  purpose: 'expired-session-maintenance'
  hostInvocationId: string
  authorityCursor: string | null
  cutoff: Date
  seek: ExpiredSessionMaintenanceSeek | null
  batchSize: number
  ownerUserId: string | null
  sessions: readonly ExpiredSessionSnapshot[]
}>

export type ExpiredSessionMaintenanceRecheck =
  | Readonly<{ status: 'current' }>
  | Readonly<{
      status: 'stale'
      reason:
        | 'installation-epoch-changed'
        | 'installation-authority-changed'
        | 'session-page-changed'
    }>

export class ExpiredSessionMaintenanceCaptureInvariantError extends Error {
  constructor() {
    super('Expired-session maintenance capture returned an invalid database shape.')
    this.name = 'ExpiredSessionMaintenanceCaptureInvariantError'
  }
}

type SnapshotRow = QueryResultRow & {
  readonly product_mutation_epoch?: unknown
  readonly installation_owner_user_id?: unknown
  readonly expired_session_rows?: unknown
}

function invariant(): never {
  throw new ExpiredSessionMaintenanceCaptureInvariantError()
}

function staleCapture(): TypeError {
  return new TypeError(
    'Expired-session maintenance capture was not issued or is no longer fresh.',
  )
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

function inputText(value: unknown, label: string, maximumBytes = maximumIdentityBytes) {
  try {
    return boundedText(value, maximumBytes)
  } catch {
    throw new TypeError(`Expired-session maintenance ${label} is invalid.`)
  }
}

function postgresTimestamp(value: unknown): string {
  if (typeof value !== 'string') return invariant()
  const match = postgresTimestampPattern.exec(value)
  if (!match?.[1] || !match[2]) return invariant()
  const millisecondTimestamp = `${match[1]}.${match[2].slice(0, 3)}Z`
  const parsed = new Date(millisecondTimestamp)
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== millisecondTimestamp
  ) {
    return invariant()
  }
  return value
}

function inputPostgresTimestamp(value: unknown, label: string): string {
  try {
    return postgresTimestamp(value)
  } catch {
    throw new TypeError(`Expired-session maintenance ${label} is invalid.`)
  }
}

function inputDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`Expired-session maintenance ${label} is invalid.`)
  }
  return new Date(value.getTime())
}

function cutoffAtMicrosecondPrecision(value: Date): string {
  return value.toISOString().replace(/Z$/, '000Z')
}

function compareIdentityBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function compareSessionTuple(
  left: Pick<ExpiredSessionSnapshot, 'expiresAt' | 'id'>,
  right: Pick<ExpiredSessionSnapshot, 'expiresAt' | 'id'>,
): number {
  const timeDifference = left.expiresAt.localeCompare(right.expiresAt)
  return timeDifference === 0 ? compareIdentityBytes(left.id, right.id) : timeDifference
}

function sessionSnapshot(value: unknown): ExpiredSessionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invariant()
  const row = value as Record<string, unknown>
  return Object.freeze({
    id: boundedText(row.id),
    accountUserId: boundedText(row.accountUserId),
    expiresAt: postgresTimestamp(row.expiresAt),
  })
}

function sessionPage(
  value: unknown,
  input: {
    readonly cutoff: Date
    readonly seek: ExpiredSessionMaintenanceSeek | null
    readonly batchSize: number
  },
): readonly ExpiredSessionSnapshot[] {
  if (!Array.isArray(value) || value.length > input.batchSize) return invariant()
  const sessions = value.map(sessionSnapshot)
  for (let index = 0; index < sessions.length; index += 1) {
    const current = sessions[index]
    if (!current || current.expiresAt > cutoffAtMicrosecondPrecision(input.cutoff)) {
      invariant()
    }
    if (input.seek && compareSessionTuple(current, input.seek) <= 0) invariant()
    const previous = sessions[index - 1]
    if (previous && compareSessionTuple(previous, current) >= 0) invariant()
  }
  return Object.freeze(sessions)
}

function canonicalAccountUserIds(
  sessions: readonly ExpiredSessionSnapshot[],
): readonly string[] {
  return Object.freeze(
    [...new Set(sessions.map((candidate) => candidate.accountUserId))].sort(
      compareIdentityBytes,
    ),
  )
}

function captureInput(input: {
  readonly hostInvocationId: string
  readonly authorityCursor: string | null
  readonly cutoff: Date
  readonly seek: ExpiredSessionMaintenanceSeek | null
  readonly batchSize: number
}): Readonly<{
  hostInvocationId: string
  authorityCursor: string | null
  cutoff: Date
  seek: ExpiredSessionMaintenanceSeek | null
  batchSize: number
}> {
  if (
    !Number.isSafeInteger(input.batchSize) ||
    input.batchSize < 1 ||
    input.batchSize > maximumExpiredSessionMaintenanceBatchSize
  ) {
    throw new TypeError('Expired-session maintenance batch size is invalid.')
  }
  const authorityCursor =
    input.authorityCursor === null
      ? null
      : inputText(input.authorityCursor, 'authority cursor', maximumAuthorityCursorBytes)
  const seek =
    input.seek === null
      ? null
      : Object.freeze({
          expiresAt: inputPostgresTimestamp(input.seek.expiresAt, 'seek expiry'),
          id: inputText(input.seek.id, 'seek identity'),
        })
  if ((authorityCursor === null) !== (seek === null)) {
    throw new TypeError('Expired-session maintenance cursor binding is invalid.')
  }
  return Object.freeze({
    hostInvocationId: inputText(input.hostInvocationId, 'host invocation identity'),
    authorityCursor,
    cutoff: inputDate(input.cutoff, 'cutoff'),
    seek,
    batchSize: input.batchSize,
  })
}

async function readSnapshot(
  query: IdentityExpiredSessionMaintenanceQuery,
  input: {
    readonly cutoff: Date
    readonly seek: ExpiredSessionMaintenanceSeek | null
    readonly batchSize: number
  },
): Promise<MaintenanceSnapshot> {
  const result = await query.query<SnapshotRow>(
    expiredSessionMaintenanceSnapshotStatement,
    [
      input.cutoff,
      input.seek?.expiresAt ?? null,
      input.seek?.id ?? null,
      input.batchSize,
    ],
  )
  if (result.rows.length !== 1) return invariant()
  const row = result.rows[0]
  if (
    !row ||
    typeof row.product_mutation_epoch !== 'string' ||
    !lifecycleValuePattern.test(row.product_mutation_epoch)
  ) {
    return invariant()
  }
  const ownerUserId =
    row.installation_owner_user_id === null
      ? null
      : boundedText(row.installation_owner_user_id)
  return Object.freeze({
    epoch: row.product_mutation_epoch,
    ownerUserId,
    sessions: sessionPage(row.expired_session_rows, input),
  })
}

function freshState(capture: ExpiredSessionMaintenanceCapture): MaintenanceCaptureState {
  const state = maintenanceCaptures.get(capture)
  if (state?.status !== 'fresh') throw staleCapture()
  return state
}

function sameSnapshot(
  expected: MaintenanceSnapshot,
  current: MaintenanceSnapshot,
): ExpiredSessionMaintenanceRecheck {
  if (current.epoch !== expected.epoch) {
    return Object.freeze({ status: 'stale', reason: 'installation-epoch-changed' })
  }
  if (current.ownerUserId !== expected.ownerUserId) {
    return Object.freeze({
      status: 'stale',
      reason: 'installation-authority-changed',
    })
  }
  if (
    current.sessions.length !== expected.sessions.length ||
    current.sessions.some((candidate, index) => {
      const original = expected.sessions[index]
      return (
        !original ||
        candidate.id !== original.id ||
        candidate.accountUserId !== original.accountUserId ||
        candidate.expiresAt !== original.expiresAt
      )
    })
  ) {
    return Object.freeze({ status: 'stale', reason: 'session-page-changed' })
  }
  return Object.freeze({ status: 'current' })
}

/** Captures one deterministic expired-session page and its installation authority. */
export async function captureExpiredSessionMaintenance(
  query: IdentityExpiredSessionMaintenanceQuery,
  input: {
    readonly hostInvocationId: string
    readonly authorityCursor: string | null
    readonly cutoff: Date
    readonly seek: ExpiredSessionMaintenanceSeek | null
    readonly batchSize: number
  },
): Promise<ExpiredSessionMaintenanceCapture> {
  const bound = captureInput(input)
  const snapshot = await readSnapshot(query, bound)
  const capture = new ConcreteExpiredSessionMaintenanceCapture(captureConstructionToken)
  maintenanceCaptures.set(capture, { status: 'fresh', ...bound, snapshot })
  Object.freeze(capture)
  return capture
}

/** Redacted authority and account-lock projection; exact session identities stay private. */
export function expiredSessionMaintenanceCaptureView(
  capture: ExpiredSessionMaintenanceCapture,
): ExpiredSessionMaintenanceCaptureView {
  const state = freshState(capture)
  return Object.freeze({
    purpose: 'expired-session-maintenance',
    expectedEpoch: state.snapshot.epoch,
    ownerUserId: state.snapshot.ownerUserId,
    hostInvocationId: state.hostInvocationId,
    authorityCursor: state.authorityCursor,
    batchSize: state.batchSize,
    capturedSessionCount: state.snapshot.sessions.length,
    resolvedAccountUserIds: canonicalAccountUserIds(state.snapshot.sessions),
  })
}

/** Must be the first Identity query after BEGIN for this captured maintenance page. */
export async function recheckExpiredSessionMaintenance(
  query: IdentityExpiredSessionMaintenanceQuery,
  capture: ExpiredSessionMaintenanceCapture,
): Promise<ExpiredSessionMaintenanceRecheck> {
  const state = freshState(capture)
  state.status = 'in-use'
  try {
    const current = await readSnapshot(query, state)
    const result = sameSnapshot(state.snapshot, current)
    state.status = result.status === 'current' ? 'rechecked' : 'spent'
    return result
  } catch (error) {
    state.status = 'spent'
    throw error
  }
}

/** One-use private DML projection available only after a successful exact recheck. */
export function claimExpiredSessionMaintenanceMutationScope(
  capture: ExpiredSessionMaintenanceCapture,
): ExpiredSessionMaintenanceMutationScope {
  const state = maintenanceCaptures.get(capture)
  if (state?.status !== 'rechecked') throw staleCapture()
  state.status = 'spent'
  return Object.freeze({
    purpose: 'expired-session-maintenance',
    hostInvocationId: state.hostInvocationId,
    authorityCursor: state.authorityCursor,
    cutoff: new Date(state.cutoff.getTime()),
    seek:
      state.seek === null
        ? null
        : Object.freeze({
            expiresAt: state.seek.expiresAt,
            id: state.seek.id,
          }),
    batchSize: state.batchSize,
    ownerUserId: state.snapshot.ownerUserId,
    sessions: Object.freeze(
      state.snapshot.sessions.map((candidate) =>
        Object.freeze({
          id: candidate.id,
          accountUserId: candidate.accountUserId,
          expiresAt: candidate.expiresAt,
        }),
      ),
    ),
  })
}
