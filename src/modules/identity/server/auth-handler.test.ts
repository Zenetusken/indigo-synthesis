import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'
import { handleAuthRequest } from './auth-handler'

const managedEnvironmentKeys = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'INDIGO_CONTENT_MODE',
  'NODE_ENV',
] as const

const originalEnvironment = Object.fromEntries(
  managedEnvironmentKeys.map((key) => [key, process.env[key]]),
)

function setEnvironment(nodeEnvironment: 'development' | 'production'): void {
  Object.assign(process.env, {
    DATABASE_URL: 'postgresql://indigo:indigo@127.0.0.1:5432/indigo_test',
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters',
    BETTER_AUTH_URL:
      nodeEnvironment === 'production'
        ? 'https://training.example.test'
        : 'http://127.0.0.1:3000',
    INDIGO_CONTENT_MODE: 'reviewed',
    NODE_ENV: nodeEnvironment,
  })
  resetServerConfigForTests()
}

afterEach(() => {
  for (const key of managedEnvironmentKeys) {
    const value = originalEnvironment[key]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else Reflect.set(process.env, key, value)
  }
  resetServerConfigForTests()
})

describe('authentication request trust boundary', () => {
  it('fails closed in a production HTTPS topology without a trustworthy client chain', async () => {
    setEnvironment('production')
    const handler = vi.fn(async () => new Response('handled'))

    const response = await handleAuthRequest(
      new Request('https://training.example.test/api/auth/sign-out', {
        method: 'POST',
      }),
      handler,
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      code: 'AUTH_CLIENT_ADDRESS_UNAVAILABLE',
      message: 'Authentication request denied.',
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('accepts a production request whose loopback proxy chain identifies a client', async () => {
    setEnvironment('production')
    const handler = vi.fn(async () => new Response('handled'))
    const request = new Request('https://training.example.test/api/auth/sign-out', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.8, 127.0.0.1' },
    })

    const response = await handleAuthRequest(request, handler)

    expect(await response.text()).toBe('handled')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('allows direct loopback development without a forwarding header', async () => {
    setEnvironment('development')
    const handler = vi.fn(async () => new Response('handled'))

    const response = await handleAuthRequest(
      new Request('http://127.0.0.1:3000/api/auth/sign-out', { method: 'POST' }),
      handler,
    )

    expect(await response.text()).toBe('handled')
    expect(handler).toHaveBeenCalledOnce()
  })
})
