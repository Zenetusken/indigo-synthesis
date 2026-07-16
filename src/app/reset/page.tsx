import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { BrandMark } from '@/components'
import { getActor } from '@/modules/identity/server/actor'
import { getMemberResetPageInstallation } from '@/modules/identity/server/recovery-page'
import { getServerConfig } from '@/platform/config/server'
import styles from '../auth-layout.module.css'
import { ResetCredentialForm } from './reset-form'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Reset trainee password' }

export default async function ResetPage() {
  const installation = await getMemberResetPageInstallation()
  if (installation.kind === 'open') redirect('/bootstrap')
  if (await getActor()) redirect('/')
  const contentModeLabel =
    getServerConfig().contentMode === 'development'
      ? 'Development content mode'
      : 'Reviewed content mode'

  return (
    <main className={styles.page}>
      <section className={styles.frame} aria-labelledby="reset-heading">
        <Link className={styles.wordmark} href={{ pathname: '/sign-in' }}>
          <BrandMark />
          <span className={styles.wordmarkText}>
            <strong>Indigo Synthesis</strong> <small>{contentModeLabel}</small>
          </span>
        </Link>
        <header className={styles.heading}>
          <h1 id="reset-heading">Choose a new password.</h1>
          <p>Use the one-time code supplied by this instance’s owner.</p>
        </header>
        <ResetCredentialForm actionBinding={installation.actionBinding} />
        <p className={styles.footnote}>
          No code yet? Ask the owner of this instance.{' '}
          <Link href={{ pathname: '/sign-in' }}>Return to sign in</Link>.
        </p>
      </section>
    </main>
  )
}
