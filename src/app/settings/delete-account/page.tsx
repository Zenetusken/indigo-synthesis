import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { PageHeading, ProductFrame, SubmitButton } from '@/components'
import { getActiveSubjectDeletionPlan } from '@/modules/data-portability/application/deletion'
import {
  type SubjectDeletionNoticeReceiptPayload,
  verifySubjectDeletionNoticeReceiptForActor,
} from '@/modules/data-portability/server/destructive-notice'
import {
  issueTraineeDataDeletionFormEnvelope,
  requireUiActor,
} from '@/modules/identity/server/actor'
import styles from '../delete/delete.module.css'
import { deletionCategoryLabel } from '../deletion-category-label'
import { createAccountDeletionPreviewAction, deleteAccountAction } from './actions'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Delete trainee data' }

type SubjectDeletionNoticeErrorKind = Exclude<
  SubjectDeletionNoticeReceiptPayload['kind'],
  'deleted'
>

const reusablePlanErrors = new Set<SubjectDeletionNoticeErrorKind>([
  'confirmation-rejected',
])

const errorMessages: Readonly<Record<SubjectDeletionNoticeErrorKind, string>> = {
  'confirmation-rejected':
    'Nothing was deleted. The confirmation or signed preview form was not accepted. Acknowledge the consequences and type DELETE exactly, or generate a fresh preview.',
  'reauthentication-failed':
    'The current password was not accepted. Nothing was deleted; generate a fresh preview before trying again.',
  'reauthentication-locked':
    'Too many password attempts. Nothing was deleted. Wait for the lockout to expire, then generate a fresh preview.',
  'plan-invalid':
    'The preview expired or no longer matches. Nothing was deleted; generate a fresh preview.',
  'plan-changed': 'Your data changed. Nothing was deleted; generate a fresh preview.',
  stale:
    'Your signed-in authority changed. Nothing was deleted. Reload, sign in again if asked, and generate a fresh preview.',
  unavailable:
    'The database could not complete the deletion. Nothing was deleted; wait, then generate a fresh preview.',
  'reauthentication-incomplete':
    'The password check did not complete cleanly. The protected deletion did not run. Generate a fresh preview before trying again.',
  'request-not-verified':
    'The deletion request could not be verified. Nothing was deleted; reload and generate a fresh preview.',
  'outcome-unknown':
    'The deletion outcome could not be confirmed. Do not submit it again until you check whether the account or training data still exists.',
  'preview-failed': 'The deletion preview could not be created.',
  'execution-failed':
    'The deletion outcome could not be confirmed. Check the current account and training state before trying again.',
}

export default async function DeleteAccountPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ notice?: string }>
}) {
  const actor = await requireUiActor()
  const preservesIdentity = actor.role === 'owner'
  let [plan, query] = await Promise.all([
    getActiveSubjectDeletionPlan(actor),
    searchParams,
  ])
  const notice = verifySubjectDeletionNoticeReceiptForActor(query.notice, actor.userId)
  const errorKind: SubjectDeletionNoticeErrorKind | null =
    notice?.kind === 'outcome-unknown'
      ? notice.actorRole === actor.role
        ? notice.kind
        : null
      : notice && notice.kind !== 'deleted'
        ? notice.kind
        : null
  if (errorKind && !reusablePlanErrors.has(errorKind)) plan = null
  const formIssuedAt = new Date()
  const form = plan
    ? issueTraineeDataDeletionFormEnvelope(
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

        {!plan || !form ? (
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
              <input type="hidden" name="planId" value={form.planId} />
              <input type="hidden" name="planDigest" value={form.planDigest} />
              <input type="hidden" name="actionBinding" value={form.actionBinding} />
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

            <form action={createAccountDeletionPreviewAction}>
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
