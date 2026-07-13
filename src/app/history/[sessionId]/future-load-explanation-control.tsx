'use client'

import { useState, useTransition } from 'react'
import { ActionButton } from '@/components'
import type { FutureLoadExplanationResult } from '@/modules/training/application/future-load-explanation'
import styles from '../history.module.css'
import { explainFutureLoadDecisionAction } from './actions'

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
    case 'fact-bundle-failed':
      return 'This decision cannot be explained from incomplete stored facts. The rule codes above still apply.'
    case 'synthesis-failed':
      return 'Could not produce a grounded explanation. The rule codes above still apply.'
    default:
      return 'Explanation unavailable. The rule codes above still apply.'
  }
}

export function FutureLoadExplanationControl(props: {
  readonly sessionId: string
  readonly decisionId: string
}) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<FutureLoadExplanationResult | null>(null)

  function onExplain() {
    startTransition(async () => {
      const next = await explainFutureLoadDecisionAction({
        sessionId: props.sessionId,
        decisionId: props.decisionId,
      })
      setResult(next)
    })
  }

  return (
    <div className={styles.explanation}>
      <ActionButton
        type="button"
        variant="secondary"
        busy={pending}
        onClick={onExplain}
        aria-describedby={`explanation-status-${props.decisionId}`}
      >
        {pending ? 'Explaining…' : 'Explain in plain language'}
      </ActionButton>

      <div
        id={`explanation-status-${props.decisionId}`}
        className={styles.explanationBody}
        aria-live="polite"
      >
        {result?.status === 'available' ? (
          <>
            <p className={styles.explanationLabel}>
              Inferred paraphrase of the stored rule (not a new decision)
            </p>
            <p className={styles.explanationProse}>{result.prose}</p>
            <p className={styles.explanationMeta}>
              Local model {result.modelId}
              {result.fromCache ? ' · cached' : ''} · {result.durationMs} ms · rules still
              authoritative
            </p>
          </>
        ) : null}
        {result?.status === 'unavailable' ? (
          <p className={styles.explanationUnavailable}>{unavailableMessage(result)}</p>
        ) : null}
      </div>
    </div>
  )
}
