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
  onClick,
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

  // While busy the control stays focusable (aria-disabled, not the native
  // disabled attribute) so keyboard/SR focus is not dropped to the body
  // mid-submit; pointer re-activation is blocked here and repeat submits are
  // already guarded by command idempotency / React's pending form action.
  return (
    <button
      {...props}
      className={classes}
      type={type}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      disabled={disabled}
      onClick={
        busy
          ? (event) => {
              event.preventDefault()
            }
          : onClick
      }
    >
      {children}
    </button>
  )
}
