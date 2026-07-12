import type { ReactNode } from 'react'
import styles from './error-summary.module.css'

export type FormError = {
  fieldId?: string
  key: string
  message: ReactNode
}

type ErrorSummaryProps = {
  errors: readonly FormError[]
  id?: string
  title?: string
}

export function ErrorSummary({
  errors,
  id = 'form-error-summary',
  title = 'Fix the following',
}: ErrorSummaryProps) {
  if (errors.length === 0) {
    return null
  }

  const titleId = `${id}-title`

  return (
    <section
      className={styles.summary}
      id={id}
      aria-labelledby={titleId}
      role="alert"
      tabIndex={-1}
    >
      <h2 id={titleId}>{title}</h2>
      <ul>
        {errors.map((error) => (
          <li key={error.key}>
            {error.fieldId ? (
              <a href={`#${error.fieldId}`}>{error.message}</a>
            ) : (
              error.message
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
