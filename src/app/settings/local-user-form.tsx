'use client'

import { useActionState } from 'react'
import { ActionButton } from '@/components'
import { createLocalUserAction, type LocalUserActionState } from './actions'
import styles from './settings.module.css'

const initialLocalUserActionState: LocalUserActionState = {
  errors: [],
  createdEmail: null,
}

export function LocalUserForm() {
  const [state, action, pending] = useActionState(
    createLocalUserAction,
    initialLocalUserActionState,
  )

  return (
    <form action={action} className={styles.form}>
      {state.errors.length > 0 ? (
        <div className={styles.error} role="alert">
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
          <input name="name" autoComplete="off" minLength={1} maxLength={100} required />
        </label>
        <label>
          <span>Local sign-in email</span>
          <input name="email" type="email" autoComplete="off" required />
        </label>
        <label>
          <span>Initial password</span>
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </label>
      </div>
      <ActionButton variant="primary" type="submit" busy={pending}>
        {pending ? 'Creating local user…' : 'Create local user'}
      </ActionButton>
    </form>
  )
}
