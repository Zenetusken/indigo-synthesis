import type { LanguageModelPort } from '../ports'
import type {
  LanguageModelCompleteRequest,
  LanguageModelCompleteResult,
  SamplingParams,
} from '../types'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export class NonLoopbackEndpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonLoopbackEndpointError'
  }
}

/**
 * Asserts the OpenAI-compatible base URL is host-local only.
 * Call before any network I/O.
 */
export function assertLoopbackEndpoint(endpoint: string): URL {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new NonLoopbackEndpointError(`Invalid endpoint URL: ${endpoint}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NonLoopbackEndpointError('Endpoint protocol must be http or https.')
  }

  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new NonLoopbackEndpointError(
      `Endpoint host must be loopback (127.0.0.1, localhost, or [::1]); got ${url.hostname}`,
    )
  }

  return url
}

function chatCompletionsUrl(baseEndpoint: string): string {
  const url = assertLoopbackEndpoint(baseEndpoint)
  const path = url.pathname.replace(/\/$/, '')
  if (path.endsWith('/chat/completions')) {
    return url.toString()
  }
  if (path.endsWith('/v1')) {
    url.pathname = `${path}/chat/completions`
    return url.toString()
  }
  if (path === '' || path === '/') {
    url.pathname = '/v1/chat/completions'
    return url.toString()
  }
  url.pathname = `${path}/chat/completions`
  return url.toString()
}

function buildRequestBody(
  request: LanguageModelCompleteRequest,
  sampling: SamplingParams,
): Record<string, unknown> {
  return {
    model: request.servedModelName,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    temperature: sampling.temperature,
    top_p: sampling.topP,
    max_tokens: sampling.maxTokens,
    presence_penalty: sampling.presencePenalty,
    // OpenAI-compatible extensions used by llama.cpp / Qwen templates
    top_k: sampling.topK,
    min_p: sampling.minP,
    repetition_penalty: sampling.repetitionPenalty,
    chat_template_kwargs: {
      enable_thinking: request.enableThinking,
    },
  }
}

export type OpenAiCompatibleLoopbackOptions = {
  readonly endpoint: string
  readonly runtimeId?: string
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch
}

/**
 * OpenAI-compatible client restricted to loopback. Used with llama-server and similar
 * host-local runtimes. This is the sole runtime file allowed to call fetch for LLM I/O.
 */
export function createOpenAiCompatibleLoopbackLanguageModel(
  options: OpenAiCompatibleLoopbackOptions,
): LanguageModelPort {
  // Fail fast at construction if misconfigured.
  assertLoopbackEndpoint(options.endpoint)
  const fetchImpl = options.fetchImpl ?? fetch
  const runtimeId = options.runtimeId ?? 'openai-compatible-loopback'

  return {
    async complete(request): Promise<LanguageModelCompleteResult> {
      let url: string
      try {
        url = chatCompletionsUrl(options.endpoint)
      } catch (error) {
        return {
          status: 'unavailable',
          reason: 'config-error',
          detail: error instanceof Error ? error.message : 'Invalid endpoint',
        }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), request.timeoutMs)

      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(buildRequestBody(request, request.sampling)),
          signal: controller.signal,
        })

        if (!response.ok) {
          return {
            status: 'unavailable',
            reason: 'model-error',
            detail: `Inference server returned HTTP ${response.status}`,
          }
        }

        const payload = (await response.json()) as {
          choices?: readonly { message?: { content?: string | null } }[]
        }
        const text = payload.choices?.[0]?.message?.content?.trim() ?? ''
        if (!text) {
          return {
            status: 'unavailable',
            reason: 'model-error',
            detail: 'Inference server returned empty content.',
          }
        }

        return {
          status: 'available',
          text,
          modelId: request.modelId,
          modelContentDigest: request.modelContentDigest,
          runtimeId,
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return {
            status: 'unavailable',
            reason: 'timeout',
            detail: `Inference timed out after ${request.timeoutMs}ms`,
          }
        }
        return {
          status: 'unavailable',
          reason: 'runtime-unreachable',
          detail: error instanceof Error ? error.message : 'Inference request failed',
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
