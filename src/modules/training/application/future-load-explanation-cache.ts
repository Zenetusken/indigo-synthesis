import { and, eq, ne, sql } from 'drizzle-orm'
import { type DatabaseTransaction, getDb } from '@/platform/db/client'
import {
  adjustmentDecisionInvalidations,
  adjustmentDecisions,
  futureLoadExplanationCache,
  sessionFeedback,
  trainingFactCorrections,
  workoutSessions,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import { sha256 } from '@/shared/canonical-json'

export type CachedFutureLoadExplanation = {
  readonly prose: string
  readonly modelId: string
  readonly modelContentDigest: string
  readonly servedModelName: string
  readonly runtimeId: string
  readonly runtimeAttestationDigest: string
  readonly promptVersion: string
  readonly validatorVersion: string
  readonly factBundleHash: string
  readonly generateDurationMs: number
}

export type FutureLoadExplanationCacheScope = {
  readonly userId: string
  readonly sessionId: string
  readonly decisionId: string
}

export type FutureLoadExplanationCacheRead =
  | { readonly status: 'hit'; readonly value: CachedFutureLoadExplanation }
  | { readonly status: 'miss' }
  | { readonly status: 'cache-unavailable' }
  | {
      readonly status: 'invalidated'
      readonly reason: 'post-completion-pain-report' | 'training-fact-correction'
    }
  | { readonly status: 'state-unavailable' }

export type FutureLoadExplanationCacheWrite =
  | { readonly status: 'stored' }
  | { readonly status: 'cache-unavailable' }
  | {
      readonly status: 'invalidated'
      readonly reason: 'post-completion-pain-report' | 'training-fact-correction'
    }
  | { readonly status: 'state-unavailable' }

export type FutureLoadExplanationCachePort = {
  /** Linearized cache read: user lock + authoritative invalidation check + cache read. */
  readonly getIfActive: (
    input: FutureLoadExplanationCacheScope & { readonly cacheKey: string },
  ) => Promise<FutureLoadExplanationCacheRead>
  /**
   * Final publication point. Generation happens before this call; available prose may be
   * returned only when this fresh locked check reports stored/cache-unavailable.
   */
  readonly putIfActive: (
    input: FutureLoadExplanationCacheScope &
      CachedFutureLoadExplanation & { readonly cacheKey: string },
  ) => Promise<FutureLoadExplanationCacheWrite>
  readonly deleteByCacheKey: (cacheKey: string) => Promise<'deleted' | 'unavailable'>
  readonly deleteBySessionId: (input: {
    readonly userId: string
    readonly sessionId: string
  }) => Promise<'deleted' | 'unavailable'>
}

export type FutureLoadExplanationCacheTestHooks = {
  readonly beforeAuthoritativeState?: (
    transaction: DatabaseTransaction,
    operation: 'get' | 'put',
  ) => Promise<void>
  readonly afterActiveState?: (operation: 'get' | 'put') => Promise<void>
  readonly beforeCacheStatement?: (
    transaction: DatabaseTransaction,
    operation: 'get' | 'put',
  ) => Promise<void>
}

/** PostgreSQL text rejects the NUL separators used by the contract cache identity. */
export function storageKeyFromExplanationCacheKey(contractCacheKey: string): string {
  return sha256(contractCacheKey)
}

type AuthoritativeState =
  | { readonly status: 'active' }
  | {
      readonly status: 'invalidated'
      readonly reason: 'post-completion-pain-report' | 'training-fact-correction'
    }
  | { readonly status: 'state-unavailable' }

async function lockAndReadAuthoritativeState(
  transaction: DatabaseTransaction,
  scope: FutureLoadExplanationCacheScope,
): Promise<AuthoritativeState> {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope.userId}, 0))`,
  )
  const [row] = await transaction
    .select({
      status: workoutSessions.status,
      feedbackSessionId: sessionFeedback.sessionId,
      invalidationCorrectionId: adjustmentDecisionInvalidations.correctionId,
      correctionKind: trainingFactCorrections.correctionKind,
    })
    .from(adjustmentDecisions)
    .innerJoin(workoutSessions, eq(workoutSessions.id, adjustmentDecisions.sessionId))
    .leftJoin(sessionFeedback, eq(sessionFeedback.sessionId, workoutSessions.id))
    .leftJoin(
      adjustmentDecisionInvalidations,
      eq(adjustmentDecisionInvalidations.decisionId, adjustmentDecisions.id),
    )
    .leftJoin(
      trainingFactCorrections,
      eq(trainingFactCorrections.id, adjustmentDecisionInvalidations.correctionId),
    )
    .where(
      and(
        eq(adjustmentDecisions.id, scope.decisionId),
        eq(workoutSessions.id, scope.sessionId),
        eq(workoutSessions.userId, scope.userId),
      ),
    )
    .limit(1)

  if (row?.status !== 'completed') return { status: 'state-unavailable' }
  if (row.feedbackSessionId === null) return { status: 'state-unavailable' }
  if (row.invalidationCorrectionId !== null) {
    return {
      status: 'invalidated',
      reason:
        row.correctionKind === 'session-feedback'
          ? 'post-completion-pain-report'
          : 'training-fact-correction',
    }
  }
  return { status: 'active' }
}

/**
 * PostgreSQL adapter. Cache statements run in nested transactions/savepoints so a cache
 * relation or write failure cannot poison the authoritative state-check transaction.
 */
export function createPostgresFutureLoadExplanationCache(options?: {
  /** Integration-only fault/ordering hooks; production composition never supplies these. */
  readonly testHooks?: FutureLoadExplanationCacheTestHooks
}): FutureLoadExplanationCachePort {
  return {
    async getIfActive(input) {
      try {
        return await getDb().transaction(async (transaction) => {
          await options?.testHooks?.beforeAuthoritativeState?.(transaction, 'get')
          const state = await lockAndReadAuthoritativeState(transaction, input)
          if (state.status !== 'active') return state
          await options?.testHooks?.afterActiveState?.('get')
          try {
            const storageKey = storageKeyFromExplanationCacheKey(input.cacheKey)
            const rows = await transaction.transaction(async (cacheTransaction) => {
              await options?.testHooks?.beforeCacheStatement?.(cacheTransaction, 'get')
              return cacheTransaction
                .select({
                  prose: futureLoadExplanationCache.prose,
                  modelId: futureLoadExplanationCache.modelId,
                  modelContentDigest: futureLoadExplanationCache.modelContentDigest,
                  servedModelName: futureLoadExplanationCache.servedModelName,
                  runtimeId: futureLoadExplanationCache.runtimeId,
                  runtimeAttestationDigest:
                    futureLoadExplanationCache.runtimeAttestationDigest,
                  promptVersion: futureLoadExplanationCache.promptVersion,
                  validatorVersion: futureLoadExplanationCache.validatorVersion,
                  factBundleHash: futureLoadExplanationCache.factBundleHash,
                  generateDurationMs: futureLoadExplanationCache.generateDurationMs,
                })
                .from(futureLoadExplanationCache)
                .where(
                  and(
                    eq(futureLoadExplanationCache.cacheKey, storageKey),
                    eq(futureLoadExplanationCache.userId, input.userId),
                    eq(futureLoadExplanationCache.sessionId, input.sessionId),
                    eq(futureLoadExplanationCache.decisionId, input.decisionId),
                  ),
                )
                .limit(1)
            })
            const row = rows[0]
            return row
              ? ({ status: 'hit', value: row } as const)
              : ({ status: 'miss' } as const)
          } catch {
            return { status: 'cache-unavailable' } as const
          }
        })
      } catch {
        return { status: 'state-unavailable' }
      }
    },

    async putIfActive(input) {
      try {
        return await getDb().transaction(async (transaction) => {
          await options?.testHooks?.beforeAuthoritativeState?.(transaction, 'put')
          const state = await lockAndReadAuthoritativeState(transaction, input)
          if (state.status !== 'active') return state
          await options?.testHooks?.afterActiveState?.('put')
          try {
            const storageKey = storageKeyFromExplanationCacheKey(input.cacheKey)
            await transaction.transaction(async (cacheTransaction) => {
              await options?.testHooks?.beforeCacheStatement?.(cacheTransaction, 'put')
              await cacheTransaction
                .delete(futureLoadExplanationCache)
                .where(
                  and(
                    eq(futureLoadExplanationCache.userId, input.userId),
                    eq(futureLoadExplanationCache.sessionId, input.sessionId),
                    eq(futureLoadExplanationCache.decisionId, input.decisionId),
                    ne(futureLoadExplanationCache.cacheKey, storageKey),
                  ),
                )
              return cacheTransaction
                .insert(futureLoadExplanationCache)
                .values({
                  id: newUuidV7(),
                  userId: input.userId,
                  sessionId: input.sessionId,
                  decisionId: input.decisionId,
                  cacheKey: storageKey,
                  prose: input.prose,
                  modelId: input.modelId,
                  modelContentDigest: input.modelContentDigest,
                  servedModelName: input.servedModelName,
                  runtimeId: input.runtimeId,
                  runtimeAttestationDigest: input.runtimeAttestationDigest,
                  promptVersion: input.promptVersion,
                  validatorVersion: input.validatorVersion,
                  factBundleHash: input.factBundleHash,
                  generateDurationMs: input.generateDurationMs,
                })
                .onConflictDoUpdate({
                  target: futureLoadExplanationCache.decisionId,
                  set: {
                    cacheKey: storageKey,
                    prose: input.prose,
                    modelId: input.modelId,
                    modelContentDigest: input.modelContentDigest,
                    servedModelName: input.servedModelName,
                    runtimeId: input.runtimeId,
                    runtimeAttestationDigest: input.runtimeAttestationDigest,
                    promptVersion: input.promptVersion,
                    validatorVersion: input.validatorVersion,
                    factBundleHash: input.factBundleHash,
                    generateDurationMs: input.generateDurationMs,
                    createdAt: new Date(),
                  },
                })
            })
            return { status: 'stored' } as const
          } catch {
            return { status: 'cache-unavailable' } as const
          }
        })
      } catch {
        return { status: 'state-unavailable' }
      }
    },

    async deleteByCacheKey(cacheKey) {
      try {
        await getDb()
          .delete(futureLoadExplanationCache)
          .where(
            eq(
              futureLoadExplanationCache.cacheKey,
              storageKeyFromExplanationCacheKey(cacheKey),
            ),
          )
        return 'deleted'
      } catch {
        return 'unavailable'
      }
    },

    async deleteBySessionId(input) {
      try {
        await getDb()
          .delete(futureLoadExplanationCache)
          .where(
            and(
              eq(futureLoadExplanationCache.userId, input.userId),
              eq(futureLoadExplanationCache.sessionId, input.sessionId),
            ),
          )
        return 'deleted'
      } catch {
        return 'unavailable'
      }
    },
  }
}

export function createMemoryFutureLoadExplanationCache(options?: {
  readonly activeState?: () => AuthoritativeState | Promise<AuthoritativeState>
}): FutureLoadExplanationCachePort {
  const byKey = new Map<
    string,
    CachedFutureLoadExplanation & {
      decisionId: string
      sessionId: string
      userId: string
    }
  >()
  const activeState = options?.activeState ?? (() => ({ status: 'active' as const }))
  return {
    async getIfActive(input) {
      const state = await activeState()
      if (state.status !== 'active') return state
      const hit = byKey.get(input.cacheKey)
      return hit ? { status: 'hit', value: hit } : { status: 'miss' }
    },
    async putIfActive(input) {
      const state = await activeState()
      if (state.status !== 'active') return state
      for (const [key, value] of byKey) {
        if (
          value.userId === input.userId &&
          value.sessionId === input.sessionId &&
          value.decisionId === input.decisionId &&
          key !== input.cacheKey
        ) {
          byKey.delete(key)
        }
      }
      byKey.set(input.cacheKey, input)
      return { status: 'stored' }
    },
    async deleteByCacheKey(cacheKey) {
      byKey.delete(cacheKey)
      return 'deleted'
    },
    async deleteBySessionId(input) {
      for (const [key, value] of byKey) {
        if (value.userId === input.userId && value.sessionId === input.sessionId) {
          byKey.delete(key)
        }
      }
      return 'deleted'
    },
  }
}

/** Test helper: subject-scoped wipe when cascading user delete is not under test. */
export async function deleteFutureLoadExplanationCacheForUser(
  userId: string,
): Promise<void> {
  await getDb()
    .delete(futureLoadExplanationCache)
    .where(eq(futureLoadExplanationCache.userId, userId))
}
