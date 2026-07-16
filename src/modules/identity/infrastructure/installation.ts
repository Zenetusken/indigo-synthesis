import { eq } from 'drizzle-orm'
import { getDb } from '@/platform/db/client'
import { installationState } from '@/platform/db/schema'

export type ServerActorInstallationState = {
  readonly ownerUserId: string | null
  readonly productMutationEpoch: string
}

export type ServerSignInInstallationState =
  | { readonly kind: 'open' }
  | {
      readonly kind: 'closed'
      readonly productMutationEpoch: string
    }

export type ServerBootstrapInstallationState =
  | {
      readonly kind: 'open'
      readonly productMutationEpoch: string
    }
  | { readonly kind: 'closed' }

export type ServerRecoveryPageInstallationState = ServerSignInInstallationState

/**
 * Identity-owned issuance projection for a server-rendered authenticated action. The raw
 * lifecycle value remains server-side and is committed only into an opaque action binding.
 */
export async function getServerActorInstallationState(): Promise<ServerActorInstallationState> {
  const [state] = await getDb()
    .select({
      ownerUserId: installationState.ownerUserId,
      productMutationEpoch: installationState.productMutationEpoch,
    })
    .from(installationState)
    .where(eq(installationState.singleton, 1))
    .limit(1)

  if (!state) {
    throw new Error('Installation state is missing. Run the current database migrations.')
  }

  return state
}

export async function getInstallationOwnerUserId(): Promise<string | null> {
  return (await getServerActorInstallationState()).ownerUserId
}

/** Shared coherent projection for public sign-in and recovery binding issuance. */
async function getServerPublicInstallationState(): Promise<ServerSignInInstallationState> {
  const [state] = await getDb()
    .select({
      ownerUserId: installationState.ownerUserId,
      bootstrapClosedAt: installationState.bootstrapClosedAt,
      productMutationEpoch: installationState.productMutationEpoch,
    })
    .from(installationState)
    .where(eq(installationState.singleton, 1))
    .limit(1)

  if (!state) {
    throw new Error('Installation state is missing. Run the current database migrations.')
  }
  if (state.ownerUserId === null && state.bootstrapClosedAt === null) {
    return { kind: 'open' }
  }
  if (state.ownerUserId === null || state.bootstrapClosedAt === null) {
    throw new Error('Installation state owner lifecycle is inconsistent.')
  }
  return {
    kind: 'closed',
    productMutationEpoch: state.productMutationEpoch,
  }
}

/** Coherent installation projection used to issue one anti-ABA sign-in page binding. */
export function getServerSignInInstallationState(): Promise<ServerSignInInstallationState> {
  return getServerPublicInstallationState()
}

/** Coherent closed/open projection for either unauthenticated recovery page. */
export function getServerRecoveryPageInstallationState(): Promise<ServerRecoveryPageInstallationState> {
  return getServerPublicInstallationState()
}

/** Coherent installation projection used to issue one anti-ABA bootstrap page binding. */
export async function getServerBootstrapInstallationState(): Promise<ServerBootstrapInstallationState> {
  const [state] = await getDb()
    .select({
      ownerUserId: installationState.ownerUserId,
      bootstrapClosedAt: installationState.bootstrapClosedAt,
      productMutationEpoch: installationState.productMutationEpoch,
    })
    .from(installationState)
    .where(eq(installationState.singleton, 1))
    .limit(1)

  if (!state) {
    throw new Error('Installation state is missing. Run the current database migrations.')
  }
  if (state.ownerUserId === null && state.bootstrapClosedAt === null) {
    return { kind: 'open', productMutationEpoch: state.productMutationEpoch }
  }
  if (state.ownerUserId === null || state.bootstrapClosedAt === null) {
    throw new Error('Installation state owner lifecycle is inconsistent.')
  }
  return { kind: 'closed' }
}
