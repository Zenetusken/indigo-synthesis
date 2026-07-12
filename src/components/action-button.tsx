import type { ButtonHTMLAttributes } from 'react'
import styles from './action-button.module.css'

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean
  fullWidth?: boolean
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger'
}

export function ActionButton({
  busy = false,
  children,
  className,
  disabled,
  fullWidth = false,
  type = 'button',
  variant = 'primary',
  ...props
}: ActionButtonProps) {
  const classes = [
    styles.button,
    styles[variant],
    fullWidth ? styles.fullWidth : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      {...props}
      className={classes}
      type={type}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
    >
      {children}
    </button>
  )
}
