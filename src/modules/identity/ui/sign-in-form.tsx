'use client'

import type { Route } from 'next'
import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useRef, useState, useTransition } from 'react'
import {
  type EmailSignInActionBinding,
  identityActionBindingHeader,
} from '../application/action-binding'
import { authClient } from './auth-client'
import styles from './identity-forms.module.css'

const rejectedCredentialMessage = 'The email or password was not accepted.'
const interruptedSignInMessage = 'Sign-in did not complete. Try again.'

export function SignInForm({
  actionBinding,
  returnTo = '/',
}: {
  readonly actionBinding: EmailSignInActionBinding
  readonly returnTo?: string
}) {
  const router = useRouter()
  const errorRef = useRef<HTMLDivElement>(null)
  const reloadRequested = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [reloadMessage, setReloadMessage] = useState<string | null>(null)
  const [refreshing, startRefresh] = useTransition()

  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

  useEffect(() => {
    if (!reloadRequested.current || refreshing) return
    reloadRequested.current = false
    setReloadMessage('Sign-in reloaded. Try again with your local credentials.')
  }, [refreshing])

  function reloadSignIn(): void {
    setError(null)
    setReloadMessage('Refreshing sign-in…')
    reloadRequested.current = true
    startRefresh(() => router.refresh())
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)

    setPending(true)
    setError(null)
    setReloadMessage(null)

    try {
      const result = await authClient.signIn.email({
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
        rememberMe: true,
        fetchOptions: {
          headers: { [identityActionBindingHeader]: actionBinding },
        },
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
          <button type="button" onClick={reloadSignIn}>
            Reload sign-in
          </button>
        </div>
      ) : null}

      {reloadMessage ? (
        <p role="status" aria-live="polite">
          {reloadMessage}
        </p>
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

      <button type="submit" disabled={pending || refreshing}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
