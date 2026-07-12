'use client'

import Link from 'next/link'
import { type FormEvent, useEffect, useRef, useState, useTransition } from 'react'
import { formatTimeInTimezone } from '@/modules/athletes/domain/time'
import {
  type DisplayUnits,
  displayLoadValue,
  formatLoad,
  maximumDisplayLoadValue,
} from '@/modules/athletes/domain/units'
import type {
  WorkoutSessionView,
  WorkoutSetView,
} from '@/modules/training/application/workouts'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import {
  abandonWorkoutAction,
  completeSetAction,
  completeWorkoutAction,
  pauseAction,
  proposeExerciseSubstitutionAction,
  reportPainAction,
  resumeAction,
  skipSetAction,
  type WorkoutActionResult,
} from './actions'
import { ContinuationFocus } from './continuation-focus'
import { RestCountdown } from './rest-countdown'
import styles from './workout.module.css'

const errorMessages: Readonly<Record<string, string>> = {
  'profile.missing': 'Profile not found.',
  'input.invalid': 'Check the entered values.',
  'input.invalid-number': 'A required number is missing or invalid.',
  'session.not-active': 'The session is not active. Resume it before recording a set.',
  'session.transition-conflict': 'The saved session changed. Reload before continuing.',
  'session.pending-sets': 'Perform or explicitly skip every prescribed set first.',
  'session.feedback-required': 'Answer the end-of-session safety question.',
  'session.pause-failed': 'The workout could not be paused. Try again.',
  'session.resume-failed': 'The workout could not be resumed. Try again.',
  'session.complete-failed': 'The workout could not be completed. Try again.',
  'session.abandon-failed': 'The workout could not be abandoned. Try again.',
  'session.not-abandonable': 'The session is no longer active or paused.',
  'program.revision-invalidated':
    'A corrected training fact invalidated this workout progression.',
  'safety.hold-active': 'A safety hold blocks this action.',
  'safety.pain-reported': 'A reported pain issue blocks normal completion.',
  'safety.report-failed': 'The issue could not be reported. Try again.',
  'content.development-forbidden-in-production':
    'This development session is blocked in reviewed content mode.',
  'content.prohibited': 'This session uses a prohibited content release.',
  'content.expired': 'This session uses an expired content release.',
  'set.already-resolved': 'That set is already performed or skipped.',
  'set.skip-reason-required': 'Enter a reason before skipping the set.',
  'set.skip-failed': 'The set could not be skipped. Try again.',
  'set.save-failed': 'The set was not saved. Your entries remain on this screen.',
  'substitution.unapproved':
    'No reviewed, equipment-compatible substitution release is installed.',
  'substitution.proposal-failed':
    'The substitution proposal could not be evaluated. Try again.',
  'abandon.reason-required': 'Enter a factual reason for abandoning the workout.',
  'abandon.ack-required':
    'Confirm that you understand this product does not assess or clear symptoms.',
}

type WorkoutClientProps = {
  session: WorkoutSessionView
  units: DisplayUnits
  unitLabel: 'kg' | 'lb'
  timezone: string
  pendingSets: WorkoutSetView[]
  currentSetId: string | null
  continuationTargetId: string | null
  previousPerformedSet: WorkoutSetView | null
  initialError: string | null
  serverNow: string
}

function useWorkoutForm(action: (formData: FormData) => Promise<WorkoutActionResult>) {
  const [isPending, startTransition] = useTransition()
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const alertRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (errorCode) alertRef.current?.focus()
  }, [errorCode])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    startTransition(async () => {
      setErrorCode(null)
      const result = await action(formData)
      if (!result.success) {
        setErrorCode(result.code)
      }
    })
  }

  return { isPending, errorCode, alertRef, submit }
}

function FormError({
  code,
  alertRef,
}: {
  code: string
  alertRef: React.RefObject<HTMLDivElement | null>
}) {
  return (
    <div className={styles.error} role="alert" tabIndex={-1} ref={alertRef}>
      <strong>Command not applied</strong>
      <span>{errorMessages[code] ?? 'The command was not applied.'}</span>
    </div>
  )
}

