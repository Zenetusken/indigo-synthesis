import { describe, expect, it } from 'vitest'
import { newUuidV7 } from './uuid-v7'

describe('UUIDv7 IDs', () => {
  it('emits an RFC 9562 version 7 UUID with the variant bits set', () => {
    expect(newUuidV7(1_700_000_000_000, new Uint8Array(10))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('sorts IDs from distinct milliseconds chronologically', () => {
    const entropy = new Uint8Array(10)
    const earlier = newUuidV7(1_700_000_000_000, entropy)
    const later = newUuidV7(1_700_000_000_001, entropy)

    expect(earlier < later).toBe(true)
  })

  it('rejects invalid entropy and timestamps', () => {
    expect(() => newUuidV7(-1)).toThrow(RangeError)
    expect(() => newUuidV7(Date.now(), new Uint8Array(9))).toThrow(RangeError)
  })
})
