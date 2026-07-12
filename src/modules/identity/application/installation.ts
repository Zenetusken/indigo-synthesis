import { eq } from 'drizzle-orm'
import { getDb } from '@/platform/db/client'
import { installationState } from '@/platform/db/schema'

export type InstallationStatus =
  | { readonly kind: 'open' }
  | {
      readonly kind: 'closed'
      readonly ownerUserId: string
      readonly closedAt: Date
    }

export async function getInstallationStatus(): Promise<InstallationStatus> {
  const [state] = await getDb()
    .select({
      ownerUserId: installationState.ownerUserId,
      closedAt: installationState.bootstrapClosedAt,
    })
    .from(installationState)
    .where(eq(installationState.singleton, 1))
    .limit(1)

  if (!state?.ownerUserId || !state.closedAt) {
    return { kind: 'open' }
  }

  return {
    kind: 'closed',
    ownerUserId: state.ownerUserId,
    closedAt: state.closedAt,
  }
}
