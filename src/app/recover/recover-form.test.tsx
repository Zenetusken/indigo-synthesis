// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerRecoveryRedemptionActionBinding } from '@/modules/identity/application/action-binding'
import type { RecoverOwnerActionState } from './actions'
import { RecoverOwnerForm } from './recover-form'

const actionBinding =
  'iab1.owner-recovery-redemption.test.binding' as OwnerRecoveryRedemptionActionBinding
const refreshedActionBinding =
  'iab1.owner-recovery-redemption.refreshed.binding' as OwnerRecoveryRedemptionActionBinding

const formMocks = vi.hoisted(() => ({
  action: vi.fn(),
  refresh: vi.fn(),
  state: {
    kind: 'idle',
    email: '',
    message: null,
    stale: false,
  } as RecoverOwnerActionState,
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

describe('RecoverOwnerForm', () => {
  beforeEach(() => {
    formMocks.state = { kind: 'idle', email: '', message: null, stale: false }
    formMocks.action.mockClear()
    formMocks.refresh.mockClear()
  })

  afterEach(cleanup)

  it('clears every secret and exposes a single uniform rejection relationship', async () => {
    const view = render(<RecoverOwnerForm actionBinding={actionBinding} />)
    expect(
      view.container.querySelector<HTMLInputElement>('input[name="actionBinding"]'),
    ).toHaveValue(actionBinding)
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
      stale: false,
    }
    view.rerender(<RecoverOwnerForm actionBinding={actionBinding} />)

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

  it('keeps only the non-secret email when a stale page proof is replaced', async () => {
    const view = render(<RecoverOwnerForm actionBinding={actionBinding} />)
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

    view.rerender(<RecoverOwnerForm actionBinding={refreshedActionBinding} />)

    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLInputElement>('input[name="actionBinding"]'),
      ).toHaveValue(refreshedActionBinding),
    )
    expect(screen.getByLabelText('Owner sign-in email')).toHaveValue('owner@example.test')
    for (const label of [
      'Host-issued recovery code',
      'New owner password',
      'Confirm new owner password',
    ]) {
      expect(screen.getByLabelText(label)).toHaveValue('')
    }
  })

  it('refreshes each distinct stale response once without retrying and clears all secrets', async () => {
    const view = render(<RecoverOwnerForm actionBinding={actionBinding} />)
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
      stale: true,
    }
    view.rerender(<RecoverOwnerForm actionBinding={actionBinding} />)

    await waitFor(() => expect(formMocks.refresh).toHaveBeenCalledOnce())
    expect(formMocks.action).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Owner sign-in email')).toHaveValue('owner@example.test')
    for (const label of [
      'Host-issued recovery code',
      'New owner password',
      'Confirm new owner password',
    ]) {
      expect(screen.getByLabelText(label)).toHaveValue('')
    }

    view.rerender(<RecoverOwnerForm actionBinding={actionBinding} />)
    expect(formMocks.refresh).toHaveBeenCalledOnce()

    formMocks.state = {
      kind: 'rejected',
      email: 'owner@example.test',
      message: 'The email, code, or password was not accepted.',
      stale: true,
    }
    view.rerender(<RecoverOwnerForm actionBinding={actionBinding} />)
    await waitFor(() => expect(formMocks.refresh).toHaveBeenCalledTimes(2))
    expect(formMocks.action).not.toHaveBeenCalled()
  })
})
