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

function form() {
  return (
    <MemberResetForm
      targetUserId={targetUserId}
      targetName={targetName}
      actionBinding={actionBinding}
    />
  )
}

const formMocks = vi.hoisted(() => ({
  action: vi.fn(),
  state: { errors: [], issued: null } as MemberResetIssueActionState,
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
    formMocks.state = { errors: [], issued: null }
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

    formMocks.state = { errors: ['The owner password was not accepted.'], issued: null }
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
})