function SetForm({
  sessionId,
  set,
  units,
  unitLabel,
}: {
  sessionId: string
  set: WorkoutSetView
  units: DisplayUnits
  unitLabel: 'kg' | 'lb'
}) {
  const { isPending, errorCode, alertRef, submit } = useWorkoutForm(completeSetAction)
  const [commandId] = useState(() => newUuidV7())
  const [actualLoad, setActualLoad] = useState(() =>
    String(displayLoadValue(set.targetLoadGrams, units)),
  )
  const [actualRepetitions, setActualRepetitions] = useState(() =>
    String(set.targetRepetitions),
  )
  const [rpe, setRpe] = useState('')
  const [note, setNote] = useState('')
  const maxLoad = maximumDisplayLoadValue(units)

  return (
    <form onSubmit={submit} className={styles.setForm} aria-busy={isPending}>
      {errorCode ? <FormError code={errorCode} alertRef={alertRef} /> : null}
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="setId" value={set.id} />
      <input type="hidden" name="commandId" value={commandId} />
      <label>
        <span>Actual load ({unitLabel})</span>
        <input
          id={`set-${set.id}-actual-load`}
          name="actualLoad"
          type="number"
          inputMode="decimal"
          min={0}
          max={maxLoad}
          step="any"
          value={actualLoad}
          onChange={(event) => setActualLoad(event.target.value)}
          required
          disabled={isPending}
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
          value={actualRepetitions}
          onChange={(event) => setActualRepetitions(event.target.value)}
          required
          disabled={isPending}
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
          value={rpe}
          onChange={(event) => setRpe(event.target.value)}
          disabled={isPending}
        />
      </label>
      <label>
        <span>Note (optional)</span>
        <input
          name="note"
          type="text"
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={isPending}
        />
      </label>
      <small>
        Values are copied from the target until edited. Completing the set explicitly
        attests them.
      </small>
      <div className={styles.setActions}>
        <button className={styles.primaryButton} type="submit" disabled={isPending}>
          {isPending ? 'Saving…' : 'Complete set'}
        </button>
      </div>
    </form>
  )
}

function SkipForm({ sessionId, set }: { sessionId: string; set: WorkoutSetView }) {
  const { isPending, errorCode, alertRef, submit } = useWorkoutForm(skipSetAction)
  const [commandId] = useState(() => newUuidV7())
  const [reason, setReason] = useState('')

  return (
    <form onSubmit={submit} className={styles.skipForm} aria-busy={isPending}>
      {errorCode ? <FormError code={errorCode} alertRef={alertRef} /> : null}
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="setId" value={set.id} />
      <input type="hidden" name="commandId" value={commandId} />
      <label>
        <span>Skip reason</span>
        <input
          name="reason"
          type="text"
          maxLength={300}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
          disabled={isPending}
        />
      </label>
      <button className={styles.secondaryButton} type="submit" disabled={isPending}>
        Skip set
      </button>
    </form>
  )
}

