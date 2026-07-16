import { inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { session } from '@/platform/db/schema'
import {
  claimExpiredSessionMaintenanceMutationScope,
  type ExpiredSessionMaintenanceCapture,
  type ExpiredSessionMaintenanceMutationScope,
  type ExpiredSessionMaintenanceSeek,
} from './expired-session-maintenance'

const maximumIdentityBytes = 512

export type ScopedExpiredSessionMaintenanceResult = Readonly<{
  deletedSessionCount: number
  complete: boolean
  last: ExpiredSessionMaintenanceSeek | null
}>

export interface ScopedExpiredSessionMaintenanceMutationGateway {
  deleteCapturedPage(): Promise<ScopedExpiredSessionMaintenanceResult>
}

export class ScopedExpiredSessionMaintenanceInvariantError extends Error {
  constructor() {
    super('The scoped expired-session maintenance mutation is no longer coherent.')
    this.name = 'ScopedExpiredSessionMaintenanceInvariantError'
  }
}

function invariant(): never {
  throw new ScopedExpiredSessionMaintenanceInvariantError()
}

function boundedText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumIdentityBytes
  ) {
    return invariant()
  }
  return value
}

function oneUse<Result>(operation: () => Promise<Result>): () => Promise<Result> {
  let claimed = false
  return () => {
    if (claimed) return invariant()
    claimed = true
    return operation()
  }
}

function deletionResult(
  scope: ExpiredSessionMaintenanceMutationScope,
): ScopedExpiredSessionMaintenanceResult {
  const last = scope.sessions.at(-1)
  return Object.freeze({
    deletedSessionCount: scope.sessions.length,
    complete: scope.sessions.length < scope.batchSize,
    last:
      last === undefined
        ? null
        : Object.freeze({
            expiresAt: last.expiresAt,
            id: last.id,
          }),
  })
}

function assertExactDeletionEvidence(
  scope: ExpiredSessionMaintenanceMutationScope,
  returned: readonly unknown[],
): void {
  if (returned.length !== scope.sessions.length) invariant()
  const expected = new Map(
    scope.sessions.map((candidate) => [candidate.id, candidate.accountUserId] as const),
  )
  const seen = new Set<string>()
  for (const value of returned) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invariant()
    const row = value as Record<string, unknown>
    const id = boundedText(row.id)
    const accountUserId = boundedText(row.accountUserId)
    if (seen.has(id) || expected.get(id) !== accountUserId) invariant()
    seen.add(id)
  }
  if (seen.size !== expected.size) invariant()
}

async function deleteCapturedPage<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  capture: ExpiredSessionMaintenanceCapture,
): Promise<ScopedExpiredSessionMaintenanceResult> {
  const scope = claimExpiredSessionMaintenanceMutationScope(capture)
  if (scope.sessions.length === 0) return deletionResult(scope)

  const deleted = await database
    .delete(session)
    .where(
      inArray(
        session.id,
        scope.sessions.map((candidate) => candidate.id),
      ),
    )
    .returning({ id: session.id, accountUserId: session.userId })
  assertExactDeletionEvidence(scope, deleted)
  return deletionResult(scope)
}

/**
 * Builds a one-use exact-page gateway without spending the capture. The private
 * scope is claimed lazily only when deletion runs, after the required recheck.
 */
export function createScopedExpiredSessionMaintenanceMutationGateway<
  TSchema extends Record<string, unknown>,
>(
  database: NodePgDatabase<TSchema>,
  capture: ExpiredSessionMaintenanceCapture,
): ScopedExpiredSessionMaintenanceMutationGateway {
  const invoke = oneUse(() => deleteCapturedPage(database, capture))
  return Object.freeze({ deleteCapturedPage: invoke })
}
