import type { QueryResultRow } from 'pg'
import type { IdentityAuthMutationQuery } from './auth-mutation-capture'

export const accountSessionCleanupBatchSize = 16
const maximumAccountScope = 1_000

const cleanupExpiredAccountSessionsStatement = `
  WITH expired_sessions AS (
    SELECT candidate.id
    FROM "session" AS candidate
    WHERE candidate.user_id = ANY($1::text[])
      AND candidate.expires_at <= $2
    ORDER BY candidate.expires_at, candidate.id COLLATE "C"
    FOR UPDATE SKIP LOCKED
    LIMIT $3
  ), deleted_sessions AS (
    DELETE FROM "session" AS expired
    USING expired_sessions
    WHERE expired.id = expired_sessions.id
    RETURNING expired.id
  )
  SELECT count(*)::integer AS deleted_count
  FROM deleted_sessions
`

type CleanupRow = QueryResultRow & { readonly deleted_count?: unknown }

function canonicalAccountUserIds(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > maximumAccountScope) {
    throw new TypeError('Expired-session cleanup account scope is invalid.')
  }
  const canonical = [...values].sort()
  if (
    canonical.some(
      (value, index) =>
        typeof value !== 'string' ||
        value.length < 1 ||
        value.includes('\0') ||
        (index > 0 && value === canonical[index - 1]),
    )
  ) {
    throw new TypeError('Expired-session cleanup account scope is invalid.')
  }
  return Object.freeze(canonical)
}

/** Deletes at most one deterministic page while the caller holds every account exclusively. */
export async function cleanupExpiredAccountSessions(
  query: IdentityAuthMutationQuery,
  accountUserIds: readonly string[],
  now = new Date(),
): Promise<number> {
  const canonical = canonicalAccountUserIds(accountUserIds)
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('Expired-session cleanup time is invalid.')
  }
  const result = await query.query<CleanupRow>(cleanupExpiredAccountSessionsStatement, [
    canonical,
    now,
    accountSessionCleanupBatchSize,
  ])
  const deleted = result.rows[0]?.deleted_count
  if (
    result.rows.length !== 1 ||
    !Number.isSafeInteger(deleted) ||
    (deleted as number) < 0 ||
    (deleted as number) > accountSessionCleanupBatchSize
  ) {
    throw new Error('Expired-session cleanup returned invalid deletion evidence.')
  }
  return deleted as number
}
