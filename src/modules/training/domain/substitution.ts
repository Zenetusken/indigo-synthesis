export type SubstitutionDecision =
  | {
      readonly allowed: true
      readonly replacementExerciseCode: string
      readonly ruleVersion: string
    }
  | {
      readonly allowed: false
      readonly code: 'substitution.unapproved'
      readonly reason: string
    }

/**
 * No substitution is published until a human-reviewed, rights-cleared, equipment-aware
 * catalog exists. Unknown input is denied instead of being treated as equivalent.
 */
export function evaluateSubstitution(
  _originalExerciseCode: string,
  _requestedExerciseCode: string,
): SubstitutionDecision {
  return {
    allowed: false,
    code: 'substitution.unapproved',
    reason: 'No reviewed, equipment-compatible substitution release is installed.',
  }
}
