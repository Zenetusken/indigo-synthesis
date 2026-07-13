import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { BrandMark } from '@/components'
import { getInstallationStatus } from '@/modules/identity/application/installation'
import { getActor } from '@/modules/identity/server/actor'
import { getServerConfig } from '@/platform/config/server'
import styles from '../auth-layout.module.css'
import { RecoverOwnerForm } from './recover-form'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Recover owner access' }

export default async function RecoverPage() {
  const installation = await getInstallationStatus()
  if (installation.kind === 'open') redirect('/bootstrap')
  if (await getActor()) redirect('/')
  const contentModeLabel =
    getServerConfig().contentMode === 'development'
      ? 'Development content mode'
      : 'Reviewed content mode'

  return (
    <main className={styles.page}>
      <section className={styles.frame} aria-labelledby="recover-heading">
        <Link className={styles.wordmark} href={{ pathname: '/sign-in' }}>
          <BrandMark />
          <span className={styles.wordmarkText}>
            <strong>Indigo Synthesis</strong> <small>{contentModeLabel}</small>
          </span>
        </Link>
        <header className={styles.heading}>
          <h1 id="recover-heading">Recover owner access.</h1>
          <p>Use a one-time code issued from the Indigo host.</p>
        </header>
        <code className={styles.recoveryCommand}>
          pnpm owner:recover issue --owner-email EMAIL --code-file ABSOLUTE_PATH
          --ttl-minutes 15
        </code>
        <RecoverOwnerForm />
        <p className={styles.footnote}>
          Host access is required to issue the code.{' '}
          <Link href={{ pathname: '/sign-in' }}>Return to sign in</Link>.
        </p>
      </section>
    </main>
  )
}
