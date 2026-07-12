import { describe, expect, it } from 'vitest'
import { evaluateSubstitution } from './substitution'

describe('substitution safety default', () => {
  it('denies an unreviewed replacement without inventing equivalence', () => {
    expect(
      evaluateSubstitution('development.back-squat', 'unreviewed.leg-press'),
    ).toEqual({
      allowed: false,
      code: 'substitution.unapproved',
      reason: 'No reviewed, equipment-compatible substitution release is installed.',
    })
  })
})
