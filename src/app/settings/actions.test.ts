import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalUserAction, issueMemberResetAction } from './actions'

const actionMocks = vi.hoisted(() => ({
  captureLocal: vi.fn(),
  captureMember: vi.fn(),
  createLocalUser: vi.fn(),
  issueMemberReset: vi.fn(),
  getPort: vi.fn(),
  revalidatePath: vi.fn(),
  localCommand: Object.freeze({ kind: 'nominal-local-command' }),
  memberCommand: Object.freeze({ kind: 'nominal-member-command' }),
}))

vi.mock('next/cache', () => ({ revalidatePath: actionMocks.revalidatePath }))

vi.mock('@/composition/identity-credential-administration', () => ({
  getProductionIdentityCredentialAdministrationMutationPort: actionMocks.getPort,
}))

vi.mock('@/modules/identity/server/credential-administration-command', () => ({
  captureLocalUserCreationMutationCommand: actionMocks.captureLocal,
  captureMemberResetIssuanceMutationCommand: actionMocks.captureMember,
}))

const localInitialState = Object.freeze({
  errors: Object.freeze([]),
  createdEmail: null,
  stale: false,
})
const memberInitialState = Object.freeze({
  errors: Object.freeze([]),
  issued: null,
  stale: false,
})

describe('settings credential-administration actions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T21:00:00.000Z'))
    vi.clearAllMocks()
    actionMocks.captureLocal.mockResolvedValue({
      kind: 'captured',
      command: actionMocks.localCommand,
    })
    actionMocks.captureMember.mockResolvedValue({
      kind: 'captured',
      command: actionMocks.memberCommand,
    })
    actionMocks.createLocalUser.mockResolvedValue({
      kind: 'created',
      email: 'new@example.test',
    })
    actionMocks.issueMemberReset.mockResolvedValue({
      kind: 'issued',
      targetUserId: 'member-id',
      code: 'indigo_m1_one_time_code',
      expiresAt: new Date('2026-07-15T21:15:00.000Z'),
    })
    actionMocks.getPort.mockReturnValue({
      createLocalUser: actionMocks.createLocalUser,
      issueMemberReset: actionMocks.issueMemberReset,
    })
  })

  afterEach(() => vi.useRealTimers())

  it('captures the local command at action entry and exposes success only after the port returns', async () => {
    const formData = new FormData()
    formData.set('currentPassword', 'owner-password-secret')

    await expect(createLocalUserAction(localInitialState, formData)).resolves.toEqual({
      errors: [],
      createdEmail: 'new@example.test',
      stale: false,
    })

    expect(actionMocks.captureLocal).toHaveBeenCalledWith({
      formData,
      commandEnteredAt: new Date('2026-07-15T21:00:00.000Z'),
    })
    expect(actionMocks.createLocalUser).toHaveBeenCalledWith(actionMocks.localCommand)
    expect(actionMocks.revalidatePath).toHaveBeenCalledOnce()
    expect(actionMocks.revalidatePath).toHaveBeenCalledWith('/settings')
  })

  it('rejects an unauthenticated local command before obtaining the mutation port', async () => {
    actionMocks.captureLocal.mockResolvedValue({ kind: 'rejected' })

    await expect(
      createLocalUserAction(localInitialState, new FormData()),
    ).resolves.toEqual({
      errors: ['Authentication request denied.'],
      createdEmail: null,
      stale: false,
    })
    expect(actionMocks.getPort).not.toHaveBeenCalled()
    expect(actionMocks.createLocalUser).not.toHaveBeenCalled()
    expect(actionMocks.revalidatePath).not.toHaveBeenCalled()
  })

  it.each([
    [
      { kind: 'input-rejected', issues: ['email: Invalid email address'] },
      ['email: Invalid email address'],
    ],
    [{ kind: 'email-conflict' }, ['A local user with that email already exists.']],
    [{ kind: 'reauthentication-failed' }, ['The owner password was not accepted.']],
    [
      { kind: 'reauthentication-locked' },
      ['Too many owner-password attempts. Try again later.'],
    ],
    [
      { kind: 'unavailable' },
      ['Credential administration is temporarily unavailable. Try again.'],
    ],
  ] as const)('maps local outcome %# without refreshing the authority form', async (result, errors) => {
    actionMocks.createLocalUser.mockResolvedValue(result)

    await expect(
      createLocalUserAction(localInitialState, new FormData()),
    ).resolves.toEqual({ errors, createdEmail: null, stale: false })
    expect(actionMocks.revalidatePath).not.toHaveBeenCalled()
  })

  it.each([
    'stale',
    'rejected',
  ] as const)('marks a %s local result stale and invalidates the rendered envelopes', async (kind) => {
    actionMocks.createLocalUser.mockResolvedValue({ kind })

    const state = await createLocalUserAction(localInitialState, new FormData())

    expect(state).toMatchObject({ createdEmail: null, stale: true })
    expect(state.errors.join(' ')).toContain('review them and submit again')
    expect(actionMocks.revalidatePath).toHaveBeenCalledOnce()
    expect(actionMocks.revalidatePath).toHaveBeenCalledWith('/settings')
  })

  it('returns a member reset code only from the committed port result', async () => {
    const formData = new FormData()

    await expect(issueMemberResetAction(memberInitialState, formData)).resolves.toEqual({
      errors: [],
      issued: {
        targetUserId: 'member-id',
        code: 'indigo_m1_one_time_code',
        expiresAt: '2026-07-15T21:15:00.000Z',
      },
      stale: false,
    })
    expect(actionMocks.captureMember).toHaveBeenCalledWith({
      formData,
      commandEnteredAt: new Date('2026-07-15T21:00:00.000Z'),
    })
    expect(actionMocks.issueMemberReset).toHaveBeenCalledWith(actionMocks.memberCommand)
    expect(actionMocks.revalidatePath).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated member command before obtaining the mutation port', async () => {
    actionMocks.captureMember.mockResolvedValue({ kind: 'rejected' })

    await expect(
      issueMemberResetAction(memberInitialState, new FormData()),
    ).resolves.toEqual({
      errors: ['Authentication request denied.'],
      issued: null,
      stale: false,
    })
    expect(actionMocks.getPort).not.toHaveBeenCalled()
    expect(actionMocks.issueMemberReset).not.toHaveBeenCalled()
  })

  it.each([
    ['cooldown', 'Wait 30 seconds before issuing another reset code for this account.'],
    ['reauthentication-failed', 'The owner password was not accepted.'],
    ['reauthentication-locked', 'Too many owner-password attempts. Try again later.'],
    ['unavailable', 'Credential administration is temporarily unavailable. Try again.'],
  ] as const)('maps member outcome %s without refreshing', async (kind, message) => {
    actionMocks.issueMemberReset.mockResolvedValue({ kind })

    await expect(
      issueMemberResetAction(memberInitialState, new FormData()),
    ).resolves.toEqual({ errors: [message], issued: null, stale: false })
    expect(actionMocks.revalidatePath).not.toHaveBeenCalled()
  })

  it.each([
    'target-invalid',
    'stale',
    'rejected',
  ] as const)('marks a %s member result stale and invalidates every rendered target binding', async (kind) => {
    actionMocks.issueMemberReset.mockResolvedValue({ kind })

    const state = await issueMemberResetAction(memberInitialState, new FormData())

    expect(state).toMatchObject({ issued: null, stale: true })
    expect(state.errors.join(' ')).toContain('review them and submit again')
    expect(actionMocks.revalidatePath).toHaveBeenCalledOnce()
    expect(actionMocks.revalidatePath).toHaveBeenCalledWith('/settings')
  })
})
