'use server'

import { redirect } from 'next/navigation'
import {
  createInstanceResetPlan,
  DeletionError,
  executeInstanceReset,
} from '@/modules/data-portability/application/deletion'
import { requireActor } from '@/modules/identity/server/actor'

function resetError(code: string): never {
  redirect(`/settings/delete?error=${encodeURIComponent(code)}` as never)
}

export async function createResetPreviewAction(): Promise<void> {
  const actor = await requireActor()
  try {
    await createInstanceResetPlan(actor)
  } catch (error) {
    resetError(error instanceof DeletionError ? error.code : 'deletion.preview-failed')
  }
  redirect('/settings/delete')
}

export async function resetInstanceAction(formData: FormData): Promise<void> {
  const actor = await requireActor()
  try {
    await executeInstanceReset({
      actor,
      planId: String(formData.get('planId') ?? ''),
      planDigest: String(formData.get('planDigest') ?? ''),
      password: String(formData.get('password') ?? ''),
      typedConfirmation: String(formData.get('typedConfirmation') ?? ''),
      acknowledged: formData.get('acknowledged') === 'on',
    })
  } catch (error) {
    resetError(error instanceof DeletionError ? error.code : 'deletion.execution-failed')
  }
  redirect('/bootstrap?reset=complete')
}
