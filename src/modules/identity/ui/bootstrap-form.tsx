'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { bootstrapOwner, getOwnerBootstrapStatus } from '../server/bootstrap'
import styles from './identity-forms.module.css'

export function BootstrapForm() {
  const router = useRouter()
  const errorRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

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

    try {
      const result = await bootstrapOwner({
        name: String(form.get('name') ?? ''),
        email: String(form.get('email') ?? ''),
        password,
        code: String(form.get('bootstrapCode') ?? ''),
      })

      if (result.kind === 'created') {
        router.push('/sign-in?created=1')
        return
      }
      if (result.kind === 'closed') {
        router.push('/sign-in?claimed=1')
        return
      }
      setError(
        'The account was not created. Check the host-issued code and account fields, then try again.',
      )
    } catch {
      try {
        const status = await getOwnerBootstrapStatus()
        if (status === 'closed') {
          router.push('/sign-in?claimed=1')
          return
        }
        setError('Creation did not complete. Your entries remain; try again.')
      } catch {
        setError(
          'Creation status is unknown. Check the instance status or try signing in before issuing another code.',
        )
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {error ? (
        <div className={styles.error} ref={errorRef} role="alert" tabIndex={-1}>
          <strong>Owner account not created</strong>
          <span>{error}</span>
        </div>
      ) : null}

      <label>
        <span>Host-issued bootstrap code</span>
        <input
          name="bootstrapCode"
          type="password"
          autoComplete="one-time-code"
          minLength={32}
          maxLength={256}
          required
        />
        <small>Issue this one-use code from the host before creating the owner.</small>
      </label>

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
