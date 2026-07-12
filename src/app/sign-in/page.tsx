import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getInstallationStatus } from '@/modules/identity/application/installation'
import { getActor } from '@/modules/identity/server/actor'
import { SignInForm } from '@/modules/identity/ui/sign-in-form'
import styles from '../auth-layout.module.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Sign in' }

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; deleted?: string; signedOut?: string }>
}) {
  const installation = await getInstallationStatus()
  if (installation.kind === 'open') redirect('/bootstrap')
  if (await getActor()) redirect('/')

  const query = await searchParams

  return (
    <main className={styles.page}>
      <section className={styles.frame} aria-labelledby="sign-in-heading">
        <a className={styles.wordmark} href="/">
          <span className={styles.mark} aria-hidden="true">
            IS
          </span>
          Indigo Synthesis
        </a>

        {query.created === '1' ? (
          <p className={styles.notice} role="status">
            Owner account created. Sign in to continue.
          </p>
        ) : null}

        {query.deleted === '1' ? (
          <p className={styles.notice} role="status">
            Local account and subject-scoped training data deleted.
          </p>
        ) : null}

        <header className={styles.heading}>
          <h1 id="sign-in-heading">Return to training.</h1>
          <p>Sign in with the local account stored on this instance.</p>
        </header>

        <SignInForm />

        <p className={styles.footnote}>
          No social login, cloud identity, or email provider is required.
        </p>
      </section>
    </main>
  )
}
