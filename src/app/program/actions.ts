'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireActor } from '@/modules/identity/server/actor'
import {
  activateProgram,
  generateDraftProgram,
  ProgramUnavailableError,
} from '@/modules/programs/application/programs'

function programError(code: string): never {
  redirect(`/program?error=${encodeURIComponent(code)}` as never)
}

export async function generateProgramAction(formData: FormData): Promise<void> {
  const actor = await requireActor()
  const asOfDate = String(formData.get('asOfDate') ?? '')
  let result: Awaited<ReturnType<typeof generateDraftProgram>>

  try {
    result = await generateDraftProgram(actor.userId, asOfDate)
  } catch (error) {
    if (error instanceof ProgramUnavailableError) programError(error.code)
    programError('program.generation-failed')
  }

  if (result.status === 'blocked') {
    programError(result.blockers[0]?.code ?? 'program.blocked')
  }

  revalidatePath('/program')
  redirect('/program')
}

export async function activateProgramAction(formData: FormData): Promise<void> {
  const actor = await requireActor()
  const revisionId = String(formData.get('revisionId') ?? '')

  try {
    await activateProgram(actor.userId, revisionId)
  } catch (error) {
    if (error instanceof ProgramUnavailableError) programError(error.code)
    programError('program.activation-failed')
  }

  revalidatePath('/')
  revalidatePath('/program')
  redirect('/today')
}
