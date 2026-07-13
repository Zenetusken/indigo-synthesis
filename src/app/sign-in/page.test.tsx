// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SignInPage from './page'

const pageMocks = vi.hoisted(() => ({
  contentMode: 'development' as 'development' | 'reviewed',
  getActor: vi.fn(),
  getInstallationStatus: vi.fn(),
  redirect: vi.fn(),
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
vi.mock('@/modules/identity/application/installation', () => ({
  getInstallationStatus: pageMocks.getInstallationStatus,
}))
vi.mock('@/modules/identity/server/actor', () => ({
  getActor: pageMocks.getActor,
}))
vi.mock('@/modules/identity/ui/sign-in-form', () => ({
  SignInForm: ({ returnTo }: { returnTo?: string }) => (
    <form data-return-to={returnTo}>
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
    pageMocks.getInstallationStatus.mockResolvedValue({
      kind: 'closed',
      ownerUserId: 'owner-id',
      closedAt: new Date('2026-07-13T12:00:00.000Z'),
    })
    pageMocks.getActor.mockResolvedValue(null)
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
