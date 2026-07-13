'use client'

import { useEffect, useState, useTransition } from 'react'
import { ActionButton } from '@/components'
import type { FutureLoadExplanationResult } from '@/modules/training/application/future-load-explanation'
import styles from '../history.module.css'
import { explainFutureLoadDecisionAction } from './actions'
import {
  eventReportsPainForSession,
  latePainReportedEvent,
} from './late-pain-client-state'

function unavailableMessage(
  result: Extract<FutureLoadExplanationResult, { status: 'unavailable' }>,
): string {
  switch (result.reason) {
    case 'llm-disabled':
      return 'Plain-language explanations are off on this instance. The rule codes above still apply.'
    case 'llm-not-ready':
      return 'The local model is not available right now. The rule codes above still apply.'
    case 'decision-not-found':
      return 'This decision could not be loaded for explanation.'
    case 'content-ineligible':
      return 'Plain-language explanation is unavailable because this content is not eligible. The stored rule code remains visible as historical evidence.'
    case 'fact-bundle-failed':
      return 'This decision cannot be explained from incomplete stored facts. The rule codes above still apply.'
    case 'decision-invalidated':
      return (
        result.detail ??
        'This decision is no longer active for explanation. Its original code remains visible as historical evidence.'
      )
    case 'synthesis-failed':
      return 'Could not produce a grounded explanation. The rule codes above still apply.'
    default:
      return 'Explanation unavailable. The rule codes above still apply.'
  }
}

export function FutureLoadExplanationControl(props: {
  readonly sessionId: string
  readonly decisionId: string
  readonly disabledReason?: 'decision-invalidated' | 'content-revoked'
}) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<FutureLoadExplanationResult | null>(null)
  const [requestFailed, setRequestFailed] = useState(false)
  const [latePainReported, setLatePainReported] = useState(false)
  const disabledReason = latePainReported ? 'decision-invalidated' : props.disabledReason
  const disabled = disabledReason !== undefined

  useEffect(() => {
    if (disabled) {
      setResult(null)
      setRequestFailed(false)
    }
  }, [disabled])

  useEffect(() => {
    const onLatePainReported = (event: Event) => {
      if (eventReportsPainForSession(event, props.sessionId)) {
        setLatePainReported(true)
      }
    }
    window.addEventListener(latePainReportedEvent, onLatePainReported)
    return () => window.removeEventListener(latePainReportedEvent, onLatePainReported)
  }, [props.sessionId])

  function onExplain() {
    setRequestFailed(false)
    startTransition(async () => {
      try {
        const next = await explainFutureLoadDecisionAction({
          sessionId: props.sessionId,
          decisionId: props.decisionId,
        })
        setResult(next)
      } catch {
        setResult(null)
        setRequestFailed(true)
      }
    })
  }

  return (
    <div className={styles.explanation}>
      <ActionButton
        type="button"
        variant="secondary"
        busy={pending}
        disabled={disabled}
        onClick={onExplain}
        aria-describedby={`explanation-status-${props.decisionId}`}
      >
        {pending ? 'Explaining…' : 'Explain in plain language'}
      </ActionButton>

      <div
        id={`explanation-status-${props.decisionId}`}
        className={styles.explanationBody}
      >
        <div className={styles.explanationResult} aria-live="polite">
          {!disabled && result?.status === 'available' ? (
            <>
              <p className={styles.explanationLabel}>
                Inferred paraphrase of the stored rule (not a new decision)
              </p>
              <p className={styles.explanationProse}>{result.prose}</p>
              <p className={styles.explanationMeta}>
                Local model {result.modelId}
                {result.fromCache ? ' · cached' : ''} · {result.durationMs} ms · rules
                still authoritative
              </p>
            </>
          ) : null}
          {!disabled && result?.status === 'unavailable' ? (
            <p className={styles.explanationUnavailable}>{unavailableMessage(result)}</p>
          ) : null}
          {!disabled && requestFailed ? (
            <p className={styles.explanationUnavailable}>
              The explanation request did not finish. Try again; the stored rule code
              still applies.
            </p>
          ) : null}
        </div>
        {disabled ? (
          <p className={styles.explanationUnavailable}>
            {disabledReason === 'content-revoked'
              ? 'Plain-language explanation unavailable because this content release was revoked. The stored rule code remains visible as historical evidence.'
              : 'Plain-language explanation unavailable because this decision is no longer active. Its original code remains visible as historical evidence.'}
          </p>
        ) : null}
      </div>
    </div>
  )
}
