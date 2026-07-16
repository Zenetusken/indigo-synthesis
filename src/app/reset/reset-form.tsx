'use client'

import { useRouter } from 'next/navigation'
import { useActionState, useEffect, useRef } from 'react'
import { ErrorSummary } from '@/components/error-summary'
import { Field } from '@/components/field'
import { SubmitButton } from '@/components/submit-button'
import type { MemberResetRedemptionActionBinding } from '@/modules/identity/application/action-binding'
import styles from '../recovery-form.module.css'
import { type ResetCredentialActionState, resetMemberCredentialAction } from './actions'

const initialState: ResetCredentialActionState = {
  kind: 'idle',
  email: '',
  message: null,
  stale: false,
}

export function ResetCredentialForm({
  actionBinding,
}: {
  readonly actionBinding: MemberResetRedemptionActionBinding
}) {
  const [state, action] = useActionState(resetMemberCredentialAction, initialState)
  const formRef = useRef<HTMLFormElement>(null)
  const issuedBindingRef = useRef(actionBinding)
  const handledStaleResponse = useRef<ResetCredentialActionState | null>(null)
  const router = useRouter()

  useEffect(() => {
    if (state.kind === 'rejected') {
      formRef.current?.reset()
      const email = formRef.current?.elements.namedItem('email')
      if (email instanceof HTMLInputElement) email.value = state.email
      document.querySelector<HTMLElement>('#reset-error-summary')?.focus()
    }
    if (state.stale && handledStaleResponse.current !== state) {
      handledStaleResponse.current = state
      router.refresh()
    } else if (!state.stale) {
      handledStaleResponse.current = null
    }
  }, [router, state])

  useEffect(() => {
    if (issuedBindingRef.current === actionBinding) return
    const form = formRef.current
    const email = form?.elements.namedItem('email')
    const preservedEmail = email instanceof HTMLInputElement ? email.value : ''
    form?.reset()
    const refreshedEmail = form?.elements.namedItem('email')
    if (refreshedEmail instanceof HTMLInputElement) refreshedEmail.value = preservedEmail
    issuedBindingRef.current = actionBinding
  }, [actionBinding])

  const errors = state.message ? [{ key: 'reset-rejected', message: state.message }] : []
  const rejectionA11y = state.message
    ? ({ 'aria-describedby': 'reset-error-summary', 'aria-invalid': true } as const)
    : {}

  return (
    <form action={action} className={styles.form} noValidate ref={formRef}>
      <input name="actionBinding" type="hidden" value={actionBinding} />
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
