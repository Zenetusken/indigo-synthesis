import { describe, expect, it } from 'vitest'
import { createCredentialLoadShedder } from './credential-load-shedder'

const start = new Date('2026-07-15T12:00:00.000Z')

function attempt(
  shedder: ReturnType<typeof createCredentialLoadShedder>,
  input: { readonly email: string; readonly address: string; readonly now?: Date },
) {
  return shedder.admit({
    purpose: 'sign-in',
    email: input.email,
    clientAddress: input.address,
    now: input.now ?? start,
  })
}

describe('credential load shedder', () => {
  it('checks address before email and leaves both buckets unchanged on throttle', () => {
    const shedder = createCredentialLoadShedder({
      maximumBuckets: 64,
      secret: 'load-shedder-test-secret',
    })
    for (let index = 0; index < 30; index += 1) {
      expect(
        attempt(shedder, {
          address: '198.51.100.1',
          email: `athlete-${index}@example.test`,
        }),
      ).toEqual({ admitted: true })
    }
    const before = shedder.activeBucketCount()

    expect(
      attempt(shedder, {
        address: '198.51.100.1',
        email: 'new@example.test',
      }),
    ).toEqual({
      admitted: false,
      reason: 'throttled',
      scope: 'sign-in:address',
    })
    expect(shedder.activeBucketCount()).toBe(before)
  })

  it('fails closed at fixed capacity without evicting a live identity', () => {
    const shedder = createCredentialLoadShedder({
      maximumBuckets: 4,
      secret: 'load-shedder-test-secret',
    })
    expect(
      attempt(shedder, { address: '198.51.100.1', email: 'one@example.test' }),
    ).toEqual({ admitted: true })
    expect(
      attempt(shedder, { address: '198.51.100.2', email: 'two@example.test' }),
    ).toEqual({ admitted: true })

    expect(
      attempt(shedder, { address: '198.51.100.3', email: 'three@example.test' }),
    ).toEqual({ admitted: false, reason: 'capacity' })
    expect(shedder.activeBucketCount()).toBe(4)
  })

  it('evicts expired buckets deterministically and restart clears only local authority', () => {
    const shedder = createCredentialLoadShedder({
      maximumBuckets: 2,
      secret: 'load-shedder-test-secret',
    })
    for (let index = 0; index < 5; index += 1) {
      expect(
        attempt(shedder, {
          address: '198.51.100.1',
          email: 'one@example.test',
        }),
      ).toEqual({ admitted: true })
    }
    expect(
      attempt(shedder, {
        address: '198.51.100.1',
        email: 'one@example.test',
      }),
    ).toMatchObject({ admitted: false, reason: 'throttled' })

    expect(
      attempt(shedder, {
        address: '198.51.100.2',
        email: 'two@example.test',
        now: new Date(start.getTime() + 60_000),
      }),
    ).toEqual({ admitted: true })
    expect(shedder.activeBucketCount()).toBe(2)

    shedder.reset()
    expect(shedder.activeBucketCount()).toBe(0)
    expect(
      attempt(shedder, { address: '198.51.100.1', email: 'one@example.test' }),
    ).toEqual({ admitted: true })
  })
})
