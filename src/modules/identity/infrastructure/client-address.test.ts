import { describe, expect, it } from 'vitest'
import {
  authClientAddressHeaders,
  authTrustedProxyCidrs,
  resolveForwardedClientAddress,
  resolveRequestClientAddress,
} from './client-address'

describe('trusted authentication client address', () => {
  it('declares only the same-host loopback proxy contract', () => {
    expect(authClientAddressHeaders).toEqual(['x-forwarded-for'])
    expect(authTrustedProxyCidrs).toEqual(['127.0.0.1/32', '::1/128'])
  })

  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['203.0.113.9, 127.0.0.1', '203.0.113.9'],
    ['203.0.113.9, ::1', '203.0.113.9'],
    ['198.51.100.4, 203.0.113.9, 127.0.0.1', '203.0.113.9'],
    ['2001:db8::42, ::1', '2001:db8::42'],
    ['127.0.0.1', '127.0.0.1'],
  ])('resolves %s to %s', (chain, expected) => {
    expect(resolveForwardedClientAddress(chain)).toBe(expected)
  })

  it.each([
    null,
    '',
    'not-an-ip',
    '203.0.113.9, not-an-ip, 127.0.0.1',
    '203.0.113.9,,127.0.0.1',
  ])('rejects an untrustworthy chain %s', (chain) => {
    expect(resolveForwardedClientAddress(chain)).toBeNull()
  })

  it('reads only the documented forwarded header', () => {
    expect(
      resolveRequestClientAddress(
        new Headers({
          'x-real-ip': '198.51.100.8',
          'x-forwarded-for': '203.0.113.9, 127.0.0.1',
        }),
      ),
    ).toBe('203.0.113.9')
  })
})
