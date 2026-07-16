import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureLocalUserCreationMutationCommand,
  captureMemberResetIssuanceMutationCommand,
  LocalUserCreationMutationCommand,
  localUserCreationMutationCommandView,
  MemberResetIssuanceMutationCommand,
  memberResetIssuanceMutationCommandView,
} from './credential-administration-command'

const commandMocks = vi.hoisted(() => ({
  headers: vi.fn(),
  verifyCookie: vi.fn(),
}))

vi.mock('next/headers', () => ({ headers: commandMocks.headers }))
vi.mock('../infrastructure/auth', () => ({
  verifyIdentitySessionCookie: commandMocks.verifyCookie,
}))
vi.mock('@/platform/config/server', () => ({
  getServerConfig: () => ({
    appOrigin: 'https://training.example.test',
    secureCookies: true,
  }),
}))

function requestHeaders(): Headers {
  return new Headers({
    cookie: 'indigo.session_token=signed-private-cookie',
    origin: 'https://training.example.test',
    'x-forwarded-for': '203.0.113.9, 127.0.0.1',
    'content-length': '999',
    'content-type': 'multipart/form-data; boundary=private',
  })
}

function localForm(): FormData {
  const form = new FormData()
  form.set('actionBinding', 'opaque-local-binding')
  form.set('targetUserId', 'preallocated-target-id')
  form.set('name', 'Local Athlete')
  form.set('email', 'Athlete@Example.test')
  form.set('initialPassword', 'initial-private-password')
  form.set('currentPassword', 'owner-private-password')
  return form
}

describe('credential-administration server commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    commandMocks.headers.mockResolvedValue(requestHeaders())
    commandMocks.verifyCookie.mockResolvedValue({
      kind: 'verified',
      sessionToken: 'verified-private-session-token',
    })
  })

  it('snapshots local-user form state and authenticates one copied header state', async () => {
    const commandEnteredAt = new Date('2026-07-15T16:00:00.123Z')
    const captured = await captureLocalUserCreationMutationCommand({
      formData: localForm(),
      commandEnteredAt,
    })

    expect(captured.kind).toBe('captured')
    if (captured.kind !== 'captured') return
    const view = localUserCreationMutationCommandView(captured.command)
    expect(view).toEqual({
      actionBinding: 'opaque-local-binding',
      targetUserId: 'preallocated-target-id',
      name: 'Local Athlete',
      email: 'Athlete@Example.test',
      initialPassword: 'initial-private-password',
      currentPassword: 'owner-private-password',
      commandEnteredAt,
      requestContext: { channel: 'web', clientAddress: '203.0.113.9' },
      verifiedSessionToken: 'verified-private-session-token',
    })
    expect(view.commandEnteredAt).not.toBe(commandEnteredAt)
    view.commandEnteredAt.setUTCFullYear(2040)
    expect(
      localUserCreationMutationCommandView(captured.command).commandEnteredAt,
    ).toEqual(commandEnteredAt)
    expect(commandMocks.headers).toHaveBeenCalledTimes(1)
    expect(commandMocks.verifyCookie).toHaveBeenCalledTimes(1)
    const verificationRequest = commandMocks.verifyCookie.mock.calls[0]?.[0] as Request
    expect(verificationRequest.method).toBe('POST')
    expect(verificationRequest.url).toBe(
      'https://training.example.test/api/auth/indigo/verify-session-cookie',
    )
    expect(verificationRequest.headers.get('cookie')).toContain('signed-private-cookie')
    expect(verificationRequest.headers.get('origin')).toBe(
      'https://training.example.test',
    )
    expect(verificationRequest.headers.has('content-length')).toBe(false)
    expect(verificationRequest.headers.has('content-type')).toBe(false)
    expect(JSON.stringify(captured.command)).toBe('{}')
  })

  it('freezes browser fields before waiting for the header snapshot', async () => {
    let releaseHeaders!: (headers: Headers) => void
    commandMocks.headers.mockReturnValue(
      new Promise<Headers>((resolve) => {
        releaseHeaders = resolve
      }),
    )
    const formData = localForm()
    const pending = captureLocalUserCreationMutationCommand({
      formData,
      commandEnteredAt: new Date('2026-07-15T16:00:00.000Z'),
    })
    formData.set('email', 'mutated@example.test')
    formData.set('currentPassword', 'mutated-password')
    releaseHeaders(requestHeaders())

    const captured = await pending
    expect(captured.kind).toBe('captured')
    if (captured.kind !== 'captured') return
    expect(localUserCreationMutationCommandView(captured.command)).toMatchObject({
      email: 'Athlete@Example.test',
      currentPassword: 'owner-private-password',
    })
  })

  it('captures a purpose-separated member target without serializing session authority', async () => {
    const formData = new FormData()
    formData.set('actionBinding', 'opaque-member-binding')
    formData.set('targetUserId', 'member-id')
    formData.set('currentPassword', 'owner-private-password')

    const captured = await captureMemberResetIssuanceMutationCommand({
      formData,
      commandEnteredAt: new Date('2026-07-15T16:00:00.000Z'),
    })

    expect(captured.kind).toBe('captured')
    if (captured.kind !== 'captured') return
    expect(memberResetIssuanceMutationCommandView(captured.command)).toMatchObject({
      actionBinding: 'opaque-member-binding',
      targetUserId: 'member-id',
      currentPassword: 'owner-private-password',
      verifiedSessionToken: 'verified-private-session-token',
    })
    expect(JSON.stringify(captured.command)).not.toContain(
      'verified-private-session-token',
    )
  })

  it.each([
    { kind: 'absent' },
    { kind: 'rejected', response: new Response(null) },
  ])('rejects an unverified credential before issuing a command: $kind', async (verification) => {
    commandMocks.verifyCookie.mockResolvedValue(verification)

    await expect(
      captureLocalUserCreationMutationCommand({
        formData: localForm(),
        commandEnteredAt: new Date('2026-07-15T16:00:00.000Z'),
      }),
    ).resolves.toEqual({ kind: 'rejected' })
  })

  it('rejects an unsupported ingress before cookie verification', async () => {
    commandMocks.headers.mockResolvedValue(
      new Headers({
        cookie: 'private',
        origin: 'https://training.example.test',
      }),
    )

    await expect(
      captureMemberResetIssuanceMutationCommand({
        formData: new FormData(),
        commandEnteredAt: new Date('2026-07-15T16:00:00.000Z'),
      }),
    ).resolves.toEqual({ kind: 'rejected' })
    expect(commandMocks.verifyCookie).not.toHaveBeenCalled()
  })

  it('rejects forged nominal commands and invalid clocks', async () => {
    const forgedLocal = Object.create(LocalUserCreationMutationCommand.prototype)
    const forgedReset = Object.create(MemberResetIssuanceMutationCommand.prototype)
    expect(() => localUserCreationMutationCommandView(forgedLocal)).toThrow(
      'was not issued',
    )
    expect(() => memberResetIssuanceMutationCommandView(forgedReset)).toThrow(
      'was not issued',
    )
    await expect(
      captureLocalUserCreationMutationCommand({
        formData: localForm(),
        commandEnteredAt: new Date(Number.NaN),
      }),
    ).rejects.toThrow('clock')
    expect(commandMocks.headers).not.toHaveBeenCalled()
  })
})
