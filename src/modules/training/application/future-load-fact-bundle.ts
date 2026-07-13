import { getAthleteProfile } from '@/modules/athletes/application/profile'
import type { DisplayUnits } from '@/modules/athletes/domain/units'
import { formatLoad } from '@/modules/athletes/domain/units'
import {
  type FutureLoadDecisionView,
  getSessionFutureLoadDecisions,
  getWorkoutSession,
  type WorkoutSessionView,
  type WorkoutSetView,
} from '@/modules/training/application/workouts'
import { getServerConfig } from '@/platform/config/server'
import {
  buildFutureLoadFactBundle,
  type ExplanationFactBundle,
  FactBundleBuildError,
  factBundleHash,
  type PersistedFutureLoadDecision,
} from '@/platform/llm'

export type FutureLoadFactBundleBuildError = {
  readonly decisionId: string
  readonly exerciseCode: string
  readonly message: string
}

export type FutureLoadFactBundleItem = {
  readonly decision: FutureLoadDecisionView
  readonly factBundle: ExplanationFactBundle
  readonly factBundleHash: string
}

export type FutureLoadFactBundlesResult =
  | { readonly status: 'unavailable'; readonly reason: 'not-found' | 'ineligible' }
  | {
      readonly status: 'available'
      readonly bundles: readonly FutureLoadFactBundleItem[]
      readonly buildErrors: readonly FutureLoadFactBundleBuildError[]
    }

function mapSetFact(
  set: WorkoutSetView,
): ExplanationFactBundle['decision']['setFacts'][number] {
  if (set.status === 'skipped') {
    return {
      ordinal: set.ordinal,
      status: 'skipped',
      loadGrams: null,
      repetitions: null,
      rpe: null,
      explicitlyConfirmed: null,
      skipReason: set.skipReason,
    }
  }

  return {
    ordinal: set.ordinal,
    status: 'performed',
    loadGrams: set.actualLoadGrams,
    repetitions: set.actualRepetitions,
    rpe: set.rpe,
    // Workout view does not yet expose explicitlyConfirmed; treat confirmedAt as proxy.
    explicitlyConfirmed: set.confirmedAt !== null,
    skipReason: null,
  }
}

/** Stable presentation invalidation when post-completion pain supersedes active framing. */
export const POST_COMPLETION_PAIN_INVALIDATION_REASON = 'post-completion-pain-report'

/**
 * Derives explanation invalidation without rewriting immutable adjustment_decision rows.
 * Post-completion pain means "active increase/hold" prose is no longer honest framing.
 */
export function isFutureLoadExplanationInvalidated(session: WorkoutSessionView):
  | { readonly invalidated: true; readonly invalidationReason: string }
  | {
      readonly invalidated: false
      readonly invalidationReason: null
    } {
  if (session.status === 'completed' && session.feedback?.painReported === true) {
    return {
      invalidated: true,
      invalidationReason: POST_COMPLETION_PAIN_INVALIDATION_REASON,
    }
  }
  return { invalidated: false, invalidationReason: null }
}

/**
 * Maps a typed future-load decision view + session snapshot into the platform
 * PersistedFutureLoadDecision DTO. Does not invent loads or reason codes.
 *
 * Note: decision evaluation at complete currently hardcodes painReported=false into the
 * methodology call; we still surface session.feedback.painReported on the FactBundle for
 * honesty without rewriting the stored reasonCode. Post-completion pain invalidates
 * explanation generation only (ledger rows stay immutable).
 */
export function toPersistedFutureLoadDecision(input: {
  readonly decision: FutureLoadDecisionView
  readonly session: WorkoutSessionView
  readonly units: DisplayUnits
  readonly contentMode: 'development' | 'reviewed'
}): PersistedFutureLoadDecision {
  const { decision, session, units, contentMode } = input
  const exercise = session.exercises.find(
    (item) => item.exerciseCode === decision.exerciseCode,
  )
  if (!exercise) {
    throw new FactBundleBuildError(
      `No session exercise snapshot for code ${decision.exerciseCode}.`,
    )
  }

  const { invalidated, invalidationReason } = isFutureLoadExplanationInvalidated(session)

  return {
    decisionId: decision.id,
    sessionId: decision.sessionId,
    exerciseCode: decision.exerciseCode,
    exerciseName: decision.exerciseName || exercise.exerciseName,
    decision: decision.decision,
    currentLoadGrams: decision.currentLoadGrams,
    nextLoadGrams: decision.nextLoadGrams,
    reasonCode: decision.reasonCode,
    ruleVersion: decision.ruleVersion,
    currentLoadLabel: formatLoad(decision.currentLoadGrams, units),
    proposedLoadLabel: formatLoad(decision.nextLoadGrams, units),
    units,
    contentMode,
    engineVersion: decision.engineVersion,
    methodologyId: decision.methodologyId,
    methodologyVersion: decision.methodologyVersion,
    painReported: session.feedback?.painReported ?? null,
    invalidated,
    invalidationReason,
    setFacts: exercise.sets.map(mapSetFact),
  }
}

export function buildSessionFutureLoadFactBundles(input: {
  readonly decisions: readonly FutureLoadDecisionView[]
  readonly session: WorkoutSessionView
  readonly units: DisplayUnits
  readonly contentMode: 'development' | 'reviewed'
}): {
  readonly bundles: readonly FutureLoadFactBundleItem[]
  readonly buildErrors: readonly FutureLoadFactBundleBuildError[]
} {
  const bundles: FutureLoadFactBundleItem[] = []
  const buildErrors: FutureLoadFactBundleBuildError[] = []

  for (const decision of input.decisions) {
    try {
      const persisted = toPersistedFutureLoadDecision({
        decision,
        session: input.session,
        units: input.units,
        contentMode: input.contentMode,
      })
      const factBundle = buildFutureLoadFactBundle(persisted)
      bundles.push({
        decision,
        factBundle,
        factBundleHash: factBundleHash(factBundle),
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown FactBundle build failure'
      buildErrors.push({
        decisionId: decision.id,
        exerciseCode: decision.exerciseCode,
        message,
      })
    }
  }

  return { bundles, buildErrors }
}

/**
 * Application use case: build contract FactBundles for a completed session's
 * future-load decisions. Does not call a language model.
 */
export async function getFutureLoadFactBundlesForSession(
  userId: string,
  sessionId: string,
): Promise<FutureLoadFactBundlesResult> {
  const [session, decisions, profile] = await Promise.all([
    getWorkoutSession(userId, sessionId),
    getSessionFutureLoadDecisions(userId, sessionId),
    getAthleteProfile(userId),
  ])

  if (session?.status !== 'completed') {
    return { status: 'unavailable', reason: 'not-found' }
  }
  if (decisions === null) {
    // null means not found or ineligible (same as getSessionAdjustments)
    return { status: 'unavailable', reason: 'ineligible' }
  }
  if (!profile) {
    return { status: 'unavailable', reason: 'not-found' }
  }

  const contentMode = getServerConfig().contentMode
  const { bundles, buildErrors } = buildSessionFutureLoadFactBundles({
    decisions,
    session,
    units: profile.profile.units,
    contentMode,
  })

  return {
    status: 'available',
    bundles,
    buildErrors,
  }
}
