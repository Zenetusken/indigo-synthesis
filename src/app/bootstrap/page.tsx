import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { BrandMark } from '@/components'
import { verifyInstanceResetNoticeReceipt } from '@/modules/data-portability/server/destructive-notice'
import { getBootstrapPageInstallation } from '@/modules/identity/server/bootstrap'
import { BootstrapForm } from '@/modules/identity/ui/bootstrap-form'
import styles from '../auth-layout.module.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Claim this instance' }

export default async function BootstrapPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>
}) {
  const installation = await getBootstrapPageInstallation()
  if (installation.kind === 'closed') redirect('/sign-in')

  const query = await searchParams
  const resetNotice = verifyInstanceResetNoticeReceipt(query.notice)

  return (
    <main className={styles.page}>
      <section className={styles.frame} aria-labelledby="bootstrap-heading">
        <Link className={styles.wordmark} href={{ pathname: '/' }}>
          <BrandMark />
          Indigo Synthesis
        </Link>

        {resetNotice?.kind === 'reset' ? (
          <p className={styles.notice} role="status">
            Instance reset. Create a new owner to begin again.
            {resetNotice.warning === 'cleanup-failed'
              ? ' Database cleanup reported a warning after commit; do not repeat the reset.'
              : null}
          </p>
        ) : null}

        {resetNotice?.kind === 'outcome-unknown' ? (
          <p className={styles.notice} role="status">
            This installation is currently open. The earlier reset response could not
            confirm its outcome; do not repeat the reset. Create a new owner to begin
            again.
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
