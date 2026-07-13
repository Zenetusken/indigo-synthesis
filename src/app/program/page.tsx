import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import {
  Disclosure,
  InlineStatus,
  PageHeading,
  ProductFrame,
  SubmitButton,
} from '@/components'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import {
  formatCalendarDate,
  formatIsoDateInTimezone,
} from '@/modules/athletes/domain/time'
import { formatLoad } from '@/modules/athletes/domain/units'
import { requireActor } from '@/modules/identity/server/actor'
import { SignOutButton } from '@/modules/identity/ui/sign-out-button'
import { getProgramOverview } from '@/modules/programs/application/programs'
import { getServerConfig } from '@/platform/config/server'
import { pluralize } from '@/platform/format/plural'
import { activateProgramAction, generateProgramAction } from './actions'
import styles from './program.module.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Program' }

const errorMessages: Readonly<Record<string, string>> = {
  'safety.current-pain':
    'A current pain or restriction answer blocks this development program.',
  'safety.contraindication': 'A reported restriction blocks program creation.',
  'safety.professional-restriction':
    'A reported professional restriction blocks program creation.',
  'safety.missing-answer': 'A safety answer is uncertain or unavailable.',
  'safety.hold-active': 'An active safety hold blocks program activation.',
  'equipment.missing': 'The confirmed equipment does not support this fixture.',
  'content.development-forbidden-in-production':
    'Development content cannot be activated in reviewed mode.',
  'content.prohibited': 'This content release has been prohibited and cannot run.',
  'content.expired': 'This content release has expired and cannot run.',
  'program.revision-not-draft': 'Only a draft program revision can be activated.',
  'program.prescription-invalid':
    'The saved prescription is incomplete or outside activation bounds.',
  'program.prescription-integrity-failed':
    'The saved prescription does not match its immutable reproducibility record.',
  'program.exercise-unverified':
    'The saved prescription includes an exercise without an installed activation contract.',
  'safety.advanced-ineligible':
    'This program includes an advanced technique without an approved eligibility rule.',
  'safety.prescription-prohibited': 'This program contains a prohibited prescription.',
  'program.active-session':
    'Finish or abandon the active workout before changing programs.',
  'program.generation-failed': 'The program could not be generated from these inputs.',
  'program.activation-failed': 'The program could not be activated.',
}

