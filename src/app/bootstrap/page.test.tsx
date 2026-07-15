// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BootstrapPage from './page'

const pageMocks = vi.hoisted(() => ({
  getBootstrapPageInstallation: vi.fn(),
  redirect: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: { pathname: string } }) => (
    <a href={href.pathname}>{children}</a>
  ),
}))
vi.mock('next/navigation', () => ({ redirect: pageMocks.redirect }))
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
    render(
      await BootstrapPage({
        searchParams: Promise.resolve({ reset: 'complete' }),
      }),
    )

    expect(screen.getByRole('status')).toHaveTextContent('Instance reset')
    expect(screen.getByRole('form', { name: 'Owner bootstrap' })).toBeVisible()
  })
})
