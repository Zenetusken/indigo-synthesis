'use client'

import { useRouter } from 'next/navigation'
import { useActionState, useEffect, useRef } from 'react'
import { ActionButton } from '@/components/action-button'
import type { MemberResetIssueActionBinding } from '@/modules/identity/application/action-binding'
import { issueMemberResetAction, type MemberResetIssueActionState } from './actions'
import styles from './settings.module.css'

const initialState: MemberResetIssueActionState = {
  errors: [],
  issued: null,
  stale: false,
}

export function MemberResetForm({
  targetUserId,
  targetName,
  actionBinding,
}: {
  readonly targetUserId: string
  readonly targetName: string
  readonly actionBinding: MemberResetIssueActionBinding
}) {
  const [state, action, pending] = useActionState(issueMemberResetAction, initialState)
  const formRef = useRef<HTMLFormElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const handledStaleResponse = useRef<MemberResetIssueActionState | null>(null)
  const router = useRouter()
  const errorId = `member-reset-error-${targetUserId}`
  const warningId = `member-reset-warning-${targetUserId}`
  const passwordDescription =
    state.errors.length > 0 ? `${warningId} ${errorId}` : warningId

  useEffect(() => {
    if (state.errors.length > 0) errorRef.current?.focus()
    if (state.issued) formRef.current?.reset()
    const currentPassword = formRef.current?.elements.namedItem('currentPassword')
    if (currentPassword instanceof HTMLInputElement) currentPassword.value = ''
    if (state.stale && handledStaleResponse.current !== state) {
      handledStaleResponse.current = state
      router.refresh()
    } else if (!state.stale) {
      handledStaleResponse.current = null
    }
  }, [router, state])

  return (
    <details className={styles.resetControl}>
      <summary>Issue password reset code for {targetName}</summary>
      <form action={action} className={styles.resetForm} ref={formRef}>
        <input name="targetUserId" type="hidden" value={targetUserId} />
        <input name="actionBinding" type="hidden" value={actionBinding} />
        {state.errors.length > 0 ? (
          <div
            className={styles.error}
            id={errorId}
            ref={errorRef}
            role="alert"
            tabIndex={-1}
          >
            {state.errors.join(' ')}
          </div>
        ) : null}
        {state.issued?.targetUserId === targetUserId ? (
          <div className={styles.resetCode} role="status">
            <strong>Copy this code now. It will not be shown again.</strong>
            <code>{state.issued.code}</code>
            <span>
              Expires at {new Date(state.issued.expiresAt).toLocaleString()}. Hand it to{' '}
              {targetName} out of band.
            </span>
          </div>
        ) : null}
        <p className={styles.resetWarning} id={warningId}>
          Issuing a new code invalidates any earlier unused reset code for {targetName}.
        </p>
        <label>
          <span>Current owner password for {targetName}</span>
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            minLength={12}
            maxLength={128}
            required
            aria-describedby={passwordDescription}
            aria-invalid={state.errors.length > 0 ? true : undefined}
          />
        </label>
        <ActionButton variant="secondary" type="submit" busy={pending}>
          {pending ? 'Issuing reset code…' : 'Issue one-time code'}
        </ActionButton>
      </form>
    </details>
  )
}
