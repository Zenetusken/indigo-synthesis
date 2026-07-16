'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  type CheckedSignOutActionBinding,
  checkedSignOutActionBindingHeader,
} from '../application/action-binding'
import { authClient } from './auth-client'
import styles from './identity-forms.module.css'

const interruptedSignOutMessage = 'Sign-out did not complete. Try again.'

export function SignOutButton({
  actionBinding,
}: {
  readonly actionBinding: CheckedSignOutActionBinding
}) {
  const router = useRouter()
  const errorRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

  async function signOut() {
    setPending(true)
    setError(null)

    try {
      const result = await authClient.signOut({
        fetchOptions: {
          headers: { [checkedSignOutActionBindingHeader]: actionBinding },
        },
      })
      if (result.error?.status === 401) {
        router.push('/sign-in')
        router.refresh()
        return
      }
      if (result.error || result.data?.success !== true) {
        setError(interruptedSignOutMessage)
        return
      }

      router.push('/sign-in?signedOut=1')
      router.refresh()
    } catch {
      setError(interruptedSignOutMessage)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className={styles.accountAction}>
      {error ? (
        <div
          className={`${styles.error} ${styles.accountError}`}
          ref={errorRef}
          role="alert"
          tabIndex={-1}
        >
          <strong>Sign-out failed</strong>
          <span>{error}</span>
        </div>
      ) : null}

      <button
        className={styles.signOut}
        type="button"
        onClick={signOut}
        disabled={pending}
        aria-busy={pending || undefined}
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  )
}
