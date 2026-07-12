import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { PageHeading, ProductFrame } from '@/components'
import { getActiveSubjectDeletionPlan } from '@/modules/data-portability/application/deletion'
import { requireActor } from '@/modules/identity/server/actor'
import styles from '../delete/delete.module.css'
import { createAccountDeletionPreviewAction, deleteAccountAction } from './actions'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Delete local account' }

const errorMessages: Readonly<Record<string, string>> = {
  'deletion.confirmation-invalid':
    'Acknowledge the consequences and type DELETE exactly.',
  'deletion.reauthentication-failed': 'The current password was not accepted.',
  'deletion.plan-invalid': 'The preview expired or no longer matches.',
  'deletion.plan-changed': 'Your data changed. Generate a fresh preview.',
  'deletion.preview-failed': 'The deletion preview could not be created.',
  'deletion.execution-failed': 'The account was not deleted. Existing data remains.',
}

export default async function DeleteAccountPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string }>
}) {
  const actor = await requireActor()
  if (actor.role === 'owner') redirect('/settings/delete')
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
          title="Delete my local account."
          description="This removes only the authenticated subject and leaves the self-hosted instance intact."
        />

        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}

        <section className={styles.warning}>
          <h2>This cannot be undone.</h2>
          <p>
            Your credential, sessions, profile, programs, workouts, performed sets, and
            subject-linked audit events are removed. Other local accounts and their data
            remain. Only a non-personal aggregate tombstone is retained.
          </p>
        </section>

        {!plan ? (
          <form action={createAccountDeletionPreviewAction}>
            <button className={styles.previewButton} type="submit">
              Generate exact account-deletion preview
            </button>
          </form>
        ) : (
          <section className={styles.preview}>
            <h2>Exact affected rows in this preview</h2>
            <dl className={styles.counts}>
              {Object.entries(plan.counts).map(([category, value]) => (
                <div key={category}>
                  <dt>{category}</dt>
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
                <span>I understand that my local account cannot be recovered.</span>
              </label>
              <button className={styles.dangerButton} type="submit">
                Delete my account
              </button>
            </form>
          </section>
        )}
      </div>
    </ProductFrame>
  )
}
