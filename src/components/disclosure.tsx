import type { DetailsHTMLAttributes, ReactNode } from 'react'
import styles from './disclosure.module.css'

type DisclosureProps = Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'children'> & {
  children: ReactNode
  summary: ReactNode
}

export function Disclosure({ children, className, summary, ...props }: DisclosureProps) {
  const classes = [styles.disclosure, className].filter(Boolean).join(' ')

  return (
    <details className={classes} {...props}>
      <summary>{summary}</summary>
      <div className={styles.content}>{children}</div>
    </details>
  )
}
