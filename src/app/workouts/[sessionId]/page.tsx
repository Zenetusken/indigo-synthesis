import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import { formatTimeInTimezone } from '@/modules/athletes/domain/time'
import {
  displayLoadValue,
  formatLoad,
  loadUnitLabel,
} from '@/modules/athletes/domain/units'
import { requireActor } from '@/modules/identity/server/actor'
import { getWorkoutSession } from '@/modules/training/application/workouts'
import { evaluateSubstitution } from '@/modules/training/domain/substitution'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import {
  abandonWorkoutAction,
  completeSetAction,
  completeWorkoutAction,
  pauseAction,
  reportPainAction,
  resumeAction,
  skipSetAction,
} from './actions'
import { ContinuationFocus } from './continuation-focus'
import { RestCountdown } from './rest-countdown'
import styles from './workout.module.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Active workout' }

const errorMessages: Readonly<Record<string, string>> = {
  'session.not-active': 'The session is not active. Resume it before recording a set.',
  'session.transition-conflict': 'The saved session changed. Reload before continuing.',
  'session.pending-sets': 'Perform or explicitly skip every prescribed set first.',
  'session.feedback-required': 'Answer the end-of-session safety question.',
  'safety.hold-active': 'A safety hold blocks this action.',
  'safety.pain-reported': 'A reported pain issue blocks normal completion.',
  'content.development-forbidden-in-production':
    'This development session is blocked in reviewed content mode.',
  'content.prohibited': 'This session uses a prohibited content release.',
  'content.expired': 'This session uses an expired content release.',
  'set.already-resolved': 'That set is already performed or skipped.',
  'set.skip-reason-required': 'Enter a reason before skipping the set.',
  'set.save-failed': 'The set was not saved. Your entries remain on this screen.',
}

