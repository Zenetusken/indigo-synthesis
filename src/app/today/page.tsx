import type { Metadata, Route } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { InlineStatus, PageHeading, ProductFrame } from '@/components'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import { formatLoad } from '@/modules/athletes/domain/units'
import { requireActor } from '@/modules/identity/server/actor'
import { getTodayState } from '@/modules/training/application/workouts'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import { startWorkoutAction } from './actions'
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
  'content.prohibited': 'This content release has been prohibited.',
  'content.expired': 'This content release has expired.',
  'session.start-failed': 'The workout could not be started from the saved prescription.',
}

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const actor = await requireActor()
  const profile = await getAthleteProfile(actor.userId)
  if (!profile) redirect('/setup')

  const [state, query] = await Promise.all([
    getTodayState(actor.userId, profile.profile.timezone),
    searchParams,
  ])
  const error = query.error
    ? (errorMessages[query.error] ?? 'The requested action was denied.')
    : null

  return (
    <ProductFrame current="today">
      <div className={styles.content}>
        <PageHeading
          eyebrow="Today"
          title="The next truthful action."
          description="No readiness score, fallback workout, or invented motivation—only persisted program state."
        />

        {error ? (
          <InlineStatus tone="error" live="assertive">
            {error} No session was created.
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
              {state.contentEligibility.eligible
                ? state.status === 'paused'
                  ? 'Workout paused.'
                  : 'Workout in progress.'
                : 'Saved workout blocked in this content mode.'}
            </h2>
            <p>
              {state.contentEligibility.eligible
                ? 'The exact saved session is ready to resume.'
                : 'The session remains inspectable, but training entries, resume, and completion are disabled. Safe unwind actions remain available without adding it to completed history.'}
            </p>
            <Link
              className={styles.primaryAction}
              href={`/workouts/${state.sessionId}` as Route}
            >
              {state.contentEligibility.eligible
                ? 'Resume workout'
                : 'Review blocked session'}
            </Link>
          </section>
        ) : null}

        {state.kind === 'planned' ? (
          <section className={styles.statePanel}>
            <h2>Session {state.workout.slotCode} is scheduled.</h2>
            <p>{state.workout.scheduledDate} · Unreviewed development fixture</p>
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
            <form action={startWorkoutAction}>
              <input type="hidden" name="plannedWorkoutId" value={state.workout.id} />
              <input type="hidden" name="commandId" value={newUuidV7()} />
              <button className={styles.primaryAction} type="submit">
                Start workout
              </button>
            </form>
          </section>
        ) : null}

        {state.kind === 'rest-day' ? (
          <section className={styles.statePanel}>
            <h2>No workout is scheduled today.</h2>
            <p>Rest is part of the program, not a missed-day score.</p>
            <p className={styles.next}>
              {state.nextWorkout
                ? `Next: ${state.nextWorkout.name} on ${state.nextWorkout.date}`
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
                ? `Next: ${state.nextWorkout.name} on ${state.nextWorkout.date}`
                : 'No later workout exists in this revision.'}
            </p>
          </section>
        ) : null}
      </div>
    </ProductFrame>
  )
}
