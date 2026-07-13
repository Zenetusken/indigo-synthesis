import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHeading, ProductFrame } from '@/components'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import { requireActor } from '@/modules/identity/server/actor'
import { listLocalUsersAsOwner } from '@/modules/identity/server/local-users'
import { SignOutButton } from '@/modules/identity/ui/sign-out-button'
import { pluralize } from '@/platform/format/plural'
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
              ? `${profile.profile.units} · ${profile.profile.timezone} · ${pluralize(profile.days.length, 'training day')}`
              : 'No confirmed profile.'}
          </p>
        </section>

        {actor.role === 'owner' ? (
          <section className={styles.section}>
            <h2>Local users</h2>
            {localUsers.length > 0 ? (
              <ul className={styles.userList}>
                {localUsers.map((localUser) => (
                  <li key={localUser.id}>
                    <strong>{localUser.name}</strong>
                    <span>{localUser.email}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No additional local users yet.</p>
            )}
            <LocalUserForm />
          </section>
        ) : null}

        <section className={styles.section}>
          <h2>Data export</h2>
          <p>
            Download a versioned JSON archive of your training facts, stored decisions,
            and saved plain-language explanations, with category hashes, provenance, and
            explicit omissions. Passwords, verification tokens, and sign-in sessions are
            never included.
          </p>
          <a className={styles.linkButton} href="/api/export">
            Create data export
          </a>
        </section>

        <section className={styles.section}>
          <h2>
            {actor.role === 'owner'
              ? 'Delete my training data'
              : 'Delete my local account'}
          </h2>
          <p>
            {actor.role === 'owner'
              ? 'Preview and permanently remove your trainee profile, training history, and saved explanations while preserving installation ownership, your login, and every other local user.'
              : 'Preview and permanently remove only your account, training data, saved explanations, and subject-linked audit history. Other local users remain unchanged.'}
          </p>
          <Link
            className={styles.dangerLink}
            href={{ pathname: '/settings/delete-account' }}
          >
            {actor.role === 'owner'
              ? 'Review training-data deletion'
              : 'Review account deletion'}
          </Link>
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
        ) : null}
      </div>
    </ProductFrame>
  )
}
