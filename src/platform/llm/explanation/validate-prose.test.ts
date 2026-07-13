import { describe, expect, it } from 'vitest'
import { canonicalFutureLoadExplanation } from './canonical-prose'
import type { ExplanationFactBundle } from './fact-bundle'
import { EXPLANATION_VALIDATOR_VERSION, validateExplanationProse } from './validate-prose'

function sampleBundle(
  overrides: Partial<ExplanationFactBundle> = {},
): ExplanationFactBundle {
  const base: ExplanationFactBundle = {
    contractVersion: '2',
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
  'Back squat future load moves from 100 kg to 102.5 kg because performed sets met the target',
  'at acceptable effort (reason development.adjustment.increase, rule 0.0.1-development).',
  'This is an unreviewed development fixture, not human-reviewed coaching guidance.',
].join(' ')

describe('validateExplanationProse', () => {
  it('pins the fail-closed validator version', () => {
    expect(EXPLANATION_VALIDATOR_VERSION).toBe('future-load-validator.v4')
  })

  it('accepts grounded increase prose', () => {
    expect(validateExplanationProse(validProse, sampleBundle())).toEqual({ ok: true })
  })

  it.each([
    'Push Press',
    '5x5 Squat',
    'One-Arm Row',
    '45-degree leg press',
    'Half-kneeling landmine press',
    'Quarter squat',
    'Double-overhand deadlift',
    '25 kg Plate Carry',
    '100 lb Dumbbell Row',
    'Exercise Bike',
    'Push/Pull Sled',
    'Pull/Push Sled',
    'Lift/Carry Complex',
  ])('accepts exact canonical prose for the legitimate name %s', (exerciseName) => {
    const bundle = sampleBundle({
      display: { ...sampleBundle().display, exerciseName },
    })
    const prose = canonicalFutureLoadExplanation(bundle)
    expect(prose).not.toBeNull()
    expect(validateExplanationProse(prose ?? '', bundle)).toEqual({ ok: true })
  })

  it('does not combine an action word in the exercise name with pain-block prose', () => {
    const bundle = sampleBundle({
      decision: {
        ...sampleBundle().decision,
        kind: 'blocked',
        currentLoadGrams: 100_000,
        proposedLoadGrams: 100_000,
        painReported: true,
      },
      grounding: {
        ...sampleBundle().grounding,
        reasonCode: 'development.adjustment.pain-block',
      },
      display: {
        currentLoadLabel: '100 kg',
        proposedLoadLabel: '100 kg',
        exerciseName: 'Olympic Lift',
      },
    })
    const prose = canonicalFutureLoadExplanation(bundle)
    expect(prose).not.toBeNull()
    expect(validateExplanationProse(prose ?? '', bundle)).toEqual({ ok: true })
  })

  it.each([
    'You should continue training through pain',
    'Injury diagnosis drill',
    'Push through pain',
    'Please continue training',
    'Squat. Continue training',
    'Lift now',
    'Push carefully',
    'Lift safely',
    'Push yourself',
    'Push hard',
    'Squat: Continue training',
    'Squat — Continue training',
    'Squat\nContinue training',
    'Squat; Continue training',
    'Squat / Continue training',
    'Squat: Proceed with training',
  ])('rejects unsafe language embedded in the exercise name: %s', (exerciseName) => {
    const bundle = sampleBundle({
      display: { ...sampleBundle().display, exerciseName },
    })
    const prose = canonicalFutureLoadExplanation(bundle)
    expect(prose).not.toBeNull()
    expect(validateExplanationProse(prose ?? '', bundle).ok).toBe(false)
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

  it.each([
    ['a repetition count reinterpreted as load', 'The additional load is 5 kg.'],
    ['raw grams reinterpreted as display load', 'The displayed load is 100000 kg.'],
    ['a set fact number outside its field', 'Reported RPE was 7.'],
    ['a non-exact unit alias', 'The current load is 100 kilograms.'],
    ['full-width invented digits', 'The additional load is ５ kg.'],
    ['a spelled-out invented load', 'The additional load is five kg.'],
  ])('rejects %s', (_label, unsafeSuffix) => {
    const result = validateExplanationProse(
      `${validProse} ${unsafeSuffix}`,
      sampleBundle(),
    )
    expect(result.ok).toBe(false)
  })

  it.each([
    'You should continue training even if you feel sharp pain.',
    'Continue training even if discomfort remains.',
    'It is okay to resume lifting through a safety hold.',
    'The trainee can increase the load next time.',
    'Keep lifting even with sharp pain.',
    'It is best to continue training.',
  ])('rejects forward advice: %s', (unsafeSuffix) => {
    const result = validateExplanationProse(
      `${validProse} ${unsafeSuffix}`,
      sampleBundle(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toMatch(/advice|safety/i)
  })

  it('accepts exact localized display labels and rejects nearby alternatives', () => {
    const bundle = sampleBundle({
      subject: { units: 'imperial' },
      display: {
        currentLoadLabel: '1,000 lb',
        proposedLoadLabel: '1,005.5 lb',
        exerciseName: 'Back squat',
      },
    })
    const prose = [
      'Back squat future load moves from 1,000 lb to 1,005.5 lb because performed sets met the target',
      'at acceptable effort (reason development.adjustment.increase, rule 0.0.1-development).',
      'This is an unreviewed development fixture, not human-reviewed coaching guidance.',
    ].join(' ')

    expect(validateExplanationProse(prose, bundle)).toEqual({ ok: true })
    expect(validateExplanationProse(`${prose} The load is 1,005 lb.`, bundle).ok).toBe(
      false,
    )
  })

  it('rejects diagnostic language', () => {
    const result = validateExplanationProse(
      `${validProse} This may indicate an injury.`,
      sampleBundle(),
    )
    expect(result.ok).toBe(false)
  })

  it.each([
    'This confirms tendonitis.',
    'This reflects arthritis.',
    'This means the shoulder is impinged.',
  ])('rejects an appended medical claim outside the closed template: %s', (suffix) => {
    expect(validateExplanationProse(`${validProse} ${suffix}`, sampleBundle()).ok).toBe(
      false,
    )
  })

  it('rejects a notice that reverses the required development disclosure', () => {
    const reversed = validProse.replace(
      'This is an unreviewed development fixture, not human-reviewed coaching guidance.',
      'This is not an unreviewed development fixture; it is human-reviewed coaching guidance.',
    )

    expect(validateExplanationProse(reversed, sampleBundle()).ok).toBe(false)
  })

  it('requires byte-for-byte template text rather than compatibility lookalikes', () => {
    expect(
      validateExplanationProse(
        validProse.replace('Back squat', 'Ｂack squat'),
        sampleBundle(),
      ).ok,
    ).toBe(false)
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
