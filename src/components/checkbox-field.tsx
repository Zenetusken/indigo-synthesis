import type { InputHTMLAttributes, ReactNode } from 'react'
import styles from './checkbox-field.module.css'

type CheckboxFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> & {
  description?: ReactNode
  error?: ReactNode
  id: string
  label: ReactNode
}

export function CheckboxField({
  'aria-describedby': ariaDescribedBy,
  description,
  error,
  id,
  label,
  ...inputProps
}: CheckboxFieldProps) {
  const descriptionId = description ? `${id}-description` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [ariaDescribedBy, descriptionId, errorId].filter(Boolean).join(' ')

  return (
    <div className={styles.field}>
      <label className={styles.target} htmlFor={id}>
        <input
          {...inputProps}
          aria-describedby={describedBy || undefined}
          aria-invalid={error ? true : inputProps['aria-invalid']}
          id={id}
          type="checkbox"
        />
        <span className={styles.copy}>
          <span className={styles.label}>{label}</span>
          {description ? (
            <span className={styles.description} id={descriptionId}>
              {description}
            </span>
          ) : null}
        </span>
      </label>
      {error ? (
        <p className={styles.error} id={errorId}>
          <span aria-hidden="true">!</span> {error}
        </p>
      ) : null}
    </div>
  )
}
