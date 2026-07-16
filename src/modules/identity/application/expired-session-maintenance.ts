const maximumBatchSize = 64
const maximumCursorBytes = 8_192
const maximumSessionIdBytes = 512
const cursorVersion = 1
const base64UrlPattern = /^[A-Za-z0-9_-]+$/
const postgresTimestampPattern =
  /^((?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/

export type ExpiredSessionMaintenanceErrorCode =
  | 'expired-session-maintenance.invalid-input'
  | 'expired-session-maintenance.invalid-cursor'
  | 'expired-session-maintenance.cursor-unavailable'
  | 'expired-session-maintenance.instance-open'
  | 'expired-session-maintenance.stale'

const errorMessages = {
  'expired-session-maintenance.invalid-input':
    'The maintenance batch size or invocation time is invalid.',
  'expired-session-maintenance.invalid-cursor':
    'The maintenance cursor is invalid or non-canonical.',
  'expired-session-maintenance.cursor-unavailable':
    'The maintenance page cannot be represented by a bounded continuation cursor.',
  'expired-session-maintenance.instance-open':
    'Expired-session maintenance requires an installed owner.',
  'expired-session-maintenance.stale':
    'The maintenance page changed while its account locks were being acquired; retry the same input cursor.',
} as const satisfies Record<ExpiredSessionMaintenanceErrorCode, string>

export class ExpiredSessionMaintenanceError extends Error {
  readonly code: ExpiredSessionMaintenanceErrorCode

  constructor(code: ExpiredSessionMaintenanceErrorCode) {
    super(errorMessages[code])
    this.name = 'ExpiredSessionMaintenanceError'
    this.code = code
  }
}

export type ExpiredSessionMaintenanceInput = Readonly<{
  batchSize: number
  cursor?: string
  now?: Date
}>

export type ExpiredSessionMaintenanceSeek = Readonly<{
  /** Exact PostgreSQL microsecond timestamp, normalized to UTC. */
  expiresAt: string
  id: string
}>

export type ParsedExpiredSessionMaintenanceInput = Readonly<{
  batchSize: number
  cursor: string | null
  sweepCutoff: Date
  seek: ExpiredSessionMaintenanceSeek | null
}>

export type ExpiredSessionMaintenanceResult =
  | Readonly<{
      status: 'complete'
      deletedCount: number
      nextCursor: null
    }>
  | Readonly<{
      status: 'continue'
      deletedCount: number
      nextCursor: string
    }>

export type ExpiredSessionMaintenancePage = Readonly<{
  deletedSessionCount: number
  complete: boolean
  last: ExpiredSessionMaintenanceSeek | null
}>

function invalidInput(): never {
  throw new ExpiredSessionMaintenanceError('expired-session-maintenance.invalid-input')
}

function invalidCursor(): never {
  throw new ExpiredSessionMaintenanceError('expired-session-maintenance.invalid-cursor')
}

function cursorUnavailable(): never {
  throw new ExpiredSessionMaintenanceError(
    'expired-session-maintenance.cursor-unavailable',
  )
}

function finiteDate(value: unknown, failure: () => never): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return failure()
  return new Date(value.getTime())
}

function canonicalTimestamp(value: unknown): Date {
  if (typeof value !== 'string') return invalidCursor()
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return invalidCursor()
  }
  return parsed
}

function canonicalSessionExpiry(value: unknown, failure: () => never): string {
  if (typeof value !== 'string') return failure()
  const match = postgresTimestampPattern.exec(value)
  if (!match?.[1] || !match[2]) return failure()
  const millisecondTimestamp = `${match[1]}.${match[2].slice(0, 3)}Z`
  const parsed = new Date(millisecondTimestamp)
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== millisecondTimestamp
  ) {
    return failure()
  }
  return value
}

function cutoffAtMicrosecondPrecision(value: Date): string {
  return value.toISOString().replace(/Z$/, '000Z')
}

function sessionId(value: unknown, failure: () => never): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumSessionIdBytes ||
    Buffer.from(value, 'utf8').toString('utf8') !== value
  ) {
    return failure()
  }
  return value
}

