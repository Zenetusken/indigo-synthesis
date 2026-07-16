// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalUserCreateActionBinding } from '@/modules/identity/application/action-binding'
import type { LocalUserActionState } from './actions'
import { LocalUserForm } from './local-user-form'

const targetUserId = 'preallocated-local-user-id'
const actionBinding = 'opaque-local-user-create-binding' as LocalUserCreateActionBinding

function form(binding = actionBinding) {
  return <LocalUserForm targetUserId={targetUserId} actionBinding={binding} />
}

const formMocks = vi.hoisted(() => ({
  action: vi.fn(),
  refresh: vi.fn(),
  state: { errors: [], createdEmail: null, stale: false } as LocalUserActionState,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: formMocks.refresh }),
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
    formMocks.state = { errors: [], createdEmail: null, stale: false }
    formMocks.refresh.mockClear()
  })

  afterEach(cleanup)

  it('clears both live passwords after rejection and resets all fields after success', async () => {
    const view = render(form())
    fillForm()

    formMocks.state = {
      errors: ['The owner password was not accepted.'],
      createdEmail: null,
      stale: false,
    }
    view.rerender(form())
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
    formMocks.state = {
      errors: [],
      createdEmail: 'trainee@example.test',
      stale: false,
    }
    view.rerender(form())
    await screen.findByRole('status')
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue(''))
    expect(screen.getByLabelText('Local sign-in email')).toHaveValue('')
    expect(screen.getByLabelText('Initial password')).toHaveValue('')
    expect(screen.getByLabelText('Current owner password')).toHaveValue('')
  })

  it('submits only the preallocated target and opaque proof as hidden authority fields', () => {
    const { container } = render(form())
    const hiddenFields = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="hidden"]'),
    )

    expect(hiddenFields.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'targetUserId', value: targetUserId },
      { name: 'actionBinding', value: actionBinding },
    ])
  })

  it('refreshes one stale form without retrying, preserving safe fields and clearing secrets', async () => {
    const view = render(form())
    fillForm()
    formMocks.state = {
      errors: ['This settings form is out of date.'],
      createdEmail: null,
      stale: true,
    }

    const refreshedBinding =
      'opaque-refreshed-local-user-binding' as LocalUserCreateActionBinding
    view.rerender(form(refreshedBinding))

    await waitFor(() => expect(formMocks.refresh).toHaveBeenCalledOnce())
    expect(formMocks.action).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Name')).toHaveValue('Local Trainee')
    expect(screen.getByLabelText('Local sign-in email')).toHaveValue(
      'trainee@example.test',
    )
    expect(screen.getByLabelText('Initial password')).toHaveValue('')
    expect(screen.getByLabelText('Current owner password')).toHaveValue('')
    expect(
      view.container.querySelector<HTMLInputElement>('input[name="actionBinding"]'),
    ).toHaveValue(refreshedBinding)

    view.rerender(form(refreshedBinding))
    expect(formMocks.refresh).toHaveBeenCalledOnce()

    formMocks.state = {
      errors: ['The refreshed settings form became stale again.'],
      createdEmail: null,
      stale: true,
    }
    view.rerender(form(refreshedBinding))
    await waitFor(() => expect(formMocks.refresh).toHaveBeenCalledTimes(2))
    expect(formMocks.action).not.toHaveBeenCalled()
  })
})
