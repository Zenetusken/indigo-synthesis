import styles from './page.module.css'

const coreLoop = [
  {
    code: 'PROFILE',
    title: 'Know the trainee',
    copy: 'Capture goals, experience, equipment, schedule, limitations, and explicit preferences.',
  },
  {
    code: 'PLAN',
    title: 'Prescribe transparently',
    copy: 'Build from a reviewed, versioned ruleset and show why each important choice was made.',
  },
  {
    code: 'TRAIN',
    title: 'Execute without friction',
    copy: 'Make today’s work obvious and record actual load, reps, RPE, rest, and notes quickly.',
  },
  {
    code: 'LEARN',
    title: 'Adapt from facts',
    copy: 'Use completed training—not invented scores—to explain the next reviewed adjustment.',
  },
] as const

const scope = [
  ['Runtime', 'One self-hosted application'],
  ['Data', 'One PostgreSQL source of truth'],
  ['Coaching', 'Deterministic and versioned'],
  ['Experience', 'Mobile-first, online-first'],
  ['Proof', 'One real end-to-end training journey'],
] as const

export default function HomePage() {
  return (
    <main className={styles.shell}>
      <header className={styles.masthead}>
        <a className={styles.wordmark} href="/" aria-label="Indigo Synthesis home">
          <span className={styles.mark} aria-hidden="true">
            IS
          </span>
          <span>
            <strong>Indigo Synthesis</strong>
            <small>Restart foundation</small>
          </span>
        </a>
        <p className={styles.status}>
          <span aria-hidden="true" />
          Discovery complete · product not yet implemented
        </p>
      </header>

      <section className={styles.hero} id="top">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>The recovered product thesis</p>
          <h1>Know today’s work. Log it. Understand what changes next.</h1>
          <p className={styles.lede}>
            A self-hosted strength training system for people who want an authored plan,
            an honest record, and explanations they can inspect.
          </p>
        </div>

        <aside className={styles.proof} aria-labelledby="proof-heading">
          <p className={styles.dataLabel}>Next proof</p>
          <h2 id="proof-heading">One complete vertical slice</h2>
          <p>
            Local sign-in → trainee setup → reviewed plan → today’s workout → logged sets
            → completion → persisted history.
          </p>
          <p className={styles.proofRule}>
            No health endpoint, mock, or plausible fallback counts as product evidence.
          </p>
        </aside>
      </section>

      <section className={styles.loopSection} aria-labelledby="loop-heading">
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>Product sequence</p>
          <h2 id="loop-heading">The loop every feature must strengthen</h2>
        </div>

        <ol className={styles.loadRail}>
          {coreLoop.map((step, index) => (
            <li key={step.code}>
              <span className={styles.notch} aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <div>
                <p className={styles.dataLabel}>{step.code}</p>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.scopeSection} aria-labelledby="scope-heading">
        <div>
          <p className={styles.eyebrow}>Architecture lock</p>
          <h2 id="scope-heading">Small enough to finish. Explicit enough to trust.</h2>
          <p>
            Social feeds, nutrition prescriptions, wearables, AI coaching, offline sync,
            Docker orchestration, and multi-service infrastructure are deliberately out of
            the restart baseline.
          </p>
        </div>

        <dl className={styles.scopeList}>
          {scope.map(([term, description]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className={styles.footer}>
        <p>
          Working title only. Methodology, safety, evidence, and brand rights remain
          gated.
        </p>
        <span>
          Repository start: <code>docs/product/VISION.md</code>
        </span>
      </footer>
    </main>
  )
}
