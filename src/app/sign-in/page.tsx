import type { Metadata, Route } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { BrandMark, Disclosure } from '@/components'
import {
  verifyInstanceResetNoticeReceipt,
  verifySubjectDeletionNoticeReceipt,
} from '@/modules/data-portability/server/destructive-notice'
import { workoutSignInReturnTo } from '@/modules/identity/application/sign-in-return'
import { getActor } from '@/modules/identity/server/actor'
import { getSignInPageInstallation } from '@/modules/identity/server/sign-in-page'
import { SignInForm } from '@/modules/identity/ui/sign-in-form'
import { getServerConfig } from '@/platform/config/server'
import styles from '../auth-layout.module.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Sign in' }

const ownerRecoveryCommand =
  'pnpm owner:recover issue --owner-email EMAIL --code-file ABSOLUTE_PATH --ttl-minutes 15'

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{
    claimed?: string
    created?: string
    expired?: string
    notice?: string
    recovered?: string
    returnTo?: string
    reset?: string
    signedOut?: string
  }>
}) {
  const query = await searchParams
  const subjectDeletionNotice = verifySubjectDeletionNoticeReceipt(query.notice)
  const instanceResetNotice = verifyInstanceResetNoticeReceipt(query.notice)
  const installation = await getSignInPageInstallation()
  if (installation.kind === 'open') {
    redirect(
      instanceResetNotice
        ? (`/bootstrap?notice=${encodeURIComponent(query.notice ?? '')}` as Route)
        : '/bootstrap',
    )
  }
  const returnTo = workoutSignInReturnTo(query.returnTo)
  const actor = await getActor()
  if (actor) {
    if (
      subjectDeletionNotice?.kind === 'outcome-unknown' &&
      subjectDeletionNotice.actorRole === actor.role
    ) {
      redirect(
        `/settings/delete-account?notice=${encodeURIComponent(query.notice ?? '')}` as Route,
      )
    }
    if (instanceResetNotice?.kind === 'outcome-unknown' && actor.role === 'owner') {
      redirect(
        `/settings/delete?notice=${encodeURIComponent(query.notice ?? '')}` as Route,
      )
    }
    redirect((returnTo ?? '/') as Route)
  }

  const contentModeLabel =
    getServerConfig().contentMode === 'development'
      ? 'Development content mode'
      : 'Reviewed content mode'

  return (
    <main className={styles.page}>
      <section className={styles.frame} aria-labelledby="sign-in-heading">
        <Link className={styles.wordmark} href={{ pathname: '/' }}>
          <BrandMark />
          <span className={styles.wordmarkText}>
            <strong>Indigo Synthesis</strong> <small>{contentModeLabel}</small>
          </span>
        </Link>

        {query.created === '1' ? (
          <p className={styles.notice} role="status">
            Owner account created. Sign in to continue.
          </p>
        ) : null}

        {query.claimed === '1' ? (
          <p className={styles.notice} role="status">
            The instance is initialized. Sign in with the owner credentials you chose.
          </p>
        ) : null}

        {subjectDeletionNotice?.kind === 'deleted' &&
        subjectDeletionNotice.actorRole === 'member' ? (
          <p className={styles.notice} role="status">
            Local account and subject-scoped training data deleted.
            {subjectDeletionNotice.warning === 'cleanup-failed'
              ? ' Database cleanup reported a warning after commit; do not repeat the deletion.'
              : null}
          </p>
        ) : null}

        {subjectDeletionNotice?.kind === 'outcome-unknown' &&
        subjectDeletionNotice.actorRole === 'member' ? (
          <p className={styles.notice} role="status">
            Account deletion could not be confirmed. Do not resubmit it; sign in to check
            whether the account still exists.
          </p>
        ) : null}

        {instanceResetNotice?.kind === 'outcome-unknown' ? (
          <p className={styles.notice} role="status">
            Instance reset could not be confirmed. Do not resubmit it; sign in to check
            whether this installation is still claimed.
          </p>
        ) : null}

        {query.reset === '1' ? (
          <p className={styles.notice} role="status">
            Password reset complete. Sign in with your new password.
          </p>
        ) : null}

        {query.recovered === '1' ? (
          <p className={styles.notice} role="status">
            Owner recovery complete. Sign in with your new password.
          </p>
        ) : null}

        {query.signedOut === '1' ? (
          <p className={styles.notice} role="status">
            Signed out from this local account.
          </p>
        ) : null}

        {query.expired === '1' && returnTo ? (
          <p className={styles.notice} role="status">
            Your session ended. Sign in again to resume your saved workout.
          </p>
        ) : null}

        <header className={styles.heading}>
          <h1 id="sign-in-heading">Return to training.</h1>
          <p>Sign in with the local account stored on this instance.</p>
        </header>

        <SignInForm
          actionBinding={installation.actionBinding}
          returnTo={returnTo ?? undefined}
        />

        <Disclosure className={styles.recoveryDisclosure} summary="Can't sign in?">
          <div className={styles.recoveryOptions}>
            <section className={styles.recoveryOption}>
              <h2>Trainee password reset</h2>
              <p>
                Ask this instance’s owner for a one-use password reset code, then choose
                your new password here.
              </p>
              <Link className={styles.recoveryLink} href={{ pathname: '/reset' }}>
                Use a trainee reset code
              </Link>
            </section>

            <section className={styles.recoveryOption}>
              <h2>Owner recovery</h2>
              <p>Recovery requires host access. Run this on the Indigo host:</p>
              <code className={styles.recoveryCommand}>{ownerRecoveryCommand}</code>
              <Link className={styles.recoveryLink} href={{ pathname: '/recover' }}>
                Use a host-issued owner recovery code
              </Link>
            </section>

            <section className={styles.recoveryOption}>
              <h2>Need an account?</h2>
              <p>
                Local accounts are created only by this instance’s owner. Public signup is
                not available.
              </p>
            </section>
          </div>
        </Disclosure>

        <p className={styles.footnote}>
          No social login, cloud identity, or email provider is required.
        </p>
      </section>
    </main>
  )
}
