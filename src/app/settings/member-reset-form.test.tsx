// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberResetIssueActionBinding } from '@/modules/identity/application/action-binding'
import type { MemberResetIssueActionState } from './actions'
import { MemberResetForm } from './member-reset-form'

const targetUserId = 'member-id'
const targetName = 'Local Trainee'
const actionBinding = 'opaque-member-reset-binding' as MemberResetIssueActionBinding

function form(binding = actionBinding) {
  return (
    <MemberResetForm
      targetUserId={targetUserId}
      targetName={targetName}
      actionBinding={binding}
    />
  )
}

const formMocks = vi.hoisted(() => ({
  action: vi.fn(),
  refresh: vi.fn(),
  state: { errors: [], issued: null, stale: false } as MemberResetIssueActionState,
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

describe('MemberResetForm', () => {
  beforeEach(() => {
    formMocks.state = { errors: [], issued: null, stale: false }
    formMocks.refresh.mockClear()
  })

  afterEach(cleanup)

  it('names the target, warns about invalidation, and clears reauthentication secrets', async () => {
    const view = render(form())
    const summary = screen.getByText('Issue password reset code for Local Trainee')
    expect(summary).toBeVisible()
    fireEvent.click(summary)
    const warning = screen.getByText(
      'Issuing a new code invalidates any earlier unused reset code for Local Trainee.',
    )
    expect(warning).toBeVisible()

    const password = screen.getByLabelText('Current owner password for Local Trainee')
    expect(password.getAttribute('aria-describedby')?.split(' ')).toContain(warning.id)
    fireEvent.change(password, { target: { value: 'current-owner-password' } })

    formMocks.state = {
      errors: ['The owner password was not accepted.'],
      issued: null,
      stale: false,
    }
    view.rerender(form())
    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(password).toHaveValue('')
    expect(password).toHaveAttribute('aria-invalid', 'true')
    expect(password.getAttribute('aria-describedby')?.split(' ')).toEqual(
      expect.arrayContaining([warning.id, alert.id]),
    )

    fireEvent.change(password, { target: { value: 'current-owner-password' } })
    formMocks.state = {
      errors: [],
      issued: {
        targetUserId: 'member-id',
        code: 'indigo_m1_one_time_code',
        expiresAt: '2026-07-13T18:00:00.000Z',
      },
      stale: false,
    }
    view.rerender(form())
    expect(await screen.findByRole('status')).toHaveTextContent('indigo_m1_one_time_code')
    expect(password).toHaveValue('')
  })

  it('submits only the selected target and opaque proof as hidden authority fields', () => {
    const { container } = render(form())
    const hiddenFields = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="hidden"]'),
    )

    expect(hiddenFields.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'targetUserId', value: targetUserId },
      { name: 'actionBinding', value: actionBinding },
    ])
  })

  it('refreshes a stale target once and clears password and one-time-code state', async () => {
    const view = render(form())
    formMocks.state = {
      errors: [],
      issued: {
        targetUserId,
        code: 'indigo_m1_one_time_code',
        expiresAt: '2026-07-15T21:15:00.000Z',
      },
      stale: false,
    }
    view.rerender(form())
    expect(await screen.findByText('indigo_m1_one_time_code')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Current owner password for Local Trainee'), {
      target: { value: 'current-owner-password' },
    })
    formMocks.state = {
      errors: ['This settings form is out of date.'],
      issued: null,
      stale: true,
    }
    const refreshedBinding =
      'opaque-refreshed-member-reset-binding' as MemberResetIssueActionBinding
    view.rerender(form(refreshedBinding))

    await waitFor(() => expect(formMocks.refresh).toHaveBeenCalledOnce())
    expect(formMocks.action).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Current owner password for Local Trainee')).toHaveValue(
      '',
    )
    expect(screen.queryByText('indigo_m1_one_time_code')).not.toBeInTheDocument()
    expect(
      view.container.querySelector<HTMLInputElement>('input[name="actionBinding"]'),
    ).toHaveValue(refreshedBinding)

    view.rerender(form(refreshedBinding))
    expect(formMocks.refresh).toHaveBeenCalledOnce()

    formMocks.state = {
      errors: ['The refreshed member target became stale again.'],
      issued: null,
      stale: true,
    }
    view.rerender(form(refreshedBinding))
    await waitFor(() => expect(formMocks.refresh).toHaveBeenCalledTimes(2))
    expect(formMocks.action).not.toHaveBeenCalled()
  })
})
