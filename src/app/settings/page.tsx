import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHeading, ProductFrame } from '@/components'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import { listLocalUsersAsOwner } from '@/modules/identity/infrastructure/local-users'
import { requireActor } from '@/modules/identity/server/actor'
import { SignOutButton } from '@/modules/identity/ui/sign-out-button'
import { LocalUserForm } from './local-user-form'
import styles from './settings.module.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const actor = await requireActor()
  const [profile, localUsers] = await Promise.all([
    getAthleteProfile(actor.userId),
    actor.role === 'owner' ? listLocalUsersAsOwner(actor) : Promise.resolve([]),
  ])

  return (
    <ProductFrame current="settings" accountActions={<SignOutButton />}>
      <div className={styles.content}>
        <PageHeading
          eyebrow="Settings"
          title="Your instance and data."
          description="Account, export, and deletion controls remain local to this installation."
        />

        <section className={styles.section}>
          <h2>Account</h2>
          <dl className={styles.facts}>
            <div>
              <dt>Name</dt>
              <dd>{actor.name}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{actor.email}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{actor.role}</dd>
            </div>
          </dl>
        </section>

        <section className={styles.section}>
          <h2>Training context</h2>
          <p>
            {profile
              ? `${profile.profile.units} · ${profile.profile.timezone} · ${profile.days.length} training days`
              : 'No confirmed profile.'}
          </p>
        </section>

        <section className={styles.section}>
          <h2>Local users</h2>
          <ul className={styles.userList}>
            {localUsers.map((localUser) => (
              <li key={localUser.id}>
                <strong>{localUser.name}</strong>
                <span>{localUser.email}</span>
              </li>
            ))}
          </ul>
          {actor.role === 'owner' ? <LocalUserForm /> : null}
        </section>

        <section className={styles.section}>
          <h2>Data export</h2>
          <p>
            Download a versioned JSON archive with category hashes, provenance, and
            explicit omissions. Passwords, tokens, and sessions are never included.
          </p>
          <a className={styles.linkButton} href="/api/export">
            Create data export
          </a>
        </section>

        {actor.role === 'owner' ? (
          <section className={styles.section}>
            <h2>Reset instance</h2>
            <p>
              Preview and explicitly confirm deletion of every local account and product
              row.
            </p>
            <Link className={styles.dangerLink} href={{ pathname: '/settings/delete' }}>
              Review instance reset
            </Link>
          </section>
        ) : (
          <section className={styles.section}>
            <h2>Delete my local account</h2>
            <p>
              Preview and permanently remove only your account, training data, and
              subject-linked audit history. Other local users remain unchanged.
            </p>
            <Link
              className={styles.dangerLink}
              href={{ pathname: '/settings/delete-account' }}
            >
              Review account deletion
            </Link>
          </section>
        )}
      </div>
    </ProductFrame>
  )
}
