import type { Metadata, Route } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import {
  FocusAlert,
  InlineStatus,
  PageHeading,
  ProductFrame,
  SubmitButton,
} from '@/components'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import { formatCalendarDate } from '@/modules/athletes/domain/time'
import { formatLoad } from '@/modules/athletes/domain/units'
import { requireUiActor } from '@/modules/identity/server/actor'
import { SignOutButton } from '@/modules/identity/ui/sign-out-button'
import { getTodayState } from '@/modules/training/application/workouts'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import { startWorkoutAction } from './actions'
import { SafetyHoldResolutionForm } from './safety-hold-resolution-form'
import styles from './today.module.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Today' }

const errorMessages: Readonly<Record<string, string>> = {
  'safety.advanced-ineligible':
    'This workout includes an advanced technique without an approved eligibility rule.',
  'safety.prescription-prohibited': 'This workout contains a prohibited prescription.',
  'safety.hold-active': 'An active safety hold blocks workout start.',
  'content.development-forbidden-in-production':
    'This unreviewed development program cannot run in reviewed content mode.',
  'content.revoked': 'This content release has been revoked.',
  'content.prohibited': 'This content release has been prohibited.',
  'content.expired': 'This content release has expired.',
  'program.revision-invalidated':
    'This workout progression was invalidated by a corrected training fact.',
  'session.start-failed': 'The workout could not be started from the saved prescription.',
}

