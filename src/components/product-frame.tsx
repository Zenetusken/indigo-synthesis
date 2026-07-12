import Link from 'next/link'
import type { ReactNode } from 'react'
import { getServerConfig } from '@/platform/config/server'
import { type PrimaryDestination, PrimaryNavigation } from './primary-navigation'
import styles from './product-frame.module.css'

type ProductFrameProps = {
  accountActions?: ReactNode
  children: ReactNode
  current: PrimaryDestination
}

export function ProductFrame({ accountActions, children, current }: ProductFrameProps) {
  const instanceLabel =
    getServerConfig().contentMode === 'development'
      ? 'Development content mode'
      : 'Reviewed content mode'

  return (
    <div className={styles.frame}>
      <a className={styles.skipLink} href="#main-content">
        Skip to main content
      </a>

      <header className={styles.masthead}>
        <Link
          className={styles.wordmark}
          href={{ pathname: '/today' }}
          aria-label="Indigo Synthesis Today"
        >
          <span className={styles.mark} aria-hidden="true">
            IS
          </span>
          <span className={styles.wordmarkText}>
            <strong>Indigo Synthesis</strong>
            <small>{instanceLabel}</small>
          </span>
        </Link>

        <PrimaryNavigation current={current} />

        {accountActions ? (
          <div className={styles.accountActions}>{accountActions}</div>
        ) : null}
      </header>

      <main className={styles.main} id="main-content" tabIndex={-1}>
        {children}
      </main>
    </div>
  )
}
