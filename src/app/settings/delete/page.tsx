import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { PageHeading, ProductFrame, SubmitButton } from '@/components'
import { getActiveInstanceResetPlan } from '@/modules/data-portability/application/deletion'
import {
  type InstanceResetNoticeReceiptPayload,
  verifyInstanceResetNoticeReceipt,
} from '@/modules/data-portability/server/destructive-notice'
import {
  issueInstanceResetFormEnvelope,
  requireUiActor,
} from '@/modules/identity/server/actor'
import { deletionCategoryLabel } from '../deletion-category-label'
import { createResetPreviewAction, resetInstanceAction } from './actions'
import styles from './delete.module.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Reset instance' }

type InstanceResetNoticeErrorKind = Exclude<
  InstanceResetNoticeReceiptPayload['kind'],
  'reset'
>

const reusablePlanErrors = new Set<InstanceResetNoticeErrorKind>([
  'confirmation-rejected',
])

const errorMessages: Readonly<Record<InstanceResetNoticeErrorKind, string>> = {
  'confirmation-rejected':
    'Nothing was reset. The confirmation or signed preview form was not accepted. Acknowledge the consequences and type RESET exactly, or generate a fresh preview.',
  'reauthentication-failed':
    'The current owner password was not accepted. Nothing was reset; generate a fresh preview before trying again.',
  'reauthentication-locked':
    'Too many password attempts. Nothing was reset. Wait for the lockout to expire, then generate a fresh preview.',
  'plan-invalid':
    'The preview expired or no longer matches. Nothing was reset; generate a fresh preview.',
  'plan-changed': 'Instance data changed. Nothing was reset; generate a fresh preview.',
  stale:
    'Installation or owner authority changed. Nothing was reset. Reload, sign in again if asked, and generate a fresh preview.',
  unavailable:
    'The database could not complete the reset. Nothing was reset; wait, then generate a fresh preview.',
  'reauthentication-incomplete':
    'The owner-password check did not complete cleanly. The protected reset did not run. Generate a fresh preview before trying again.',
  'request-not-verified':
    'The reset request could not be verified. Nothing was reset; reload and generate a fresh preview.',
  'outcome-unknown':
    'The reset outcome could not be confirmed. Do not submit it again until you check whether this installation is still claimed.',
  'preview-failed': 'The reset preview could not be created.',
  'execution-failed':
    'The reset outcome could not be confirmed. Check whether the installation is still claimed before trying again.',
}

export default async function DeleteSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>
}) {
  const actor = await requireUiActor()
  if (actor.role !== 'owner') redirect('/settings')
  let [plan, query] = await Promise.all([getActiveInstanceResetPlan(actor), searchParams])
  const notice = verifyInstanceResetNoticeReceipt(query.notice)
  const errorKind: InstanceResetNoticeErrorKind | null =
    notice && notice.kind !== 'reset' ? notice.kind : null
  if (errorKind && !reusablePlanErrors.has(errorKind)) plan = null
  const formIssuedAt = new Date()
  const form = plan
    ? issueInstanceResetFormEnvelope(
        actor.authenticatedActionEnvelope,
        plan,
        formIssuedAt,
      )
    : null
  if (plan && !form) {
    const planExpired =
      Math.floor(plan.expiresAt.getTime() / 1_000) <=
      Math.floor(formIssuedAt.getTime() / 1_000)
    if (!planExpired) redirect('/sign-in')
    plan = null
  }
  const error = errorKind ? errorMessages[errorKind] : null

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
            Profiles, programs, planned workouts, sessions, performed sets, saved
            plain-language explanations, and subject-linked audit history are removed.
            Backups remain the operator’s responsibility. The installation returns to its
            unclaimed bootstrap state; only non-personal installation state and completion
            tombstones remain.
          </p>
        </section>

        {!plan || !form ? (
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
              <input type="hidden" name="planId" value={form.planId} />
              <input type="hidden" name="planDigest" value={form.planDigest} />
              <input type="hidden" name="actionBinding" value={form.actionBinding} />
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

            <form action={createResetPreviewAction}>
              <SubmitButton variant="secondary" pendingLabel="Refreshing preview…">
                Generate fresh preview
              </SubmitButton>
            </form>
          </section>
        )}
      </div>
    </ProductFrame>
  )
}
