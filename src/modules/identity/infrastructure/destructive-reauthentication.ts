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
  | 'member-reset-issue'
  | 'local-user-create'

export type DestructiveReauthenticationDenial = 'failed' | 'locked'

type ReauthenticationOutcome =
  | { readonly status: 'succeeded' }
  | { readonly status: DestructiveReauthenticationDenial }

export type ReauthenticationDenialAudit = {
  readonly actorUserId: string | null
  readonly subjectUserId: string | null
  readonly eventType: string
  readonly entityType: string
  readonly entityId: string | null
  readonly metadata?: Readonly<Record<string, unknown>>
}

function denialAuditValues(input: {
  readonly audit?: ReauthenticationDenialAudit
  readonly purpose: DestructiveReauthenticationPurpose
  readonly outcome: DestructiveReauthenticationDenial
  readonly stateId: string
  readonly attemptsInWindow: number
  readonly windowStartedAt: Date
  readonly lockedUntil: Date | null
  readonly now: Date
}) {
  return {
    id: newUuidV7(),
    actorUserId: input.audit?.actorUserId ?? null,
    subjectUserId: input.audit?.subjectUserId ?? null,
    eventType: input.audit?.eventType ?? 'destructive-reauthentication-denied',
    entityType: input.audit?.entityType ?? 'destructive-reauthentication-state',
    entityId: input.audit ? input.audit.entityId : input.stateId,
    metadata: {
      ...input.audit?.metadata,
      purpose: input.purpose,
      outcome: input.outcome,
      attemptsInWindow: input.attemptsInWindow,
      windowStartedAt: input.windowStartedAt.toISOString(),
      lockedUntil: input.lockedUntil?.toISOString() ?? null,
    },
    createdAt: input.now,
  }
}

/**
 * Verifies one destructive password challenge and commits denied-attempt state before
 * returning. The caller must hold every relevant credential-lifecycle advisory lock
 * across this function and the protected command. A custom audit context makes this
 * denial the credential action's sole event instead of appending a second wrapper event.
 */
export async function verifyDestructiveReauthentication(input: {
  readonly userId: string
  readonly purpose: DestructiveReauthenticationPurpose
  readonly password: string
  readonly audit?: ReauthenticationDenialAudit
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
      await transaction.insert(auditEvents).values(
        denialAuditValues({
          audit: input.audit,
          purpose: input.purpose,
          outcome,
          stateId,
          attemptsInWindow,
          windowStartedAt,
          lockedUntil,
          now,
        }),
      )

      return { status: outcome }
    },
    { isolationLevel: 'serializable' },
  )
}