function SubstitutionProposalForm({
  sessionId,
  sessionExerciseId,
  originalExerciseName,
}: {
  sessionId: string
  sessionExerciseId: string
  originalExerciseName: string
}) {
  const { isPending, errorCode, alertRef, submit } = useWorkoutForm(
    proposeExerciseSubstitutionAction,
  )
  const [commandId] = useState(() => newUuidV7())
  const [requestedExerciseCode, setRequestedExerciseCode] = useState('')

  return (
    <section
      className={styles.substitutionPanel}
      aria-label={`Substitution proposal for ${originalExerciseName}`}
    >
      <div className={styles.substitutionProof}>
        <strong>Prescription unchanged</strong>
        <span>{originalExerciseName} remains the prescribed exercise.</span>
      </div>
      {errorCode ? (
        <div
          className={styles.substitutionUnavailable}
          role="alert"
          tabIndex={-1}
          ref={alertRef}
        >
          <strong>Substitution not applied</strong>
          <span>{errorMessages[errorCode] ?? 'The substitution was not applied.'}</span>
          <span>The original prescription remains unchanged.</span>
        </div>
      ) : null}
      <form className={styles.substitutionForm} onSubmit={submit} aria-busy={isPending}>
        <input type="hidden" name="sessionId" value={sessionId} />
        <input type="hidden" name="sessionExerciseId" value={sessionExerciseId} />
        <input type="hidden" name="commandId" value={commandId} />
        <label>
          <span>Requested exercise</span>
          <input
            name="requestedExerciseCode"
            type="text"
            maxLength={200}
            value={requestedExerciseCode}
            onChange={(event) => setRequestedExerciseCode(event.target.value)}
            aria-describedby={`substitution-help-${sessionExerciseId}`}
            required
            disabled={isPending}
          />
        </label>
        <p id={`substitution-help-${sessionExerciseId}`}>
          Enter the exercise name or catalog code you want considered.
        </p>
        <button className={styles.secondaryButton} type="submit" disabled={isPending}>
          {isPending ? 'Checking proposal…' : 'Propose substitute'}
        </button>
      </form>
    </section>
  )
}

function CompleteWorkoutForm({ sessionId }: { sessionId: string }) {
  const { isPending, errorCode, alertRef, submit } = useWorkoutForm(completeWorkoutAction)
  const [commandId] = useState(() => newUuidV7())
  const [checked, setChecked] = useState(false)

  return (
    <section className={styles.completePanel}>
      <h2>Review workout completion</h2>
      <p>Every prescribed set is performed or explicitly skipped.</p>
      {errorCode ? <FormError code={errorCode} alertRef={alertRef} /> : null}
      <form onSubmit={submit} aria-busy={isPending}>
        <input type="hidden" name="sessionId" value={sessionId} />
        <input type="hidden" name="commandId" value={commandId} />
        <label>
          <input
            id="complete-workout-ack"
            name="noPainAttested"
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            required
            disabled={isPending}
          />{' '}
          I confirm that I am not reporting pain or a safety issue from this session.
        </label>
        <button className={styles.primaryButton} type="submit" disabled={isPending}>
          {isPending ? 'Completing…' : 'Complete workout'}
        </button>
      </form>
    </section>
  )
}

function ReportPainForm({ sessionId }: { sessionId: string }) {
  const { isPending, errorCode, alertRef, submit } = useWorkoutForm(reportPainAction)
  const [commandId] = useState(() => newUuidV7())
  const [details, setDetails] = useState('')

  return (
    <section
      className={styles.safetyStop}
      id="report-pain"
      aria-labelledby="report-pain-heading"
    >
      <h2 id="report-pain-heading">Report pain or an issue</h2>
      <p>
        This pauses training and creates a persisted safety hold. It does not diagnose the
        issue.
      </p>
      {errorCode ? <FormError code={errorCode} alertRef={alertRef} /> : null}
      <form onSubmit={submit} className={styles.safetyForm} aria-busy={isPending}>
        <input type="hidden" name="sessionId" value={sessionId} />
        <input type="hidden" name="commandId" value={commandId} />
        <label>
          <span>Optional factual context</span>
          <input
            name="details"
            type="text"
            maxLength={1_000}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            disabled={isPending}
          />
        </label>
        <button className={styles.dangerButton} type="submit" disabled={isPending}>
          {isPending ? 'Reporting…' : 'Stop and report issue'}
        </button>
      </form>
    </section>
  )
}

