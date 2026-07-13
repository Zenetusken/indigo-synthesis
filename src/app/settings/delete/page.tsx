import type { Metadata } from 'next'
import { PageHeading, ProductFrame, SubmitButton } from '@/components'
import { getActiveInstanceResetPlan } from '@/modules/data-portability/application/deletion'
import { requireActor } from '@/modules/identity/server/actor'
import { deletionCategoryLabel } from '../deletion-category-label'
import { createResetPreviewAction, resetInstanceAction } from './actions'
import styles from './delete.module.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Reset instance' }

const errorMessages: Readonly<Record<string, string>> = {
  'deletion.confirmation-invalid': 'Acknowledge the consequences and type RESET exactly.',
  'deletion.reauthentication-failed': 'The current owner password was not accepted.',
  'deletion.reauthentication-locked':
    'Too many password attempts. Wait for the lockout to expire before trying again.',
  'deletion.plan-invalid': 'The preview expired or no longer matches.',
  'deletion.plan-changed': 'Instance data changed. Generate a fresh preview.',
  'deletion.owner-changed':
    'Installation ownership changed. Sign in again before resetting this instance.',
  'deletion.preview-failed': 'The deletion preview could not be created.',
  'deletion.execution-failed': 'The instance was not reset. Existing data remains.',
}

export default async function DeleteSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const actor = await requireActor()
  const [plan, query] = await Promise.all([
    getActiveInstanceResetPlan(actor),
    searchParams,
  ])
  const error = query.error
    ? (errorMessages[query.error] ?? 'The reset command was not applied.')
    : null

  return (
    <ProductFrame current="settings">
      <div className={styles.content}>
        <PageHeading
          eyebrow="Settings · destructive action"
          title="Reset this instance."
          description="This is the explicit destruction exception to immutable training history."
        />

        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}

        <section className={styles.warning}>
          <h2>This deletes every local account and all product data.</h2>
          <p>
            Profiles, programs, planned workouts, sessions, performed sets, explanations,
            and subject-linked audit history are removed. Backups remain the operator’s
            responsibility. Only a non-personal completion tombstone remains.
          </p>
        </section>

        {!plan ? (
          <form action={createResetPreviewAction}>
            <SubmitButton variant="secondary" pendingLabel="Generating preview…">
              Generate exact reset preview
            </SubmitButton>
          </form>
        ) : (
          <section className={styles.preview}>
            <h2>Exact rows in this preview</h2>
            <dl className={styles.counts}>
              {Object.entries(plan.counts).map(([category, value]) => (
                <div key={category}>
                  <dt>{deletionCategoryLabel(category)}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <p>Preview expires {plan.expiresAt.toLocaleString()}.</p>

            <form action={resetInstanceAction} className={styles.form}>
              <input type="hidden" name="planId" value={plan.id} />
              <input type="hidden" name="planDigest" value={plan.digest} />
              <label>
                <span>Current owner password</span>
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              <label>
                <span>Type RESET</span>
                <input
                  name="typedConfirmation"
                  type="text"
                  autoComplete="off"
                  pattern="RESET"
                  required
                />
              </label>
              <label className={styles.acknowledgement}>
                <input name="acknowledged" type="checkbox" required />
                <span>
                  I understand that live-instance data cannot be recovered after commit.
                </span>
              </label>
              <SubmitButton variant="danger" pendingLabel="Resetting…">
                Reset instance
              </SubmitButton>
            </form>
          </section>
        )}
      </div>
    </ProductFrame>
  )
}
