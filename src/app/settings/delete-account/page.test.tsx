// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DeleteAccountPage from './page'

const pageMocks = vi.hoisted(() => ({
  getPlan: vi.fn(),
  issueForm: vi.fn(),
  redirect: vi.fn(),
  requireUiActor: vi.fn(),
  verifyNotice: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: pageMocks.redirect }))
vi.mock('@/components', () => ({
  PageHeading: ({ title }: { title: string }) => <h1>{title}</h1>,
  ProductFrame: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  SubmitButton: ({ children }: { children: ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}))
vi.mock('@/modules/data-portability/application/deletion', () => ({
  getActiveSubjectDeletionPlan: pageMocks.getPlan,
}))
vi.mock('@/modules/data-portability/server/destructive-notice', () => ({
  verifySubjectDeletionNoticeReceiptForActor: pageMocks.verifyNotice,
}))
vi.mock('@/modules/identity/server/actor', () => ({
  issueTraineeDataDeletionFormEnvelope: pageMocks.issueForm,
  requireUiActor: pageMocks.requireUiActor,
}))
vi.mock('./actions', () => ({
  createAccountDeletionPreviewAction: vi.fn(),
  deleteAccountAction: vi.fn(),
}))

const actionEnvelope = Object.freeze({ opaque: true })
const plan = {
  id: 'subject-plan-id',
  digest: 'subject-plan-digest',
  expiresAt: new Date('2099-07-16T13:00:00.000Z'),
  counts: { users: 1 },
}

describe('subject-deletion page binding and recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pageMocks.requireUiActor.mockResolvedValue({
      userId: 'member-id',
      email: 'member@example.test',
      name: 'Member',
      role: 'member',
      authenticatedActionEnvelope: actionEnvelope,
    })
    pageMocks.getPlan.mockResolvedValue(plan)
    pageMocks.verifyNotice.mockReturnValue(null)
    pageMocks.issueForm.mockReturnValue({
      planId: plan.id,
      planDigest: plan.digest,
      actionBinding: 'opaque-subject-binding',
    })
  })

  afterEach(cleanup)

  it('renders only the opaque plan binding and always offers a fresh preview', async () => {
    const { container } = render(
      await DeleteAccountPage({ searchParams: Promise.resolve({}) }),
    )

    expect(pageMocks.issueForm).toHaveBeenCalledWith(
      actionEnvelope,
      plan,
      expect.any(Date),
    )
    expect(container.querySelector('input[name="planId"]')).toHaveValue(plan.id)
    expect(container.querySelector('input[name="planDigest"]')).toHaveValue(plan.digest)
    expect(container.querySelector('input[name="actionBinding"]')).toHaveValue(
      'opaque-subject-binding',
    )
    expect(container.querySelector('input[name="expectedEpoch"]')).toBeNull()
    expect(container.querySelector('input[name="sessionId"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate fresh preview' })).toBeVisible()
  })

  it('states known stale failure without claiming that an uncertain operation rolled back', async () => {
    pageMocks.verifyNotice.mockReturnValueOnce({ kind: 'stale' })
    render(
      await DeleteAccountPage({
        searchParams: Promise.resolve({ notice: 'signed-stale' }),
      }),
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was deleted')
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Generate exact account-deletion preview' }),
    ).toBeVisible()

    cleanup()
    pageMocks.verifyNotice.mockReturnValueOnce({
      kind: 'outcome-unknown',
      actorRole: 'member',
    })
    render(
      await DeleteAccountPage({
        searchParams: Promise.resolve({ notice: 'signed-unknown' }),
      }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('outcome could not be confirmed')
    expect(screen.getByRole('alert')).toHaveTextContent('Do not submit it again')
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
    expect(pageMocks.issueForm).not.toHaveBeenCalled()
  })

  it('states that a request-capture failure never started deletion', async () => {
    pageMocks.verifyNotice.mockReturnValueOnce({ kind: 'request-not-verified' })

    render(
      await DeleteAccountPage({
        searchParams: Promise.resolve({ notice: 'signed-request-failure' }),
      }),
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'request could not be verified. Nothing was deleted',
    )
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
  })

  it('ignores an unsigned or invalid notice instead of inventing an outcome', async () => {
    render(
      await DeleteAccountPage({
        searchParams: Promise.resolve({ notice: 'tampered-or-expired' }),
      }),
    )

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Current password')).toBeVisible()
    expect(pageMocks.verifyNotice).toHaveBeenCalledWith(
      'tampered-or-expired',
      'member-id',
    )
  })

  it('drops a preview that expires during rendering instead of emitting a dead form', async () => {
    pageMocks.getPlan.mockResolvedValueOnce({
      ...plan,
      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
    })
    pageMocks.issueForm.mockReturnValueOnce(null)

    render(await DeleteAccountPage({ searchParams: Promise.resolve({}) }))

    expect(
      screen.getByRole('button', { name: 'Generate exact account-deletion preview' }),
    ).toBeVisible()
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
  })

  it('redirects when a current plan cannot be bound to the now-expired session', async () => {
    const redirectSignal = new Error('NEXT_REDIRECT')
    pageMocks.issueForm.mockReturnValueOnce(null)
    pageMocks.redirect.mockImplementationOnce(() => {
      throw redirectSignal
    })

    await expect(DeleteAccountPage({ searchParams: Promise.resolve({}) })).rejects.toBe(
      redirectSignal,
    )
    expect(pageMocks.redirect).toHaveBeenCalledWith('/sign-in')
  })
})
