import Link from 'next/link'
import styles from './error-state.module.css'

export default function NotFound() {
  return (
    <main className={styles.page}>
      <section className={styles.panel}>
        <span className={styles.eyebrow}>Unavailable</span>
        <h1>This record is unavailable.</h1>
        <p>
          It may not exist, may belong to another local user, or may not be visible in its
          current state. No substitute data is shown.
        </p>
        <Link href={{ pathname: '/today' }}>Return to Today</Link>
      </section>
    </main>
  )
}
