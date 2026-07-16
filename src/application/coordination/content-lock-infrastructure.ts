import type {
  ContentLockIssuanceScope,
  ContentLockOwnerSlot,
  ContentLockSourceProjection,
  ContentLockTransactionScope,
} from './content-lock-plan'

export type ContentReleaseCoordinate = {
  readonly kind: 'methodology' | 'template'
  readonly id: string
  readonly version: string
}

/**
 * Infrastructure-only factory injected already bound to one owner slot. It accepts structured
 * content coordinates, never caller-composed advisory-key strings.
 */
export interface ContentLockProjectionFactory<Slot extends ContentLockOwnerSlot> {
  readonly ownerSlot: Slot

  createIssuanceProjection(
    scope: ContentLockIssuanceScope,
    coordinates: readonly ContentReleaseCoordinate[],
  ): ContentLockSourceProjection<'issuance', Slot>

  createTransactionProjection(
    scope: ContentLockTransactionScope,
    coordinates: readonly ContentReleaseCoordinate[],
  ): ContentLockSourceProjection<'transaction', Slot>
}
