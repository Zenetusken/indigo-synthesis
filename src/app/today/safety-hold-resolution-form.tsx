'use client'

import { useActionState, useEffect, useId, useReducer, useRef, useState } from 'react'
import { resolveSafetyHoldAction, type SafetyHoldResolutionActionState } from './actions'
import styles from './today.module.css'

const initialState: SafetyHoldResolutionActionState = {
  errorCode: null,
  values: { acknowledged: false, reason: '' },
}

const errorMessages: Readonly<Record<string, string>> = {
  'hold.not-found': 'The safety hold could not be found.',
  'hold.live-session-not-abandoned':
    'Abandon the affected workout before resolving this hold.',
  'hold.reason-required': 'Enter a factual reason for resolving the hold.',
  'hold.ack-required':
    'Confirm that you understand this product does not assess or clear symptoms.',
  'hold.already-resolved': 'This hold has already been resolved.',
  'hold.not-resolvable':
    'This hold is no longer eligible for self-resolution. Reload Today for the current safety state.',
  'hold.completed-source-invalidation-required':
    'This completed workout still has affected progression awaiting invalidation. The hold remains active.',
  'input.invalid': 'Check the entered resolution details and try again.',
  'hold.resolve-failed': 'The hold could not be resolved. Try again.',
}

type SafetyHoldResolutionFormProps = {
  readonly commandId: string
  readonly holdId: string
}

export function SafetyHoldResolutionForm({
  commandId,
  holdId,
}: SafetyHoldResolutionFormProps) {
  const [state, formAction, isPending] = useActionState(
    resolveSafetyHoldAction,
    initialState,
  )
  const [reason, setReason] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [, restoreControlledValues] = useReducer((version: number) => version + 1, 0)
  const alertRef = useRef<HTMLDivElement>(null)
  const errorId = useId()

  useEffect(() => {
    if (!state.errorCode) return
    setReason(state.values.reason)
    setAcknowledged(state.values.acknowledged)
    restoreControlledValues()
    alertRef.current?.focus()
  }, [state])

  const reasonInvalid =
    state.errorCode === 'hold.reason-required' || state.errorCode === 'input.invalid'
  const acknowledgementInvalid = state.errorCode === 'hold.ack-required'

  return (
    <div className={styles.holdResolution}>
      {state.errorCode ? (
        <div
          className={styles.holdError}
          id={errorId}
          ref={alertRef}
          role="alert"
          tabIndex={-1}
        >
          <strong>Safety hold not resolved</strong>
          <span>
            {errorMessages[state.errorCode] ??
              'The hold could not be resolved. Try again.'}
          </span>
        </div>
      ) : null}

      <form
        action={formAction}
        aria-busy={isPending}
        className={styles.holdForm}
        noValidate
      >
        <input type="hidden" name="holdId" value={holdId} />
        <input type="hidden" name="commandId" value={commandId} />
        <label>
          <span>Factual reason for resolving the hold (required)</span>
          <input
            aria-describedby={state.errorCode ? errorId : undefined}
            aria-invalid={reasonInvalid || undefined}
            aria-required="true"
            disabled={isPending}
            maxLength={300}
            name="reason"
            onChange={(event) => setReason(event.target.value)}
            type="text"
            value={reason}
          />
        </label>
        <label className={styles.checkboxLabel}>
          <input
            aria-describedby={state.errorCode ? errorId : undefined}
            aria-invalid={acknowledgementInvalid || undefined}
            aria-required="true"
            checked={acknowledged}
            disabled={isPending}
            name="acknowledged"
            onChange={(event) => setAcknowledged(event.target.checked)}
            type="checkbox"
            value="on"
          />
          <span>I understand that this product does not assess or clear symptoms.</span>
        </label>
        <button className={styles.primaryAction} disabled={isPending} type="submit">
          {isPending ? 'Resolving safety hold…' : 'Resolve safety hold'}
        </button>
      </form>
    </div>
  )
}
