import { createHash } from 'node:crypto'

export type ExplanationFactBundle = {
  readonly contractVersion: '2'
  readonly bundleKind: 'future-load-decision'
  readonly locale: 'en'
  readonly contentMode: 'development' | 'reviewed'
  readonly subject: {
    readonly units: 'metric' | 'imperial'
  }
  readonly decision: {
    readonly decisionId: string
    readonly sessionId: string
    readonly exerciseCode: string
    readonly kind: 'blocked' | 'hold' | 'increase'
    readonly currentLoadGrams: number
    readonly proposedLoadGrams: number
    readonly invalidated: boolean
    readonly invalidationReason: string | null
    readonly setFacts: readonly {
      readonly ordinal: number
      readonly status: 'performed' | 'skipped'
      readonly loadGrams: number | null
      readonly repetitions: number | null
      readonly rpe: number | null
      readonly explicitlyConfirmed: boolean | null
    }[]
    readonly painReported: boolean | null
  }
  readonly grounding: {
    readonly reasonCode: string
    readonly ruleId: string
    readonly ruleVersion: string
    readonly engineVersion: string
    readonly methodologyId: string
    readonly methodologyVersion: string
  }
  readonly display: {
    readonly currentLoadLabel: string
    readonly proposedLoadLabel: string
    readonly exerciseName: string
  }
  readonly constraints: {
    readonly mustMentionReasonCode: true
    readonly mustMentionRuleVersion: true
    readonly mustUseDisplayLoadLabelsOnly: true
    readonly mustNotInventNumbers: true
    readonly mustNotDiagnose: true
    readonly mustNotAdviseIgnoringPainOrHolds: true
    readonly developmentFixtureNoticeRequired: boolean
    readonly maxOutputTokens: number
  }
}

/** Stable JSON with sorted object keys for hashing. */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Canonical numbers must be finite.')
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonStringify(entry)).join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonStringify(entry)}`)
      .join(',')}}`
  }
  throw new Error('Unsupported value for canonical JSON.')
}

export function factBundleHash(bundle: ExplanationFactBundle): string {
  return createHash('sha256').update(canonicalJsonStringify(bundle)).digest('hex')
}

export function explanationCacheKey(input: {
  readonly decisionId: string
  readonly promptVersion: string
  readonly validatorVersion: string
  readonly modelId: string
  readonly modelContentDigest: string
  readonly factBundleHash: string
}): string {
  return [
    input.decisionId,
    input.promptVersion,
    input.validatorVersion,
    input.modelId,
    input.modelContentDigest,
    input.factBundleHash,
  ].join('\0')
}
