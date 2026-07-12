'use client'

import { useEffect } from 'react'

type ContinuationFocusProps = {
  targetId: string | null
}

export function ContinuationFocus({ targetId }: ContinuationFocusProps) {
  useEffect(() => {
    if (!targetId) return
    document.getElementById(targetId)?.focus()
  }, [targetId])

  return null
}
