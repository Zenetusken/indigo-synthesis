import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { InlineStatus, PageHeading, ProductFrame } from '@/components'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import { formatDateTimeInTimezone } from '@/modules/athletes/domain/time'
import { formatLoad } from '@/modules/athletes/domain/units'
import { requireActor } from '@/modules/identity/server/actor'
import {
  getSessionAdjustments,
  getWorkoutSession,
} from '@/modules/training/application/workouts'
import styles from '../history.module.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Workout history' }

export default async function SessionHistoryPage({
  params,
}: {
  params: Promise<{ sessionId: string }>
}) {
  const actor = await requireActor()
  const { sessionId } = await params
  const [session, adjustments, profile] = await Promise.all([
    getWorkoutSession(actor.userId, sessionId),
    getSessionAdjustments(actor.userId, sessionId),
    getAthleteProfile(actor.userId),
  ])
  if (session?.status !== 'completed' || !adjustments || !profile) notFound()
  const units = profile.profile.units
  const timezone = profile.profile.timezone

  return (
    <ProductFrame current="history">
      <div className={styles.content}>
        <PageHeading
          eyebrow={`${session.plannedWorkout.scheduledDate} · Session ${session.plannedWorkout.slotCode}`}
          title="Workout completed."
          description={`Started ${formatDateTimeInTimezone(session.startedAt, timezone)} · Completed ${session.completedAt ? formatDateTimeInTimezone(session.completedAt, timezone) : 'Unavailable'}`}
        />

        <InlineStatus tone="success">Persisted immutable completion facts</InlineStatus>

        <section className={styles.facts} aria-labelledby="performed-heading">
          <h2 id="performed-heading">Performed and skipped sets</h2>
          {session.exercises.map((exercise) => (
            <article className={styles.exercise} key={exercise.id}>
              <h2>{exercise.exerciseName}</h2>
              <ol className={styles.sets}>
                {exercise.sets.map((set) => (
                  <li key={set.id}>
                    <span>Set {set.ordinal}</span>
                    {set.status === 'performed' ? (
                      <strong>
                        {formatLoad(set.actualLoadGrams, units)} ×{' '}
                        {set.actualRepetitions ?? '—'} · RPE {set.rpe ?? 'not reported'}
                      </strong>
                    ) : (
                      <strong>Skipped · {set.skipReason}</strong>
                    )}
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </section>

        <section className={styles.adjustments} aria-labelledby="adjustment-heading">
          <h2 id="adjustment-heading">Future-load decisions</h2>
          <p>
            Development policy only. These deterministic outputs are not human-reviewed
            coaching guidance.
          </p>
          <ul className={styles.adjustmentList}>
            {adjustments.map((decision) => (
              <li key={decision.id}>
                <strong>{decision.exerciseCode}</strong>
                <span>
                  {decision.decision}: {formatLoad(decision.currentLoadGrams, units)} →{' '}
                  {formatLoad(decision.nextLoadGrams, units)}
                </span>
                <code>
                  {decision.reasonCode} · rule {decision.ruleVersion}
                </code>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </ProductFrame>
  )
}
