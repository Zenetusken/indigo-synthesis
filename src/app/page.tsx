import { redirect } from 'next/navigation'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import { getInstallationStatus } from '@/modules/identity/application/installation'
import { getActor } from '@/modules/identity/server/actor'
import { getProgramOverview } from '@/modules/programs/application/programs'

export const dynamic = 'force-dynamic'

export default async function RootStateResolver() {
  const installation = await getInstallationStatus()

  if (installation.kind === 'open') {
    redirect('/bootstrap')
  }

  const actor = await getActor()

  if (!actor) {
    redirect('/sign-in')
  }

  const profile = await getAthleteProfile(actor.userId)

  if (!profile) {
    redirect('/setup')
  }

  const program = await getProgramOverview(actor.userId)
  redirect(program?.programStatus === 'active' ? '/today' : '/program')
}