export default async function WorkoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const actor = await requireActor()
  const { sessionId } = await params
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
  const currentSetId = pendingSets[0]?.id
  const continuationTargetId = currentSetId ? `set-${currentSetId}-actual-load` : null
  const orderedSets = session.exercises.flatMap((exercise) => exercise.sets)
  const currentSetIndex = orderedSets.findIndex((set) => set.id === currentSetId)
  const previousPerformedSet = orderedSets
    .slice(0, currentSetIndex < 0 ? 0 : currentSetIndex)
    .reverse()
    .find((set) => set.status === 'performed' && set.confirmedAt)
  const error = query.error
    ? (errorMessages[query.error] ?? 'The command was not applied.')
    : null

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <Link href={{ pathname: '/today' }}>← Back to Today</Link>
        <span>
          {session.status.toUpperCase()} · VERSION {session.optimisticVersion}
        </span>
      </header>

      <div className={styles.content}>
        <ContinuationFocus targetId={continuationTargetId} />
        <header className={styles.heading}>
          <h1>{session.plannedWorkout.name}</h1>
          <p>
            {session.plannedWorkout.scheduledDate} · Started{' '}
            {formatTimeInTimezone(session.startedAt, timezone)} ·{' '}
            <span aria-atomic="true" aria-live="polite" role="status">
              Draft saved in PostgreSQL at version {session.optimisticVersion}
            </span>
          </p>
        </header>

        {!session.contentEligibility.eligible ? (
          <section className={styles.error} role="alert">
            <strong>Saved session blocked in this content mode</strong>
            <span>
              This prescription remains inspectable, but sets, resume, and completion are
              disabled. You may report a safety issue, pause, or abandon the session; it
              cannot enter completed history.
            </span>
          </section>
        ) : null}

        {error ? (
          <div className={styles.error} role="alert">
            <strong>Command not applied</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {session.feedback?.painReported ? (
          <section className={styles.safetyStop} aria-labelledby="safety-stop-heading">
            <h2 id="safety-stop-heading">Training stopped for a reported issue</h2>
            <p>
              The application cannot assess pain. This session is paused and a persisted
              safety hold blocks further sets or resume. End the workout or seek qualified
              guidance.
            </p>
          </section>
        ) : null}

        {previousPerformedSet?.confirmedAt ? (
          <RestCountdown
            confirmedAt={previousPerformedSet.confirmedAt.toISOString()}
            prescribedSeconds={previousPerformedSet.restSeconds}
            serverNow={new Date().toISOString()}
          />
        ) : null}

        <ol className={styles.exerciseList}>
          {session.exercises.map((exercise) => (
            <li className={styles.exercise} key={exercise.id}>
              <header className={styles.exerciseHeader}>
                <div>
                  <h2>{exercise.exerciseName}</h2>
                  <p>
                    Exercise {exercise.ordinal} · {exercise.rationaleCode}
                  </p>
                </div>
                <div className={styles.priorPerformance}>
                  <span>Prior comparable performance</span>
                  {exercise.priorComparablePerformance ? (
                    <strong>
                      {exercise.priorComparablePerformance.sets.length} performed sets ·{' '}
                      {formatLoad(
                        exercise.priorComparablePerformance.sets[0]?.loadGrams ?? null,
                        units,
                      )}{' '}
                      ×{' '}
                      {exercise.priorComparablePerformance.sets[0]?.repetitions ??
                        'Unavailable'}
                    </strong>
                  ) : (
                    <strong>Unavailable — no completed comparable session</strong>
                  )}
                </div>
              </header>

              {(() => {
                const substitution = evaluateSubstitution(
                  exercise.exerciseCode,
                  'not-selected',
                )
                return substitution.allowed ? null : (
                  <p className={styles.substitutionUnavailable} role="status">
                    Substitution unavailable — {substitution.reason} The original
                    prescription is unchanged.
                  </p>
                )
              })()}

              <ol className={styles.setList}>
                {exercise.sets.map((set) => {
                  const rowClasses = [
                    styles.setRow,
                    set.status === 'performed' ? styles.performed : undefined,
                    set.id === currentSetId ? styles.current : undefined,
                  ]
                    .filter(Boolean)
                    .join(' ')

                  return (
                    <li className={rowClasses} key={set.id}>
                      <span className={styles.notch}>
                        <span className={styles.visuallyHidden}>
                          Set {set.ordinal}: {set.status}
                        </span>
                        <span aria-hidden="true">
                          {set.status === 'performed' ? '✓' : set.ordinal}
                        </span>
                      </span>
                      <div className={styles.target}>
                        <span>Target</span>
                        <strong>
                          {formatLoad(set.targetLoadGrams, units)} ×{' '}
                          {set.targetRepetitions}
                        </strong>
                        <span>{set.restSeconds} s rest</span>
                      </div>

                      {set.status === 'performed' ? (
                        <div className={styles.actualSummary}>
                          <span>User-attested performed</span>
                          <strong>
                            {formatLoad(set.actualLoadGrams, units)} ×{' '}
                            {set.actualRepetitions ?? '—'} · RPE{' '}
                            {set.rpe ?? 'not reported'}
                          </strong>
                          <span>
                            Confirmed{' '}
                            {set.confirmedAt
                              ? formatTimeInTimezone(set.confirmedAt, timezone)
                              : '—'}
                          </span>
                        </div>
                      ) : null}

                      {set.status === 'skipped' ? (
                        <div className={styles.actualSummary}>
                          <span>Explicitly skipped</span>
                          <strong>{set.skipReason}</strong>
                        </div>
                      ) : null}

                      {set.status === 'pending' &&
                      session.status === 'active' &&
                      session.contentEligibility.eligible &&
                      !session.feedback?.painReported ? (
                        <>
                          <form action={completeSetAction} className={styles.setForm}>
                            <input type="hidden" name="sessionId" value={session.id} />
                            <input type="hidden" name="setId" value={set.id} />
                            <input type="hidden" name="commandId" value={newUuidV7()} />
                            <label>
                              <span>Actual load ({unitLabel})</span>
                              <input
                                id={`set-${set.id}-actual-load`}
                                name="actualLoad"
                                type="number"
                                inputMode="decimal"
                                min={0}
                                max={1_000}
                                step={units === 'metric' ? 0.5 : 0.001}
                                defaultValue={displayLoadValue(
                                  set.targetLoadGrams,
                                  units,
                                )}
                                required
                              />
                            </label>
                            <label>
                              <span>Actual reps</span>
                              <input
                                name="actualRepetitions"
                                type="number"
                                inputMode="numeric"
                                min={1}
                                max={100}
                                defaultValue={set.targetRepetitions}
                                required
                              />
                            </label>
                            <label>
                              <span>RPE (optional)</span>
                              <input
                                name="rpe"
                                type="number"
                                inputMode="numeric"
                                min={1}
                                max={10}
                              />
                            </label>
                            <label>
                              <span>Note (optional)</span>
                              <input name="note" type="text" maxLength={500} />
                            </label>
                            <small>
                              Values are copied from the target until edited. Completing
                              the set explicitly attests them.
                            </small>
                            <div className={styles.setActions}>
                              <button className={styles.primaryButton} type="submit">
                                Complete set
                              </button>
                            </div>
                          </form>
                          <form action={skipSetAction} className={styles.skipForm}>
                            <input type="hidden" name="sessionId" value={session.id} />
                            <input type="hidden" name="setId" value={set.id} />
                            <input type="hidden" name="commandId" value={newUuidV7()} />
                            <label>
                              <span>Skip reason</span>
                              <input name="reason" type="text" maxLength={300} required />
                            </label>
                            <button className={styles.secondaryButton} type="submit">
                              Skip set
                            </button>
                          </form>
                        </>
                      ) : null}
                    </li>
                  )
                })}
              </ol>
            </li>
          ))}
        </ol>

        {pendingSets.length === 0 &&
        !session.feedback?.painReported &&
        session.contentEligibility.eligible &&
        ['active', 'paused'].includes(session.status) ? (
          <section className={styles.completePanel}>
            <h2>Review workout completion</h2>
            <p>Every prescribed set is performed or explicitly skipped.</p>
            <form action={completeWorkoutAction}>
              <input type="hidden" name="sessionId" value={session.id} />
              <input type="hidden" name="commandId" value={newUuidV7()} />
              <label>
                <input name="noPainAttested" type="checkbox" required /> I confirm that I
                am not reporting pain or a safety issue from this session.
              </label>
              <button className={styles.primaryButton} type="submit">
                Complete workout
              </button>
            </form>
          </section>
        ) : null}

        {['active', 'paused'].includes(session.status) ? (
          <section className={styles.safetyStop}>
            <h2>Report pain or an issue</h2>
            <p>
              This pauses training and creates a persisted safety hold. It does not
              diagnose the issue.
            </p>
            <form action={reportPainAction} className={styles.safetyForm}>
              <input type="hidden" name="sessionId" value={session.id} />
              <label>
                <span>Optional factual context</span>
                <input name="details" type="text" maxLength={1_000} />
              </label>
              <button className={styles.dangerButton} type="submit">
                Stop and report issue
              </button>
            </form>
          </section>
        ) : null}
      </div>

      {['active', 'paused'].includes(session.status) ? (
        <footer className={styles.dock}>
          <strong>{pendingSets.length} unresolved sets</strong>
          <div className={styles.dockActions}>
            {session.status === 'active' ? (
              <form action={pauseAction}>
                <input type="hidden" name="sessionId" value={session.id} />
                <button className={styles.secondaryButton} type="submit">
                  Pause workout
                </button>
              </form>
            ) : !session.feedback?.painReported && session.contentEligibility.eligible ? (
              <form action={resumeAction}>
                <input type="hidden" name="sessionId" value={session.id} />
                <button className={styles.primaryButton} type="submit">
                  Resume workout
                </button>
              </form>
            ) : null}
            <form action={abandonWorkoutAction}>
              <input type="hidden" name="sessionId" value={session.id} />
              <button className={styles.dangerButton} type="submit">
                Abandon workout
              </button>
            </form>
          </div>
        </footer>
      ) : null}
    </main>
  )
}
