'use client'

import styles from './error-state.module.css'

export default function ErrorState({ reset }: { readonly reset: () => void }) {
  return (
    <main className={styles.page}>
      <section className={styles.panel} role="alert">
        <span className={styles.eyebrow}>Explicit error state</span>
        <h1>The saved view could not be loaded.</h1>
        <p>
          Indigo will not replace unavailable data with a plausible workout. Retry the
          same persisted request or return to Today.
        </p>
        <div className={styles.actions}>
          <button type="button" onClick={reset}>
            Retry
          </button>
          <a href="/today">Return to Today</a>
        </div>
      </section>
    </main>
  )
}
