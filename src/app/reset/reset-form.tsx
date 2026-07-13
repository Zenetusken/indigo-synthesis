'use client'

import { useActionState, useEffect, useRef } from 'react'
import { ErrorSummary, Field, SubmitButton } from '@/components'
import styles from '../recovery-form.module.css'
import { type ResetCredentialActionState, resetMemberCredentialAction } from './actions'

const initialState: ResetCredentialActionState = {
  kind: 'idle',
  email: '',
  message: null,
}

export function ResetCredentialForm() {
  const [state, action] = useActionState(resetMemberCredentialAction, initialState)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (state.kind === 'rejected') {
      formRef.current?.reset()
      const email = formRef.current?.elements.namedItem('email')
      if (email instanceof HTMLInputElement) email.value = state.email
      document.querySelector<HTMLElement>('#reset-error-summary')?.focus()
    }
  }, [state])

  const errors = state.message ? [{ key: 'reset-rejected', message: state.message }] : []
  const rejectionA11y = state.message
    ? ({ 'aria-describedby': 'reset-error-summary', 'aria-invalid': true } as const)
    : {}

  return (
    <form action={action} className={styles.form} noValidate ref={formRef}>
      <ErrorSummary
        errors={errors}
        id="reset-error-summary"
        title="Password reset did not complete"
      />
      <Field id="reset-email" label="Local sign-in email">
        <input
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={state.email}
          maxLength={320}
          required
          {...rejectionA11y}
        />
      </Field>
      <Field id="reset-code" label="Owner-issued reset code">
        <input
          name="code"
          type="password"
          autoComplete="one-time-code"
          required
          {...rejectionA11y}
        />
      </Field>
      <Field hint="Use 12–128 characters." id="reset-new-password" label="New password">
        <input
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          {...rejectionA11y}
        />
      </Field>
      <Field id="reset-confirm-password" label="Confirm new password">
        <input
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          {...rejectionA11y}
        />
      </Field>
      <SubmitButton variant="primary" pendingLabel="Resetting password…">
        Reset password
      </SubmitButton>
    </form>
  )
}
