import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'
import {
  createEmailSignInMutationCommand,
  type EmailSignInMutationCommand,
  emailSignInMutationCommandView,
} from './auth-mutation-port'

const origin = 'http://127.0.0.1:3000'

function request(body: Record<string, unknown>): Request {
  return new Request(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'x-indigo-action-binding': 'opaque-page-binding',
    },
    body: JSON.stringify(body),
  })
}

describe('nominal email sign-in command', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/indigo_auth_command_test')
    vi.stubEnv('BETTER_AUTH_SECRET', 'auth-command-test-secret-at-least-32-characters')
    vi.stubEnv('BETTER_AUTH_URL', origin)
    vi.stubEnv('INDIGO_CONTENT_MODE', 'development')
    vi.stubEnv('NODE_ENV', 'test')
    resetServerConfigForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetServerConfigForTests()
  })

  it('derives capture identity and provider body from one request', async () => {
    const command = await createEmailSignInMutationCommand({
      actionBinding: 'opaque-page-binding',
      clientAddress: '198.51.100.8',
      request: request({
        email: ' ATHLETE@EXAMPLE.TEST ',
        password: 'valid-password-123',
      }),
    })
    const view = emailSignInMutationCommandView(command)
    const body = (await view.providerRequest.json()) as Record<string, unknown>

    expect(view).toMatchObject({
      actionBinding: 'opaque-page-binding',
      clientAddress: '198.51.100.8',
      credentialEmail: 'athlete@example.test',
      rateLimitEmail: 'athlete@example.test',
      syntacticallyValid: true,
    })
    expect(body).toMatchObject({
      email: view.credentialEmail,
      password: 'valid-password-123',
    })
    expect(view.providerRequest.headers.get('x-indigo-action-binding')).toBeNull()
  })

  it('snapshots provider headers before asynchronous credential parsing', async () => {
    const mutableRequest = request({
      email: 'athlete@example.test',
      password: 'valid-password-123',
    })
    mutableRequest.headers.set('origin', 'https://attacker.example')

    const pending = createEmailSignInMutationCommand({
      actionBinding: 'opaque-page-binding',
      clientAddress: '198.51.100.8',
      request: mutableRequest,
    })
    mutableRequest.headers.set('origin', origin)

    const view = emailSignInMutationCommandView(await pending)
    expect(view.providerRequest.headers.get('origin')).toBe('https://attacker.example')
  })

  it.each([
    'nul\0bearing@example.test',
    '\u0001control@example.test',
  ])('canonicalizes invalid input %j onto the same non-creatable provider identity', async (email) => {
    const command = await createEmailSignInMutationCommand({
      actionBinding: 'opaque-page-binding',
      clientAddress: '198.51.100.8',
      request: request({ email, password: 'valid-password-123' }),
    })
    const view = emailSignInMutationCommandView(command)
    const body = (await view.providerRequest.json()) as Record<string, unknown>

    expect(view.syntacticallyValid).toBe(false)
    expect(view.credentialEmail.length).toBeGreaterThan(254)
    expect(view.credentialEmail).not.toContain('\0')
    expect(body.email).toBe(view.credentialEmail)
    expect(body.password).toEqual(expect.any(String))
  })

  it('rejects structural forgeries even after a caller imports the nominal type', () => {
    const forged = Object.freeze({}) as EmailSignInMutationCommand
    expect(() => emailSignInMutationCommandView(forged)).toThrow(
      'was not issued by Identity',
    )
  })
})
