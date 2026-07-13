'use client'

import { type ReactNode, useEffect, useRef } from 'react'

/**
 * Wraps a server-rendered error/notice that appears on first paint (e.g. after a
 * failed action redirects with `?error=`). A live region present at load does not
 * reliably announce; moving focus to this alert on mount does, and is appropriate
 * because it only renders as the direct result of the action the user just took.
 */
export function FocusAlert({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  return (
    <div ref={ref} role="alert" tabIndex={-1} style={{ outline: 'none' }}>
      {children}
    </div>
  )
}