function PauseResumeForm({
  sessionId,
  status,
  painReported,
  eligible,
}: {
  sessionId: string
  status: string
  painReported: boolean
  eligible: boolean
}) {
  const pause = useWorkoutForm(pauseAction)
  const resume = useWorkoutForm(resumeAction)

  if (status === 'active') {
    return (
      <form onSubmit={pause.submit} aria-busy={pause.isPending}>
        {pause.errorCode ? (
          <FormError code={pause.errorCode} alertRef={pause.alertRef} />
        ) : null}
        <input type="hidden" name="sessionId" value={sessionId} />
        <button
          className={styles.secondaryButton}
          type="submit"
          disabled={pause.isPending}
        >
          {pause.isPending ? 'Pausing…' : 'Pause workout'}
        </button>
      </form>
    )
  }

  if (!painReported && eligible) {
    return (
      <form onSubmit={resume.submit} aria-busy={resume.isPending}>
        {resume.errorCode ? (
          <FormError code={resume.errorCode} alertRef={resume.alertRef} />
        ) : null}
        <input type="hidden" name="sessionId" value={sessionId} />
        <button
          id="resume-workout"
          className={styles.primaryButton}
          type="submit"
          disabled={resume.isPending}
        >
          {resume.isPending ? 'Resuming…' : 'Resume workout'}
        </button>
      </form>
    )
  }

  return null
}

