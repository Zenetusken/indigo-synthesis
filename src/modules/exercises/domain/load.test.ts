import { describe, expect, it } from 'vitest'
import {
  isCanonicalLoadGrams,
  MAX_CANONICAL_LOAD_GRAMS,
  MIN_CANONICAL_LOAD_GRAMS,
} from './load'

describe('canonical integer-gram load bounds', () => {
  it('accepts both inclusive boundaries', () => {
    expect(isCanonicalLoadGrams(MIN_CANONICAL_LOAD_GRAMS)).toBe(true)
    expect(isCanonicalLoadGrams(MAX_CANONICAL_LOAD_GRAMS)).toBe(true)
  })

  it.each([
    -1,
    0.5,
    MAX_CANONICAL_LOAD_GRAMS + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects non-canonical load %s', (loadGrams) => {
    expect(isCanonicalLoadGrams(loadGrams)).toBe(false)
  })
})
