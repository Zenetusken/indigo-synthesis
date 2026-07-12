import type { ReactNode } from 'react'
import styles from './page-heading.module.css'

type PageHeadingProps = {
  actions?: ReactNode
  description?: ReactNode
  eyebrow?: ReactNode
  id?: string
  title: ReactNode
}

export function PageHeading({
  actions,
  description,
  eyebrow,
  id,
  title,
}: PageHeadingProps) {
  return (
    <header className={styles.heading}>
      <div className={styles.copy}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h1 id={id}>{title}</h1>
        {description ? <div className={styles.description}>{description}</div> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  )
}
