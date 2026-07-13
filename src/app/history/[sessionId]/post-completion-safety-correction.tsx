'use client'

import { type ReactNode, useEffect, useRef } from 'react'
import styles from '../history.module.css'
import { consumeLatePainSubmissionPending } from './late-pain-client-state'

export function PostCompletionSafetyCorrection(props: {
  readonly sessionId: string
  readonly children: ReactNode
}) {
  const regionRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (consumeLatePainSubmissionPending(props.sessionId)) {
      regionRef.current?.focus()
    }
  }, [props.sessionId])

  return (
    <section
      ref={regionRef}
      className={styles.correction}
      aria-labelledby="correction-heading"
      role="status"
      tabIndex={-1}
    >
      {props.children}
    </section>
  )
}
