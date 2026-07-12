import { eq } from 'drizzle-orm'
import { getDb } from '@/platform/db/client'
import { installationState } from '@/platform/db/schema'

export async function getInstallationOwnerUserId(): Promise<string | null> {
  const [state] = await getDb()
    .select({ ownerUserId: installationState.ownerUserId })
    .from(installationState)
    .where(eq(installationState.singleton, 1))
    .limit(1)

  return state?.ownerUserId ?? null
}
