import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureMemberResetRedemptionMutationCommand,
  captureOwnerRecoveryRedemptionMutationCommand,
  MemberResetRedemptionMutationCommand,
  memberResetRedemptionMutationCommandView,
  OwnerRecoveryRedemptionMutationCommand,
  ownerRecoveryRedemptionMutationCommandView,
} from './recovery-redemption-command'

const commandMocks = vi.hoisted(() => ({
  admitLoadShedder: vi.fn(),
  headers: vi.fn(),
}))

vi.mock('next/headers', () => ({ headers: commandMocks.headers }))
vi.mock('../infrastructure/credential-load-shedder', () => ({
  admitCredentialLoadShedder: commandMocks.admitLoadShedder,
}))
vi.mock('@/platform/config/server', () => ({
  getServerConfig: () => ({
    appOrigin: 'https://training.example.test',
    secureCookies: true,
  }),
}))

function requestHeaders(): Headers {
  return new Headers({
    origin: 'https://training.example.test',
    'x-forwarded-for': '203.0.113.9, 127.0.0.1',
  })
}

function recoveryForm(): FormData {
  const form = new FormData()
  form.set('actionBinding', 'opaque-recovery-binding')
  form.set('email', 'Member@Example.test')
  form.set('code', 'private-one-time-code')
  form.set('newPassword', 'private-new-password')
  form.set('confirmPassword', 'private-confirmation')
  return form
}

describe('public recovery server commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    commandMocks.headers.mockResolvedValue(requestHeaders())
    commandMocks.admitLoadShedder.mockReturnValue({ admitted: true })
  })

  it('snapshots member-reset input and derives one trusted header context before admission', async () => {
    const commandEnteredAt = new Date('2026-07-15T17:00:00.123Z')
    const captured = await captureMemberResetRedemptionMutationCommand({
      formData: recoveryForm(),
      commandEnteredAt,
    })

    expect(captured.kind).toBe('captured')
    if (captured.kind !== 'captured') return
    const view = memberResetRedemptionMutationCommandView(captured.command)
    expect(view).toEqual({
      actionBinding: 'opaque-recovery-binding',
      email: 'Member@Example.test',
      code: 'private-one-time-code',
      newPassword: 'private-new-password',
      confirmation: 'private-confirmation',
      commandEnteredAt,
      requestContext: { channel: 'web', clientAddress: '203.0.113.9' },
    })
    expect(view.commandEnteredAt).not.toBe(commandEnteredAt)
    view.commandEnteredAt.setUTCFullYear(2040)
    expect(
      memberResetRedemptionMutationCommandView(captured.command).commandEnteredAt,
    ).toEqual(commandEnteredAt)
    expect(commandMocks.headers).toHaveBeenCalledTimes(1)
    expect(commandMocks.admitLoadShedder).toHaveBeenCalledWith({
      purpose: 'member-reset',
      email: 'Member@Example.test',
      clientAddress: '203.0.113.9',
      now: commandEnteredAt,
    })
    expect(JSON.stringify(captured.command)).toBe('{}')
  })

  it('freezes all browser fields before waiting for the one header snapshot', async () => {
    let releaseHeaders!: (headers: Headers) => void
    commandMocks.headers.mockReturnValue(
      new Promise<Headers>((resolve) => {
        releaseHeaders = resolve
      }),
    )
    const formData = recoveryForm()
    const pending = captureOwnerRecoveryRedemptionMutationCommand({
      formData,
      commandEnteredAt: new Date('2026-07-15T17:00:00.000Z'),
    })
    formData.set('actionBinding', 'mutated-binding')
    formData.set('email', 'mutated@example.test')
    formData.set('code', 'mutated-code')
    formData.set('newPassword', 'mutated-password')
    formData.set('confirmPassword', 'mutated-confirmation')
    releaseHeaders(requestHeaders())

    const captured = await pending
    expect(captured.kind).toBe('captured')
    if (captured.kind !== 'captured') return
    expect(ownerRecoveryRedemptionMutationCommandView(captured.command)).toMatchObject({
      actionBinding: 'opaque-recovery-binding',
      email: 'Member@Example.test',
      code: 'private-one-time-code',
      newPassword: 'private-new-password',
      confirmation: 'private-confirmation',
    })
    expect(commandMocks.admitLoadShedder).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'owner-recovery' }),
    )
  })

  it.each([
    {
      name: 'cross-origin request',
      headers: new Headers({
        origin: 'https://attacker.example',
        'x-forwarded-for': '203.0.113.9, 127.0.0.1',
      }),
    },
    {
      name: 'unresolved network address',
      headers: new Headers({ origin: 'https://training.example.test' }),
    },
  ])('rejects a $name before local admission', async ({ headers }) => {
    commandMocks.headers.mockResolvedValue(headers)

    await expect(
      captureMemberResetRedemptionMutationCommand({
        formData: recoveryForm(),
        commandEnteredAt: new Date('2026-07-15T17:00:00.000Z'),
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'ingress' })
    expect(commandMocks.admitLoadShedder).not.toHaveBeenCalled()
  })

  it('uniformly rejects process-local load shedding without issuing a command', async () => {
    commandMocks.admitLoadShedder.mockReturnValue({
      admitted: false,
      reason: 'throttled',
      scope: 'owner-recovery:address',
    })

    await expect(
      captureOwnerRecoveryRedemptionMutationCommand({
        formData: recoveryForm(),
        commandEnteredAt: new Date('2026-07-15T17:00:00.000Z'),
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'load-shed' })
  })

  it('rejects forged purpose-specific commands and invalid command clocks', async () => {
    const forgedMember = Object.create(MemberResetRedemptionMutationCommand.prototype)
    const forgedOwner = Object.create(OwnerRecoveryRedemptionMutationCommand.prototype)
    expect(() => memberResetRedemptionMutationCommandView(forgedMember)).toThrow(
      'was not issued',
    )
    expect(() => ownerRecoveryRedemptionMutationCommandView(forgedOwner)).toThrow(
      'was not issued',
    )
    await expect(
      captureMemberResetRedemptionMutationCommand({
        formData: recoveryForm(),
        commandEnteredAt: new Date(Number.NaN),
      }),
    ).rejects.toThrow('clock')
    expect(commandMocks.headers).not.toHaveBeenCalled()
  })
})
