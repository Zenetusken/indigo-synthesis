import { describe, expect, it } from 'vitest'
import { hasSufficientRoleConnectionAllowance } from './preflight'

describe('database preflight role connection allowance', () => {
  it.each([
    [-1, 6],
    [-1, 10],
    [-1, 64],
    [6, 6],
    [10, 10],
    [64, 64],
    ['6', 6],
  ])('accepts rolconnlimit %j for pool maximum %i', (limit, poolMaximum) => {
    expect(hasSufficientRoleConnectionAllowance(limit, poolMaximum)).toBe(true)
  })

  it.each([
    [5, 6],
    [9, 10],
    [63, 64],
    [0, 6],
    [-2, 6],
    [undefined, 6],
    [null, 10],
    ['', 10],
    ['unlimited', 64],
    [6.5, 6],
  ])('rejects rolconnlimit %j for pool maximum %i', (limit, poolMaximum) => {
    expect(hasSufficientRoleConnectionAllowance(limit, poolMaximum)).toBe(false)
  })
})
