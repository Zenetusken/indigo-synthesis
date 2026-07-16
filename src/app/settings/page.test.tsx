// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from './page'

const pageMocks = vi.hoisted(() => ({
  getAthleteProfile: vi.fn(),
  issueLocalForm: vi.fn(),
  issueMemberForm: vi.fn(),
  listLocalUsers: vi.fn(),
  redirect: vi.fn(),
  requireUiActor: vi.fn(),
  verifyDeletionNotice: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: { pathname: string } }) => (
    <a href={href.pathname}>{children}</a>
  ),
}))
vi.mock('next/navigation', () => ({ redirect: pageMocks.redirect }))
vi.mock('@/components', () => ({
  PageHeading: ({ title }: { title: string }) => <h1>{title}</h1>,
  ProductFrame: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}))
vi.mock('@/modules/athletes/application/profile', () => ({
  getAthleteProfile: pageMocks.getAthleteProfile,
}))
vi.mock('@/modules/data-portability/server/destructive-notice', () => ({
  verifySubjectDeletionNoticeReceipt: pageMocks.verifyDeletionNotice,
}))
vi.mock('@/modules/identity/server/actor', () => ({
  issueLocalUserCreationFormEnvelope: pageMocks.issueLocalForm,
  issueMemberResetIssuanceFormEnvelope: pageMocks.issueMemberForm,
  requireUiActor: pageMocks.requireUiActor,
}))
vi.mock('@/modules/identity/server/local-users', () => ({
  listLocalUsersAsOwner: pageMocks.listLocalUsers,
}))
vi.mock('@/modules/identity/ui/sign-out-button', () => ({
  SignOutButton: () => <button type="button">Sign out</button>,
}))
vi.mock('./local-user-form', () => ({
  LocalUserForm: ({
    targetUserId,
    actionBinding,
  }: {
    targetUserId: string
    actionBinding: string
  }) => (
    <form
      aria-label="Create local user"
      data-target-user-id={targetUserId}
      data-action-binding={actionBinding}
    />
  ),
}))
vi.mock('./member-reset-form', () => ({
  MemberResetForm: ({
    targetUserId,
    targetName,
    actionBinding,
  }: {
    targetUserId: string
    targetName: string
    actionBinding: string
  }) => (
    <form
      aria-label={`Reset ${targetName}`}
      data-target-user-id={targetUserId}
      data-action-binding={actionBinding}
    />
  ),
}))

const authenticatedActionEnvelope = Object.freeze({ opaque: true })

describe('settings credential-administration form envelopes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pageMocks.requireUiActor.mockResolvedValue({
      userId: 'owner-id',
      email: 'owner@example.test',
      name: 'Owner',
      role: 'owner',
      checkedSignOutActionBinding: 'opaque-sign-out-binding',
      authenticatedActionEnvelope,
    })
    pageMocks.getAthleteProfile.mockResolvedValue(null)
    pageMocks.verifyDeletionNotice.mockReturnValue(null)
    pageMocks.listLocalUsers.mockResolvedValue([
      {
        id: 'owner-id',
        name: 'Owner',
        email: 'owner@example.test',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'member-a',
        name: 'Athlete A',
        email: 'a@example.test',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
      {
        id: 'member-b',
        name: 'Athlete B',
        email: 'b@example.test',
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
      },
    ])
    pageMocks.issueLocalForm.mockReturnValue({
      targetUserId: 'preallocated-local-target',
      actionBinding: 'opaque-local-binding',
    })
    pageMocks.issueMemberForm.mockImplementation(
      (_envelope: unknown, targetUserId: string) => ({
        targetUserId,
        actionBinding: `opaque-reset-binding-${targetUserId}`,
      }),
    )
  })

  afterEach(cleanup)

  it('uses one post-read clock and preserves each exact target-to-binding mapping', async () => {
    render(await SettingsPage({}))

    expect(screen.getByRole('form', { name: 'Create local user' })).toHaveAttribute(
      'data-target-user-id',
      'preallocated-local-target',
    )
    expect(screen.getByRole('form', { name: 'Create local user' })).toHaveAttribute(
      'data-action-binding',
      'opaque-local-binding',
    )
    expect(screen.getByRole('form', { name: 'Reset Athlete A' })).toHaveAttribute(
      'data-action-binding',
      'opaque-reset-binding-member-a',
    )
    expect(screen.getByRole('form', { name: 'Reset Athlete B' })).toHaveAttribute(
      'data-target-user-id',
      'member-b',
    )
    expect(pageMocks.issueMemberForm).toHaveBeenCalledTimes(2)
    const formIssuedAt = pageMocks.issueLocalForm.mock.calls[0]?.[1]
    expect(formIssuedAt).toBeInstanceOf(Date)
    expect(pageMocks.issueMemberForm.mock.calls[0]?.[2]).toBe(formIssuedAt)
    expect(pageMocks.issueMemberForm.mock.calls[1]?.[2]).toBe(formIssuedAt)
    expect(pageMocks.issueMemberForm).not.toHaveBeenCalledWith(
      expect.anything(),
      'owner-id',
      expect.anything(),
    )
  })

  it('redirects instead of rendering a dead form when the session expires during reads', async () => {
    const redirectSignal = new Error('NEXT_REDIRECT')
    pageMocks.issueLocalForm.mockReturnValue(null)
    pageMocks.redirect.mockImplementation(() => {
      throw redirectSignal
    })

    await expect(SettingsPage({})).rejects.toBe(redirectSignal)
    expect(pageMocks.redirect).toHaveBeenCalledWith('/sign-in')
    expect(pageMocks.issueMemberForm).not.toHaveBeenCalled()
  })

  it('confirms owner training-data deletion and warns against repeating a committed cleanup failure', async () => {
    pageMocks.verifyDeletionNotice.mockReturnValueOnce({
      kind: 'deleted',
      actorRole: 'owner',
      warning: 'cleanup-failed',
    })
    render(
      await SettingsPage({
        searchParams: Promise.resolve({ notice: 'signed-owner-success' }),
      }),
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      'Your training data was deleted. Your owner account and this installation remain available.',
    )
    expect(screen.getByRole('status')).toHaveTextContent('do not repeat the deletion')
  })

  it('never renders owner deletion-success copy to a member', async () => {
    pageMocks.verifyDeletionNotice.mockReturnValueOnce({
      kind: 'deleted',
      actorRole: 'owner',
      warning: null,
    })
    pageMocks.requireUiActor.mockResolvedValueOnce({
      userId: 'member-id',
      email: 'member@example.test',
      name: 'Member',
      role: 'member',
      checkedSignOutActionBinding: 'opaque-member-sign-out-binding',
      authenticatedActionEnvelope,
    })

    render(
      await SettingsPage({
        searchParams: Promise.resolve({ notice: 'signed-owner-success' }),
      }),
    )

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(pageMocks.listLocalUsers).not.toHaveBeenCalled()
  })
})
