import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn(),
  drizzleAdapter: vi.fn(() => Symbol('adapter')),
  getDb: vi.fn(() => Symbol('singleton-database')),
}))

vi.mock('better-auth/minimal', () => ({ betterAuth: mocks.betterAuth }))
vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: mocks.drizzleAdapter,
}))
vi.mock('@/platform/db/client', () => ({ getDb: mocks.getDb }))

import {
  clearProvenAbsentIdentitySession,
  resetAuthForTests,
  verifyIdentitySessionCookie,
} from './auth'
import { createScopedIdentityMutationGateway } from './scoped-mutation-auth'

const testEnvironment = {
  DATABASE_URL: 'postgresql://localhost/indigo_auth_gateway_test',
  BETTER_AUTH_SECRET: 'scoped-auth-gateway-test-secret-1234567890',
  BETTER_AUTH_URL: 'http://127.0.0.1:3000',
  INDIGO_CONTENT_MODE: 'development',
  NODE_ENV: 'test',
} as const

const originalEnvironment = Object.fromEntries(
  Object.keys(testEnvironment).map((key) => [key, process.env[key]]),
)

type CapturedOptions = {
  readonly database: unknown
  readonly plugins?: readonly { readonly id: string }[]
  readonly [key: string]: unknown
}

function capturedOptions(index: number): CapturedOptions {
  const value = mocks.betterAuth.mock.calls[index]?.[0]
  if (!value || typeof value !== 'object')
    throw new Error('auth options were not captured')
  return value as CapturedOptions
}

