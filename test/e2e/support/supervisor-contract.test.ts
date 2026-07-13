import { describe, expect, it } from 'vitest'
import { resolveE2ePort } from './supervisor-contract'

describe('resolveE2ePort', () => {
  it('uses the committed default only when no override exists', () => {
    expect(resolveE2ePort('TEST_PORT', undefined, 3100)).toBe(3100)
    expect(resolveE2ePort('TEST_PORT', '3200', 3100)).toBe(3200)
  })

  it.each([
    '',
    '3100.5',
    ' 3100',
    'port',
    '1023',
    '65536',
  ])('rejects the unsafe override %j', (value) => {
    expect(() => resolveE2ePort('TEST_PORT', value, 3100)).toThrow(/TEST_PORT/)
  })
})
