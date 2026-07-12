'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { authClient } from './auth-client'
import styles from './identity-forms.module.css'

export function SignInForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)

    const form = new FormData(event.currentTarget)
    const result = await authClient.signIn.email({
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      rememberMe: true,
    })

    if (result.error) {
      setError('The email or password was not accepted.')
      setPending(false)
      return
    }

    router.push('/')
    router.refresh()
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {error ? (
        <div className={styles.error} role="alert" tabIndex={-1}>
          <strong>Sign-in failed</strong>
          <span>{error}</span>
        </div>
      ) : null}

      <label>
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" required />
      </label>

      <label>
        <span>Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={12}
          maxLength={128}
          required
        />
      </label>

      <button type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
