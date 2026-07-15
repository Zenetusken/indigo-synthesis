import { createHmac } from 'node:crypto'
import { getServerConfig } from '@/platform/config/server'
import type { WebRecoveryPurpose } from './web-recovery-rate-limit'

const loadShedderWindowMilliseconds = 60_000
const productionMaximumBuckets = 2_048
const loadShedderLimits = Object.freeze({ address: 30, email: 5 })

type LoadShedderDimension = 'address' | 'email'
type LoadShedderScope = `${WebRecoveryPurpose}:${LoadShedderDimension}`

type LoadShedderBucket = {
  readonly expiresAt: number
  count: number
}

export type CredentialLoadShedderAdmission =
  | { readonly admitted: true }
  | {
      readonly admitted: false
      readonly reason: 'capacity' | 'throttled'
      readonly scope?: LoadShedderScope
    }

export type CredentialLoadShedder = Readonly<{
  admit(input: {
    readonly purpose: WebRecoveryPurpose
    readonly email: string
    readonly clientAddress: string
    readonly now?: Date
  }): CredentialLoadShedderAdmission
  activeBucketCount(): number
  reset(): void
}>

function finiteTime(now: Date): number {
  const milliseconds = now.getTime()
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('Credential load-shedder clock must be a valid date.')
  }
  return milliseconds
}

/**
 * Creates a bounded, process-local load shedder. It is deliberately not a brute-force
 * authority: durable admission repeats after capture on the leased control transaction.
 */
export function createCredentialLoadShedder(options?: {
  readonly maximumBuckets?: number
  readonly secret?: string
}): CredentialLoadShedder {
  const maximumBuckets = options?.maximumBuckets ?? productionMaximumBuckets
  if (!Number.isSafeInteger(maximumBuckets) || maximumBuckets < 2) {
    throw new TypeError('Credential load-shedder capacity must be at least two buckets.')
  }
  const secret = options?.secret ?? getServerConfig().authSecret
  const buckets = new Map<string, LoadShedderBucket>()

  const keyFor = (scope: LoadShedderScope, value: string): string =>
    createHmac('sha256', secret)
      .update(`indigo-credential-load-shedder-v1\0${scope}\0${value}`, 'utf8')
      .digest('hex')

  const evictExpired = (now: number): void => {
    const expired = [...buckets]
      .filter(([, bucket]) => bucket.expiresAt <= now)
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          left.expiresAt - right.expiresAt || leftKey.localeCompare(rightKey),
      )
    for (const [key] of expired) buckets.delete(key)
  }

  return Object.freeze({
    admit(input): CredentialLoadShedderAdmission {
      const now = finiteTime(input.now ?? new Date())
      evictExpired(now)
      const dimensions = [
        {
          dimension: 'address' as const,
          scope: `${input.purpose}:address` as const,
          value: input.clientAddress,
        },
        {
          dimension: 'email' as const,
          scope: `${input.purpose}:email` as const,
          value: input.email,
        },
      ].map((dimension) => ({
        ...dimension,
        key: keyFor(dimension.scope, dimension.value),
      }))

      // Address is deliberately inspected first so random-email floods stop at one shared key.
      for (const dimension of dimensions) {
        const bucket = buckets.get(dimension.key)
        if (bucket && bucket.count >= loadShedderLimits[dimension.dimension]) {
          return {
            admitted: false,
            reason: 'throttled',
            scope: dimension.scope,
          }
        }
      }

      const missingCount = dimensions.reduce(
        (count, dimension) => count + (buckets.has(dimension.key) ? 0 : 1),
        0,
      )
      if (buckets.size + missingCount > maximumBuckets) {
        return { admitted: false, reason: 'capacity' }
      }

      for (const dimension of dimensions) {
        const bucket = buckets.get(dimension.key)
        if (bucket) bucket.count += 1
        else {
          buckets.set(dimension.key, {
            count: 1,
            expiresAt: now + loadShedderWindowMilliseconds,
          })
        }
      }
      return { admitted: true }
    },
    activeBucketCount: () => buckets.size,
    reset: () => buckets.clear(),
  })
}

let productionLoadShedder: CredentialLoadShedder | undefined

export function admitCredentialLoadShedder(input: {
  readonly purpose: WebRecoveryPurpose
  readonly email: string
  readonly clientAddress: string
}): CredentialLoadShedderAdmission {
  productionLoadShedder ??= createCredentialLoadShedder()
  return productionLoadShedder.admit(input)
}

export function resetCredentialLoadShedderForTests(): void {
  productionLoadShedder?.reset()
  productionLoadShedder = undefined
}
