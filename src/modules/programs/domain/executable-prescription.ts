import {
  type CanonicalValue,
  canonicalSha256,
  canonicalStringify,
} from '@/modules/methodology/domain/canonical'

export const EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION =
  'executable-prescription-v2' as const

export type ExecutableSetProjection = {
  readonly ordinal: number
  readonly setKind: string
  readonly targetLoadGrams: number
  readonly targetRepetitions: number
  readonly restSeconds: number
}

export type ExecutableExerciseProjection = {
  readonly exerciseCode: string
  readonly exerciseName: string
  readonly ordinal: number
  readonly safetyTier: string
  readonly rationaleCode: string
  readonly sets: readonly ExecutableSetProjection[]
}

export type ExecutableWorkoutProjection = {
  readonly scheduledDate: string
  readonly ordinal: number
  readonly programOrdinal: number
  readonly slotCode: string
  readonly name: string
  readonly exercises: readonly ExecutableExerciseProjection[]
}

export type ExecutablePrescriptionProjection = {
  readonly hashMaterialVersion: typeof EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION
  readonly engineVersion: string
  readonly methodology: {
    readonly id: string
    readonly version: string
    readonly reviewStatus: string
  }
  readonly template: {
    readonly id: string
    readonly version: string
    readonly reviewStatus: string
  }
  readonly normalizedInputHash: string
  readonly workouts: readonly ExecutableWorkoutProjection[]
}

export type ExecutablePrescriptionIntegrityResult =
  | { readonly valid: true }
  | {
      readonly valid: false
      readonly reason:
        | 'normalized-input-hash-mismatch'
        | 'output-snapshot-mismatch'
        | 'output-hash-mismatch'
    }

function canonicalProjection(value: ExecutablePrescriptionProjection): CanonicalValue {
  return value as unknown as CanonicalValue
}

export function executablePrescriptionHash(
  projection: ExecutablePrescriptionProjection,
): string {
  return canonicalSha256(canonicalProjection(projection))
}

export function verifyExecutablePrescriptionIntegrity(input: {
  readonly normalizedInput: CanonicalValue
  readonly storedNormalizedInputHash: string
  readonly storedOutputSnapshot: CanonicalValue
  readonly storedOutputHash: string
  readonly persistedProjection: ExecutablePrescriptionProjection
}): ExecutablePrescriptionIntegrityResult {
  if (canonicalSha256(input.normalizedInput) !== input.storedNormalizedInputHash) {
    return { valid: false, reason: 'normalized-input-hash-mismatch' }
  }

  if (
    canonicalStringify(input.storedOutputSnapshot) !==
    canonicalStringify(canonicalProjection(input.persistedProjection))
  ) {
    return { valid: false, reason: 'output-snapshot-mismatch' }
  }

  if (executablePrescriptionHash(input.persistedProjection) !== input.storedOutputHash) {
    return { valid: false, reason: 'output-hash-mismatch' }
  }

  return { valid: true }
}
