import { describe, expect, it } from 'vitest'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import {
  completeSetCommandSchema,
  completeWorkoutCommandSchema,
  reportPainCommandSchema,
  skipSetCommandSchema,
  startWorkoutCommandSchema,
} from './commands'

function validSetCommand() {
  return {
    sessionId: newUuidV7(),
    setId: newUuidV7(),
    commandId: newUuidV7(),
    actualLoadGrams: 50_000,
    actualRepetitions: 5,
    rpe: 8,
    note: null,
  }
}

describe('workout command schemas', () => {
  it.each([
    ['fractional repetitions', { actualRepetitions: 4.5 }],
    ['fractional RPE', { rpe: 7.5 }],
    ['fractional grams', { actualLoadGrams: 50_000.5 }],
    ['non-finite grams', { actualLoadGrams: Number.POSITIVE_INFINITY }],
    ['grams above the database bound', { actualLoadGrams: 1_000_001 }],
    ['too many repetitions', { actualRepetitions: 101 }],
    ['too much RPE', { rpe: 11 }],
    ['an overlong note', { note: 'n'.repeat(501) }],
  ])('rejects %s instead of normalizing it', (_name, override) => {
    expect(
      completeSetCommandSchema.safeParse({ ...validSetCommand(), ...override }).success,
    ).toBe(false)
  })

  it('rejects fractional form values after lossless numeric parsing', () => {
    const formData = new FormData()
    formData.set('actualRepetitions', '4.5')
    formData.set('rpe', '7.5')

    expect(
      completeSetCommandSchema.safeParse({
        ...validSetCommand(),
        actualRepetitions: Number(formData.get('actualRepetitions')),
        rpe: Number(formData.get('rpe')),
      }).success,
    ).toBe(false)
  })

  it('requires UUID record identifiers and a nonempty command identifier', () => {
    expect(
      startWorkoutCommandSchema.safeParse({
        plannedWorkoutId: 'not-a-record-id',
        commandId: newUuidV7(),
      }).success,
    ).toBe(false)
    expect(
      startWorkoutCommandSchema.safeParse({
        plannedWorkoutId: newUuidV7(),
        commandId: '   ',
      }).success,
    ).toBe(false)
  })

  it('enforces bounded skip and safety-report text', () => {
    expect(
      skipSetCommandSchema.safeParse({
        sessionId: newUuidV7(),
        setId: newUuidV7(),
        commandId: newUuidV7(),
        reason: '',
      }).success,
    ).toBe(false)
    expect(
      skipSetCommandSchema.safeParse({
        sessionId: newUuidV7(),
        setId: newUuidV7(),
        commandId: newUuidV7(),
        reason: 's'.repeat(301),
      }).success,
    ).toBe(false)
    expect(
      reportPainCommandSchema.safeParse({
        sessionId: newUuidV7(),
        details: 'p'.repeat(1_001),
      }).success,
    ).toBe(false)
  })

  it('does not coerce a completion attestation', () => {
    expect(
      completeWorkoutCommandSchema.safeParse({
        sessionId: newUuidV7(),
        commandId: newUuidV7(),
        noPainAttested: 'true',
      }).success,
    ).toBe(false)
  })
})
