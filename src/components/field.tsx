import { Children, cloneElement, type ReactElement, type ReactNode } from 'react'
import styles from './field.module.css'

type FieldControlProps = {
  'aria-describedby'?: string
  'aria-invalid'?: boolean | 'false' | 'true'
  id?: string
}

type FieldProps = {
  children: ReactElement<FieldControlProps>
  error?: ReactNode
  hint?: ReactNode
  id: string
  label: ReactNode
  optional?: boolean
}

export function Field({
  children,
  error,
  hint,
  id,
  label,
  optional = false,
}: FieldProps) {
  const control = Children.only(children)
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [control.props['aria-describedby'], hintId, errorId]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        <span>{label}</span>
        {optional ? <span className={styles.optional}>Optional</span> : null}
      </label>
      {hint ? (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      ) : null}
      <div className={styles.control}>
        {cloneElement(control, {
          'aria-describedby': describedBy || undefined,
          'aria-invalid': error ? true : control.props['aria-invalid'],
          id,
        })}
      </div>
      {error ? (
        <p className={styles.error} id={errorId}>
          <span aria-hidden="true">!</span> {error}
        </p>
      ) : null}
    </div>
  )
}
