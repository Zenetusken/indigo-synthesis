'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { authClient } from './auth-client'
import styles from './identity-forms.module.css'

export function BootstrapForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)

    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') ?? '')
    const confirmation = String(form.get('passwordConfirmation') ?? '')

    if (password !== confirmation) {
      setError('The password confirmation does not match.')
      setPending(false)
      return
    }

    const result = await authClient.signUp.email({
      name: String(form.get('name') ?? ''),
      email: String(form.get('email') ?? ''),
      password,
    })

    if (result.error) {
      const closed = result.error.message?.toLowerCase().includes('bootstrap')
      setError(
        closed
          ? 'This instance already has an owner. Sign in instead.'
          : (result.error.message ?? 'The owner account could not be created.'),
      )
      setPending(false)
      return
    }

    router.push('/sign-in?created=1')
    router.refresh()
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {error ? (
        <div className={styles.error} role="alert" tabIndex={-1}>
          <strong>Owner account not created</strong>
          <span>{error}</span>
        </div>
      ) : null}

      <label>
        <span>Name</span>
        <input name="name" autoComplete="name" minLength={2} maxLength={100} required />
      </label>

      <label>
        <span>Local sign-in email</span>
        <input name="email" type="email" autoComplete="email" required />
      </label>

      <label>
        <span>Password</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
        <small>Use 12–128 characters. This installation does not require email.</small>
      </label>

      <label>
        <span>Confirm password</span>
        <input
          name="passwordConfirmation"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
      </label>

      <button type="submit" disabled={pending}>
        {pending ? 'Creating owner…' : 'Create owner account'}
      </button>
    </form>
  )
}
