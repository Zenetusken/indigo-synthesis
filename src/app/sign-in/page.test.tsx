// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SignInPage from './page'

const pageMocks = vi.hoisted(() => ({
  contentMode: 'development' as 'development' | 'reviewed',
  getActor: vi.fn(),
  getSignInPageInstallation: vi.fn(),
  redirect: vi.fn(),
  verifyResetNotice: vi.fn(),
  verifySubjectNotice: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
  }: {
    children: ReactNode
    href: string | { pathname: string }
  }) => <a href={typeof href === 'string' ? href : href.pathname}>{children}</a>,
}))
vi.mock('next/navigation', () => ({
  redirect: pageMocks.redirect,
}))
vi.mock('@/modules/data-portability/server/destructive-notice', () => ({
  verifyInstanceResetNoticeReceipt: pageMocks.verifyResetNotice,
  verifySubjectDeletionNoticeReceipt: pageMocks.verifySubjectNotice,
}))
vi.mock('@/modules/identity/server/sign-in-page', () => ({
  getSignInPageInstallation: pageMocks.getSignInPageInstallation,
}))
vi.mock('@/modules/identity/server/actor', () => ({
  getActor: pageMocks.getActor,
}))
vi.mock('@/modules/identity/ui/sign-in-form', () => ({
  SignInForm: ({
    actionBinding,
    returnTo,
  }: {
    actionBinding: string
    returnTo?: string
  }) => (
    <form data-action-binding={actionBinding} data-return-to={returnTo}>
      <button type="submit">Sign in</button>
    </form>
  ),
}))
vi.mock('@/platform/config/server', () => ({
  getServerConfig: () => ({ contentMode: pageMocks.contentMode }),
}))

async function renderSignIn(searchParams: Record<string, string> = {}) {
  render(await SignInPage({ searchParams: Promise.resolve(searchParams) }))
}

