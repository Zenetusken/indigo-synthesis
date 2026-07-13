// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubmitButton } from './submit-button'

const formStatus = vi.hoisted(() => ({
  useFormStatus: vi.fn(),
}))

vi.mock('react-dom', async (importOriginal) => {
  const original = await importOriginal<typeof import('react-dom')>()
  return { ...original, useFormStatus: formStatus.useFormStatus }
})

describe('SubmitButton', () => {
  beforeEach(() => {
    formStatus.useFormStatus.mockReturnValue({
      pending: false,
      data: null,
      method: null,
      action: null,
    })
  })

  afterEach(cleanup)

  it('renders a submit control with its idle label', () => {
    render(<SubmitButton pendingLabel="Saving…">Save</SubmitButton>)

    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'submit')
  })

  it('locks the control and exposes its pending state', () => {
    formStatus.useFormStatus.mockReturnValue({
      pending: true,
      data: new FormData(),
      method: 'post',
      action: '/save',
    })

    render(<SubmitButton pendingLabel="Saving…">Save</SubmitButton>)

    const button = screen.getByRole('button', { name: 'Saving…' })
    // The busy control stays focusable (aria-disabled, not native `disabled`)
    // so mid-submit focus is not dropped to the body; the pointer/keyboard
    // re-activation guard is asserted behaviourally in action-button.test.tsx.
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-busy', 'true')
  })
})
