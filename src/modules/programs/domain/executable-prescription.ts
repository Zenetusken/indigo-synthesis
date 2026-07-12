import {
  type CanonicalValue,
  canonicalSha256,
  canonicalStringify,
} from '@/modules/methodology/domain/canonical'

export const EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION =
  'executable-prescription-v2' as const

export const LEGACY_EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION =
  'executable-prescription-v1' as const

export type ExecutablePrescriptionHashMaterialVersion =
  | typeof LEGACY_EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION
  | typeof EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION

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

export type ExecutableWorkoutProjectionV1 = {
  readonly scheduledDate: string
  readonly ordinal: number
  readonly slotCode: string
  readonly name: string
  readonly exercises: readonly ExecutableExerciseProjection[]
}

export type ExecutableWorkoutProjectionV2 = ExecutableWorkoutProjectionV1 & {
  readonly programOrdinal: number
}

type ExecutablePrescriptionProjectionBase<
  Version extends ExecutablePrescriptionHashMaterialVersion,
  Workout,
> = {
  readonly hashMaterialVersion: Version
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
  readonly workouts: readonly Workout[]
}

export type ExecutablePrescriptionProjectionV1 = ExecutablePrescriptionProjectionBase<
  typeof LEGACY_EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
  ExecutableWorkoutProjectionV1
>

export type ExecutablePrescriptionProjectionV2 = ExecutablePrescriptionProjectionBase<
  typeof EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION,
  ExecutableWorkoutProjectionV2
>

/** Current writers must emit only v2 hash material. */
export type ExecutablePrescriptionProjection = ExecutablePrescriptionProjectionV2

/** Readers retain the exact historical v1 format without allowing writers to emit it. */
export type SupportedExecutablePrescriptionProjection =
  | ExecutablePrescriptionProjectionV1
  | ExecutablePrescriptionProjectionV2

export type ExecutablePrescriptionIntegrityResult =
  | { readonly valid: true }
  | {
      readonly valid: false
      readonly reason:
        | 'normalized-input-hash-mismatch'
        | 'output-snapshot-mismatch'
        | 'output-hash-mismatch'
    }

function canonicalProjection(
  value: SupportedExecutablePrescriptionProjection,
): CanonicalValue {
  return value as unknown as CanonicalValue
}

export function executablePrescriptionHashMaterialVersion(
  storedSnapshot: unknown,
): ExecutablePrescriptionHashMaterialVersion | null {
  if (
    storedSnapshot === null ||
    typeof storedSnapshot !== 'object' ||
    Array.isArray(storedSnapshot)
  ) {
    return null
  }

  const version = Reflect.get(storedSnapshot, 'hashMaterialVersion')
  return version === LEGACY_EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION ||
    version === EXECUTABLE_PRESCRIPTION_HASH_MATERIAL_VERSION
    ? version
    : null
}

export function executablePrescriptionHash(
  projection: SupportedExecutablePrescriptionProjection,
): string {
  return canonicalSha256(canonicalProjection(projection))
}

export function verifyExecutablePrescriptionIntegrity(input: {
  readonly normalizedInput: CanonicalValue
  readonly storedNormalizedInputHash: string
  readonly storedOutputSnapshot: CanonicalValue
  readonly storedOutputHash: string
  readonly persistedProjection: SupportedExecutablePrescriptionProjection
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
