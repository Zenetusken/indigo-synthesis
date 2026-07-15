import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { BrandMark } from '@/components'
import { getBootstrapPageInstallation } from '@/modules/identity/server/bootstrap'
import { BootstrapForm } from '@/modules/identity/ui/bootstrap-form'
import styles from '../auth-layout.module.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Claim this instance' }

export default async function BootstrapPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>
}) {
  const installation = await getBootstrapPageInstallation()
  if (installation.kind === 'closed') redirect('/sign-in')

  const query = await searchParams

  return (
    <main className={styles.page}>
      <section className={styles.frame} aria-labelledby="bootstrap-heading">
        <Link className={styles.wordmark} href={{ pathname: '/' }}>
          <BrandMark />
          Indigo Synthesis
        </Link>

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

        <BootstrapForm actionBinding={installation.actionBinding} />

        <p className={styles.footnote}>
          Your account and training data stay in this installation’s PostgreSQL database.
        </p>
      </section>
    </main>
  )
}
