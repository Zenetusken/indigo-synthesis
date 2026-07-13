import type { LanguageModelPort } from '../ports'
import { assertLoopbackEndpoint, fetchLoopback } from '../runtime/loopback-fetch'
import type {
  LanguageModelCompleteRequest,
  LanguageModelCompleteResult,
  SamplingParams,
} from '../types'

export {
  assertLoopbackEndpoint,
  NonLoopbackEndpointError,
} from '../runtime/loopback-fetch'

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
 * host-local runtimes. All I/O crosses the shared loopback-only network primitive.
 */
export function createOpenAiCompatibleLoopbackLanguageModel(
  options: OpenAiCompatibleLoopbackOptions,
): LanguageModelPort {
  // Fail fast at construction if misconfigured.
  assertLoopbackEndpoint(options.endpoint)
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
      let responseReceived = false

      try {
        const response = await fetchLoopback(
          url,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify(buildRequestBody(request, request.sampling)),
            signal: controller.signal,
          },
          options.fetchImpl,
        )
        responseReceived = true

        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          return {
            status: 'unavailable',
            reason: 'model-error',
            detail: 'Inference server redirects are not permitted.',
          }
        }

        if (!response.ok) {
          return {
            status: 'unavailable',
            reason: 'model-error',
            detail: `Inference server returned HTTP ${response.status}`,
          }
        }

        const payload = (await response.json()) as {
          model?: unknown
          choices?: readonly { message?: { content?: string | null } }[]
        }
        if (typeof payload.model !== 'string' || payload.model.trim().length === 0) {
          return {
            status: 'unavailable',
            reason: 'model-error',
            detail: 'Inference server response omitted a non-empty model identifier.',
          }
        }
        if (payload.model !== request.servedModelName) {
          return {
            status: 'unavailable',
            reason: 'model-error',
            detail: `Inference server responded as model "${payload.model}"; expected "${request.servedModelName}".`,
          }
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
        if (responseReceived) {
          return {
            status: 'unavailable',
            reason: 'model-error',
            detail: 'Inference server returned a malformed response body.',
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
