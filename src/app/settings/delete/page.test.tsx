// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DeleteSettingsPage from './page'

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
  getActiveInstanceResetPlan: pageMocks.getPlan,
}))
vi.mock('@/modules/data-portability/server/destructive-notice', () => ({
  verifyInstanceResetNoticeReceipt: pageMocks.verifyNotice,
}))
vi.mock('@/modules/identity/server/actor', () => ({
  issueInstanceResetFormEnvelope: pageMocks.issueForm,
  requireUiActor: pageMocks.requireUiActor,
}))
vi.mock('./actions', () => ({
  createResetPreviewAction: vi.fn(),
  resetInstanceAction: vi.fn(),
}))

const actionEnvelope = Object.freeze({ opaque: true })
const plan = {
  id: 'reset-plan-id',
  digest: 'reset-plan-digest',
  expiresAt: new Date('2099-07-16T13:00:00.000Z'),
  counts: { users: 2 },
}

describe('instance-reset page binding and recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pageMocks.requireUiActor.mockResolvedValue({
      userId: 'owner-id',
      email: 'owner@example.test',
      name: 'Owner',
      role: 'owner',
      authenticatedActionEnvelope: actionEnvelope,
    })
    pageMocks.getPlan.mockResolvedValue(plan)
    pageMocks.verifyNotice.mockReturnValue(null)
    pageMocks.issueForm.mockReturnValue({
      planId: plan.id,
      planDigest: plan.digest,
      actionBinding: 'opaque-reset-binding',
    })
  })

  afterEach(cleanup)

  it('renders the opaque reset binding and a fresh-preview recovery action', async () => {
    const { container } = render(
      await DeleteSettingsPage({ searchParams: Promise.resolve({}) }),
    )

    expect(pageMocks.issueForm).toHaveBeenCalledWith(
      actionEnvelope,
      plan,
      expect.any(Date),
    )
    expect(container.querySelector('input[name="planId"]')).toHaveValue(plan.id)
    expect(container.querySelector('input[name="planDigest"]')).toHaveValue(plan.digest)
    expect(container.querySelector('input[name="actionBinding"]')).toHaveValue(
      'opaque-reset-binding',
    )
    expect(container.querySelector('input[name="expectedEpoch"]')).toBeNull()
    expect(container.querySelector('input[name="sessionId"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate fresh preview' })).toBeVisible()
  })

  it('distinguishes a known capacity rejection from an unknown reset outcome', async () => {
    pageMocks.verifyNotice.mockReturnValueOnce({ kind: 'unavailable' })
    render(
      await DeleteSettingsPage({
        searchParams: Promise.resolve({ notice: 'signed-capacity' }),
      }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The database could not complete the reset. Nothing was reset',
    )
    expect(screen.queryByLabelText('Current owner password')).not.toBeInTheDocument()

    cleanup()
    pageMocks.verifyNotice.mockReturnValueOnce({ kind: 'outcome-unknown' })
    render(
      await DeleteSettingsPage({
        searchParams: Promise.resolve({ notice: 'signed-unknown' }),
      }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('outcome could not be confirmed')
    expect(screen.getByRole('alert')).toHaveTextContent('Do not submit it again')
    expect(screen.queryByLabelText('Current owner password')).not.toBeInTheDocument()
    expect(pageMocks.issueForm).not.toHaveBeenCalled()
  })

  it('states that a request-capture failure never started the reset', async () => {
    pageMocks.verifyNotice.mockReturnValueOnce({ kind: 'request-not-verified' })

    render(
      await DeleteSettingsPage({
        searchParams: Promise.resolve({ notice: 'signed-request-failure' }),
      }),
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'request could not be verified. Nothing was reset',
    )
    expect(screen.queryByLabelText('Current owner password')).not.toBeInTheDocument()
  })

  it('redirects a member before reading an owner-only reset plan', async () => {
    const redirectSignal = new Error('NEXT_REDIRECT')
    pageMocks.requireUiActor.mockResolvedValueOnce({
      userId: 'member-id',
      role: 'member',
      authenticatedActionEnvelope: actionEnvelope,
    })
    pageMocks.redirect.mockImplementationOnce(() => {
      throw redirectSignal
    })

    await expect(DeleteSettingsPage({ searchParams: Promise.resolve({}) })).rejects.toBe(
      redirectSignal,
    )
    expect(pageMocks.redirect).toHaveBeenCalledWith('/settings')
    expect(pageMocks.getPlan).not.toHaveBeenCalled()
  })

  it('drops a preview that expires during rendering instead of emitting a dead form', async () => {
    pageMocks.getPlan.mockResolvedValueOnce({
      ...plan,
      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
    })
    pageMocks.issueForm.mockReturnValueOnce(null)

    render(await DeleteSettingsPage({ searchParams: Promise.resolve({}) }))

    expect(
      screen.getByRole('button', { name: 'Generate exact reset preview' }),
    ).toBeVisible()
    expect(screen.queryByLabelText('Current owner password')).not.toBeInTheDocument()
  })

  it('redirects when a current reset plan cannot bind to the current session', async () => {
    const redirectSignal = new Error('NEXT_REDIRECT')
    pageMocks.issueForm.mockReturnValueOnce(null)
    pageMocks.redirect.mockImplementationOnce(() => {
      throw redirectSignal
    })

    await expect(DeleteSettingsPage({ searchParams: Promise.resolve({}) })).rejects.toBe(
      redirectSignal,
    )
    expect(pageMocks.redirect).toHaveBeenCalledWith('/sign-in')
  })
})
