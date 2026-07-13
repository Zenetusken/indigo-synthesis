// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecoverOwnerActionState } from './actions'
import { RecoverOwnerForm } from './recover-form'

const formMocks = vi.hoisted(() => ({
  action: vi.fn(),
  state: {
    kind: 'idle',
    email: '',
    message: null,
  } as RecoverOwnerActionState,
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useActionState: () => [formMocks.state, formMocks.action, false],
  }
})

describe('RecoverOwnerForm', () => {
  beforeEach(() => {
    formMocks.state = { kind: 'idle', email: '', message: null }
  })

  afterEach(cleanup)

  it('clears every secret and exposes a single uniform rejection relationship', async () => {
    const view = render(<RecoverOwnerForm />)
    expect(screen.getByLabelText('New owner password')).toHaveAttribute(
      'aria-describedby',
      'recover-new-password-hint',
    )
    expect(screen.getByText('Use 12–128 characters.')).toHaveAttribute(
      'id',
      'recover-new-password-hint',
    )
    fireEvent.change(screen.getByLabelText('Owner sign-in email'), {
      target: { value: 'owner@example.test' },
    })
    for (const [label, value] of [
      ['Host-issued recovery code', 'indigo_r1_secret'],
      ['New owner password', 'replacement-password'],
      ['Confirm new owner password', 'replacement-password'],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } })
    }

    formMocks.state = {
      kind: 'rejected',
      email: 'owner@example.test',
      message: 'The email, code, or password was not accepted.',
    }
    view.rerender(<RecoverOwnerForm />)

    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(screen.getByLabelText('Owner sign-in email')).toHaveValue('owner@example.test')
    for (const label of [
      'Host-issued recovery code',
      'New owner password',
      'Confirm new owner password',
    ]) {
      expect(screen.getByLabelText(label)).toHaveValue('')
    }
    for (const label of [
      'Owner sign-in email',
      'Host-issued recovery code',
      'New owner password',
      'Confirm new owner password',
    ]) {
      const control = screen.getByLabelText(label)
      expect(control).toHaveAttribute('aria-invalid', 'true')
      expect(control.getAttribute('aria-describedby')?.split(' ')).toContain(
        'recover-error-summary',
      )
    }
    expect(screen.getByLabelText('New owner password')).toHaveAttribute(
      'aria-describedby',
      'recover-error-summary recover-new-password-hint',
    )
  })
})
