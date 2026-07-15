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

/** Coherent installation projection used to issue one anti-ABA sign-in page binding. */
export async function getServerSignInInstallationState(): Promise<ServerSignInInstallationState> {
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
