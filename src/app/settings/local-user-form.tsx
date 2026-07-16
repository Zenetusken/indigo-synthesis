'use client'

import { useActionState, useEffect, useRef } from 'react'
import { ActionButton } from '@/components/action-button'
import type { LocalUserCreateActionBinding } from '@/modules/identity/application/action-binding'
import { createLocalUserAction, type LocalUserActionState } from './actions'
import styles from './settings.module.css'

const initialLocalUserActionState: LocalUserActionState = {
  errors: [],
  createdEmail: null,
}

export function LocalUserForm({
  targetUserId,
  actionBinding,
}: {
  readonly targetUserId: string
  readonly actionBinding: LocalUserCreateActionBinding
}) {
  const [state, action, pending] = useActionState(
    createLocalUserAction,
    initialLocalUserActionState,
  )
  const formRef = useRef<HTMLFormElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const rejectionA11y =
    state.errors.length > 0
      ? ({
          'aria-describedby': 'local-user-error-summary',
          'aria-invalid': true,
        } as const)
      : {}

  useEffect(() => {
    const form = formRef.current
    if (!form) return
    if (state.errors.length > 0) errorRef.current?.focus()
    if (state.createdEmail) form.reset()
    for (const fieldName of ['initialPassword', 'currentPassword']) {
      const field = form.elements.namedItem(fieldName)
      if (field instanceof HTMLInputElement) field.value = ''
    }
  }, [state])

  return (
    <form action={action} className={styles.form} ref={formRef}>
      <input name="targetUserId" type="hidden" value={targetUserId} />
      <input name="actionBinding" type="hidden" value={actionBinding} />
      {state.errors.length > 0 ? (
        <div
          className={styles.error}
          id="local-user-error-summary"
          ref={errorRef}
          role="alert"
          tabIndex={-1}
        >
          {state.errors.join(' ')}
        </div>
      ) : null}
      {state.createdEmail ? (
        <div className={styles.success} role="status">
          Local user {state.createdEmail} created. Share the password out of band.
        </div>
      ) : null}
      <div className={styles.formGrid}>
        <label>
          <span>Name</span>
          <input
            name="name"
            autoComplete="off"
            minLength={1}
            maxLength={100}
            required
            {...rejectionA11y}
          />
        </label>
        <label>
          <span>Local sign-in email</span>
          <input
            name="email"
            type="email"
            autoComplete="off"
            required
            {...rejectionA11y}
          />
        </label>
        <label>
          <span>Initial password</span>
          <input
            name="initialPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            {...rejectionA11y}
          />
        </label>
        <label>
          <span>Current owner password</span>
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            minLength={12}
            maxLength={128}
            required
            {...rejectionA11y}
          />
        </label>
      </div>
      <ActionButton variant="primary" type="submit" busy={pending}>
        {pending ? 'Creating local user…' : 'Create local user'}
      </ActionButton>
    </form>
  )
}
