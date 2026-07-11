export type EvidenceGrade =
  | 'established'
  | 'supported'
  | 'experimental'
  | 'expert-opinion'
  | 'unverified'
  | 'prohibited'

export interface ContentHash {
  readonly algorithm: 'sha256'
  readonly value: string
}

export interface SourceReference {
  readonly id: string
  readonly title: string
  readonly uri?: string
  readonly evidenceGrade: EvidenceGrade
  readonly reviewerId: string
  readonly approvedAt: string
  readonly applicablePopulation: string
  readonly limitations: readonly string[]
  readonly reviewDueAt: string
}

export interface RuleSetReference {
  readonly id: string
  readonly version: string
  readonly status: 'draft' | 'reviewed' | 'retired'
  readonly reviewedAt?: string
  readonly reviewerIds: readonly string[]
}

export interface RecommendationReason {
  readonly code: string
  readonly summary: string
  readonly sourceReferences: readonly SourceReference[]
}

export interface VersionReference {
  readonly id: string
  readonly version: string
}

export interface PrescriptionWarning {
  readonly code: string
  readonly summary: string
  readonly sourceReferences: readonly SourceReference[]
}

export interface ManualReviewRequirement {
  readonly required: boolean
  readonly reasonCodes: readonly string[]
}

export interface Prescription<TOutput> {
  readonly engineVersion: string
  readonly methodologyRelease: RuleSetReference
  readonly template: VersionReference
  readonly normalizedInputHash: ContentHash
  readonly outputHash: ContentHash
  readonly output: TOutput
  readonly reasons: readonly RecommendationReason[]
  readonly warnings: readonly PrescriptionWarning[]
  readonly manualReview: ManualReviewRequirement
}
