'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { authClient } from './auth-client'

export function SignOutButton() {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function signOut() {
    setPending(true)
    await authClient.signOut()
    router.push('/sign-in?signedOut=1')
    router.refresh()
  }

  return (
    <button type="button" onClick={signOut} disabled={pending}>
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
