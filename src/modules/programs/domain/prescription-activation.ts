export type PersistedSetForActivation = {
  readonly ordinal: number
  readonly setKind: string
  readonly targetLoadGrams: number
  readonly targetRepetitions: number
  readonly restSeconds: number
}

export type PersistedExerciseForActivation = {
  readonly exerciseCode: string
  readonly exerciseName: string
  readonly ordinal: number
  readonly safetyTier: string
  readonly rationaleCode: string
  readonly sets: readonly PersistedSetForActivation[]
}

export type PersistedWorkoutForActivation = {
  readonly scheduledDate: string
  readonly ordinal: number
  readonly slotCode: string
  readonly name: string
  readonly exercises: readonly PersistedExerciseForActivation[]
}

export type PrescriptionActivationResult =
  | { readonly eligible: true }
  | {
      readonly eligible: false
      readonly code:
        | 'program.prescription-invalid'
        | 'program.exercise-unverified'
        | 'safety.advanced-ineligible'
        | 'safety.prescription-prohibited'
        | 'equipment.missing'
      readonly message: string
    }

function invalid(
  code: Exclude<PrescriptionActivationResult, { eligible: true }>['code'],
  message: string,
): PrescriptionActivationResult {
  return { eligible: false, code, message }
}

function hasContiguousOrdinals(rows: readonly { readonly ordinal: number }[]): boolean {
  return rows.every((row, index) => row.ordinal === index + 1)
}

export function validatePersistedPrescriptionForActivation(input: {
  readonly workouts: readonly PersistedWorkoutForActivation[]
  readonly availableEquipment: readonly string[]
  readonly requiredEquipmentByExercise: Readonly<
    Record<string, readonly string[] | undefined>
  >
}): PrescriptionActivationResult {
  if (input.workouts.length === 0 || !hasContiguousOrdinals(input.workouts)) {
    return invalid(
      'program.prescription-invalid',
      'A program needs a nonempty, contiguously ordered workout schedule.',
    )
  }

  const availableEquipment = new Set(input.availableEquipment)

  for (const workout of input.workouts) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(workout.scheduledDate) ||
      !workout.name.trim() ||
      !['A', 'B', 'C'].includes(workout.slotCode) ||
      workout.exercises.length === 0 ||
      !hasContiguousOrdinals(workout.exercises)
    ) {
      return invalid(
        'program.prescription-invalid',
        'Every workout needs a date, name, supported slot, and ordered exercises.',
      )
    }

    const exerciseCodes = new Set<string>()
    for (const exercise of workout.exercises) {
      if (exercise.safetyTier === 'prohibited') {
        return invalid(
          'safety.prescription-prohibited',
          'A prohibited exercise cannot enter an active program.',
        )
      }
      if (exercise.safetyTier !== 'standard') {
        return invalid(
          'safety.advanced-ineligible',
          'No approved advanced-technique eligibility rule is installed.',
        )
      }
      if (
        !exercise.exerciseCode.trim() ||
        !exercise.exerciseName.trim() ||
        !exercise.rationaleCode.trim() ||
        exerciseCodes.has(exercise.exerciseCode) ||
        exercise.sets.length === 0 ||
        !hasContiguousOrdinals(exercise.sets)
      ) {
        return invalid(
          'program.prescription-invalid',
          'Every exercise needs unique identity, explanation, and ordered sets.',
        )
      }
      exerciseCodes.add(exercise.exerciseCode)

      const requiredEquipment = input.requiredEquipmentByExercise[exercise.exerciseCode]
      if (!requiredEquipment) {
        return invalid(
          'program.exercise-unverified',
          'The exercise has no installed activation or equipment contract.',
        )
      }
      const missingEquipment = requiredEquipment.filter(
        (equipment) => !availableEquipment.has(equipment),
      )
      if (missingEquipment.length > 0) {
        return invalid(
          'equipment.missing',
          `The prescription requires unavailable equipment: ${missingEquipment.join(', ')}.`,
        )
      }

      for (const set of exercise.sets) {
        if (
          !Number.isInteger(set.ordinal) ||
          !['warmup', 'working'].includes(set.setKind) ||
          !Number.isInteger(set.targetLoadGrams) ||
          set.targetLoadGrams < 0 ||
          set.targetLoadGrams > 1_000_000 ||
          !Number.isInteger(set.targetRepetitions) ||
          set.targetRepetitions < 1 ||
          set.targetRepetitions > 100 ||
          !Number.isInteger(set.restSeconds) ||
          set.restSeconds < 0 ||
          set.restSeconds > 900
        ) {
          return invalid(
            'program.prescription-invalid',
            'A set is outside the persisted load, repetition, rest, or kind bounds.',
          )
        }
      }
    }
  }

  return { eligible: true }
}
