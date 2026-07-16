import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AuthenticatedActionEnvelope,
  getActor,
  getUiActor,
  issueInstanceResetFormEnvelope,
  issueLocalUserCreationFormEnvelope,
  issueMemberResetIssuanceFormEnvelope,
  issueTraineeDataDeletionFormEnvelope,
} from './actor'

const actorMocks = vi.hoisted(() => ({
  getHeaders: vi.fn(),
  getSession: vi.fn(),
  getInstallation: vi.fn(),
  issueBinding: vi.fn(),
  issueInstanceResetBinding: vi.fn(),
  issueLocalUserBinding: vi.fn(),
  issueMemberResetBinding: vi.fn(),
  issueTraineeDeletionBinding: vi.fn(),
  newUuid: vi.fn(),
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
  issueInstanceResetActionBinding: actorMocks.issueInstanceResetBinding,
  issueLocalUserCreateActionBinding: actorMocks.issueLocalUserBinding,
  issueMemberResetIssueActionBinding: actorMocks.issueMemberResetBinding,
  issueTraineeDataDeletionActionBinding: actorMocks.issueTraineeDeletionBinding,
}))
vi.mock('@/platform/ids/uuid-v7', () => ({ newUuidV7: actorMocks.newUuid }))

describe('server authenticated actor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    actorMocks.getHeaders.mockResolvedValue(new Headers({ cookie: 'private-cookie' }))
    actorMocks.newUuid.mockReturnValue('preallocated-local-user-id')
    actorMocks.issueLocalUserBinding.mockReturnValue('opaque-local-user-binding')
    actorMocks.issueMemberResetBinding.mockReturnValue('opaque-member-reset-binding')
    actorMocks.issueTraineeDeletionBinding.mockReturnValue(
      'opaque-trainee-deletion-binding',
    )
    actorMocks.issueInstanceResetBinding.mockReturnValue('opaque-instance-reset-binding')
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
    expect(publicJson).not.toContain('authenticatedActionEnvelope')
  })

  it('issues owner-only target-bound settings form envelopes without exposing raw state', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000)
    const now = new Date('2026-07-15T18:00:00.000Z')
    actorMocks.getSession.mockResolvedValue({
      user: {
        id: 'private-owner-id',
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
      ownerUserId: 'private-owner-id',
      productMutationEpoch: 'private-installation-epoch',
    })
    actorMocks.issueBinding.mockReturnValue('opaque-checked-sign-out-binding')

    const actor = await getUiActor()
    if (!actor) throw new Error('Expected an authenticated owner.')
    const localUserForm = issueLocalUserCreationFormEnvelope(
      actor.authenticatedActionEnvelope,
      now,
    )
    const memberResetForm = issueMemberResetIssuanceFormEnvelope(
      actor.authenticatedActionEnvelope,
      'member-id',
      now,
    )
    const plan = {
      id: 'private-plan-id',
      digest: 'private-plan-digest',
      expiresAt: new Date(now.getTime() + 10 * 60 * 1_000),
    }
    const traineeDeletionForm = issueTraineeDataDeletionFormEnvelope(
      actor.authenticatedActionEnvelope,
      plan,
      now,
    )
    const instanceResetForm = issueInstanceResetFormEnvelope(
      actor.authenticatedActionEnvelope,
      plan,
      now,
    )

    expect(actorMocks.newUuid).toHaveBeenCalledWith(now.getTime())
    expect(actorMocks.issueLocalUserBinding).toHaveBeenCalledWith(
      {
        expectedEpoch: 'private-installation-epoch',
        sessionId: 'private-provider-session-id',
        actorUserId: 'private-owner-id',
        targetUserId: 'preallocated-local-user-id',
        sessionExpiresAt: expiresAt,
      },
      now,
    )
    expect(actorMocks.issueMemberResetBinding).toHaveBeenCalledWith(
      {
        expectedEpoch: 'private-installation-epoch',
        sessionId: 'private-provider-session-id',
        actorUserId: 'private-owner-id',
        targetUserId: 'member-id',
        sessionExpiresAt: expiresAt,
      },
      now,
    )
    expect(actorMocks.issueTraineeDeletionBinding).toHaveBeenCalledWith(
      {
        expectedEpoch: 'private-installation-epoch',
        sessionId: 'private-provider-session-id',
        actorUserId: 'private-owner-id',
        planId: plan.id,
        planDigest: plan.digest,
        sessionExpiresAt: expiresAt,
        planExpiresAt: plan.expiresAt,
      },
      now,
    )
    expect(actorMocks.issueInstanceResetBinding).toHaveBeenCalledWith(
      {
        expectedEpoch: 'private-installation-epoch',
        sessionId: 'private-provider-session-id',
        actorUserId: 'private-owner-id',
        planId: plan.id,
        planDigest: plan.digest,
        sessionExpiresAt: expiresAt,
        planExpiresAt: plan.expiresAt,
      },
      now,
    )
    expect(localUserForm).toEqual({
      targetUserId: 'preallocated-local-user-id',
      actionBinding: 'opaque-local-user-binding',
    })
    expect(memberResetForm).toEqual({
      targetUserId: 'member-id',
      actionBinding: 'opaque-member-reset-binding',
    })
    expect(traineeDeletionForm).toEqual({
      planId: plan.id,
      planDigest: plan.digest,
      actionBinding: 'opaque-trainee-deletion-binding',
    })
    expect(instanceResetForm).toEqual({
      planId: plan.id,
      planDigest: plan.digest,
      actionBinding: 'opaque-instance-reset-binding',
    })

    const transport = JSON.stringify({
      actor,
      localUserForm,
      memberResetForm,
      traineeDeletionForm,
      instanceResetForm,
    })
    expect(transport).not.toContain('private-installation-epoch')
    expect(transport).not.toContain('private-provider-session-id')
    expect(transport).not.toContain('private-provider-session-token')
  })

  it('allows members to bind their own trainee-data preview but not instance reset', async () => {
    const now = new Date('2026-07-15T18:00:00.000Z')
    actorMocks.getSession.mockResolvedValue({
      user: { id: 'member-id', email: 'member@example.test', name: 'Member' },
      session: {
        id: 'session-id',
        token: 'private-token',
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
    })
    actorMocks.getInstallation.mockResolvedValue({
      ownerUserId: 'owner-id',
      productMutationEpoch: 'private-installation-epoch',
    })
    actorMocks.issueBinding.mockReturnValue('opaque-checked-sign-out-binding')
    const actor = await getUiActor()
    if (!actor) throw new Error('Expected an authenticated member.')
    const plan = {
      id: 'member-plan',
      digest: 'member-digest',
      expiresAt: new Date(now.getTime() + 10 * 60 * 1_000),
    }

    expect(
      issueTraineeDataDeletionFormEnvelope(actor.authenticatedActionEnvelope, plan, now),
    ).toEqual({
      planId: plan.id,
      planDigest: plan.digest,
      actionBinding: 'opaque-trainee-deletion-binding',
    })
    expect(() =>
      issueInstanceResetFormEnvelope(actor.authenticatedActionEnvelope, plan, now),
    ).toThrow('Owner role is required')
    expect(actorMocks.issueInstanceResetBinding).not.toHaveBeenCalled()
  })

  it('rejects member and forged action envelopes before issuing settings bindings', async () => {
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
    actorMocks.issueBinding.mockReturnValue('opaque-checked-sign-out-binding')

    const actor = await getUiActor()
    if (!actor) throw new Error('Expected an authenticated member.')
    expect(() =>
      issueLocalUserCreationFormEnvelope(actor.authenticatedActionEnvelope),
    ).toThrow('Owner role is required')
    expect(() =>
      issueMemberResetIssuanceFormEnvelope(
        Object.freeze({}) as AuthenticatedActionEnvelope,
        'member-id',
      ),
    ).toThrow('was not issued by Identity')
    expect(actorMocks.issueLocalUserBinding).not.toHaveBeenCalled()
    expect(actorMocks.issueMemberResetBinding).not.toHaveBeenCalled()
  })

  it('returns no settings form when the session expires during page data reads', async () => {
    const expiresAt = new Date(Date.now() + 60_500)
    const unusableWholeSecond = new Date(Math.floor(expiresAt.getTime() / 1_000) * 1_000)
    actorMocks.getSession.mockResolvedValue({
      user: { id: 'owner-id', email: 'owner@example.test', name: 'Owner' },
      session: {
        id: 'session-id',
        token: 'private-token',
        expiresAt,
      },
    })
    actorMocks.getInstallation.mockResolvedValue({
      ownerUserId: 'owner-id',
      productMutationEpoch: 'private-installation-epoch',
    })
    actorMocks.issueBinding.mockReturnValue('opaque-checked-sign-out-binding')

    const actor = await getUiActor()
    if (!actor) throw new Error('Expected an authenticated owner.')
    expect(
      issueLocalUserCreationFormEnvelope(
        actor.authenticatedActionEnvelope,
        unusableWholeSecond,
      ),
    ).toBeNull()
    expect(
      issueMemberResetIssuanceFormEnvelope(
        actor.authenticatedActionEnvelope,
        'member-id',
        unusableWholeSecond,
      ),
    ).toBeNull()
    const expiredPlan = {
      id: 'expired-plan',
      digest: 'expired-digest',
      expiresAt: new Date(Date.now() - 2_000),
    }
    const afterPlanExpiry = new Date(expiredPlan.expiresAt.getTime() + 1_000)
    expect(
      issueTraineeDataDeletionFormEnvelope(
        actor.authenticatedActionEnvelope,
        expiredPlan,
        afterPlanExpiry,
      ),
    ).toBeNull()
    expect(
      issueInstanceResetFormEnvelope(
        actor.authenticatedActionEnvelope,
        expiredPlan,
        afterPlanExpiry,
      ),
    ).toBeNull()
    expect(actorMocks.newUuid).not.toHaveBeenCalled()
    expect(actorMocks.issueLocalUserBinding).not.toHaveBeenCalled()
    expect(actorMocks.issueMemberResetBinding).not.toHaveBeenCalled()
    expect(actorMocks.issueTraineeDeletionBinding).not.toHaveBeenCalled()
    expect(actorMocks.issueInstanceResetBinding).not.toHaveBeenCalled()
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
