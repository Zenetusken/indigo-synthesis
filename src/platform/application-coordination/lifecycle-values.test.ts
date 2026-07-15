import { describe, expect, it } from 'vitest'
import {
  createInstallationMutationEpoch,
  createSubjectDataGeneration,
  installationMutationEpochMatches,
  installationMutationEpochWireValue,
  subjectDataGenerationWireValue,
} from './lifecycle-values'

const epochValue = '123e4567-e89b-42d3-a456-426614174000'
const generationValue = '018f5c37-7e41-4a83-8a5b-12ae32083959'

describe('Platform lifecycle values', () => {
  it('round-trips canonical opaque UUID values without exposing structure', () => {
    const epoch = createInstallationMutationEpoch(epochValue)
    const generation = createSubjectDataGeneration(generationValue)

    expect(installationMutationEpochWireValue(epoch)).toBe(epochValue)
    expect(subjectDataGenerationWireValue(generation)).toBe(generationValue)
    expect(installationMutationEpochMatches(epoch, epochValue)).toBe(true)
    expect(installationMutationEpochMatches(epoch, generationValue)).toBe(false)
    expect(Object.keys(epoch)).toEqual([])
    expect(Object.keys(generation)).toEqual([])
    expect(JSON.stringify({ epoch, generation })).toBe('{"epoch":{},"generation":{}}')
    expect(
      (epoch.constructor as unknown as Record<PropertyKey, unknown>).value,
    ).toBeUndefined()
    expect(
      (generation.constructor as unknown as Record<PropertyKey, unknown>).value,
    ).toBeUndefined()
    expect(() => Reflect.construct(epoch.constructor, [epochValue])).toThrow(
      'was not issued by Platform',
    )
    expect(() => Reflect.construct(generation.constructor, [generationValue])).toThrow(
      'was not issued by Platform',
    )
  })

  it.each([
    null,
    undefined,
    '',
    epochValue.toUpperCase(),
    '123e4567-e89b-12d3-a456-426614174000',
    '123e4567-e89b-42d3-c456-426614174000',
    `${epochValue} `,
  ])('rejects noncanonical lifecycle input %#', (raw) => {
    expect(() => createInstallationMutationEpoch(raw)).toThrow('canonical UUIDv4')
    expect(() => createSubjectDataGeneration(raw)).toThrow('canonical UUIDv4')
  })
})
