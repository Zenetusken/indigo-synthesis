import type { Metadata, Route } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHeading, ProductFrame } from '@/components'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import { formatCalendarDate, formatTimeInTimezone } from '@/modules/athletes/domain/time'
import { requireUiActor } from '@/modules/identity/server/actor'
import { SignOutButton } from '@/modules/identity/ui/sign-out-button'
import { getCompletedSessions } from '@/modules/training/application/workouts'
import styles from './history.module.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'History' }

export default async function HistoryPage() {
  const actor = await requireUiActor()
  const [sessions, profile] = await Promise.all([
    getCompletedSessions(actor.userId),
    getAthleteProfile(actor.userId),
  ])
  if (!profile) redirect('/setup')

  return (
    <ProductFrame
      current="history"
      accountActions={<SignOutButton actionBinding={actor.checkedSignOutActionBinding} />}
    >
      <div className={styles.content}>
        <PageHeading
          eyebrow="History"
          title="Completed work, without invention."
          description="Completed sessions keep recorded sets, correction history, deterministic future-load decisions, and clearly labeled optional explanations."
        />

        {sessions.length === 0 ? (
          <section className={styles.empty}>
            <h2>No completed workouts</h2>
            <p>Complete a workout to build your factual history.</p>
          </section>
        ) : (
          <ol className={styles.list}>
            {sessions.map((session) => (
              <li key={session.id}>
                <Link href={`/history/${session.id}` as Route}>
                  <span className={styles.date}>
                    {formatCalendarDate(session.scheduledDate)}
                  </span>
                  <strong>{session.plannedName}</strong>
                  <span className={styles.meta}>
                    Completed{' '}
                    {session.completedAt
                      ? formatTimeInTimezone(
                          session.completedAt,
                          profile.profile.timezone,
                        )
                      : '—'}
                  </span>
                  {!session.contentEligibility.eligible ? (
                    <span className={styles.contentStatus}>Content release revoked</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>
    </ProductFrame>
  )
}
