import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getInstallationStatus } from '@/modules/identity/application/installation'
import { BootstrapForm } from '@/modules/identity/ui/bootstrap-form'
import styles from '../auth-layout.module.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Claim this instance' }

export default async function BootstrapPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>
}) {
  const installation = await getInstallationStatus()
  if (installation.kind === 'closed') redirect('/sign-in')

  const query = await searchParams

  return (
    <main className={styles.page}>
      <section className={styles.frame} aria-labelledby="bootstrap-heading">
        <a className={styles.wordmark} href="/">
          <span className={styles.mark} aria-hidden="true">
            IS
          </span>
          Indigo Synthesis
        </a>

        {query.reset === 'complete' ? (
          <p className={styles.notice} role="status">
            Instance reset. Create a new owner to begin again.
          </p>
        ) : null}

        <header className={styles.heading}>
          <h1 id="bootstrap-heading">Initialize this instance.</h1>
          <p>
            Issue a one-use code from the host, then create the local owner. Public signup
            is never exposed.
          </p>
        </header>

        <BootstrapForm />

        <p className={styles.footnote}>
          Your account and training data stay in this installation’s PostgreSQL database.
        </p>
      </section>
    </main>
  )
}
