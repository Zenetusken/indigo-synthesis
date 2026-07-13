const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export class NonLoopbackEndpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonLoopbackEndpointError'
  }
}

/** Parse and reject every non-HTTP(S), non-loopback target before network I/O. */
export function assertLoopbackEndpoint(endpoint: string | URL): URL {
  let url: URL
  try {
    url = new URL(endpoint.toString())
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

/**
 * The sole LLM network primitive. It revalidates the final URL immediately before the
 * request and always disables redirect following, including for injected test clients.
 */
export async function fetchLoopback(
  endpoint: string | URL,
  init: RequestInit,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const url = assertLoopbackEndpoint(endpoint)
  return fetchImpl(url.toString(), { ...init, redirect: 'error' })
}
