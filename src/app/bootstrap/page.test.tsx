// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BootstrapPage from './page'

const pageMocks = vi.hoisted(() => ({
  getBootstrapPageInstallation: vi.fn(),
  redirect: vi.fn(),
  verifyResetNotice: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: { pathname: string } }) => (
    <a href={href.pathname}>{children}</a>
  ),
}))
vi.mock('next/navigation', () => ({ redirect: pageMocks.redirect }))
vi.mock('@/modules/data-portability/server/destructive-notice', () => ({
  verifyInstanceResetNoticeReceipt: pageMocks.verifyResetNotice,
}))
vi.mock('@/modules/identity/server/bootstrap', () => ({
  getBootstrapPageInstallation: pageMocks.getBootstrapPageInstallation,
}))
vi.mock('@/modules/identity/ui/bootstrap-form', () => ({
  BootstrapForm: ({ actionBinding }: { actionBinding: string }) => (
    <form aria-label="Owner bootstrap" data-action-binding={actionBinding} />
  ),
}))

describe('owner bootstrap page binding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pageMocks.getBootstrapPageInstallation.mockResolvedValue({
      kind: 'open',
      actionBinding: 'opaque-owner-bootstrap-binding',
    })
    pageMocks.verifyResetNotice.mockReturnValue(null)
  })

  afterEach(cleanup)

  it('passes only the opaque open-generation binding into the browser form', async () => {
    render(await BootstrapPage({ searchParams: Promise.resolve({}) }))

    expect(screen.getByRole('form', { name: 'Owner bootstrap' })).toHaveAttribute(
      'data-action-binding',
      'opaque-owner-bootstrap-binding',
    )
  })

  it('keeps the post-reset orientation while retaining the bound form', async () => {
    pageMocks.verifyResetNotice.mockReturnValueOnce({ kind: 'reset', warning: null })
    render(
      await BootstrapPage({
        searchParams: Promise.resolve({ notice: 'signed-reset-success' }),
      }),
    )

    expect(screen.getByRole('status')).toHaveTextContent('Instance reset')
    expect(screen.getByRole('form', { name: 'Owner bootstrap' })).toBeVisible()
  })

  it('uses the open installation state to resolve an earlier unknown reset outcome', async () => {
    pageMocks.verifyResetNotice.mockReturnValueOnce({ kind: 'outcome-unknown' })
    render(
      await BootstrapPage({
        searchParams: Promise.resolve({ notice: 'signed-reset-unknown' }),
      }),
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      'This installation is currently open.',
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'earlier reset response could not confirm its outcome',
    )
    expect(screen.getByRole('status')).toHaveTextContent('do not repeat the reset')
  })

  it('warns about cleanup only after confirming reset commit', async () => {
    pageMocks.verifyResetNotice.mockReturnValueOnce({
      kind: 'reset',
      warning: 'cleanup-failed',
    })
    render(
      await BootstrapPage({
        searchParams: Promise.resolve({ notice: 'signed-reset-cleanup' }),
      }),
    )

    expect(screen.getByRole('status')).toHaveTextContent('Instance reset.')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Database cleanup reported a warning after commit',
    )
  })

  it('ignores an invalid receipt instead of inventing a reset outcome', async () => {
    render(
      await BootstrapPage({
        searchParams: Promise.resolve({ notice: 'tampered-or-expired' }),
      }),
    )

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(pageMocks.verifyResetNotice).toHaveBeenCalledWith('tampered-or-expired')
  })
})
