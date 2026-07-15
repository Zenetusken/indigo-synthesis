'use client'

import { useActionState, useEffect, useRef } from 'react'
import { ErrorSummary } from '@/components/error-summary'
import { Field } from '@/components/field'
import { SubmitButton } from '@/components/submit-button'
import styles from '../recovery-form.module.css'
import { type RecoverOwnerActionState, recoverOwnerAction } from './actions'

const initialState: RecoverOwnerActionState = {
  kind: 'idle',
  email: '',
  message: null,
}

export function RecoverOwnerForm() {
  const [state, action] = useActionState(recoverOwnerAction, initialState)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (state.kind === 'rejected') {
      formRef.current?.reset()
      const email = formRef.current?.elements.namedItem('email')
      if (email instanceof HTMLInputElement) email.value = state.email
      document.querySelector<HTMLElement>('#recover-error-summary')?.focus()
    }
  }, [state])

  const errors = state.message
    ? [{ key: 'recover-rejected', message: state.message }]
    : []
  const rejectionA11y = state.message
    ? ({ 'aria-describedby': 'recover-error-summary', 'aria-invalid': true } as const)
    : {}

  return (
    <form action={action} className={styles.form} noValidate ref={formRef}>
      <ErrorSummary
        errors={errors}
        id="recover-error-summary"
        title="Owner recovery did not complete"
      />
      <Field id="recover-email" label="Owner sign-in email">
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
      <Field id="recover-code" label="Host-issued recovery code">
        <input
          name="code"
          type="password"
          autoComplete="one-time-code"
          required
          {...rejectionA11y}
        />
      </Field>
      <Field
        hint="Use 12–128 characters."
        id="recover-new-password"
        label="New owner password"
      >
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
      <Field id="recover-confirm-password" label="Confirm new owner password">
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
      <SubmitButton variant="primary" pendingLabel="Recovering owner…">
        Recover owner account
      </SubmitButton>
    </form>
  )
}
