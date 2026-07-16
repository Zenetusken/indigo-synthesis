import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'

type AdapterCall = {
  readonly operation: string
  readonly model: string
}

const adapterState = vi.hoisted(() => ({
  database: {
    user: [] as Record<string, unknown>[],
    session: [] as Record<string, unknown>[],
    account: [] as Record<string, unknown>[],
    verification: [] as Record<string, unknown>[],
  },
  calls: [] as AdapterCall[],
  deleteSessionError: null as Error | null,
  failAllOperations: null as Error | null,
}))

vi.mock('better-auth/adapters/drizzle', async () => {
  const { memoryAdapter } = await vi.importActual<
    typeof import('better-auth/adapters/memory')
  >('better-auth/adapters/memory')

  return {
    drizzleAdapter: vi.fn(() => {
      const factory = memoryAdapter(adapterState.database)
      return (options: never) => {
        const adapter = factory(options)
        const databaseOperations = new Set([
          'count',
          'create',
          'delete',
          'deleteMany',
          'findMany',
          'findOne',
          'update',
          'updateMany',
        ])
        return new Proxy(adapter, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver)
            if (
              !databaseOperations.has(String(property)) ||
              typeof value !== 'function'
            ) {
              return value
            }
            return async (...arguments_: unknown[]) => {
              const input = arguments_[0]
              const model =
                input &&
                typeof input === 'object' &&
                'model' in input &&
                typeof input.model === 'string'
                  ? input.model
                  : 'unknown'
              const operation = String(property)
              adapterState.calls.push({ operation, model })
              if (adapterState.failAllOperations) throw adapterState.failAllOperations
              if (
                operation === 'delete' &&
                model === 'session' &&
                adapterState.deleteSessionError
              ) {
                throw adapterState.deleteSessionError
              }
              return Reflect.apply(value, target, arguments_)
            }
          },
        })
      }
    }),
  }
})

vi.mock('@/platform/db/client', () => ({ getDb: vi.fn(() => ({})) }))

import {
  clearProvenAbsentIdentitySession,
  handleIdentityGetSession,
  resetAuthForTests,
  verifyIdentitySessionCookie,
} from './auth'
import { createScopedIdentityMutationGateway } from './scoped-mutation-auth'

const appOrigin = 'http://127.0.0.1:3000'
const authSecret = 'scoped-auth-behavior-test-secret-1234567890'
const testEnvironment = {
  DATABASE_URL: 'postgresql://localhost/indigo_auth_behavior_test',
  BETTER_AUTH_SECRET: authSecret,
  BETTER_AUTH_URL: appOrigin,
  INDIGO_CONTENT_MODE: 'development',
  NODE_ENV: 'test',
} as const

const originalEnvironment = Object.fromEntries(
  Object.keys(testEnvironment).map((key) => [key, process.env[key]]),
)

function cookieValue(token: string): string {
  const signature = createHmac('sha256', authSecret).update(token).digest('base64')
  return encodeURIComponent(`${token}.${signature}`)
}

function signOutRequest(input?: {
  readonly token?: string
  readonly origin?: string
  readonly cookie?: string
}): Request {
  const headers = new Headers({ origin: input?.origin ?? appOrigin })
  if (input?.token) {
    headers.set('cookie', `better-auth.session_token=${cookieValue(input.token)}`)
  } else if (input?.cookie) {
    headers.set('cookie', `better-auth.session_token=${input.cookie}`)
  }
  return new Request(`${appOrigin}/api/auth/sign-out`, {
    method: 'POST',
    headers,
  })
}

function setCookieHeader(response: Response): string | null {
  return response.headers.get('set-cookie')
}