function canonicalCursorBytes(cursor: unknown): Uint8Array {
  if (
    typeof cursor !== 'string' ||
    cursor.length < 1 ||
    Buffer.byteLength(cursor, 'ascii') > maximumCursorBytes ||
    !base64UrlPattern.test(cursor)
  ) {
    return invalidCursor()
  }
  let decoded: Buffer
  try {
    decoded = Buffer.from(cursor, 'base64url')
  } catch {
    return invalidCursor()
  }
  if (decoded.toString('base64url') !== cursor) return invalidCursor()
  return decoded
}

function decodeCursor(cursor: string): Readonly<{
  sweepCutoff: Date
  seek: ExpiredSessionMaintenanceSeek
}> {
  const bytes = canonicalCursorBytes(cursor)
  let json: string
  let value: unknown
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    value = JSON.parse(json)
  } catch {
    return invalidCursor()
  }
  if (!Array.isArray(value) || value.length !== 4 || value[0] !== cursorVersion) {
    return invalidCursor()
  }
  const sweepCutoff = canonicalTimestamp(value[1])
  const expiresAt = canonicalSessionExpiry(value[2], invalidCursor)
  const id = sessionId(value[3], invalidCursor)
  if (
    expiresAt > cutoffAtMicrosecondPrecision(sweepCutoff) ||
    JSON.stringify([cursorVersion, value[1], value[2], id]) !== json
  ) {
    return invalidCursor()
  }
  return Object.freeze({
    sweepCutoff: new Date(sweepCutoff.getTime()),
    seek: Object.freeze({ expiresAt, id }),
  })
}

export function parseExpiredSessionMaintenanceInput(
  input: ExpiredSessionMaintenanceInput,
): ParsedExpiredSessionMaintenanceInput {
  if (
    !input ||
    typeof input !== 'object' ||
    !Number.isSafeInteger(input.batchSize) ||
    input.batchSize < 1 ||
    input.batchSize > maximumBatchSize
  ) {
    return invalidInput()
  }
  const invocationTime = finiteDate(input.now ?? new Date(), invalidInput)
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor)
    if (decoded.sweepCutoff.getTime() > invocationTime.getTime()) {
      return invalidCursor()
    }
    return Object.freeze({
      batchSize: input.batchSize,
      cursor: input.cursor,
      sweepCutoff: decoded.sweepCutoff,
      seek: decoded.seek,
    })
  }
  return Object.freeze({
    batchSize: input.batchSize,
    cursor: null,
    sweepCutoff: invocationTime,
    seek: null,
  })
}

export function encodeExpiredSessionMaintenanceCursor(input: {
  readonly sweepCutoff: Date
  readonly last: ExpiredSessionMaintenanceSeek
}): string {
  const sweepCutoff = finiteDate(input.sweepCutoff, cursorUnavailable)
  const expiresAt = canonicalSessionExpiry(input.last?.expiresAt, cursorUnavailable)
  const id = sessionId(input.last?.id, cursorUnavailable)
  if (expiresAt > cutoffAtMicrosecondPrecision(sweepCutoff)) {
    return cursorUnavailable()
  }
  const cursor = Buffer.from(
    JSON.stringify([cursorVersion, sweepCutoff.toISOString(), expiresAt, id]),
    'utf8',
  ).toString('base64url')
  if (Buffer.byteLength(cursor, 'ascii') > maximumCursorBytes) {
    return cursorUnavailable()
  }
  return cursor
}

export function toExpiredSessionMaintenanceResult(input: {
  readonly sweepCutoff: Date
  readonly page: ExpiredSessionMaintenancePage
}): ExpiredSessionMaintenanceResult {
  const { page } = input
  if (
    !Number.isSafeInteger(page.deletedSessionCount) ||
    page.deletedSessionCount < 0 ||
    typeof page.complete !== 'boolean' ||
    (page.last === null && (!page.complete || page.deletedSessionCount !== 0)) ||
    (page.last !== null && page.deletedSessionCount === 0)
  ) {
    return cursorUnavailable()
  }
  if (page.complete) {
    return Object.freeze({
      status: 'complete',
      deletedCount: page.deletedSessionCount,
      nextCursor: null,
    })
  }
  if (page.last === null) return cursorUnavailable()
  return Object.freeze({
    status: 'continue',
    deletedCount: page.deletedSessionCount,
    nextCursor: encodeExpiredSessionMaintenanceCursor({
      sweepCutoff: input.sweepCutoff,
      last: page.last,
    }),
  })
}
