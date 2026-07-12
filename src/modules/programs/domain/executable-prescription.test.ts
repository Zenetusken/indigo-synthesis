import { describe, expect, it } from 'vitest'
import type { CanonicalValue } from '@/modules/methodology/domain/canonical'
import {
  EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
  type ExecutablePrescriptionProjection,
  type ExecutablePrescriptionProjectionV1,
  executablePrescriptionHash,
  executablePrescriptionHashMaterialVersion,
  LEGACY_EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
  type SupportedExecutablePrescriptionProjection,
  verifyExecutablePrescriptionIntegrity,
} from './executable-prescription'

const normalizedInput = {
  asOfDate: '2026-07-11',
  startingLoads: [{ exerciseId: 'development.back-squat', loadGrams: 50_000 }],
} satisfies CanonicalValue

function projection(): ExecutablePrescriptionProjection {
  return {
    hashMaterialVersion: 'executable-prescription-v2',
    engineVersion: '0.1.0-development',
    methodology: {
      id: 'development.methodology-fixture',
      version: '0.0.1-development',
      reviewStatus: 'development',
    },
    template: {
      id: 'development.full-body-three-day',
      version: '0.0.1-development',
      reviewStatus: 'development',
    },
    normalizedInputHash:
      'bd3a6f2b8d0c1d456bdec0b4d3839c06d3dfbeefa806ff98eeac40439e4647d5',
    workouts: [
      {
        scheduledDate: '2026-07-11',
        ordinal: 1,
        programOrdinal: 1,
        slotCode: 'A',
        name: 'Session A — development fixture',
        exercises: [
          {
            exerciseCode: 'development.back-squat',
            exerciseName: 'Back squat — development fixture',
            ordinal: 1,
            safetyTier: 'standard',
            rationaleCode: 'development.fixture-instantiation',
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
      },
    ],
  }
}

function projectionV1(): ExecutablePrescriptionProjectionV1 {
  const current = projection()
  return {
    hashMaterialVersion: LEGACY_EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
    engineVersion: current.engineVersion,
    methodology: current.methodology,
    template: current.template,
    normalizedInputHash: current.normalizedInputHash,
    workouts: current.workouts.map((workout) => ({
      scheduledDate: workout.scheduledDate,
      ordinal: workout.ordinal,
      slotCode: workout.slotCode,
      name: workout.name,
      exercises: workout.exercises,
    })),
  }
}

function verifiedInput(persistedProjection = projection()) {
  const expected = projection()
  return {
    normalizedInput,
    storedNormalizedInputHash: expected.normalizedInputHash,
    storedOutputSnapshot: expected as unknown as CanonicalValue,
    storedOutputHash: executablePrescriptionHash(expected),
    persistedProjection,
  }
}

function verifiedV1Input(
  persistedProjection: SupportedExecutablePrescriptionProjection = projectionV1(),
) {
  const expected = projectionV1()
  return {
    normalizedInput,
    storedNormalizedInputHash: expected.normalizedInputHash,
    storedOutputSnapshot: expected as unknown as CanonicalValue,
    storedOutputHash: executablePrescriptionHash(expected),
    persistedProjection,
  }
}

function changeFirstWorkout(
  value: ExecutablePrescriptionProjection,
  change: (
    workout: ExecutablePrescriptionProjection['workouts'][number],
  ) => ExecutablePrescriptionProjection['workouts'][number],
): ExecutablePrescriptionProjection {
  const [workout, ...remaining] = value.workouts
  if (!workout) throw new Error('Test projection has no workout.')
  return { ...value, workouts: [change(workout), ...remaining] }
}

function changeFirstExercise(
  value: ExecutablePrescriptionProjection,
  change: (
    exercise: ExecutablePrescriptionProjection['workouts'][number]['exercises'][number],
  ) => ExecutablePrescriptionProjection['workouts'][number]['exercises'][number],
): ExecutablePrescriptionProjection {
  return changeFirstWorkout(value, (workout) => {
    const [exercise, ...remaining] = workout.exercises
    if (!exercise) throw new Error('Test projection has no exercise.')
    return { ...workout, exercises: [change(exercise), ...remaining] }
  })
}

function changeFirstSet(
  value: ExecutablePrescriptionProjection,
  change: (
    set: ExecutablePrescriptionProjection['workouts'][number]['exercises'][number]['sets'][number],
  ) => ExecutablePrescriptionProjection['workouts'][number]['exercises'][number]['sets'][number],
): ExecutablePrescriptionProjection {
  return changeFirstExercise(value, (exercise) => {
    const [set, ...remaining] = exercise.sets
    if (!set) throw new Error('Test projection has no set.')
    return { ...exercise, sets: [change(set), ...remaining] }
  })
}

describe('canonical executable prescription', () => {
  it('has a fixed development-only vector', () => {
    expect(executablePrescriptionHash(projection())).toBe(
      'f846b3b1fe4aa9dd54e7f635b0e64cbb3dd193cfb383f0deaed89b5a0b348981',
    )
  })

  it('retains the fixed historical v1 hash vector', () => {
    expect(executablePrescriptionHash(projectionV1())).toBe(
      '54cfd5100dbb5f9a6dc46fdbb6637147ce2731647a10f3ff55183aac5e19a8ed',
    )
  })

  it('accepts an exact normalized input, snapshot, projection, and hash', () => {
    expect(verifyExecutablePrescriptionIntegrity(verifiedInput())).toEqual({
      valid: true,
    })
  })

  it('accepts the exact typed historical v1 projection and hash', () => {
    expect(verifyExecutablePrescriptionIntegrity(verifiedV1Input())).toEqual({
      valid: true,
    })
  })

  it.each([
    ['null', null],
    ['array', []],
    ['missing version', {}],
    ['unknown version', { hashMaterialVersion: 'executable-prescription-v3' }],
  ] as const)('rejects a %s persisted hash-material discriminator', (_case, value) => {
    expect(executablePrescriptionHashMaterialVersion(value)).toBeNull()
  })

  it('recognizes only the two supported persisted hash-material versions', () => {
    expect(
      executablePrescriptionHashMaterialVersion({
        hashMaterialVersion: LEGACY_EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
      }),
    ).toBe(LEGACY_EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION)
    expect(
      executablePrescriptionHashMaterialVersion({
        hashMaterialVersion: EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
      }),
    ).toBe(EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION)
  })

  it('rejects a v2-shaped snapshot retagged as v1', () => {
    const retaggedSnapshot = {
      ...projection(),
      hashMaterialVersion: LEGACY_EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
    } satisfies CanonicalValue

    expect(
      verifyExecutablePrescriptionIntegrity({
        ...verifiedV1Input(),
        storedOutputSnapshot: retaggedSnapshot,
      }),
    ).toEqual({ valid: false, reason: 'output-snapshot-mismatch' })
  })

  it('rejects a normalized-input hash that does not describe the saved input', () => {
    expect(
      verifyExecutablePrescriptionIntegrity({
        ...verifiedInput(),
        normalizedInput: { ...normalizedInput, asOfDate: '2026-07-12' },
      }),
    ).toEqual({ valid: false, reason: 'normalized-input-hash-mismatch' })
  })

  it.each([
    [
      'engine version',
      (value: ExecutablePrescriptionProjection) => ({
        ...value,
        engineVersion: 'tampered',
      }),
    ],
    [
      'methodology identity',
      (value: ExecutablePrescriptionProjection) => ({
        ...value,
        methodology: { ...value.methodology, id: 'tampered' },
      }),
    ],
    [
      'methodology version',
      (value: ExecutablePrescriptionProjection) => ({
        ...value,
        methodology: { ...value.methodology, version: 'tampered' },
      }),
    ],
    [
      'methodology review status',
      (value: ExecutablePrescriptionProjection) => ({
        ...value,
        methodology: { ...value.methodology, reviewStatus: 'reviewed' },
      }),
    ],
    [
      'template identity',
      (value: ExecutablePrescriptionProjection) => ({
        ...value,
        template: { ...value.template, id: 'tampered' },
      }),
    ],
    [
      'template version',
      (value: ExecutablePrescriptionProjection) => ({
        ...value,
        template: { ...value.template, version: 'tampered' },
      }),
    ],
    [
      'template review status',
      (value: ExecutablePrescriptionProjection) => ({
        ...value,
        template: { ...value.template, reviewStatus: 'reviewed' },
      }),
    ],
    [
      'normalized input hash projection',
      (value: ExecutablePrescriptionProjection) => ({
        ...value,
        normalizedInputHash: 'tampered',
      }),
    ],
    [
      'workout name',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstWorkout(value, (workout) => ({
          ...workout,
          name: 'Tampered workout',
        })),
    ],
    [
      'scheduled date',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstWorkout(value, (workout) => ({
          ...workout,
          scheduledDate: '2026-07-12',
        })),
    ],
    [
      'workout ordinal',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstWorkout(value, (workout) => ({ ...workout, ordinal: 2 })),
    ],
    [
      'absolute program ordinal',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstWorkout(value, (workout) => ({ ...workout, programOrdinal: 2 })),
    ],
    [
      'workout slot',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstWorkout(value, (workout) => ({ ...workout, slotCode: 'B' })),
    ],
    [
      'exercise identity',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstExercise(value, (exercise) => ({
          ...exercise,
          exerciseCode: 'tampered.exercise',
        })),
    ],
    [
      'exercise name',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstExercise(value, (exercise) => ({
          ...exercise,
          exerciseName: 'Tampered exercise',
        })),
    ],
    [
      'exercise ordinal',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstExercise(value, (exercise) => ({ ...exercise, ordinal: 2 })),
    ],
    [
      'safety tier',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstExercise(value, (exercise) => ({
          ...exercise,
          safetyTier: 'advanced',
        })),
    ],
    [
      'rationale code',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstExercise(value, (exercise) => ({
          ...exercise,
          rationaleCode: 'tampered.reason',
        })),
    ],
    [
      'set ordinal',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstSet(value, (set) => ({ ...set, ordinal: 2 })),
    ],
    [
      'set kind',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstSet(value, (set) => ({ ...set, setKind: 'warmup' })),
    ],
    [
      'target load',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstSet(value, (set) => ({ ...set, targetLoadGrams: 51_000 })),
    ],
    [
      'target repetitions',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstSet(value, (set) => ({ ...set, targetRepetitions: 6 })),
    ],
    [
      'rest',
      (value: ExecutablePrescriptionProjection) =>
        changeFirstSet(value, (set) => ({ ...set, restSeconds: 121 })),
    ],
  ] as const)('rejects independent %s tampering', (_label, tamper) => {
    expect(
      verifyExecutablePrescriptionIntegrity(verifiedInput(tamper(projection()))),
    ).toEqual({ valid: false, reason: 'output-snapshot-mismatch' })
  })

  it('rejects a snapshot whose hash is stale even when rows match it', () => {
    const changed = changeFirstSet(projection(), (set) => ({
      ...set,
      targetLoadGrams: 52_000,
    }))

    expect(
      verifyExecutablePrescriptionIntegrity({
        ...verifiedInput(changed),
        storedOutputSnapshot: changed as unknown as CanonicalValue,
      }),
    ).toEqual({ valid: false, reason: 'output-hash-mismatch' })
  })
})
