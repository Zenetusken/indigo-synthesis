import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getActor, getUiActor } from './actor'

const actorMocks = vi.hoisted(() => ({
  getHeaders: vi.fn(),
  getSession: vi.fn(),
  getInstallation: vi.fn(),
  issueBinding: vi.fn(),
  redirect: vi.fn(),
}))

vi.mock('next/headers', () => ({ headers: actorMocks.getHeaders }))
vi.mock('next/navigation', () => ({ redirect: actorMocks.redirect }))
vi.mock('../infrastructure/auth', () => ({
  readIdentitySession: actorMocks.getSession,
}))
vi.mock('../infrastructure/installation', () => ({
  getServerActorInstallationState: actorMocks.getInstallation,
}))
vi.mock('../infrastructure/action-binding', () => ({
  issueCheckedSignOutActionBinding: actorMocks.issueBinding,
}))

describe('server authenticated actor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    actorMocks.getHeaders.mockResolvedValue(new Headers({ cookie: 'private-cookie' }))
  })

  it('issues an opaque sign-out binding from server-only session and epoch state', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000)
    actorMocks.getSession.mockResolvedValue({
      user: {
        id: 'private-actor-id',
        email: 'owner@example.test',
        name: 'Owner',
      },
      session: {
        id: 'private-provider-session-id',
        token: 'private-provider-session-token',
        expiresAt,
      },
    })
    actorMocks.getInstallation.mockResolvedValue({
      ownerUserId: 'private-actor-id',
      productMutationEpoch: 'private-installation-epoch',
    })
    actorMocks.issueBinding.mockReturnValue('opaque-checked-sign-out-binding')

    const actor = await getUiActor()

    expect(actorMocks.getSession).toHaveBeenCalledWith(expect.any(Headers))
    expect(actorMocks.issueBinding).toHaveBeenCalledWith(
      {
        expectedEpoch: 'private-installation-epoch',
        sessionId: 'private-provider-session-id',
        actorUserId: 'private-actor-id',
        sessionExpiresAt: expiresAt,
      },
      expect.any(Date),
    )
    expect(actor).toEqual({
      userId: 'private-actor-id',
      email: 'owner@example.test',
      name: 'Owner',
      role: 'owner',
      checkedSignOutActionBinding: 'opaque-checked-sign-out-binding',
    })

    const publicJson = JSON.stringify(actor)
    expect(publicJson).not.toContain('private-provider-session-id')
    expect(publicJson).not.toContain('private-provider-session-token')
    expect(publicJson).not.toContain('private-installation-epoch')
  })

  it('does not read installation state or issue a binding without a session', async () => {
    actorMocks.getSession.mockResolvedValue(null)

    await expect(getActor()).resolves.toBeNull()
    expect(actorMocks.getInstallation).not.toHaveBeenCalled()
    expect(actorMocks.issueBinding).not.toHaveBeenCalled()
  })

  it('keeps ordinary server authorization free of UI action-binding issuance', async () => {
    actorMocks.getSession.mockResolvedValue({
      user: { id: 'member-id', email: 'member@example.test', name: 'Member' },
      session: {
        id: 'session-id',
        token: 'private-token',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    actorMocks.getInstallation.mockResolvedValue({
      ownerUserId: 'owner-id',
      productMutationEpoch: 'private-installation-epoch',
    })

    await expect(getActor()).resolves.toEqual({
      userId: 'member-id',
      email: 'member@example.test',
      name: 'Member',
      role: 'member',
    })
    expect(actorMocks.issueBinding).not.toHaveBeenCalled()
  })

  it('maps a session that expires during UI issuance to unauthenticated', async () => {
    actorMocks.getSession.mockResolvedValue({
      user: { id: 'member-id', email: 'member@example.test', name: 'Member' },
      session: {
        id: 'session-id',
        token: 'private-token',
        expiresAt: new Date(Date.now() - 1),
      },
    })
    actorMocks.getInstallation.mockResolvedValue({
      ownerUserId: 'owner-id',
      productMutationEpoch: 'private-installation-epoch',
    })

    await expect(getUiActor()).resolves.toBeNull()
    expect(actorMocks.issueBinding).not.toHaveBeenCalled()
  })
})
