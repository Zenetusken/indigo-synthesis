// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResetCredentialActionState } from './actions'
import { ResetCredentialForm } from './reset-form'

const formMocks = vi.hoisted(() => ({
  action: vi.fn(),
  state: {
    kind: 'idle',
    email: '',
    message: null,
  } as ResetCredentialActionState,
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useActionState: () => [formMocks.state, formMocks.action, false],
  }
})

describe('ResetCredentialForm', () => {
  beforeEach(() => {
    formMocks.state = { kind: 'idle', email: '', message: null }
  })

  afterEach(cleanup)

  it('clears every secret and applies one non-enumerating form error to all controls', async () => {
    const view = render(<ResetCredentialForm />)
    expect(screen.getByLabelText('New password')).toHaveAttribute(
      'aria-describedby',
      'reset-new-password-hint',
    )
    expect(screen.getByText('Use 12–128 characters.')).toHaveAttribute(
      'id',
      'reset-new-password-hint',
    )
    fireEvent.change(screen.getByLabelText('Local sign-in email'), {
      target: { value: 'member@example.test' },
    })
    for (const [label, value] of [
      ['Owner-issued reset code', 'indigo_m1_secret'],
      ['New password', 'replacement-password'],
      ['Confirm new password', 'replacement-password'],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } })
    }

    formMocks.state = {
      kind: 'rejected',
      email: 'member@example.test',
      message: 'The email, code, or password was not accepted.',
    }
    view.rerender(<ResetCredentialForm />)

    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(screen.getByLabelText('Local sign-in email')).toHaveValue(
      'member@example.test',
    )
    for (const label of [
      'Owner-issued reset code',
      'New password',
      'Confirm new password',
    ]) {
      expect(screen.getByLabelText(label)).toHaveValue('')
    }
    for (const label of [
      'Local sign-in email',
      'Owner-issued reset code',
      'New password',
      'Confirm new password',
    ]) {
      const control = screen.getByLabelText(label)
      expect(control).toHaveAttribute('aria-invalid', 'true')
      expect(control.getAttribute('aria-describedby')?.split(' ')).toContain(
        'reset-error-summary',
      )
    }
    expect(screen.getByLabelText('New password')).toHaveAttribute(
      'aria-describedby',
      'reset-error-summary reset-new-password-hint',
    )
  })
})
