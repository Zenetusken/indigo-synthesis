import type { Metadata } from 'next'
import { PageHeading, ProductFrame, SubmitButton } from '@/components'
import { getActiveSubjectDeletionPlan } from '@/modules/data-portability/application/deletion'
import { requireActor } from '@/modules/identity/server/actor'
import styles from '../delete/delete.module.css'
import { deletionCategoryLabel } from '../deletion-category-label'
import { createAccountDeletionPreviewAction, deleteAccountAction } from './actions'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Delete trainee data' }

const errorMessages: Readonly<Record<string, string>> = {
  'deletion.confirmation-invalid':
    'Acknowledge the consequences and type DELETE exactly.',
  'deletion.reauthentication-failed': 'The current password was not accepted.',
  'deletion.reauthentication-locked':
    'Too many password attempts. Wait for the lockout to expire before trying again.',
  'deletion.plan-invalid': 'The preview expired or no longer matches.',
  'deletion.plan-changed': 'Your data changed. Generate a fresh preview.',
  'deletion.owner-changed':
    'Installation ownership changed. Sign in again before deleting owner training data.',
  'deletion.preview-failed': 'The deletion preview could not be created.',
  'deletion.execution-failed': 'The account was not deleted. Existing data remains.',
}

export default async function DeleteAccountPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string }>
}) {
  const actor = await requireActor()
  const preservesIdentity = actor.role === 'owner'
  const [plan, query] = await Promise.all([
    getActiveSubjectDeletionPlan(actor),
    searchParams,
  ])
  const error = query.error
    ? (errorMessages[query.error] ?? 'The deletion command was not applied.')
    : null

  return (
    <ProductFrame current="settings">
      <div className={styles.content}>
        <PageHeading
          eyebrow="Settings · destructive action"
          title={
            preservesIdentity ? 'Delete my training data.' : 'Delete my local account.'
          }
          description={
            preservesIdentity
              ? 'This removes your trainee profile and training history while preserving your owner login and this self-hosted installation.'
              : 'This removes only the authenticated subject and leaves the self-hosted instance intact.'
          }
        />

        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}

        <section className={styles.warning}>
          <h2>This cannot be undone.</h2>
          <p>
            {preservesIdentity
              ? 'Your profile, programs, workouts, performed sets, saved plain-language explanations, and subject-linked training audit events are removed. Your owner credential, current login sessions, installation ownership, and every other local user remain.'
              : 'Your credential, sessions, profile, programs, workouts, performed sets, saved plain-language explanations, and subject-linked audit events are removed. Other local accounts and their data remain.'}{' '}
            Non-personal destructive-action audit evidence and an aggregate completion
            tombstone may remain.
          </p>
        </section>

        {!plan ? (
          <form action={createAccountDeletionPreviewAction}>
            <SubmitButton variant="secondary" pendingLabel="Generating preview…">
              {preservesIdentity
                ? 'Generate exact training-data preview'
                : 'Generate exact account-deletion preview'}
            </SubmitButton>
          </form>
        ) : (
          <section className={styles.preview}>
            <h2>
              {preservesIdentity
                ? 'Exact training rows in this preview'
                : 'Exact affected rows in this preview'}
            </h2>
            <dl className={styles.counts}>
              {Object.entries(plan.counts).map(([category, value]) => (
                <div key={category}>
                  <dt>{deletionCategoryLabel(category)}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <p>Preview expires {plan.expiresAt.toLocaleString()}.</p>

            <form action={deleteAccountAction} className={styles.form}>
              <input type="hidden" name="planId" value={plan.id} />
              <input type="hidden" name="planDigest" value={plan.digest} />
              <label>
                <span>Current password</span>
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              <label>
                <span>Type DELETE</span>
                <input
                  name="typedConfirmation"
                  type="text"
                  autoComplete="off"
                  pattern="DELETE"
                  required
                />
              </label>
              <label className={styles.acknowledgement}>
                <input name="acknowledged" type="checkbox" required />
                <span>
                  {preservesIdentity
                    ? 'I understand that my training data cannot be recovered.'
                    : 'I understand that my local account cannot be recovered.'}
                </span>
              </label>
              <SubmitButton variant="danger" pendingLabel="Deleting…">
                {preservesIdentity ? 'Delete my training data' : 'Delete my account'}
              </SubmitButton>
            </form>
          </section>
        )}
      </div>
    </ProductFrame>
  )
}
