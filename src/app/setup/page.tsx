import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import { getInstallationStatus } from '@/modules/identity/application/installation'
import { requireActor } from '@/modules/identity/server/actor'
import styles from './setup.module.css'
import { SetupForm } from './setup-form'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Training setup' }

export default async function SetupPage() {
  const installation = await getInstallationStatus()
  if (installation.kind === 'open') redirect('/bootstrap')
  const actor = await requireActor()
  if (await getAthleteProfile(actor.userId)) redirect('/program')

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Set up your training context.</h1>
        <p>
          Confirm only information you know. Missing or restricted inputs block a program
          instead of producing a plausible substitute.
        </p>
      </header>
      <SetupForm />
    </main>
  )
}
