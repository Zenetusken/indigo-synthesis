import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureInstanceResetMutationCommand,
  captureTraineeDataDeletionMutationCommand,
  instanceResetCommandView,
  traineeDataDeletionCommandView,
} from './destructive-command'

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

function destructiveForm(): FormData {
  const form = new FormData()
  form.set('actionBinding', 'opaque-plan-binding')
  form.set('planId', 'rendered-plan-id')
  form.set('planDigest', 'rendered-plan-digest')
  form.set('password', 'private-current-password')
  form.set('typedConfirmation', 'DELETE')
  form.set('acknowledged', 'on')
  return form
}

describe('destructive server commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    commandMocks.headers.mockResolvedValue(requestHeaders())
    commandMocks.verifyCookie.mockResolvedValue({
      kind: 'verified',
      sessionToken: 'verified-private-session-token',
    })
  })

  it('captures a purpose-specific nominal command without exposing cookie authority', async () => {
    const commandEnteredAt = new Date('2026-07-16T13:00:00.123Z')
    const captured = await captureTraineeDataDeletionMutationCommand({
      formData: destructiveForm(),
      commandEnteredAt,
    })

    expect(captured.kind).toBe('captured')
    if (captured.kind !== 'captured') return
    const view = traineeDataDeletionCommandView(captured.command)
    expect(view).toEqual({
      purpose: 'trainee-data-deletion',
      actionBinding: 'opaque-plan-binding',
      planId: 'rendered-plan-id',
      planDigest: 'rendered-plan-digest',
      currentPassword: 'private-current-password',
      typedConfirmation: 'DELETE',
      acknowledged: true,
      commandEnteredAt,
      requestContext: { channel: 'web', clientAddress: '203.0.113.9' },
    })
    expect(view.commandEnteredAt).not.toBe(commandEnteredAt)
    view.commandEnteredAt.setUTCFullYear(2099)
    expect(traineeDataDeletionCommandView(captured.command).commandEnteredAt).toEqual(
      commandEnteredAt,
    )
    expect(JSON.stringify(captured.command)).toBe('{}')
    expect(JSON.stringify(view)).not.toContain('verified-private-session-token')

    const verificationRequest = commandMocks.verifyCookie.mock.calls[0]?.[0] as Request
    expect(verificationRequest.method).toBe('POST')
    expect(verificationRequest.url).toBe(
      'https://training.example.test/api/auth/indigo/verify-session-cookie',
    )
    expect(verificationRequest.headers.get('cookie')).toContain('signed-private-cookie')
    expect(verificationRequest.headers.has('content-length')).toBe(false)
    expect(verificationRequest.headers.has('content-type')).toBe(false)
  })

  it('snapshots all browser fields before waiting for request authentication', async () => {
    let releaseHeaders!: (headers: Headers) => void
    commandMocks.headers.mockReturnValue(
      new Promise<Headers>((resolve) => {
        releaseHeaders = resolve
      }),
    )
    const formData = destructiveForm()
    const pending = captureInstanceResetMutationCommand({
      formData,
      commandEnteredAt: new Date('2026-07-16T13:00:00.000Z'),
    })
    formData.set('planId', 'mutated-plan')
    formData.set('planDigest', 'mutated-digest')
    formData.set('password', 'mutated-password')
    formData.delete('acknowledged')
    releaseHeaders(requestHeaders())

    const captured = await pending
    expect(captured.kind).toBe('captured')
    if (captured.kind !== 'captured') return
    expect(instanceResetCommandView(captured.command)).toMatchObject({
      purpose: 'instance-reset',
      planId: 'rendered-plan-id',
      planDigest: 'rendered-plan-digest',
      currentPassword: 'private-current-password',
      acknowledged: true,
    })
  })

  it('keeps deletion and reset nominal purposes separate', async () => {
    const formData = destructiveForm()
    formData.set('typedConfirmation', 'RESET')
    const captured = await captureInstanceResetMutationCommand({
      formData,
      commandEnteredAt: new Date('2026-07-16T13:00:00.000Z'),
    })

    expect(captured.kind).toBe('captured')
    if (captured.kind !== 'captured') return
    expect(instanceResetCommandView(captured.command).purpose).toBe('instance-reset')
    expect(() => traineeDataDeletionCommandView(captured.command as never)).toThrow(
      'purpose does not match',
    )
  })

  it.each([
    { kind: 'absent' },
    { kind: 'rejected', response: new Response(null) },
  ])('rejects an unverified cookie before issuing a command: $kind', async (verification) => {
    commandMocks.verifyCookie.mockResolvedValue(verification)
    await expect(
      captureTraineeDataDeletionMutationCommand({
        formData: destructiveForm(),
        commandEnteredAt: new Date('2026-07-16T13:00:00.000Z'),
      }),
    ).resolves.toEqual({ kind: 'rejected' })
  })

  it('rejects unsupported ingress before cookie verification and invalid clocks before any await', async () => {
    commandMocks.headers.mockResolvedValue(
      new Headers({
        cookie: 'private',
        origin: 'https://training.example.test',
      }),
    )
    await expect(
      captureInstanceResetMutationCommand({
        formData: destructiveForm(),
        commandEnteredAt: new Date('2026-07-16T13:00:00.000Z'),
      }),
    ).resolves.toEqual({ kind: 'rejected' })
    expect(commandMocks.verifyCookie).not.toHaveBeenCalled()

    await expect(
      captureTraineeDataDeletionMutationCommand({
        formData: destructiveForm(),
        commandEnteredAt: new Date(Number.NaN),
      }),
    ).rejects.toThrow('clock')
    expect(commandMocks.headers).toHaveBeenCalledTimes(1)
  })

  it('rejects forged nominal commands', () => {
    expect(() => traineeDataDeletionCommandView({} as never)).toThrow(
      'was not issued by Identity',
    )
    expect(() => instanceResetCommandView({} as never)).toThrow(
      'was not issued by Identity',
    )
  })
})
