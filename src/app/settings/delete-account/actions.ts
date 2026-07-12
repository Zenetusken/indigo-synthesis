'use server'

import { redirect } from 'next/navigation'
import {
  createSubjectDeletionPlan,
  DeletionError,
  executeSubjectDeletion,
} from '@/modules/data-portability/application/deletion'
import { requireActor } from '@/modules/identity/server/actor'

function deletionError(code: string): never {
  redirect(`/settings/delete-account?error=${encodeURIComponent(code)}` as never)
}

export async function createAccountDeletionPreviewAction(): Promise<void> {
  const actor = await requireActor()
  try {
    await createSubjectDeletionPlan(actor)
  } catch (error) {
    deletionError(error instanceof DeletionError ? error.code : 'deletion.preview-failed')
  }
  redirect('/settings/delete-account' as never)
}

export async function deleteAccountAction(formData: FormData): Promise<void> {
  const actor = await requireActor()
  try {
    await executeSubjectDeletion({
      actor,
      planId: String(formData.get('planId') ?? ''),
      planDigest: String(formData.get('planDigest') ?? ''),
      password: String(formData.get('password') ?? ''),
      typedConfirmation: String(formData.get('typedConfirmation') ?? ''),
      acknowledged: formData.get('acknowledged') === 'on',
    })
  } catch (error) {
    deletionError(
      error instanceof DeletionError ? error.code : 'deletion.execution-failed',
    )
  }
  redirect('/sign-in?deleted=1')
}
