// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SetupPage from './page'

const pageMocks = vi.hoisted(() => ({
  getAthleteProfile: vi.fn(),
  getInstallationStatus: vi.fn(),
  redirect: vi.fn(),
  requireUiActor: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: pageMocks.redirect }))
vi.mock('@/modules/athletes/application/profile', () => ({
  getAthleteProfile: pageMocks.getAthleteProfile,
}))
vi.mock('@/modules/identity/application/installation', () => ({
  getInstallationStatus: pageMocks.getInstallationStatus,
}))
vi.mock('@/modules/identity/server/actor', () => ({
  requireUiActor: pageMocks.requireUiActor,
}))
vi.mock('@/modules/identity/ui/sign-out-button', () => ({
  SignOutButton: ({ actionBinding }: { actionBinding: string }) => (
    <button type="button" data-action-binding={actionBinding}>
      Sign out
    </button>
  ),
}))
vi.mock('./setup-form', () => ({ SetupForm: () => <form aria-label="Training setup" /> }))

describe('training setup account bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pageMocks.getInstallationStatus.mockResolvedValue({
      kind: 'closed',
      ownerUserId: 'owner-id',
      closedAt: new Date(),
    })
    pageMocks.requireUiActor.mockResolvedValue({
      userId: 'member-id',
      email: 'member@example.test',
      name: 'Member',
      role: 'member',
      checkedSignOutActionBinding: 'opaque-setup-sign-out-binding',
    })
    pageMocks.getAthleteProfile.mockResolvedValue(null)
  })

  afterEach(cleanup)

  it('identifies the current local account and exposes checked sign-out', async () => {
    render(await SetupPage())

    expect(screen.getByLabelText('Current local account')).toHaveTextContent(
      'Signed in as member@example.test',
    )
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveAttribute(
      'data-action-binding',
      'opaque-setup-sign-out-binding',
    )
    expect(screen.getByRole('form', { name: 'Training setup' })).toBeVisible()
  })
})
