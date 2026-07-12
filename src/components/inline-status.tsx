import type { HTMLAttributes, ReactNode } from 'react'
import styles from './inline-status.module.css'

type StatusTone = 'neutral' | 'pending' | 'success' | 'warning' | 'error'

const statusMarks: Record<StatusTone, string> = {
  neutral: '—',
  pending: '…',
  success: '✓',
  warning: '!',
  error: '×',
}

type InlineStatusProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  children: ReactNode
  live?: 'off' | 'polite' | 'assertive'
  tone?: StatusTone
}

export function InlineStatus({
  children,
  className,
  live = 'off',
  tone = 'neutral',
  ...props
}: InlineStatusProps) {
  const classes = [styles.status, styles[tone], className].filter(Boolean).join(' ')

  return (
    <div className={classes} aria-live={live} {...props}>
      <span className={styles.mark} aria-hidden="true">
        {statusMarks[tone]}
      </span>
      <span>{children}</span>
    </div>
  )
}
