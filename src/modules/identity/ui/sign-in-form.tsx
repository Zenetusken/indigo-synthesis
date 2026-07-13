'use client'

import type { Route } from 'next'
import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { authClient } from './auth-client'
import styles from './identity-forms.module.css'

const rejectedCredentialMessage = 'The email or password was not accepted.'
const interruptedSignInMessage = 'Sign-in did not complete. Try again.'

export function SignInForm({ returnTo = '/' }: { returnTo?: string }) {
  const router = useRouter()
  const errorRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)

    setPending(true)
    setError(null)

    try {
      const result = await authClient.signIn.email({
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
        rememberMe: true,
      })

      if (result.error) {
        const passwordInput = formElement.elements.namedItem('password')
        if (passwordInput instanceof HTMLInputElement) passwordInput.value = ''
        setError(rejectedCredentialMessage)
        return
      }

      router.push(returnTo as Route)
      router.refresh()
    } catch {
      setError(interruptedSignInMessage)
    } finally {
      setPending(false)
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {error ? (
        <div className={styles.error} ref={errorRef} role="alert" tabIndex={-1}>
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
