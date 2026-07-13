import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/platform/db/client'
import { futureLoadExplanationCache } from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

export type CachedFutureLoadExplanation = {
  readonly prose: string
  readonly modelId: string
  readonly modelContentDigest: string
  readonly promptVersion: string
  readonly factBundleHash: string
  readonly generateDurationMs: number
}

export type FutureLoadExplanationCachePort = {
  readonly getByCacheKey: (
    cacheKey: string,
  ) => Promise<CachedFutureLoadExplanation | null>
  readonly put: (input: {
    readonly userId: string
    readonly sessionId: string
    readonly decisionId: string
    readonly cacheKey: string
    readonly prose: string
    readonly modelId: string
    readonly modelContentDigest: string
    readonly promptVersion: string
    readonly factBundleHash: string
    readonly generateDurationMs: number
  }) => Promise<void>
  readonly deleteByDecisionId: (decisionId: string) => Promise<void>
}

/**
 * Contract cache keys use U+0000 separators (explanationCacheKey). PostgreSQL text
 * columns reject null bytes, so persist a stable hex digest of the contract key.
 */
export function storageKeyFromExplanationCacheKey(contractCacheKey: string): string {
  return createHash('sha256').update(contractCacheKey, 'utf8').digest('hex')
}

/**
 * PostgreSQL-backed prose cache. Not part of the immutable training ledger.
 * Only store validation-passing available results (caller enforces).
 */
export function createPostgresFutureLoadExplanationCache(): FutureLoadExplanationCachePort {
  return {
    async getByCacheKey(cacheKey) {
      const db = getDb()
      const storageKey = storageKeyFromExplanationCacheKey(cacheKey)
      const rows = await db
        .select({
          prose: futureLoadExplanationCache.prose,
          modelId: futureLoadExplanationCache.modelId,
          modelContentDigest: futureLoadExplanationCache.modelContentDigest,
          promptVersion: futureLoadExplanationCache.promptVersion,
          factBundleHash: futureLoadExplanationCache.factBundleHash,
          generateDurationMs: futureLoadExplanationCache.generateDurationMs,
        })
        .from(futureLoadExplanationCache)
        .where(eq(futureLoadExplanationCache.cacheKey, storageKey))
        .limit(1)
      const row = rows[0]
      return row ?? null
    },

    async put(input) {
      const db = getDb()
      const storageKey = storageKeyFromExplanationCacheKey(input.cacheKey)
      await db
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
          promptVersion: input.promptVersion,
          factBundleHash: input.factBundleHash,
          generateDurationMs: input.generateDurationMs,
        })
        .onConflictDoNothing({ target: futureLoadExplanationCache.cacheKey })
    },

    async deleteByDecisionId(decisionId) {
      const db = getDb()
      await db
        .delete(futureLoadExplanationCache)
        .where(eq(futureLoadExplanationCache.decisionId, decisionId))
    },
  }
}

export function createMemoryFutureLoadExplanationCache(): FutureLoadExplanationCachePort {
  const byKey = new Map<string, CachedFutureLoadExplanation & { decisionId: string }>()
  return {
    async getByCacheKey(cacheKey) {
      const hit = byKey.get(cacheKey)
      if (!hit) return null
      return {
        prose: hit.prose,
        modelId: hit.modelId,
        modelContentDigest: hit.modelContentDigest,
        promptVersion: hit.promptVersion,
        factBundleHash: hit.factBundleHash,
        generateDurationMs: hit.generateDurationMs,
      }
    },
    async put(input) {
      if (byKey.has(input.cacheKey)) return
      byKey.set(input.cacheKey, {
        decisionId: input.decisionId,
        prose: input.prose,
        modelId: input.modelId,
        modelContentDigest: input.modelContentDigest,
        promptVersion: input.promptVersion,
        factBundleHash: input.factBundleHash,
        generateDurationMs: input.generateDurationMs,
      })
    },
    async deleteByDecisionId(decisionId) {
      for (const [key, value] of byKey) {
        if (value.decisionId === decisionId) byKey.delete(key)
      }
    },
  }
}

/** Test helper: subject-scoped wipe when cascading user delete is not under test. */
export async function deleteFutureLoadExplanationCacheForUser(userId: string): Promise<void> {
  const db = getDb()
  await db
    .delete(futureLoadExplanationCache)
    .where(and(eq(futureLoadExplanationCache.userId, userId)))
}
