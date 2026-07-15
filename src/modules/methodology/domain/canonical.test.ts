import { describe, expect, it } from 'vitest'
import {
  canonicalSha256,
  canonicalStringify,
  NonCanonicalValueError,
  sha256,
} from './canonical'

describe('canonical JSON and SHA-256', () => {
  it('matches published SHA-256 vectors without a platform import', () => {
    expect(sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
    expect(sha256('🏋️ café')).toBe(
      'a4a724bd18290cd824ae2d5f2afa52e48d659f31e5c18d1160af8879af07bc1d',
    )
    expect(sha256('a'.repeat(100_000))).toBe(
      '6d1cf22d7cc09b085dfc25ee1a1f3ae0265804c607bc2074ad253bcc82fd81ee',
    )
  })

  it('sorts object keys recursively while retaining array order', () => {
    expect(
      canonicalStringify({
        z: 1,
        nested: { y: true, a: null },
        array: [{ b: 2, a: 1 }, 'last'],
      }),
    ).toBe('{"array":[{"a":1,"b":2},"last"],"nested":{"a":null,"y":true},"z":1}')
  })

  it('gives equivalent objects the same hash independent of insertion order', () => {
    const left = canonicalSha256({ alpha: 1, beta: { x: 2, y: 3 } })
    const right = canonicalSha256({ beta: { y: 3, x: 2 }, alpha: 1 })

    expect(left).toBe(right)
  })

  it('rejects values JSON cannot represent truthfully', () => {
    expect(() => canonicalStringify(Number.NaN)).toThrow(NonCanonicalValueError)
    expect(() => canonicalStringify(Number.POSITIVE_INFINITY)).toThrow(
      NonCanonicalValueError,
    )
  })
})
