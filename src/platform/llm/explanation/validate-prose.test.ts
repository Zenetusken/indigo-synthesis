import { describe, expect, it } from 'vitest'
import type { ExplanationFactBundle } from './fact-bundle'
import { validateExplanationProse } from './validate-prose'

function sampleBundle(
  overrides: Partial<ExplanationFactBundle> = {},
): ExplanationFactBundle {
  const base: ExplanationFactBundle = {
    contractVersion: '1',
    bundleKind: 'future-load-decision',
    locale: 'en',
    contentMode: 'development',
    subject: { units: 'metric' },
    decision: {
      decisionId: 'dec-1',
      sessionId: 'ses-1',
      exerciseCode: 'back-squat',
      kind: 'increase',
      currentLoadGrams: 100_000,
      proposedLoadGrams: 102_500,
      invalidated: false,
      invalidationReason: null,
      setFacts: [
        {
          ordinal: 1,
          status: 'performed',
          loadGrams: 100_000,
          repetitions: 5,
          rpe: 7,
          explicitlyConfirmed: true,
          skipReason: null,
        },
      ],
      painReported: false,
    },
    grounding: {
      reasonCode: 'development.adjustment.increase',
      ruleId: 'development-adjustment',
      ruleVersion: '0.0.1-development',
      engineVersion: '0.1.0-development',
      methodologyId: 'development',
      methodologyVersion: '0.0.1-development',
    },
    display: {
      currentLoadLabel: '100 kg',
      proposedLoadLabel: '102.5 kg',
      exerciseName: 'Back squat',
    },
    constraints: {
      mustMentionReasonCode: true,
      mustMentionRuleVersion: true,
      mustUseDisplayLoadLabelsOnly: true,
      mustNotInventNumbers: true,
      mustNotDiagnose: true,
      mustNotAdviseIgnoringPainOrHolds: true,
      developmentFixtureNoticeRequired: true,
      maxOutputTokens: 256,
    },
  }

  return {
    ...base,
    ...overrides,
    decision: { ...base.decision, ...overrides.decision },
    grounding: { ...base.grounding, ...overrides.grounding },
    display: { ...base.display, ...overrides.display },
    constraints: { ...base.constraints, ...overrides.constraints },
  }
}

const validProse = [
  'Back squat working load moves from 100 kg to 102.5 kg because all sets met the target',
  'at acceptable RPE (reason development.adjustment.increase, rule 0.0.1-development).',
  'This is an unreviewed development fixture, not human-reviewed coaching guidance.',
].join(' ')

describe('validateExplanationProse', () => {
  it('accepts grounded increase prose', () => {
    expect(validateExplanationProse(validProse, sampleBundle())).toEqual({ ok: true })
  })

  it('rejects missing reason code', () => {
    const result = validateExplanationProse(
      'Load goes from 100 kg to 102.5 kg under rule 0.0.1-development. unreviewed development fixture',
      sampleBundle(),
    )
    expect(result.ok).toBe(false)
  })

  it('rejects invented load numbers', () => {
    const result = validateExplanationProse(
      `${validProse} Maybe try 110 kg next time.`,
      sampleBundle(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.detail).toMatch(/110/)
    }
  })

  it('rejects diagnostic language', () => {
    const result = validateExplanationProse(
      `${validProse} This may indicate an injury.`,
      sampleBundle(),
    )
    expect(result.ok).toBe(false)
  })

  it('rejects prose for invalidated decisions', () => {
    const result = validateExplanationProse(
      validProse,
      sampleBundle({
        decision: {
          ...sampleBundle().decision,
          invalidated: true,
          invalidationReason: 'post-completion correction',
        },
      }),
    )
    expect(result.ok).toBe(false)
  })
})
