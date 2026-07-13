import { describe, expect, it, vi } from 'vitest'
import {
  assertLoopbackEndpoint,
  createOpenAiCompatibleLoopbackLanguageModel,
  NonLoopbackEndpointError,
} from './openai-compatible-loopback'

const baseRequest = {
  messages: [{ role: 'user' as const, content: 'hello' }],
  sampling: {
    temperature: 0.3,
    topP: 0.8,
    topK: 20,
    minP: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    maxTokens: 64,
  },
  timeoutMs: 1_000,
  servedModelName: 'test-model',
  enableThinking: false,
  modelId: 'test-model',
  modelContentDigest: 'a'.repeat(64),
}

describe('assertLoopbackEndpoint', () => {
  it('accepts loopback hosts', () => {
    expect(assertLoopbackEndpoint('http://127.0.0.1:8080/v1').hostname).toBe('127.0.0.1')
    expect(assertLoopbackEndpoint('http://localhost:8080/v1').hostname).toBe('localhost')
  })

  it('rejects non-loopback hosts', () => {
    expect(() => assertLoopbackEndpoint('http://example.com/v1')).toThrow(
      NonLoopbackEndpointError,
    )
    expect(() => assertLoopbackEndpoint('https://api.openai.com/v1')).toThrow(
      NonLoopbackEndpointError,
    )
  })
})

describe('createOpenAiCompatibleLoopbackLanguageModel', () => {
  it('returns model text from a successful completion', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        model: 'test-model',
        choices: [{ message: { content: 'Grounded prose.' } }],
      }),
    )
    const model = createOpenAiCompatibleLoopbackLanguageModel({
      endpoint: 'http://127.0.0.1:8080/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await model.complete(baseRequest)
    expect(result).toMatchObject({
      status: 'available',
      text: 'Grounded prose.',
      modelId: 'test-model',
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const call = fetchImpl.mock.calls[0]
    expect(call).toBeDefined()
    const [url, init] = call as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8080/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
  })

  it.each([
    301, 302, 303, 307, 308,
  ])('rejects redirect response %s without consuming a body', async (status) => {
    const model = createOpenAiCompatibleLoopbackLanguageModel({
      endpoint: 'http://127.0.0.1:8080/v1',
      fetchImpl: (async () =>
        new Response(null, {
          status,
          headers: { location: 'http://evil.example/v1/chat/completions' },
        })) as unknown as typeof fetch,
    })

    await expect(model.complete(baseRequest)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'model-error',
      detail: 'Inference server redirects are not permitted.',
    })
  })

  it('keeps the deadline active while reading the response body', async () => {
    vi.useFakeTimers()
    try {
      const model = createOpenAiCompatibleLoopbackLanguageModel({
        endpoint: 'http://127.0.0.1:8080/v1',
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

      const pending = model.complete({ ...baseRequest, timeoutMs: 50 })
      await vi.advanceTimersByTimeAsync(50)
      await expect(pending).resolves.toMatchObject({
        status: 'unavailable',
        reason: 'timeout',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps malformed JSON bodies to model-error', async () => {
    const model = createOpenAiCompatibleLoopbackLanguageModel({
      endpoint: 'http://127.0.0.1:8080/v1',
      fetchImpl: (async () => ({
        ok: true,
        redirected: false,
        status: 200,
        json: async () => {
          throw new SyntaxError('bad JSON')
        },
      })) as unknown as typeof fetch,
    })

    await expect(model.complete(baseRequest)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'model-error',
      detail: 'Inference server returned a malformed response body.',
    })
  })

  it('requires a non-empty exact response model identifier', async () => {
    for (const responseModel of [undefined, '', 'test-model-q5']) {
      const model = createOpenAiCompatibleLoopbackLanguageModel({
        endpoint: 'http://127.0.0.1:8080/v1',
        fetchImpl: (async () =>
          Response.json({
            model: responseModel,
            choices: [{ message: { content: 'Grounded prose.' } }],
          })) as unknown as typeof fetch,
      })

      const result = await model.complete(baseRequest)
      expect(result).toMatchObject({ status: 'unavailable', reason: 'model-error' })
      if (result.status === 'unavailable') {
        expect(result.detail).toMatch(/model/i)
      }
    }
  })

  it('maps connection failure to runtime-unreachable', async () => {
    const model = createOpenAiCompatibleLoopbackLanguageModel({
      endpoint: 'http://127.0.0.1:8080/v1',
      fetchImpl: (async () => {
        throw new Error('connect ECONNREFUSED')
      }) as unknown as typeof fetch,
    })

    await expect(model.complete(baseRequest)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'runtime-unreachable',
    })
  })

  it('refuses to construct with a remote endpoint', () => {
    expect(() =>
      createOpenAiCompatibleLoopbackLanguageModel({
        endpoint: 'http://evil.example/v1',
      }),
    ).toThrow(NonLoopbackEndpointError)
  })
})
