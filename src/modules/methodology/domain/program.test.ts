import { describe, expect, it } from 'vitest'
import { MAX_CANONICAL_LOAD_GRAMS } from '@/modules/exercises/domain/load'
import { DEVELOPMENT_EXERCISE_IDS } from './development-fixture'
import {
  evaluateContentActivation,
  generateDevelopmentProgram,
  InvalidProgramInputError,
  type ProgramGenerationInput,
} from './program'

function validInput(): ProgramGenerationInput {
  return {
    asOfDate: '2026-07-07',
    trainingWeekdays: [1, 3, 5],
    startingLoads: DEVELOPMENT_EXERCISE_IDS.map((exerciseId, index) => ({
      exerciseId,
      loadGrams: (index + 1) * 10_000,
    })),
    safety: {
      isAdult: true,
      familiarWithResistanceTraining: true,
      hasCurrentPain: false,
      hasContraindication: false,
      hasProfessionalRestriction: false,
    },
  }
}

describe('development program generation', () => {
  it('creates an explicit two-cycle A/B/C schedule from athlete-local inputs', () => {
    const result = generateDevelopmentProgram(validInput(), 'development')

    expect(result.status).toBe('created')
    if (result.status !== 'created') return

    expect(
      result.prescription.output.plannedWorkouts.map((workout) => [
        workout.sessionKey,
        workout.localDate,
      ]),
    ).toEqual([
      ['A', '2026-07-08'],
      ['B', '2026-07-10'],
      ['C', '2026-07-13'],
      ['A', '2026-07-15'],
      ['B', '2026-07-17'],
      ['C', '2026-07-20'],
    ])
    expect(result.prescription.output.developmentOnly).toBe(true)
    expect(result.prescription.manualReview).toEqual({
      required: true,
      reasonCodes: ['development.not-human-reviewed'],
    })
    expect(result.prescription.output.notice).toContain('UNREVIEWED DEVELOPMENT FIXTURE')
  })

  it('normalizes unordered inputs into identical outputs and hashes', () => {
    const ordered = generateDevelopmentProgram(validInput(), 'development')
    const reversedInput = validInput()
    const reversed = generateDevelopmentProgram(
      {
        ...reversedInput,
        trainingWeekdays: [5, 1, 3],
        startingLoads: [...reversedInput.startingLoads].reverse(),
      },
      'development',
    )

    expect(ordered.status).toBe('created')
    expect(reversed.status).toBe('created')
    if (ordered.status !== 'created' || reversed.status !== 'created') return

    expect(ordered.normalizedInput).toEqual(reversed.normalizedInput)
    expect(ordered.prescription.normalizedInputHash).toEqual(
      reversed.prescription.normalizedInputHash,
    )
    expect(ordered.prescription.outputHash).toEqual(reversed.prescription.outputHash)
    expect(ordered.prescription.output).toEqual(reversed.prescription.output)
  })

  it('forbids the unreviewed fixture in production', () => {
    const result = generateDevelopmentProgram(validInput(), 'production')

    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') return

    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      'content.development-forbidden-in-production',
    )
  })

  it('puts safety blocks ahead of content activation blocks', () => {
    const input = validInput()
    const result = generateDevelopmentProgram(
      {
        ...input,
        safety: { ...input.safety, hasCurrentPain: true },
      },
      'production',
    )

    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') return

    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      'safety.current-pain',
      'content.development-forbidden-in-production',
    ])
  })

  it('blocks missing safety facts instead of substituting permissive defaults', () => {
    const input = validInput()
    const result = generateDevelopmentProgram(
      {
        ...input,
        safety: { ...input.safety, hasContraindication: null },
      },
      'development',
    )

    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') return

    expect(result.blockers).toEqual([
      {
        category: 'safety',
        code: 'safety.missing-answer',
        summary: 'Safety answers are unavailable for: hasContraindication.',
      },
    ])
  })

  it('requires exactly three distinct weekdays and every explicit starting load', () => {
    const input = validInput()

    expect(() =>
      generateDevelopmentProgram(
        { ...input, trainingWeekdays: [1, 1, 5] },
        'development',
      ),
    ).toThrow(InvalidProgramInputError)
    expect(() =>
      generateDevelopmentProgram(
        { ...input, startingLoads: input.startingLoads.slice(1) },
        'development',
      ),
    ).toThrow(/Missing explicit starting loads/)
  })

  it('enforces the shared canonical integer-gram bounds at generator input', () => {
    const input = validInput()
    const withFirstLoad = (loadGrams: number): ProgramGenerationInput => ({
      ...input,
      startingLoads: input.startingLoads.map((entry, index) =>
        index === 0 ? { ...entry, loadGrams } : entry,
      ),
    })

    expect(() =>
      generateDevelopmentProgram(
        withFirstLoad(MAX_CANONICAL_LOAD_GRAMS + 1),
        'development',
      ),
    ).toThrow(InvalidProgramInputError)
    expect(
      generateDevelopmentProgram(withFirstLoad(MAX_CANONICAL_LOAD_GRAMS), 'development')
        .status,
    ).toBe('created')
  })
})

describe('content activation eligibility', () => {
  it('allows draft development content only in development with manual review', () => {
    expect(
      evaluateContentActivation({
        environment: 'development',
        contentMode: 'development',
        methodologyStatus: 'draft',
        templateStatus: 'draft',
      }),
    ).toEqual({ eligible: true, manualReviewRequired: true, blockers: [] })
  })

  it('requires both reviewed statuses for reviewed content', () => {
    const eligibility = evaluateContentActivation({
      environment: 'production',
      contentMode: 'reviewed',
      methodologyStatus: 'reviewed',
      templateStatus: 'draft',
    })

    expect(eligibility.eligible).toBe(false)
    expect(eligibility.blockers.map((blocker) => blocker.code)).toEqual([
      'content.release-not-reviewed',
    ])
  })

  it('never activates retired content', () => {
    const eligibility = evaluateContentActivation({
      environment: 'development',
      contentMode: 'reviewed',
      methodologyStatus: 'retired',
      templateStatus: 'reviewed',
    })

    expect(eligibility.eligible).toBe(false)
    expect(eligibility.blockers[0]?.code).toBe('content.retired')
  })
})