function AbandonPanel({ sessionId }: { sessionId: string }) {
  const [isRevealed, setIsRevealed] = useState(false)
  const [reason, setReason] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const alertRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (errorCode) alertRef.current?.focus()
  }, [errorCode])

  function close() {
    setIsRevealed(false)
    setReason('')
    setAcknowledged(false)
    setErrorCode(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    setErrorCode(null)

    if (!reason.trim()) {
      setErrorCode('abandon.reason-required')
      return
    }
    if (!acknowledged) {
      setErrorCode('abandon.ack-required')
      return
    }

    const formData = new FormData(form)
    startTransition(async () => {
      const result = await abandonWorkoutAction(formData)
      if (!result.success) {
        setErrorCode(result.code)
      }
      // Success redirects to /today.
    })
  }

  if (!isRevealed) {
    return (
      <button
        type="button"
        className={styles.dangerButton}
        onClick={() => setIsRevealed(true)}
      >
        Abandon workout
      </button>
    )
  }

  return (
    <div className={styles.abandonPanel}>
      {errorCode ? (
        <div className={styles.error} role="alert" tabIndex={-1} ref={alertRef}>
          <strong>Abandon not confirmed</strong>
          <span>{errorMessages[errorCode] ?? 'The workout could not be abandoned.'}</span>
        </div>
      ) : null}
      <form onSubmit={submit} aria-busy={isPending}>
        <input type="hidden" name="sessionId" value={sessionId} />
        <label>
          <span>Factual reason for abandoning (required)</span>
          <input
            name="reason"
            type="text"
            maxLength={300}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            aria-required="true"
            disabled={isPending}
          />
        </label>
        <label className={styles.checkboxLabel}>
          <input
            name="acknowledged"
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            aria-required="true"
            disabled={isPending}
          />{' '}
          I understand that this product does not assess or clear symptoms.
        </label>
        <div className={styles.abandonActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={close}
            disabled={isPending}
          >
            Cancel
          </button>
          <button className={styles.dangerButton} type="submit" disabled={isPending}>
            {isPending ? 'Abandoning…' : 'Confirm abandon'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function WorkoutClient({
  session,
  units,
  unitLabel,
  timezone,
  pendingSets,
  currentSetId,
  continuationTargetId,
  previousPerformedSet,
  initialError,
  serverNow,
}: WorkoutClientProps) {
  return (
    <main className={styles.page}>
      <a className={styles.skipLink} href="#workout-content">
        Skip to workout content
      </a>

      <header className={styles.topbar}>
        <Link href={{ pathname: '/today' }}>← Back to Today</Link>
        <span>
          {session.status} · version {session.optimisticVersion}
        </span>
      </header>

      <div className={styles.content} id="workout-content" tabIndex={-1}>
        <ContinuationFocus
          targetId={initialError ? 'workout-command-error' : continuationTargetId}
        />
        <header className={styles.heading}>
          <h1>{session.plannedWorkout.name}</h1>
          <p>
            {session.plannedWorkout.scheduledDate} · Started{' '}
            {formatTimeInTimezone(session.startedAt, timezone)} ·{' '}
            <span aria-atomic="true" aria-live="polite" role="status">
              Draft saved · revision {session.optimisticVersion}
            </span>
          </p>
        </header>

        {session.progressionInvalidated ? (
          <section
            className={styles.invalidationStop}
            aria-labelledby="progression-invalidated-heading"
          >
            <h2 id="progression-invalidated-heading">
              This workout progression was invalidated.
            </h2>
            <p>
              A corrected training fact invalidated the revision behind this saved
              session. Its facts remain available for inspection, but no sets,
              substitution proposals, safety reports, resume, pause, or completion can be
              recorded. Abandoning the session is the only available close-out action.
            </p>
          </section>
        ) : null}

        {!session.contentEligibility.eligible && !session.progressionInvalidated ? (
          <section className={styles.error} role="alert">
            <strong>Saved session blocked in this content mode</strong>
            <span>
              This prescription remains inspectable, but sets, resume, and completion are
              disabled. You may report a safety issue, pause, or abandon the session; it
              cannot enter completed history.
            </span>
          </section>
        ) : null}

        {initialError ? (
          <div
            className={styles.error}
            id="workout-command-error"
            role="alert"
            tabIndex={-1}
          >
            <strong>Command not applied</strong>
            <span>{errorMessages[initialError] ?? 'The command was not applied.'}</span>
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

        {!session.progressionInvalidated && previousPerformedSet?.confirmedAt ? (
          <RestCountdown
            confirmedAt={previousPerformedSet.confirmedAt.toISOString()}
            prescribedSeconds={previousPerformedSet.restSeconds}
            serverNow={serverNow}
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

              {!session.progressionInvalidated ? (
                <SubstitutionProposalForm
                  sessionId={session.id}
                  sessionExerciseId={exercise.id}
                  originalExerciseName={exercise.exerciseName}
                />
              ) : null}

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
                    <li
                      className={rowClasses}
                      key={set.id}
                      aria-current={set.id === currentSetId ? 'step' : undefined}
                    >
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
                      !session.progressionInvalidated &&
                      session.status === 'active' &&
                      session.contentEligibility.eligible &&
                      !session.feedback?.painReported ? (
                        <>
                          <SetForm
                            sessionId={session.id}
                            set={set}
                            units={units}
                            unitLabel={unitLabel}
                          />
                          <SkipForm sessionId={session.id} set={set} />
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
        !session.progressionInvalidated &&
        !session.feedback?.painReported &&
        session.contentEligibility.eligible &&
        session.status === 'active' ? (
          <CompleteWorkoutForm sessionId={session.id} />
        ) : null}

        {['active', 'paused'].includes(session.status) &&
        !session.progressionInvalidated ? (
          <ReportPainForm sessionId={session.id} />
        ) : null}
      </div>

      {['active', 'paused'].includes(session.status) ? (
        <footer className={styles.dock}>
          <strong>
            {session.progressionInvalidated
              ? `Session blocked · ${pendingSets.length} unresolved sets`
              : `${pendingSets.length} unresolved sets`}
          </strong>
          <div className={styles.dockActions}>
            {!session.progressionInvalidated ? (
              <>
                {!session.feedback?.painReported ? (
                  <a className={styles.dockSafetyLink} href="#report-pain">
                    Report pain or an issue
                  </a>
                ) : null}
                <PauseResumeForm
                  sessionId={session.id}
                  status={session.status}
                  painReported={session.feedback?.painReported ?? false}
                  eligible={session.contentEligibility.eligible}
                />
              </>
            ) : null}
            <AbandonPanel sessionId={session.id} />
          </div>
        </footer>
      ) : null}
    </main>
  )
}
