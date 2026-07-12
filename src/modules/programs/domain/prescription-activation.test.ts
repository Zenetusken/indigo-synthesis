import { describe, expect, it } from 'vitest'
import { validatePersistedPrescriptionForActivation } from './prescription-activation'

const validWorkout = {
  scheduledDate: '2026-07-11',
  ordinal: 1,
  slotCode: 'A',
  name: 'Development session A',
  exercises: [
    {
      exerciseCode: 'development.back-squat',
      exerciseName: 'Back squat',
      ordinal: 1,
      safetyTier: 'standard',
      rationaleCode: 'development.fixture',
      sets: [
        {
          ordinal: 1,
          setKind: 'working',
          targetLoadGrams: 50_000,
          targetRepetitions: 5,
          restSeconds: 120,
        },
      ],
    },
  ],
} as const

const requiredEquipment = {
  'development.back-squat': ['barbell', 'rack', 'plates'],
} as const

function validate(
  workouts: readonly (typeof validWorkout)[],
  availableEquipment = ['barbell', 'rack', 'plates'],
) {
  return validatePersistedPrescriptionForActivation({
    workouts,
    availableEquipment,
    requiredEquipmentByExercise: requiredEquipment,
  })
}

describe('persisted prescription activation', () => {
  it('accepts a complete standard prescription with confirmed equipment', () => {
    expect(validate([validWorkout])).toEqual({ eligible: true })
  })

  it('rejects an empty or structurally incomplete program', () => {
    expect(validate([])).toMatchObject({
      eligible: false,
      code: 'program.prescription-invalid',
    })
    expect(
      validate([{ ...validWorkout, exercises: [] } as unknown as typeof validWorkout]),
    ).toMatchObject({
      eligible: false,
      code: 'program.prescription-invalid',
    })
  })

  it.each([
    ['advanced', 'safety.advanced-ineligible'],
    ['prohibited', 'safety.prescription-prohibited'],
  ] as const)('rejects a %s safety tier', (safetyTier, code) => {
    const workout = {
      ...validWorkout,
      exercises: [{ ...validWorkout.exercises[0], safetyTier }],
    } as unknown as typeof validWorkout
    expect(validate([workout])).toMatchObject({ eligible: false, code })
  })

  it('rejects exercises without an installed contract or required equipment', () => {
    const unknownExercise = {
      ...validWorkout,
      exercises: [{ ...validWorkout.exercises[0], exerciseCode: 'unknown.exercise' }],
    } as unknown as typeof validWorkout
    expect(validate([unknownExercise])).toMatchObject({
      eligible: false,
      code: 'program.exercise-unverified',
    })
    expect(validate([validWorkout], ['barbell', 'plates'])).toMatchObject({
      eligible: false,
      code: 'equipment.missing',
    })
  })

  it('rejects noncontiguous ordinals and set values outside persisted bounds', () => {
    const noncontiguous = {
      ...validWorkout,
      exercises: [{ ...validWorkout.exercises[0], ordinal: 2 }],
    } as unknown as typeof validWorkout
    const outOfBounds = {
      ...validWorkout,
      exercises: [
        {
          ...validWorkout.exercises[0],
          sets: [{ ...validWorkout.exercises[0].sets[0], restSeconds: 901 }],
        },
      ],
    } as unknown as typeof validWorkout

    expect(validate([noncontiguous])).toMatchObject({
      eligible: false,
      code: 'program.prescription-invalid',
    })
    expect(validate([outOfBounds])).toMatchObject({
      eligible: false,
      code: 'program.prescription-invalid',
    })
  })
})