export default async function ProgramPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const actor = await requireActor()
  const profile = await getAthleteProfile(actor.userId)
  if (!profile) redirect('/setup')

  const [overview, query] = await Promise.all([
    getProgramOverview(actor.userId),
    searchParams,
  ])
  const error = query.error
    ? (errorMessages[query.error] ?? 'The program is unavailable.')
    : null
  const today = formatIsoDateInTimezone(new Date(), profile.profile.timezone)
  const isDevelopmentMode = getServerConfig().contentMode === 'development'

  return (
    <ProductFrame current="program" accountActions={<SignOutButton />}>
      <div className={styles.content}>
        <PageHeading
          eyebrow="Program sheet"
          title={
            overview
              ? 'Your current prescription.'
              : isDevelopmentMode
                ? 'Create one explicit plan.'
                : 'Reviewed program content is not installed.'
          }
          description={
            overview
              ? 'Review the exact scheduled work, provenance, and release status.'
              : isDevelopmentMode
                ? 'The technical fixture preserves your confirmed inputs without pretending to be reviewed coaching.'
                : 'This instance accepts reviewed training content only. No reviewed release is installed yet.'
          }
        />

        {error ? (
          <InlineStatus tone="error" live="assertive">
            {error} Review setup before trying again.
          </InlineStatus>
        ) : null}

        {isDevelopmentMode ? (
          <div className={styles.warning} role="note">
            <strong>Unreviewed development fixture</strong>
            <p>
              The exercises, sets, repetitions, rest periods, and progression values below
              exist only to validate product mechanics. They are not human-reviewed
              coaching guidance and cannot activate in reviewed content mode.
            </p>
          </div>
        ) : (
          <div className={styles.warning} role="note">
            <strong>No reviewed program release is installed</strong>
            <p>
              Reviewed content mode rejects the bundled development fixture. Program
              creation and activation will remain unavailable until an operator installs a
              human-reviewed methodology and template release.
            </p>
          </div>
        )}

        {!overview ? (
          <section className={styles.empty}>
            <h2>
              {isDevelopmentMode
                ? 'No program revision exists'
                : 'Reviewed program creation is unavailable'}
            </h2>
            {isDevelopmentMode ? (
              <>
                <p>
                  Choose the explicit local start date. The same confirmed inputs, date,
                  and versions always produce the same program and hashes.
                </p>
                <form action={generateProgramAction} className={styles.generateForm}>
                  <label>
                    <span>Program start date</span>
                    <input name="asOfDate" type="date" defaultValue={today} required />
                  </label>
                  <SubmitButton variant="primary" pendingLabel="Creating…">
                    Create development program
                  </SubmitButton>
                </form>
              </>
            ) : (
              <p>
                There is no reviewed methodology and template release to generate from.
                This screen will not offer the unreviewed development generator in
                reviewed content mode.
              </p>
            )}
          </section>
        ) : (
          <article className={styles.sheet}>
            <header className={styles.sheetHeader}>
              <div>
                <h2>Two-cycle A/B/C fixture</h2>
                <p>
                  Revision {overview.revisionNumber} ·{' '}
                  {pluralize(overview.workouts.length, 'scheduled workout')}
                </p>
              </div>
              {overview.revisionStatus === 'draft' && isDevelopmentMode ? (
                <form action={activateProgramAction}>
                  <input type="hidden" name="revisionId" value={overview.revisionId} />
                  <SubmitButton variant="primary" pendingLabel="Activating…">
                    Activate development program
                  </SubmitButton>
                </form>
              ) : overview.revisionStatus === 'active' && isDevelopmentMode ? (
                <InlineStatus tone="success">Active revision</InlineStatus>
              ) : (
                <InlineStatus tone="error">
                  Saved development revision unavailable in reviewed content mode
                </InlineStatus>
              )}
            </header>

            <ol className={styles.schedule}>
              {overview.workouts.map((workout) => (
                <li className={styles.workout} key={workout.id}>
                  <div className={styles.workoutMeta}>
                    <strong>Session {workout.slotCode}</strong>
                    <span>{formatCalendarDate(workout.scheduledDate)}</span>
                  </div>
                  <ol className={styles.exercises}>
                    {workout.exercises.map((exercise) => {
                      const firstSet = exercise.sets[0]
                      return (
                        <li key={exercise.id}>
                          <span className={styles.ordinal}>
                            {String(exercise.ordinal).padStart(2, '0')}
                          </span>
                          <strong>{exercise.exerciseName}</strong>
                          <span className={styles.prescription}>
                            {exercise.sets.length} × {firstSet?.targetRepetitions ?? '—'}{' '}
                            ·{' '}
                            {firstSet
                              ? formatLoad(
                                  firstSet.targetLoadGrams,
                                  profile.profile.units,
                                )
                              : 'Unavailable'}{' '}
                            · {firstSet?.restSeconds ?? '—'} s rest
                          </span>
                        </li>
                      )
                    })}
                  </ol>
                </li>
              ))}
            </ol>

            <Disclosure summary="Version and reproducibility record">
              <dl className={styles.versions}>
                <div>
                  <dt>Engine</dt>
                  <dd>{overview.engineVersion}</dd>
                </div>
                <div>
                  <dt>Methodology</dt>
                  <dd>
                    {overview.methodologyId}@{overview.methodologyVersion} ·{' '}
                    {overview.methodologyReviewStatus}
                  </dd>
                </div>
                <div>
                  <dt>Template</dt>
                  <dd>
                    {overview.templateId}@{overview.templateVersion} ·{' '}
                    {overview.templateReviewStatus}
                  </dd>
                </div>
                <div>
                  <dt>Normalized input SHA-256</dt>
                  <dd>{overview.normalizedInputHash}</dd>
                </div>
                <div>
                  <dt>Output SHA-256</dt>
                  <dd>{overview.outputHash}</dd>
                </div>
              </dl>
            </Disclosure>
          </article>
        )}
      </div>
    </ProductFrame>
  )
}