describe('request-scoped Identity auth configuration', () => {
  beforeEach(() => {
    Object.assign(process.env, testEnvironment)
    resetServerConfigForTests()
    resetAuthForTests()
    vi.clearAllMocks()
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetServerConfigForTests()
    resetAuthForTests()
  })

  it('shares security policy while disabling every mutation on the read singleton', async () => {
    const singletonAuth = {
      api: {
        verifyIdentitySessionCookie: vi
          .fn()
          .mockResolvedValue(Response.json({ sessionToken: null })),
        clearProvenAbsentIdentitySession: vi.fn(),
      },
    }
    const scopedAuth = {
      handler: vi.fn(),
      api: { signOut: vi.fn() },
    }
    mocks.betterAuth
      .mockReturnValueOnce(singletonAuth as never)
      .mockReturnValueOnce(scopedAuth as never)

    await verifyIdentitySessionCookie(
      new Request('http://127.0.0.1:3000/api/auth/sign-out', {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:3000' },
      }),
    )
    createScopedIdentityMutationGateway(Symbol('scoped-database') as never)

    const singleton = capturedOptions(0)
    const scoped = capturedOptions(1)
    const {
      database: singletonDatabase,
      plugins: singletonPlugins,
      ...singletonPolicy
    } = singleton
    const { database: scopedDatabase, plugins: scopedPlugins, ...scopedPolicy } = scoped

    const { disabledPaths: singletonDisabledPaths, ...singletonSharedPolicy } =
      singletonPolicy
    const { disabledPaths: scopedDisabledPaths, ...scopedSharedPolicy } = scopedPolicy
    expect(scopedSharedPolicy).toEqual(singletonSharedPolicy)
    expect(singletonDisabledPaths).toEqual(
      expect.arrayContaining(['/sign-in/email', '/sign-out']),
    )
    expect(scopedDisabledPaths).not.toEqual(
      expect.arrayContaining(['/sign-in/email', '/sign-out']),
    )
    expect(singletonPlugins?.map(({ id }) => id)).toEqual([
      'indigo-session-cookie',
      'next-cookies',
    ])
    expect(scopedPlugins?.map(({ id }) => id)).toEqual(['indigo-checked-sign-out'])
    expect(scopedPlugins?.some(({ id }) => id === 'next-cookies')).toBe(false)
    expect(singletonDatabase).not.toBe(scopedDatabase)

    expect(mocks.drizzleAdapter).toHaveBeenNthCalledWith(
      1,
      mocks.getDb.mock.results[0]?.value,
      expect.objectContaining({
        provider: 'pg',
        transaction: true,
        schema: expect.objectContaining({
          user: expect.anything(),
          session: expect.anything(),
          account: expect.anything(),
          verification: expect.anything(),
        }),
      }),
    )
    expect(mocks.drizzleAdapter).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        provider: 'pg',
        transaction: false,
        schema: expect.objectContaining({
          user: expect.anything(),
          session: expect.anything(),
          account: expect.anything(),
          verification: expect.anything(),
        }),
      }),
    )
  })

  it('forwards the original Request through every narrow gateway method', async () => {
    const response = new Response(null, { status: 204 })
    const singletonAuth = {
      api: {
        verifyIdentitySessionCookie: vi
          .fn()
          .mockResolvedValue(Response.json({ sessionToken: 'raw-session-token' })),
        clearProvenAbsentIdentitySession: vi.fn().mockResolvedValue(response),
      },
    }
    const scopedAuth = {
      handler: vi.fn().mockResolvedValue(response),
      api: { signOut: vi.fn().mockResolvedValue(response) },
    }
    mocks.betterAuth
      .mockReturnValueOnce(singletonAuth as never)
      .mockReturnValueOnce(scopedAuth as never)

    const signOutRequest = new Request('http://127.0.0.1:3000/api/auth/sign-out', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3000' },
    })
    const signInRequest = new Request('http://127.0.0.1:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3000' },
    })

    await expect(verifyIdentitySessionCookie(signOutRequest)).resolves.toEqual({
      kind: 'verified',
      sessionToken: 'raw-session-token',
    })
    const gateway = createScopedIdentityMutationGateway(
      Symbol('scoped-database') as never,
    )
    expect(Object.keys(gateway)).toEqual(['signInEmail', 'checkedSignOut'])
    expect(Object.isFrozen(gateway)).toBe(true)
    await expect(clearProvenAbsentIdentitySession(signOutRequest)).resolves.toBe(response)
    await expect(gateway.signInEmail(signInRequest)).resolves.toBe(response)
    await expect(gateway.checkedSignOut(signOutRequest)).resolves.toBe(response)

    expect(singletonAuth.api.verifyIdentitySessionCookie).toHaveBeenCalledWith({
      request: signOutRequest,
      headers: signOutRequest.headers,
      asResponse: true,
    })
    expect(singletonAuth.api.clearProvenAbsentIdentitySession).toHaveBeenCalledWith({
      request: signOutRequest,
      headers: signOutRequest.headers,
      asResponse: true,
    })
    expect(scopedAuth.handler).toHaveBeenCalledWith(signInRequest)
    expect(scopedAuth.api.signOut).toHaveBeenCalledWith({
      request: signOutRequest,
      headers: signOutRequest.headers,
      asResponse: true,
    })
  })

  it('rejects a request whose method or route does not match the gateway method', async () => {
    const scopedAuth = {
      handler: vi.fn(),
      api: { signOut: vi.fn() },
    }
    mocks.betterAuth.mockReturnValueOnce(scopedAuth as never)
    const gateway = createScopedIdentityMutationGateway(
      Symbol('scoped-database') as never,
    )
    const wrongRoute = new Request('http://127.0.0.1:3000/api/auth/sign-out', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3000' },
    })
    const wrongMethod = new Request('http://127.0.0.1:3000/api/auth/sign-out', {
      method: 'GET',
    })

    await expect(gateway.signInEmail(wrongRoute)).rejects.toThrow(
      'does not match its gateway route',
    )
    await expect(gateway.checkedSignOut(wrongMethod)).rejects.toThrow(
      'does not match its gateway route',
    )
    expect(scopedAuth.handler).not.toHaveBeenCalled()
    expect(scopedAuth.api.signOut).not.toHaveBeenCalled()
  })
})
