import type { UrlObject } from 'node:url'
import Link from 'next/link'
import styles from './product-frame.module.css'

export type PrimaryDestination = 'today' | 'program' | 'history' | 'settings'

type NavigationItem = {
  destination: PrimaryDestination
  href: UrlObject
  label: string
}

const navigationItems: readonly NavigationItem[] = [
  { destination: 'today', href: { pathname: '/today' }, label: 'Today' },
  { destination: 'program', href: { pathname: '/program' }, label: 'Program' },
  { destination: 'history', href: { pathname: '/history' }, label: 'History' },
  { destination: 'settings', href: { pathname: '/settings' }, label: 'Settings' },
]

type PrimaryNavigationProps = {
  current: PrimaryDestination
}

export function PrimaryNavigation({ current }: PrimaryNavigationProps) {
  return (
    <nav className={styles.navigation} aria-label="Primary">
      <ul>
        {navigationItems.map((item) => {
          const isCurrent = item.destination === current

          return (
            <li key={item.destination}>
              <Link
                className={styles.navigationLink}
                href={item.href}
                aria-current={isCurrent ? 'page' : undefined}
              >
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
