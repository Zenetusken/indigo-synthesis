// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RecoverPage from './recover/page'
import ResetPage from './reset/page'

const pageMocks = vi.hoisted(() => ({
  getActor: vi.fn(),
  getMemberResetPageInstallation: vi.fn(),
  getOwnerRecoveryPageInstallation: vi.fn(),
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
vi.mock('next/navigation', () => ({ redirect: pageMocks.redirect }))
vi.mock('@/modules/identity/server/recovery-page', () => ({
  getMemberResetPageInstallation: pageMocks.getMemberResetPageInstallation,
  getOwnerRecoveryPageInstallation: pageMocks.getOwnerRecoveryPageInstallation,
}))
vi.mock('@/modules/identity/server/actor', () => ({ getActor: pageMocks.getActor }))
vi.mock('@/platform/config/server', () => ({
  getServerConfig: () => ({ contentMode: 'reviewed' }),
}))
vi.mock('./reset/reset-form', () => ({
  ResetCredentialForm: ({ actionBinding }: { actionBinding: string }) => (
    <form aria-label="Trainee recovery form" data-action-binding={actionBinding} />
  ),
}))
vi.mock('./recover/recover-form', () => ({
  RecoverOwnerForm: ({ actionBinding }: { actionBinding: string }) => (
    <form aria-label="Owner recovery form" data-action-binding={actionBinding} />
  ),
}))

describe('unauthenticated recovery pages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pageMocks.getMemberResetPageInstallation.mockResolvedValue({
      kind: 'closed',
      actionBinding: 'opaque-member-reset-binding',
    })
    pageMocks.getOwnerRecoveryPageInstallation.mockResolvedValue({
      kind: 'closed',
      actionBinding: 'opaque-owner-recovery-binding',
    })
    pageMocks.getActor.mockResolvedValue(null)
  })

  afterEach(cleanup)

  it('returns both recovery paths to bootstrap while the instance is unclaimed', async () => {
    pageMocks.getMemberResetPageInstallation.mockResolvedValue({ kind: 'open' })
    pageMocks.getOwnerRecoveryPageInstallation.mockResolvedValue({ kind: 'open' })

    await ResetPage()
    await RecoverPage()

    expect(pageMocks.redirect).toHaveBeenNthCalledWith(1, '/bootstrap')
    expect(pageMocks.redirect).toHaveBeenNthCalledWith(2, '/bootstrap')
  })

  it('does not expose unauthenticated recovery forms to a signed-in actor', async () => {
    pageMocks.getActor.mockResolvedValue({ userId: 'owner-id' })

    await ResetPage()
    await RecoverPage()

    expect(pageMocks.redirect).toHaveBeenNthCalledWith(1, '/')
    expect(pageMocks.redirect).toHaveBeenNthCalledWith(2, '/')
  })

  it('renders explicit reviewed-instance orientation and host mediation', async () => {
    render(await ResetPage())
    expect(screen.getByRole('heading', { name: 'Choose a new password.' })).toBeVisible()
    expect(screen.getByRole('form', { name: 'Trainee recovery form' })).toHaveAttribute(
      'data-action-binding',
      'opaque-member-reset-binding',
    )
    expect(
      screen.getByRole('link', { name: /Indigo Synthesis Reviewed content mode/ }),
    ).toHaveAttribute('href', '/sign-in')

    cleanup()
    render(await RecoverPage())
    expect(screen.getByRole('heading', { name: 'Recover owner access.' })).toBeVisible()
    expect(screen.getByRole('form', { name: 'Owner recovery form' })).toHaveAttribute(
      'data-action-binding',
      'opaque-owner-recovery-binding',
    )
    expect(screen.getByText(/pnpm owner:recover issue/)).toBeVisible()
  })
})
