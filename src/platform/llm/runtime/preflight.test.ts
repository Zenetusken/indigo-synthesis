import { describe, expect, it, vi } from 'vitest'
import {
  assessMemoryReadiness,
  type EndpointStatus,
  endpointModelReadinessBlocker,
  probeEndpoint,
  VERIFIED_RUNTIME_HEADROOM_BYTES,
} from './preflight'

function endpoint(models: readonly string[]): EndpointStatus {
  return {
    endpoint: 'http://127.0.0.1:8080/v1',
    reachable: true,
    models,
    detail: 'test endpoint',
  }
}

describe('probeEndpoint', () => {
  it.each([
    301, 302, 303, 307, 308,
  ])('rejects redirect response %s and requests manual redirect handling', async (status) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status,
          headers: { location: 'http://evil.example/v1/models' },
        }),
    )

    const result = await probeEndpoint('http://127.0.0.1:8080/v1', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result).toMatchObject({ reachable: false, models: [] })
    expect(result.detail).toMatch(/Redirects are not permitted/)
    const call = fetchImpl.mock.calls[0]
    expect(call).toBeDefined()
    const [, init] = call as unknown as [string, RequestInit]
    expect(init.redirect).toBe('error')
  })

  it('keeps the deadline active while reading the models body', async () => {
    vi.useFakeTimers()
    try {
      const pending = probeEndpoint('http://127.0.0.1:8080/v1', {
        timeoutMs: 50,
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          const signal = init?.signal as AbortSignal
          return {
            ok: true,
            redirected: false,
            status: 200,
            json: () =>
              new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                  reject(new DOMException('aborted', 'AbortError'))
                })
              }),
          } as Response
        }) as unknown as typeof fetch,
      })

      await vi.advanceTimersByTimeAsync(50)
      await expect(pending).resolves.toMatchObject({ reachable: false, models: [] })
      await expect(pending).resolves.toHaveProperty(
        'detail',
        expect.stringMatching(/timed out/),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects malformed models bodies', async () => {
    const invalidJson = await probeEndpoint('http://127.0.0.1:8080/v1', {
      fetchImpl: (async () => ({
        ok: true,
        redirected: false,
        status: 200,
        json: async () => {
          throw new SyntaxError('bad JSON')
        },
      })) as unknown as typeof fetch,
    })
    expect(invalidJson).toMatchObject({ reachable: false, models: [] })
    expect(invalidJson.detail).toMatch(/Malformed response body/)

    const wrongShape = await probeEndpoint('http://127.0.0.1:8080/v1', {
      fetchImpl: (async () => Response.json({ models: [] })) as unknown as typeof fetch,
    })
    expect(wrongShape).toMatchObject({ reachable: false, models: [] })
    expect(wrongShape.detail).toMatch(/Malformed JSON body/)
  })

  it('refuses non-loopback probe targets before fetch', async () => {
    const fetchImpl = vi.fn()
    const result = await probeEndpoint('https://models.example/v1', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toMatchObject({ reachable: false, models: [] })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('endpointModelReadinessBlocker', () => {
  it('blocks empty and non-exact served-model lists', () => {
    expect(endpointModelReadinessBlocker(endpoint([]), 'qwen3.5-9b-q4_k_m')).toMatch(
      /lists no models/,
    )
    expect(
      endpointModelReadinessBlocker(endpoint(['qwen3.5-9b-q5_k_m']), 'qwen3.5-9b-q4_k_m'),
    ).toMatch(/does not list exact served model/)
    expect(
      endpointModelReadinessBlocker(
        endpoint(['/weights/qwen3.5-9b-q4_k_m.gguf']),
        'qwen3.5-9b-q4_k_m',
      ),
    ).toMatch(/does not list exact served model/)
  })

  it('accepts only an exact non-empty served-model match', () => {
    expect(
      endpointModelReadinessBlocker(endpoint(['qwen3.5-9b-q4_k_m']), 'qwen3.5-9b-q4_k_m'),
    ).toBeNull()
  })
})

describe('assessMemoryReadiness', () => {
  const approxModelBytes = 5_680_000_000

  it('requires model bytes plus operating headroom before a runtime is verified', () => {
    const result = assessMemoryReadiness({
      memAvailableBytes: VERIFIED_RUNTIME_HEADROOM_BYTES,
      approxModelBytes,
      runtimeVerified: false,
    })

    expect(result).toMatchObject({
      readinessBasis: 'model-load',
      sufficientForApproxModelBytes: false,
      sufficientForReadiness: false,
    })
    expect(result.requiredAvailableBytes).toBe(
      approxModelBytes + VERIFIED_RUNTIME_HEADROOM_BYTES,
    )
  })

  it('does not require room to load a second model after the attested runtime is resident', () => {
    const result = assessMemoryReadiness({
      memAvailableBytes: VERIFIED_RUNTIME_HEADROOM_BYTES,
      approxModelBytes,
      runtimeVerified: true,
    })

    expect(result).toEqual({
      readinessBasis: 'verified-runtime',
      requiredAvailableBytes: VERIFIED_RUNTIME_HEADROOM_BYTES,
      sufficientForApproxModelBytes: false,
      sufficientForReadiness: true,
    })
  })
})
