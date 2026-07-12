import { verifyPassword } from 'better-auth/crypto'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/platform/db/client'
import {
  account,
  auditEvents,
  destructiveReauthenticationStates,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

export const destructiveReauthenticationPolicy = {
  maximumFailedAttempts: 5,
  attemptWindowMilliseconds: 15 * 60 * 1_000,
  lockoutMilliseconds: 15 * 60 * 1_000,
} as const

export type DestructiveReauthenticationPurpose =
  | 'trainee-data-deletion'
  | 'instance-reset'

export type DestructiveReauthenticationDenial = 'failed' | 'locked'

type ReauthenticationOutcome =
  | { readonly status: 'succeeded' }
  | { readonly status: DestructiveReauthenticationDenial }

/**
 * Verifies one destructive password challenge and commits denied-attempt state before
 * returning. The caller must convert a denial into its public application error only
 * after this function returns, otherwise the transaction would roll back the lockout.
 *
 * The credential row is locked while the password is checked. Callers additionally
 * hold the shared credential-lifecycle advisory lock around this function and the
 * destructive command so owner recovery cannot cross the boundary.
 */
export async function verifyDestructiveReauthentication(input: {
  readonly userId: string
  readonly purpose: DestructiveReauthenticationPurpose
  readonly password: string
  readonly now?: Date
}): Promise<ReauthenticationOutcome> {
  const now = input.now ?? new Date()

  return getDb().transaction(
    async (transaction): Promise<ReauthenticationOutcome> => {
      const [credential] = await transaction
        .select({ id: account.id, password: account.password })
        .from(account)
        .where(
          and(eq(account.userId, input.userId), eq(account.providerId, 'credential')),
        )
        .for('update')
        .limit(1)

      if (!credential?.password) {
        return { status: 'failed' }
      }

      const [state] = await transaction
        .select()
        .from(destructiveReauthenticationStates)
        .where(
          and(
            eq(destructiveReauthenticationStates.accountId, credential.id),
            eq(destructiveReauthenticationStates.purpose, input.purpose),
          ),
        )
        .for('update')
        .limit(1)

      if (state?.lockedUntil && state.lockedUntil > now) {
        await transaction.insert(auditEvents).values({
          id: newUuidV7(),
          actorUserId: null,
          subjectUserId: null,
          eventType: 'destructive-reauthentication-denied',
          entityType: 'destructive-reauthentication-state',
          entityId: state.id,
          metadata: {
            purpose: input.purpose,
            outcome: 'locked',
            attemptsInWindow: state.failedAttempts,
            windowStartedAt: state.windowStartedAt.toISOString(),
            lockedUntil: state.lockedUntil.toISOString(),
          },
          createdAt: now,
        })
        return { status: 'locked' }
      }

      const accepted = await verifyPassword({
        hash: credential.password,
        password: input.password,
      })
      if (accepted) {
        if (state) {
          await transaction
            .delete(destructiveReauthenticationStates)
            .where(eq(destructiveReauthenticationStates.id, state.id))
        }
        return { status: 'succeeded' }
      }

      const windowCutoff = new Date(
        now.getTime() - destructiveReauthenticationPolicy.attemptWindowMilliseconds,
      )
      const continuesWindow =
        state !== undefined &&
        state.windowStartedAt > windowCutoff &&
        state.lockedUntil === null
      const attemptsInWindow = continuesWindow ? state.failedAttempts + 1 : 1
      const becomesLocked =
        attemptsInWindow >= destructiveReauthenticationPolicy.maximumFailedAttempts
      const windowStartedAt = continuesWindow ? state.windowStartedAt : now
      const lockedUntil = becomesLocked
        ? new Date(now.getTime() + destructiveReauthenticationPolicy.lockoutMilliseconds)
        : null
      const stateId = state?.id ?? newUuidV7()

      if (state) {
        await transaction
          .update(destructiveReauthenticationStates)
          .set({
            windowStartedAt,
            failedAttempts: attemptsInWindow,
            lockedUntil,
            lastAttemptAt: now,
            updatedAt: now,
          })
          .where(eq(destructiveReauthenticationStates.id, state.id))
      } else {
        await transaction.insert(destructiveReauthenticationStates).values({
          id: stateId,
          accountId: credential.id,
          purpose: input.purpose,
          windowStartedAt,
          failedAttempts: attemptsInWindow,
          lockedUntil,
          lastAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        })
      }

      const outcome = becomesLocked ? 'locked' : 'failed'
      await transaction.insert(auditEvents).values({
        id: newUuidV7(),
        actorUserId: null,
        subjectUserId: null,
        eventType: 'destructive-reauthentication-denied',
        entityType: 'destructive-reauthentication-state',
        entityId: stateId,
        metadata: {
          purpose: input.purpose,
          outcome,
          attemptsInWindow,
          windowStartedAt: windowStartedAt.toISOString(),
          lockedUntil: lockedUntil?.toISOString() ?? null,
        },
        createdAt: now,
      })

      return { status: outcome }
    },
    { isolationLevel: 'serializable' },
  )
}
