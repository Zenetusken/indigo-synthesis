import type {
  InstallationMutationEpoch,
  SubjectDataGeneration,
} from './mutation-authority'

export type ContentLockPlanShape =
  | 'none'
  | 'release-revocation'
  | 'current-publication.initial'
  | 'current-publication.existing'
  | 'stale-regeneration'
  | 'correction-closure'

export type ContentLockOwnerSlot =
  | 'methodology-target'
  | 'programs-current'
  | 'training-history'

export type ContentLockPlanBindings = {
  readonly shape: ContentLockPlanShape
  readonly purpose: string
  readonly actorAccountId: string
  readonly subjectId: string | null
  readonly formOrCommandId: string
  readonly sourceEntityIds: readonly string[]
  readonly expectedEpoch: InstallationMutationEpoch
  readonly expectedGeneration: SubjectDataGeneration | null
}

/** Cheap canonical/schema/shape/MAC verification has completed without database admission. */
export abstract class PreparedContentLockPlan {
  protected readonly preparedContentLockPlanNominal!: never

  protected constructor() {}
}

/** One-use, binding-checked plan whose canonical keys remain private to Platform. */
export abstract class VerifiedContentLockPlan<
  Shape extends ContentLockPlanShape = ContentLockPlanShape,
> {
  protected readonly verifiedContentLockPlanNominal!: Shape

  protected constructor() {}
}

/** Lexical scope in which owner infrastructure may derive fragments for a new envelope. */
export abstract class ContentLockIssuanceScope {
  protected readonly contentLockIssuanceScopeNominal!: never

  protected constructor() {}
}

/** UoW transaction identity to which fresh owner projections are bound. */
export abstract class ContentLockTransactionScope {
  protected readonly contentLockTransactionScopeNominal!: never

  protected constructor() {}
}

/**
 * Owner-derived opaque projection. No coordinate or advisory-key accessor crosses the neutral
 * boundary, and issuance projections cannot be reused for transaction attestation.
 */
export abstract class ContentLockSourceProjection<
  Phase extends 'issuance' | 'transaction',
  Slot extends ContentLockOwnerSlot = ContentLockOwnerSlot,
> {
  protected readonly contentLockSourceProjectionNominal!: readonly [Phase, Slot]

  protected constructor() {}
}

export type IssuanceContentLockSourceProjection = {
  [Slot in ContentLockOwnerSlot]: ContentLockSourceProjection<'issuance', Slot>
}[ContentLockOwnerSlot]

export type TransactionContentLockSourceProjection = {
  [Slot in ContentLockOwnerSlot]: ContentLockSourceProjection<'transaction', Slot>
}[ContentLockOwnerSlot]

/**
 * Transaction-scoped equality proof. Implementations reject missing, duplicate, extra,
 * wrong-owner, wrong-scope, wrong-source, or byte-unequal fresh owner projections.
 */
export abstract class LockedContentPlanAttestor {
  protected readonly lockedContentPlanAttestorNominal!: never

  protected constructor() {}

  abstract assertCurrentLockedContentSet(
    fragments: readonly TransactionContentLockSourceProjection[],
  ): void
}

/** Browser-safe authenticated envelope. It is not encrypted and never carries authority. */
export type ContentLockPlanEnvelope = string

export interface ContentLockPlanPort {
  /** Performs every connection-free validation, including constant-time MAC verification. */
  prepareEnvelope(rawEnvelope: unknown): PreparedContentLockPlan

  /**
   * Runs binding checks after bounded credential capture and scopes the one-use capability to the
   * callback. The callback must immediately enter UnitOfWork admission.
   */
  withVerifiedContentLockPlan<Shape extends ContentLockPlanShape, Result>(
    prepared: PreparedContentLockPlan,
    bindings: ContentLockPlanBindings & { readonly shape: Shape },
    callback: (plan: VerifiedContentLockPlan<Shape>) => Promise<Result>,
  ): Promise<Result>

  /**
   * Opens a callback-only issuance scope. Platform seals the exact owner-fragment union after
   * enforcing the closed shape registry; callers never submit raw advisory keys.
   */
  withIssuanceScope<Result>(
    bindings: ContentLockPlanBindings,
    callback: (context: {
      readonly scope: ContentLockIssuanceScope
      seal(
        fragments: readonly IssuanceContentLockSourceProjection[],
      ): ContentLockPlanEnvelope
    }) => Promise<Result>,
  ): Promise<Result>

  activeVerifiedScopeCount(): number
}