describe('request-scoped Identity auth behavior', () => {
  beforeEach(() => {
    Object.assign(process.env, testEnvironment)
    resetServerConfigForTests()
    resetAuthForTests()
    adapterState.database.user.splice(0)
    adapterState.database.session.splice(0)
    adapterState.database.account.splice(0)
    adapterState.database.verification.splice(0)
    adapterState.calls.splice(0)
    adapterState.deleteSessionError = null
    adapterState.failAllOperations = null
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetServerConfigForTests()
    resetAuthForTests()
  })

  it('verifies a signed session cookie through a server-only direct endpoint', async () => {
    const request = signOutRequest({ token: 'raw-session-token' })

    await expect(verifyIdentitySessionCookie(request)).resolves.toEqual({
      kind: 'verified',
      sessionToken: 'raw-session-token',
    })
    await expect(
      verifyIdentitySessionCookie(signOutRequest({ cookie: 'tampered.cookie' })),
    ).resolves.toEqual({ kind: 'absent' })
    await expect(verifyIdentitySessionCookie(signOutRequest())).resolves.toEqual({
      kind: 'absent',
    })
    expect(adapterState.calls).toEqual([])

    for (const path of [
      '/indigo/verify-session-cookie',
      '/indigo/clear-proven-absent-session',
    ]) {
      const externalRequest = new Request(`${appOrigin}/api/auth${path}`, {
        method: 'POST',
        headers: request.headers,
      })
      expect(() => handleIdentityGetSession(externalRequest)).toThrow('unsupported route')
    }
  })

  it('clears a coherently proven-absent credential without touching the adapter', async () => {
    adapterState.failAllOperations = new Error('database access is forbidden')
    const response = await clearProvenAbsentIdentitySession(
      signOutRequest({ token: 'proven-absent-token' }),
    )

    expect(response.status).toBe(200)
    expect(setCookieHeader(response)).toMatch(/better-auth\.session_token=; Max-Age=0/)
    expect(adapterState.calls).toEqual([])
  })

  it('does not clear an absent, invalid, or cross-origin cookie', async () => {
    for (const [request, status] of [
      [signOutRequest(), 401],
      [signOutRequest({ cookie: 'tampered.cookie' }), 401],
      [
        signOutRequest({
          token: 'valid-token',
          origin: 'https://attacker.example',
        }),
        403,
      ],
    ] as const) {
      const response = await clearProvenAbsentIdentitySession(request)
      expect(response.status).toBe(status)
      expect(setCookieHeader(response)).toBeNull()
    }
    expect(adapterState.calls).toEqual([])
  })

  it('deletes the verified session before staging cookie expiry', async () => {
    adapterState.database.session.push({
      id: 'session-id',
      token: 'checked-token',
    })
    const gateway = createScopedIdentityMutationGateway({} as never)

    const response = await gateway.checkedSignOut(
      signOutRequest({ token: 'checked-token' }),
    )

    expect(response.status).toBe(200)
    expect(adapterState.calls).toEqual([{ operation: 'delete', model: 'session' }])
    expect(adapterState.database.session).toEqual([])
    expect(setCookieHeader(response)).toMatch(/better-auth\.session_token=; Max-Age=0/)
  })

  it('rejects invalid checked sign-out credentials without deletion or expiry', async () => {
    const gateway = createScopedIdentityMutationGateway({} as never)

    for (const request of [
      signOutRequest(),
      signOutRequest({ cookie: 'tampered.cookie' }),
    ]) {
      const response = await gateway.checkedSignOut(request)
      expect(response.status).toBe(401)
      expect(setCookieHeader(response)).toBeNull()
    }
    expect(adapterState.calls).toEqual([])
  })

  it('propagates the exact deletion failure before any success or cookie expiry', async () => {
    const failure = new Error('session deletion failed')
    adapterState.deleteSessionError = failure
    const append = vi.spyOn(Headers.prototype, 'append')
    const gateway = createScopedIdentityMutationGateway({} as never)

    await expect(
      gateway.checkedSignOut(signOutRequest({ token: 'checked-token' })),
    ).rejects.toBe(failure)

    expect(adapterState.calls).toEqual([{ operation: 'delete', model: 'session' }])
    expect(append.mock.calls.some(([name]) => name.toLowerCase() === 'set-cookie')).toBe(
      false,
    )
  })
})
