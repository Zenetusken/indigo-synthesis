// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalUserActionState } from './actions'
import { LocalUserForm } from './local-user-form'

const formMocks = vi.hoisted(() => ({
  action: vi.fn(),
  state: { errors: [], createdEmail: null } as LocalUserActionState,
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useActionState: () => [formMocks.state, formMocks.action, false],
  }
})

function fillForm() {
  for (const [label, value] of [
    ['Name', 'Local Trainee'],
    ['Local sign-in email', 'trainee@example.test'],
    ['Initial password', 'initial-user-password'],
    ['Current owner password', 'current-owner-password'],
  ]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  }
}

describe('LocalUserForm', () => {
  beforeEach(() => {
    formMocks.state = { errors: [], createdEmail: null }
  })

  afterEach(cleanup)

  it('clears both live passwords after rejection and resets all fields after success', async () => {
    const view = render(<LocalUserForm />)
    fillForm()

    formMocks.state = {
      errors: ['The owner password was not accepted.'],
      createdEmail: null,
    }
    view.rerender(<LocalUserForm />)
    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(screen.getByLabelText('Name')).toHaveValue('Local Trainee')
    expect(screen.getByLabelText('Local sign-in email')).toHaveValue(
      'trainee@example.test',
    )
    expect(screen.getByLabelText('Initial password')).toHaveValue('')
    expect(screen.getByLabelText('Current owner password')).toHaveValue('')
    for (const label of [
      'Name',
      'Local sign-in email',
      'Initial password',
      'Current owner password',
    ]) {
      expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByLabelText(label)).toHaveAttribute('aria-describedby', alert.id)
    }

    fillForm()
    formMocks.state = { errors: [], createdEmail: 'trainee@example.test' }
    view.rerender(<LocalUserForm />)
    await screen.findByRole('status')
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue(''))
    expect(screen.getByLabelText('Local sign-in email')).toHaveValue('')
    expect(screen.getByLabelText('Initial password')).toHaveValue('')
    expect(screen.getByLabelText('Current owner password')).toHaveValue('')
  })
})
