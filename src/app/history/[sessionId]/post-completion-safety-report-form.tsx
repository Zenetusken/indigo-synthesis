'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { SubmitButton } from '@/components'
import styles from '../history.module.css'
import {
  type PostCompletionSafetyReportState,
  reportPostCompletionSafetyIssueAction,
} from './actions'

const initialPostCompletionSafetyReportState: PostCompletionSafetyReportState = {
  errorCode: null,
  success: false,
  values: { details: '' },
}

const errorMessages: Readonly<Record<string, string>> = {
  'input.invalid': 'The report was incomplete. Review it and try again.',
  'session.not-found': 'This completed workout is unavailable.',
  'session.not-reportable': 'This workout cannot accept a safety report.',
  'command.idempotency-conflict':
    'This report identifier was already used for different information. Reload and try again.',
  'safety.report-failed':
    'The safety report was not recorded. Existing facts remain unchanged.',
}

function newClientCommandId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function PostCompletionSafetyReportForm({ sessionId }: { sessionId: string }) {
  const [state, action] = useActionState(
    reportPostCompletionSafetyIssueAction,
    initialPostCompletionSafetyReportState,
  )
  const [commandId] = useState(() => newClientCommandId())
  const [details, setDetails] = useState('')
  const resultRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (state.errorCode || state.success) resultRef.current?.focus()
  }, [state])

  return (
    <section className={styles.safetyReport} aria-labelledby="history-safety-heading">
      <h2 id="history-safety-heading">Report a post-completion safety issue</h2>
      <p>
        Use this only for pain or a safety issue from this workout that was not reported
        before completion. Indigo will retain the original completion fact, append this
        correction, and invalidate affected future progression. It does not diagnose or
        clear symptoms.
      </p>

      {state.errorCode ? (
        <div className={styles.reportError} ref={resultRef} role="alert" tabIndex={-1}>
          <strong>Safety report not recorded</strong>
          <span>
            {errorMessages[state.errorCode] ?? 'The safety report was not recorded.'}
          </span>
        </div>
      ) : null}
      {state.success ? (
        <div className={styles.reportSuccess} ref={resultRef} role="status" tabIndex={-1}>
          Safety correction recorded and affected progression invalidated.
        </div>
      ) : null}

      {!state.success ? (
        <form action={action} className={styles.reportForm}>
          <input type="hidden" name="sessionId" value={sessionId} />
          <input type="hidden" name="commandId" value={commandId} />
          <label>
            <span>Optional factual context</span>
            <textarea
              name="details"
              maxLength={1_000}
              value={details}
              onChange={(event) => setDetails(event.target.value)}
            />
          </label>
          <SubmitButton variant="danger" pendingLabel="Recording report…">
            Record safety report
          </SubmitButton>
        </form>
      ) : null}
    </section>
  )
}
