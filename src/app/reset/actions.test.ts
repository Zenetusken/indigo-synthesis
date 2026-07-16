import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publicRecoveryFailure } from '@/modules/identity/recovery/recovery-policy'
import { resetMemberCredentialAction } from './actions'

const actionMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  getPort: vi.fn(),
  redeem: vi.fn(),
  redirect: vi.fn(),
  revalidatePath: vi.fn(),
  command: Object.freeze({ kind: 'nominal-member-reset-command' }),
}))

vi.mock('next/cache', () => ({ revalidatePath: actionMocks.revalidatePath }))
vi.mock('next/navigation', () => ({ redirect: actionMocks.redirect }))
vi.mock('@/composition/identity-recovery-mutations', () => ({
  getProductionIdentityRecoveryMutationPort: actionMocks.getPort,
}))
vi.mock('@/modules/identity/server/recovery-redemption-command', () => ({
  captureMemberResetRedemptionMutationCommand: actionMocks.capture,
}))

const initialState = Object.freeze({
  kind: 'idle' as const,
  email: '',
  message: null,
  stale: false,
})

function resetForm(): FormData {
  const formData = new FormData()
  formData.set('email', 'member@example.test')
  formData.set('code', 'private-code')
  formData.set('newPassword', 'private-new-password')
  formData.set('confirmPassword', 'private-new-password')
  return formData
}

describe('member-reset redemption action', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T22:00:00.123Z'))
    vi.clearAllMocks()
    actionMocks.capture.mockResolvedValue({
      kind: 'captured',
      command: actionMocks.command,
    })
    actionMocks.redeem.mockResolvedValue(publicRecoveryFailure)
    actionMocks.getPort.mockReturnValue({ redeemMemberReset: actionMocks.redeem })
  })

  afterEach(() => vi.useRealTimers())

  it('captures the nominal command at action entry and redirects only after redemption', async () => {
    const formData = resetForm()
    actionMocks.redeem.mockResolvedValue({
      kind: 'redeemed',
      targetUserId: 'member-id',
      revokedSessionCount: 2,
    })

    await expect(resetMemberCredentialAction(initialState, formData)).resolves.toBe(
      undefined,
    )

    expect(actionMocks.capture).toHaveBeenCalledWith({
      formData,
      commandEnteredAt: new Date('2026-07-15T22:00:00.123Z'),
    })
    expect(actionMocks.redeem).toHaveBeenCalledWith(actionMocks.command)
    expect(actionMocks.redirect).toHaveBeenCalledOnce()
    expect(actionMocks.redirect).toHaveBeenCalledWith('/sign-in?reset=1')
    expect(actionMocks.revalidatePath).not.toHaveBeenCalled()
  })

  it('keeps ingress denial outside the public credential-failure set', async () => {
    actionMocks.capture.mockResolvedValue({ kind: 'rejected', reason: 'ingress' })

    await expect(resetMemberCredentialAction(initialState, resetForm())).resolves.toEqual(
      {
        kind: 'rejected',
        email: 'member@example.test',
        message: 'Authentication request denied.',
        stale: false,
      },
    )
    expect(actionMocks.getPort).not.toHaveBeenCalled()
    expect(actionMocks.redeem).not.toHaveBeenCalled()
    expect(actionMocks.redirect).not.toHaveBeenCalled()
    expect(actionMocks.revalidatePath).not.toHaveBeenCalled()
  })

  it('maps process load shedding to the canonical credential failure', async () => {
    actionMocks.capture.mockResolvedValue({ kind: 'rejected', reason: 'load-shed' })

    await expect(resetMemberCredentialAction(initialState, resetForm())).resolves.toEqual(
      {
        kind: 'rejected',
        email: 'member@example.test',
        message: publicRecoveryFailure.message,
        stale: false,
      },
    )
    expect(actionMocks.getPort).not.toHaveBeenCalled()
  })

  it('renders ordinary mutation rejection uniformly without refreshing', async () => {
    await expect(resetMemberCredentialAction(initialState, resetForm())).resolves.toEqual(
      {
        kind: 'rejected',
        email: 'member@example.test',
        message: publicRecoveryFailure.message,
        stale: false,
      },
    )
    expect(actionMocks.redirect).not.toHaveBeenCalled()
    expect(actionMocks.revalidatePath).not.toHaveBeenCalled()
  })

  it('invalidates an expired or stale form while keeping its public response uniform', async () => {
    actionMocks.redeem.mockResolvedValue({ kind: 'stale' })

    await expect(resetMemberCredentialAction(initialState, resetForm())).resolves.toEqual(
      {
        kind: 'rejected',
        email: 'member@example.test',
        message: publicRecoveryFailure.message,
        stale: true,
      },
    )
    expect(actionMocks.revalidatePath).toHaveBeenCalledOnce()
    expect(actionMocks.revalidatePath).toHaveBeenCalledWith('/reset')
    expect(actionMocks.redirect).not.toHaveBeenCalled()
  })
})
