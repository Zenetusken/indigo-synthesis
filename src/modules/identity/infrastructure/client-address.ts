import { isIP } from 'node:net'

export const authClientAddressHeaders = ['x-forwarded-for'] as const
export const authTrustedProxyCidrs = ['127.0.0.1/32', '::1/128'] as const

function normalizeAddress(value: string): string | null {
  const address = value.trim()
  if (!address || isIP(address) === 0) return null
  return address.toLowerCase()
}

function isTrustedLoopbackProxy(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Resolves an X-Forwarded-For chain for the only supported ingress topology: a TLS
 * terminator on the same host forwarding to the loopback-bound application process.
 *
 * The chain is evaluated from right to left. Loopback proxy hops are discarded and the
 * first untrusted address is the client. A leftmost spoofed value is therefore ignored
 * when a real client address appears to its right. Every token must be a valid IP so a
 * malformed chain fails closed.
 */
export function resolveForwardedClientAddress(value: string | null): string | null {
  if (value === null) return null

  const addresses = value.split(',').map(normalizeAddress)
  if (addresses.length === 0 || addresses.some((address) => address === null)) {
    return null
  }

  const validAddresses = addresses as string[]
  if (validAddresses.length === 1) return validAddresses[0] ?? null

  for (let index = validAddresses.length - 1; index >= 0; index -= 1) {
    const address = validAddresses[index]
    if (!address) return null
    if (isTrustedLoopbackProxy(address)) continue
    return address
  }

  return validAddresses[0] ?? null
}

export function resolveRequestClientAddress(headers: Headers): string | null {
  return resolveForwardedClientAddress(headers.get(authClientAddressHeaders[0]))
}
