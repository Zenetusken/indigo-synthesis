'use client'

import type { ComponentProps } from 'react'
import { useFormStatus } from 'react-dom'
import { ActionButton } from './action-button'

type SubmitButtonProps = Omit<ComponentProps<typeof ActionButton>, 'busy' | 'type'> & {
  pendingLabel: string
}

export function SubmitButton({ children, pendingLabel, ...props }: SubmitButtonProps) {
  const { pending } = useFormStatus()

  return (
    <ActionButton {...props} busy={pending} type="submit">
      {pending ? pendingLabel : children}
    </ActionButton>
  )
}
