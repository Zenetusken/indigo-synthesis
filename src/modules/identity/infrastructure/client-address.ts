import { isIP } from 'node:net'

export const authClientAddressHeaders = ['x-forwarded-for'] as const
export const authTrustedProxyCidrs = ['127.0.0.1/32', '::1/128'] as const
export const directLoopbackClientAddress = 'loopback-direct' as const

function normalizeAddress(value: string): string | null {
  const address = value.trim()
  if (!address || isIP(address) === 0) return null
  return address.toLowerCase()
}

function isTrustedLoopbackProxy(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function ipv6Segments(address: string): number[] {
  let source = address
  const finalColon = source.lastIndexOf(':')
  const embeddedIpv4 = source.slice(finalColon + 1)
  if (isIP(embeddedIpv4) === 4) {
    const octets = embeddedIpv4.split('.').map(Number)
    source = `${source.slice(0, finalColon)}:${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`
  }

  const [left = '', right = ''] = source.split('::')
  const leftSegments = left ? left.split(':') : []
  const rightSegments = right ? right.split(':') : []
  const missing = 8 - leftSegments.length - rightSegments.length
  return [
    ...leftSegments,
    ...Array.from({ length: Math.max(0, missing) }, () => '0'),
    ...rightSegments,
  ].map((segment) => Number.parseInt(segment || '0', 16))
}

function canonicalIpv6(segments: readonly number[]): string {
  let bestStart = -1
  let bestLength = 0
  for (let index = 0; index < segments.length; ) {
    if (segments[index] !== 0) {
      index += 1
      continue
    }
    let end = index
    while (end < segments.length && segments[end] === 0) end += 1
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index
      bestLength = end - index
    }
    index = end
  }

  if (bestStart < 0) return segments.map((segment) => segment.toString(16)).join(':')
  const before = segments.slice(0, bestStart).map((segment) => segment.toString(16))
  const after = segments
    .slice(bestStart + bestLength)
    .map((segment) => segment.toString(16))
  return `${before.join(':')}::${after.join(':')}`
}

export function minimizeCredentialClientAddress(address: string): string {
  if (address === directLoopbackClientAddress) return address
  const version = isIP(address)
  if (version === 4) {
    const octets = address.split('.')
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`
  }
  if (version === 6) {
    const segments = ipv6Segments(address)
    segments[3] = (segments[3] ?? 0) & 0xff00
    for (let index = 4; index < 8; index += 1) segments[index] = 0
    return `${canonicalIpv6(segments)}/56`
  }
  throw new Error('Credential client address was not resolved by the trusted ingress.')
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

/**
 * Produces the audit/rate-limit address for a supported web ingress. A loopback-only
 * HTTP installation has no proxy header by design, so it receives an explicit sentinel
 * rather than pretending an unknown address is an Internet client. HTTPS deployments
 * must supply the trusted forwarded chain and therefore pass allowDirectLoopback=false.
 */
export function resolveWebClientAddress(
  headers: Headers,
  options: { readonly allowDirectLoopback: boolean },
): string | null {
  const forwarded = headers.get(authClientAddressHeaders[0])
  if (forwarded !== null) return resolveForwardedClientAddress(forwarded)
  return options.allowDirectLoopback ? directLoopbackClientAddress : null
}
