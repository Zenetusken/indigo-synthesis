import type { Metadata, Route } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { BrandMark, Disclosure } from '@/components'
import { getInstallationStatus } from '@/modules/identity/application/installation'
import { workoutSignInReturnTo } from '@/modules/identity/application/sign-in-return'
import { getActor } from '@/modules/identity/server/actor'
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
    deleted?: string
    expired?: string
    recovered?: string
    returnTo?: string
    reset?: string
    signedOut?: string
  }>
}) {
  const installation = await getInstallationStatus()
  if (installation.kind === 'open') redirect('/bootstrap')
  const query = await searchParams
  const returnTo = workoutSignInReturnTo(query.returnTo)
  if (await getActor()) redirect((returnTo ?? '/') as Route)

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

        {query.deleted === '1' ? (
          <p className={styles.notice} role="status">
            Local account and subject-scoped training data deleted.
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

        {query.expired === '1' && returnTo ? (
          <p className={styles.notice} role="status">
            Your session ended. Sign in again to resume your saved workout.
          </p>
        ) : null}

        <header className={styles.heading}>
          <h1 id="sign-in-heading">Return to training.</h1>
          <p>Sign in with the local account stored on this instance.</p>
        </header>

        <SignInForm returnTo={returnTo ?? undefined} />

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
