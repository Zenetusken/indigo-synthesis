import { describe, expect, it, vi } from 'vitest'
import {
  assertLoopbackEndpoint,
  fetchLoopback,
  NonLoopbackEndpointError,
} from './loopback-fetch'

describe('loopbackFetch', () => {
  it.each([
    'http://127.0.0.1:8080/v1',
    'https://localhost:8443/v1',
    'http://[::1]:8080/v1',
  ])('accepts the loopback endpoint %s', (endpoint) => {
    expect(assertLoopbackEndpoint(endpoint).hostname).toMatch(
      /127\.0\.0\.1|localhost|\[::1\]/,
    )
  })

  it.each([
    'https://api.openai.com/v1',
    'http://127.0.0.1.example/v1',
  ])('rejects %s before invoking fetch', async (endpoint) => {
    const fetchImpl = vi.fn()
    await expect(
      fetchLoopback(endpoint, {}, fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(NonLoopbackEndpointError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('forces manual redirect handling at the final network boundary', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))

    await fetchLoopback(
      'http://127.0.0.1:8080/v1/models',
      { redirect: 'follow' },
      fetchImpl as unknown as typeof fetch,
    )

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/v1/models',
      expect.objectContaining({ redirect: 'error' }),
    )
  })
})