describe('Sign-in orientation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pageMocks.contentMode = 'development'
    pageMocks.getSignInPageInstallation.mockResolvedValue({
      kind: 'closed',
      actionBinding: 'opaque-sign-in-binding',
    })
    pageMocks.getActor.mockResolvedValue(null)
    pageMocks.verifyResetNotice.mockReturnValue(null)
    pageMocks.verifySubjectNotice.mockReturnValue(null)
  })

  afterEach(cleanup)

  it.each([
    ['development', 'Development content mode'],
    ['reviewed', 'Reviewed content mode'],
  ] as const)('identifies the instance as using %s content', async (mode, label) => {
    pageMocks.contentMode = mode

    await renderSignIn()

    expect(
      screen.getByRole('link', { name: `Indigo Synthesis ${label}` }),
    ).toHaveAttribute('href', '/')
    expect(
      screen.getByRole('button', { name: 'Sign in' }).closest('form'),
    ).toHaveAttribute('data-action-binding', 'opaque-sign-in-binding')
  })

  it('keeps sign-in primary and expands explicit next actions on request', async () => {
    await renderSignIn()

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible()
    const summary = screen.getByText("Can't sign in?")
    const disclosure = summary.closest('details')
    expect(disclosure).not.toHaveAttribute('open')

    fireEvent.click(summary)

    expect(disclosure).toHaveAttribute('open')
    expect(
      screen.getByRole('link', { name: 'Use a trainee reset code' }),
    ).toHaveAttribute('href', '/reset')
    expect(
      screen.getByText(/Ask this instance’s owner for a one-use password reset code/),
    ).toBeVisible()
    expect(
      screen.getByRole('link', { name: 'Use a host-issued owner recovery code' }),
    ).toHaveAttribute('href', '/recover')
    expect(
      screen.getByText(
        'pnpm owner:recover issue --owner-email EMAIL --code-file ABSOLUTE_PATH --ttl-minutes 15',
        { selector: 'code' },
      ),
    ).toBeVisible()
    expect(
      screen.getByText(/Local accounts are created only by this instance’s owner/),
    ).toBeVisible()
    expect(screen.getByText(/Public signup is not available/)).toBeVisible()
  })

  it.each([
    ['reset', 'Password reset complete. Sign in with your new password.'],
    ['recovered', 'Owner recovery complete. Sign in with your new password.'],
  ])('renders the %s completion notice as status', async (query, message) => {
    await renderSignIn({ [query]: '1' })

    expect(screen.getByRole('status')).toHaveTextContent(message)
  })

  it('confirms a checked sign-out without disclosing session detail', async () => {
    await renderSignIn({ signedOut: '1' })

    expect(screen.getByRole('status')).toHaveTextContent(
      'Signed out from this local account.',
    )
    expect(screen.getByRole('status')).not.toHaveTextContent(/session|token|account id/i)
  })

  it('orients an uncertain member deletion without claiming either outcome', async () => {
    pageMocks.verifySubjectNotice.mockReturnValueOnce({
      kind: 'outcome-unknown',
      actorRole: 'member',
    })
    await renderSignIn({ notice: 'signed-member-unknown' })

    expect(screen.getByRole('status')).toHaveTextContent(
      'Account deletion could not be confirmed.',
    )
    expect(screen.getByRole('status')).toHaveTextContent('Do not resubmit it')
  })

  it('returns an authenticated member with uncertain deletion to the checking page', async () => {
    const redirectSignal = new Error('NEXT_REDIRECT')
    pageMocks.getActor.mockResolvedValueOnce({ userId: 'member-id', role: 'member' })
    pageMocks.verifySubjectNotice.mockReturnValueOnce({
      kind: 'outcome-unknown',
      actorRole: 'member',
    })
    pageMocks.redirect.mockImplementationOnce(() => {
      throw redirectSignal
    })

    await expect(
      SignInPage({
        searchParams: Promise.resolve({ notice: 'signed-member-unknown' }),
      }),
    ).rejects.toBe(redirectSignal)
    expect(pageMocks.redirect).toHaveBeenCalledWith(
      '/settings/delete-account?notice=signed-member-unknown',
    )
  })

  it('returns an authenticated owner with uncertain reset to the checking page', async () => {
    const redirectSignal = new Error('NEXT_REDIRECT')
    pageMocks.getActor.mockResolvedValueOnce({ userId: 'owner-id', role: 'owner' })
    pageMocks.verifyResetNotice.mockReturnValueOnce({ kind: 'outcome-unknown' })
    pageMocks.redirect.mockImplementationOnce(() => {
      throw redirectSignal
    })

    await expect(
      SignInPage({ searchParams: Promise.resolve({ notice: 'signed-reset-unknown' }) }),
    ).rejects.toBe(redirectSignal)
    expect(pageMocks.redirect).toHaveBeenCalledWith(
      '/settings/delete?notice=signed-reset-unknown',
    )
  })

  it('preserves reset uncertainty when an open installation redirects to bootstrap', async () => {
    const redirectSignal = new Error('NEXT_REDIRECT')
    pageMocks.getSignInPageInstallation.mockResolvedValueOnce({ kind: 'open' })
    pageMocks.verifyResetNotice.mockReturnValueOnce({ kind: 'outcome-unknown' })
    pageMocks.redirect.mockImplementationOnce(() => {
      throw redirectSignal
    })

    await expect(
      SignInPage({ searchParams: Promise.resolve({ notice: 'signed-reset-unknown' }) }),
    ).rejects.toBe(redirectSignal)

    expect(pageMocks.redirect).toHaveBeenCalledWith(
      '/bootstrap?notice=signed-reset-unknown',
    )
  })

  it('marks cleanup-after-commit as a warning without weakening deletion success', async () => {
    pageMocks.verifySubjectNotice.mockReturnValueOnce({
      kind: 'deleted',
      actorRole: 'member',
      warning: 'cleanup-failed',
    })
    await renderSignIn({ notice: 'signed-member-cleanup' })

    expect(screen.getByRole('status')).toHaveTextContent(
      'Local account and subject-scoped training data deleted.',
    )
    expect(screen.getByRole('status')).toHaveTextContent('do not repeat the deletion')
  })

  it('ignores an invalid receipt instead of inventing a destructive notice', async () => {
    await renderSignIn({ notice: 'tampered-or-expired' })

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(pageMocks.verifySubjectNotice).toHaveBeenCalledWith('tampered-or-expired')
    expect(pageMocks.verifyResetNotice).toHaveBeenCalledWith('tampered-or-expired')
  })

  it('orients an expired athlete and preserves only the exact saved-workout return', async () => {
    const sessionId = '0198f6d2-7c31-7f14-8f01-123456789abc'
    await renderSignIn({
      expired: '1',
      returnTo: `/workouts/${sessionId}`,
    })

    expect(screen.getByRole('status')).toHaveTextContent(
      'Your session ended. Sign in again to resume your saved workout.',
    )
    expect(
      screen.getByRole('button', { name: 'Sign in' }).closest('form'),
    ).toHaveAttribute('data-return-to', `/workouts/${sessionId}`)
  })

  it('does not disclose session expiry or accept an arbitrary return target', async () => {
    await renderSignIn({ expired: '1', returnTo: '//evil.example/settings' })

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Your session ended\. Sign in again/),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Sign in' }).closest('form'),
    ).not.toHaveAttribute('data-return-to')
  })

  it('redirects an already-authenticated athlete to a validated saved workout', async () => {
    const sessionId = '0198f6d2-7c31-7f14-8f01-123456789abc'
    pageMocks.getActor.mockResolvedValueOnce({ userId: 'athlete-id' })

    await renderSignIn({ returnTo: `/workouts/${sessionId}` })

    expect(pageMocks.redirect).toHaveBeenCalledWith(`/workouts/${sessionId}`)
  })
})
