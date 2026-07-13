import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import { loadUnitLabel } from '@/modules/athletes/domain/units'
import { requireActorForWorkout } from '@/modules/identity/server/actor'
import { getWorkoutSession } from '@/modules/training/application/workouts'
import { WorkoutClient } from './workout-client'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Active workout' }

export default async function WorkoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { sessionId } = await params
  const actor = await requireActorForWorkout(sessionId)
  const [session, profile, query] = await Promise.all([
    getWorkoutSession(actor.userId, sessionId),
    getAthleteProfile(actor.userId),
    searchParams,
  ])
  if (!session || !profile) notFound()

  const units = profile.profile.units
  const unitLabel = loadUnitLabel(units)
  const timezone = profile.profile.timezone

  const pendingSets = session.exercises
    .flatMap((exercise) => exercise.sets)
    .filter((set) => set.status === 'pending')
  const currentSetId = session.progressionInvalidated
    ? null
    : (pendingSets[0]?.id ?? null)
  const canComplete =
    !session.progressionInvalidated &&
    pendingSets.length === 0 &&
    !session.feedback?.painReported &&
    session.contentEligibility.eligible &&
    session.status === 'active'
  const continuationTargetId = currentSetId
    ? `set-${currentSetId}-actual-load`
    : canComplete
      ? 'complete-workout-ack'
      : session.status === 'paused' &&
          !session.progressionInvalidated &&
          !session.feedback?.painReported &&
          session.contentEligibility.eligible
        ? 'resume-workout'
        : null
  const orderedSets = session.exercises.flatMap((exercise) => exercise.sets)
  const currentSetIndex = orderedSets.findIndex((set) => set.id === currentSetId)
  const previousPerformedSet = session.progressionInvalidated
    ? null
    : orderedSets
        .slice(0, currentSetIndex < 0 ? 0 : currentSetIndex)
        .reverse()
        .find((set) => set.status === 'performed' && set.confirmedAt)

  return (
    <WorkoutClient
      session={session}
      units={units}
      unitLabel={unitLabel}
      timezone={timezone}
      pendingSets={pendingSets}
      currentSetId={currentSetId}
      continuationTargetId={continuationTargetId}
      previousPerformedSet={previousPerformedSet ?? null}
      initialError={query.error ?? null}
      serverNow={new Date().toISOString()}
    />
  )
}