const blockedHoldMessages = {
  'not-session-pain-hold':
    'This hold was not created from a session pain report, so it cannot be self-resolved here. Training remains stopped.',
  'source-session-missing':
    'The source workout record is unavailable, so this hold cannot be self-resolved. Training remains stopped.',
  'completed-source-awaiting-invalidation':
    'This report came from a completed workout whose progression has not yet been safely invalidated. The hold cannot be resolved here, and training remains stopped.',
} as const

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>
}) {
  const actor = await requireUiActor()
  const profile = await getAthleteProfile(actor.userId)
  if (!profile) redirect('/setup')

  const [state, query] = await Promise.all([
    getTodayState(actor.userId, profile.profile.timezone),
    searchParams,
  ])
  const error = query.error
    ? (errorMessages[query.error] ?? 'The requested action was denied.')
    : null
  const notice =
    query.notice === 'hold-resolved'
      ? 'Safety hold resolution recorded. The source workout remains closed, and any invalidated progression stays unavailable.'
      : null

  return (
    <ProductFrame
      current="today"
      accountActions={<SignOutButton actionBinding={actor.checkedSignOutActionBinding} />}
    >
      <div className={styles.content}>
        <PageHeading
          eyebrow="Today"
          title="The next truthful action."
          description="No readiness score, fallback workout, or invented motivation—only persisted program state."
        />

        {error ? (
          <FocusAlert>
            <InlineStatus tone="error">{error}</InlineStatus>
          </FocusAlert>
        ) : null}

        {notice ? (
          <InlineStatus tone="success" live="polite" role="status">
            {notice}
          </InlineStatus>
        ) : null}

        {state.kind === 'program-required' ? (
          <section className={styles.statePanel}>
            <h2>No active program.</h2>
            <p>Review and activate a program revision before starting a workout.</p>
            <Link className={styles.primaryAction} href={{ pathname: '/program' }}>
              Review program
            </Link>
          </section>
        ) : null}

        {state.kind === 'active' ? (
          <section className={styles.statePanel}>
            <h2>
              {state.progressionInvalidated
                ? 'Workout progression invalidated.'
                : state.contentEligibility.eligible
                  ? state.status === 'paused'
                    ? 'Workout paused.'
                    : 'Workout in progress.'
                  : 'Saved workout blocked in this content mode.'}
            </h2>
            <p>
              {state.progressionInvalidated
                ? 'The session remains available for factual review and abandonment, but it cannot accept more training entries or completion.'
                : state.contentEligibility.eligible
                  ? 'The exact saved session is ready to resume.'
                  : 'The session remains inspectable, but training entries, resume, and completion are disabled. Safe unwind actions remain available without adding it to completed history.'}
            </p>
            <Link
              className={styles.primaryAction}
              href={`/workouts/${state.sessionId}` as Route}
            >
              {state.progressionInvalidated
                ? 'Review invalidated session'
                : state.contentEligibility.eligible
                  ? 'Resume workout'
                  : 'Review blocked session'}
            </Link>
          </section>
        ) : null}

        {state.kind === 'hold' ? (
          <section className={styles.statePanel} aria-labelledby="safety-hold-heading">
            <h2 id="safety-hold-heading">
              Training is stopped for a reported safety issue.
            </h2>
            <p>
              This product cannot assess pain or other symptoms. Resolving this hold is
              only a record of your decision; it is not a medical clearance.
            </p>
            {state.resolutionAvailability.kind === 'requires-abandonment' ? (
              <p>
                The affected workout is still live.{' '}
                <Link
                  href={`/workouts/${state.resolutionAvailability.sessionId}` as Route}
                >
                  Open it and abandon the session
                </Link>{' '}
                before you can resolve this hold.
              </p>
            ) : null}
            {state.resolutionAvailability.kind === 'blocked' ? (
              <p className={styles.holdConstraint} role="status">
                {blockedHoldMessages[state.resolutionAvailability.reason]}
              </p>
            ) : null}
            {state.resolutionAvailability.kind === 'available' ? (
              <SafetyHoldResolutionForm commandId={newUuidV7()} holdId={state.holdId} />
            ) : null}
          </section>
        ) : null}

        {state.kind === 'planned' ? (
          <section className={styles.statePanel}>
            <h2>
              {state.contentEligibility.eligible
                ? `Session ${state.workout.slotCode} is scheduled.`
                : 'Scheduled workout blocked in this content mode.'}
            </h2>
            <p>
              {formatCalendarDate(state.workout.scheduledDate)} ·{' '}
              {state.contentEligibility.eligible
                ? 'Unreviewed development fixture'
                : 'The persisted content release is not eligible for new training entries.'}
            </p>
            {!state.contentEligibility.eligible ? (
              <InlineStatus tone="error" live="polite" role="status">
                {errorMessages[state.contentEligibility.code] ??
                  'The persisted content release is not eligible to start.'}
              </InlineStatus>
            ) : null}
            <ol className={styles.preview}>
              {state.workout.exercises.map((exercise) => {
                const set = exercise.sets[0]
                return (
                  <li key={exercise.id}>
                    <span>{String(exercise.ordinal).padStart(2, '0')}</span>
                    <strong>{exercise.exerciseName}</strong>
                    <code>
                      {exercise.sets.length} × {set?.targetRepetitions ?? '—'} ·{' '}
                      {set
                        ? formatLoad(set.targetLoadGrams, profile.profile.units)
                        : 'Unavailable'}
                    </code>
                  </li>
                )
              })}
            </ol>
            {state.contentEligibility.eligible ? (
              <form action={startWorkoutAction}>
                <input type="hidden" name="plannedWorkoutId" value={state.workout.id} />
                <input type="hidden" name="commandId" value={newUuidV7()} />
                <SubmitButton variant="primary" pendingLabel="Starting…">
                  Start workout
                </SubmitButton>
              </form>
            ) : null}
          </section>
        ) : null}

        {state.kind === 'rest-day' ? (
          <section className={styles.statePanel}>
            <h2>No workout is scheduled today.</h2>
            <p>Rest is part of the program, not a missed-day score.</p>
            <p className={styles.next}>
              {state.nextWorkout
                ? `Next: ${state.nextWorkout.name} on ${formatCalendarDate(state.nextWorkout.date)}`
                : 'No later workout exists in this revision.'}
            </p>
          </section>
        ) : null}

        {state.kind === 'completed' ? (
          <section className={styles.statePanel}>
            <h2>Today’s workout is complete.</h2>
            <p>The immutable factual summary is available in History.</p>
            <Link
              className={styles.primaryAction}
              href={`/history/${state.sessionId}` as Route}
            >
              View completed workout
            </Link>
          </section>
        ) : null}

        {state.kind === 'abandoned' ? (
          <section className={styles.statePanel}>
            <h2>Today’s workout was abandoned.</h2>
            <p>
              The saved terminal state is retained truthfully; this prescription cannot be
              silently restarted as a new session.
            </p>
            <p className={styles.next}>
              {state.nextWorkout
                ? `Next: ${state.nextWorkout.name} on ${formatCalendarDate(state.nextWorkout.date)}`
                : 'No later workout exists in this revision.'}
            </p>
          </section>
        ) : null}
      </div>
    </ProductFrame>
  )
}
