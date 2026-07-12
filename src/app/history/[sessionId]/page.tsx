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
import { PostCompletionSafetyReportForm } from './post-completion-safety-report-form'

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
  const correctedSets = session.exercises.flatMap((exercise) =>
    exercise.sets.filter((set) => set.correction),
  )
  const feedbackCorrection = session.feedback?.correction ?? null

  return (
    <ProductFrame current="history">
      <div className={styles.content}>
        <PageHeading
          eyebrow={`${session.plannedWorkout.scheduledDate} · Session ${session.plannedWorkout.slotCode}`}
          title="Workout completed."
          description={`Started ${formatDateTimeInTimezone(session.startedAt, timezone)} · Completed ${session.completedAt ? formatDateTimeInTimezone(session.completedAt, timezone) : 'Unavailable'}`}
        />

        <InlineStatus
          tone={feedbackCorrection || correctedSets.length > 0 ? 'warning' : 'success'}
        >
          {feedbackCorrection || correctedSets.length > 0
            ? 'Original completion facts retained with append-only audited corrections'
            : 'Persisted immutable completion facts'}
        </InlineStatus>

        {!session.contentEligibility.eligible ? (
          <InlineStatus tone="warning">
            Content release revoked. This page remains a factual history record; Indigo
            will not use this release for new or resumed training.
          </InlineStatus>
        ) : null}

        {feedbackCorrection ? (
          <section className={styles.correction} aria-labelledby="correction-heading">
            <h2 id="correction-heading">Post-completion safety correction</h2>
            <dl className={styles.correctionFacts}>
              <div>
                <dt>Original completion answer</dt>
                <dd>
                  {session.feedback?.original.painReported
                    ? 'Pain or a safety issue was reported at completion'
                    : 'No pain or safety issue reported at completion'}{' '}
                  ·{' '}
                  {session.feedback
                    ? formatDateTimeInTimezone(
                        session.feedback.original.answeredAt,
                        timezone,
                      )
                    : 'time unavailable'}
                </dd>
              </div>
              <div>
                <dt>Effective safety fact</dt>
                <dd>Pain or a safety issue was reported after completion</dd>
              </div>
              <div>
                <dt>Correction recorded</dt>
                <dd>
                  {formatDateTimeInTimezone(feedbackCorrection.createdAt, timezone)}
                </dd>
              </div>
              <div>
                <dt>Reason</dt>
                <dd>{feedbackCorrection.reason}</dd>
              </div>
            </dl>
            {session.feedback?.details ? (
              <p>
                <strong>Factual context:</strong> {session.feedback.details}
              </p>
            ) : null}
            <p>
              Every affected adjustment and descendant program revision is permanently
              invalidated. The original workout remains completed; no replacement load is
              invented.
            </p>
          </section>
        ) : (
          <PostCompletionSafetyReportForm sessionId={session.id} />
        )}

        <section className={styles.facts} aria-labelledby="performed-heading">
          <h2 id="performed-heading">Performed and skipped sets</h2>
          {session.exercises.map((exercise) => (
            <article className={styles.exercise} key={exercise.id}>
              <h3>{exercise.exerciseName}</h3>
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
                    {set.correction ? (
                      <small className={styles.setCorrection}>
                        Original:{' '}
                        {set.original.status === 'performed'
                          ? `${formatLoad(set.original.actualLoadGrams, units)} × ${set.original.actualRepetitions ?? '—'} · RPE ${set.original.rpe ?? 'not reported'}`
                          : `Skipped · ${set.original.skipReason}`}
                        <br />
                        Effective audited correction · {set.correction.reason} ·{' '}
                        {formatDateTimeInTimezone(set.correction.createdAt, timezone)}
                      </small>
                    ) : null}
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
              <li
                className={
                  decision.invalidatedAt ? styles.invalidatedDecision : undefined
                }
                key={decision.id}
              >
                <strong>{decision.exerciseCode}</strong>
                <span>
                  {decision.invalidatedAt
                    ? 'Invalidated original decision'
                    : decision.decision}
                  : {formatLoad(decision.currentLoadGrams, units)} →{' '}
                  {formatLoad(decision.nextLoadGrams, units)}
                </span>
                <code>
                  {decision.reasonCode} · rule {decision.ruleVersion}
                </code>
                {decision.invalidatedAt ? (
                  <small>
                    No longer active · invalidated{' '}
                    {formatDateTimeInTimezone(decision.invalidatedAt, timezone)}
                    {decision.invalidationReason
                      ? ` · ${decision.invalidationReason}`
                      : ''}
                  </small>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </ProductFrame>
  )
}
