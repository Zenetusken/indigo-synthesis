import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureSubjectExportCommand } from './subject-export-command'

const commandMocks = vi.hoisted(() => ({ verifyCookie: vi.fn() }))

vi.mock('../infrastructure/auth', () => ({
  verifyIdentitySessionCookie: commandMocks.verifyCookie,
}))
vi.mock('@/platform/config/server', () => ({
  getServerConfig: () => ({ appOrigin: 'https://training.example.test' }),
}))

function exportRequest(): Request {
  return new Request('https://training.example.test/api/export', {
    headers: {
      cookie: 'indigo.session_token=signed-private-cookie',
      'content-length': '999',
      'content-type': 'application/private',
      'x-request-id': 'export-request-1',
    },
  })
}

describe('subject export server command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    commandMocks.verifyCookie.mockResolvedValue({
      kind: 'verified',
      sessionToken: 'verified-private-session-token',
    })
  })

  it('issues one opaque command from server-verified cookie authority', async () => {
    const captured = await captureSubjectExportCommand(exportRequest())

    expect(captured.kind).toBe('captured')
    if (captured.kind !== 'captured') return
    expect(JSON.stringify(captured.command)).toBe('{}')
    expect(JSON.stringify(captured)).not.toContain('verified-private-session-token')
    const verificationRequest = commandMocks.verifyCookie.mock.calls[0]?.[0] as Request
    expect(verificationRequest.method).toBe('POST')
    expect(verificationRequest.url).toBe(
      'https://training.example.test/api/auth/indigo/verify-session-cookie',
    )
    expect(verificationRequest.headers.get('cookie')).toContain('signed-private-cookie')
    expect(verificationRequest.headers.get('x-request-id')).toBe('export-request-1')
    expect(verificationRequest.headers.get('origin')).toBe(
      'https://training.example.test',
    )
    expect(verificationRequest.headers.has('content-length')).toBe(false)
    expect(verificationRequest.headers.has('content-type')).toBe(false)
  })

  it.each([
    'absent',
    'rejected',
  ] as const)('returns one non-enumerating rejection for %s verification', async (kind) => {
    commandMocks.verifyCookie.mockResolvedValue(
      kind === 'absent'
        ? { kind }
        : { kind, response: new Response(null, { status: 401 }) },
    )

    await expect(captureSubjectExportCommand(exportRequest())).resolves.toEqual({
      kind: 'rejected',
    })
  })

  it('normalizes internal verification to the configured origin behind a host alias', async () => {
    const captured = await captureSubjectExportCommand(
      new Request('http://localhost:3100/api/export', {
        headers: { cookie: 'indigo.session_token=signed-private-cookie' },
      }),
    )

    expect(captured.kind).toBe('captured')
    const verificationRequest = commandMocks.verifyCookie.mock.calls[0]?.[0] as Request
    expect(verificationRequest.url).toBe(
      'https://training.example.test/api/auth/indigo/verify-session-cookie',
    )
    expect(verificationRequest.headers.get('origin')).toBe(
      'https://training.example.test',
    )
  })
})
