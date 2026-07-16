'use server'

import { redirect } from 'next/navigation'
import { getProductionDataPortabilityDestructiveMutationPort } from '@/composition/data-portability-destructive-mutations'
import { createSubjectDeletionPlan } from '@/modules/data-portability/application/deletion'
import {
  type DestructiveNoticeFailureKind,
  issueSubjectDeletionNoticeReceipt,
  type SubjectDeletionNoticeReceiptPayload,
} from '@/modules/data-portability/server/destructive-notice'
import { requireActor } from '@/modules/identity/server/actor'
import { captureTraineeDataDeletionMutationCommand } from '@/modules/identity/server/destructive-command'

function noticeUrl(path: string, payload: SubjectDeletionNoticeReceiptPayload): string {
  const receipt = issueSubjectDeletionNoticeReceipt(payload)
  return `${path}?notice=${encodeURIComponent(receipt)}`
}

function deletionError(kind: DestructiveNoticeFailureKind): never {
  redirect(noticeUrl('/settings/delete-account', { kind }) as never)
}

function unreachableResult(value: never): never {
  throw new TypeError(`Unexpected subject-deletion result: ${String(value)}`)
}

export async function createAccountDeletionPreviewAction(): Promise<void> {
  const actor = await requireActor()
  try {
    await createSubjectDeletionPlan(actor)
  } catch {
    deletionError('preview-failed')
  }
  redirect('/settings/delete-account' as never)
}

export async function deleteAccountAction(formData: FormData): Promise<void> {
  const commandEnteredAt = new Date()
  let captured: Awaited<ReturnType<typeof captureTraineeDataDeletionMutationCommand>>
  try {
    captured = await captureTraineeDataDeletionMutationCommand({
      formData,
      commandEnteredAt,
    })
  } catch {
    deletionError('request-not-verified')
  }
  if (captured.kind === 'rejected') deletionError('stale')

  let result: Awaited<
    ReturnType<
      ReturnType<
        typeof getProductionDataPortabilityDestructiveMutationPort
      >['deleteSubject']
    >
  >
  try {
    result = await getProductionDataPortabilityDestructiveMutationPort().deleteSubject(
      captured.command,
    )
  } catch {
    deletionError('execution-failed')
  }

  switch (result.kind) {
    case 'deleted':
      return redirect(noticeUrl(postDeletionPath(result.actorRole), result) as never)
    case 'outcome-unknown':
      if (result.actorRole === 'member') {
        return redirect(noticeUrl('/sign-in', result) as never)
      }
      return redirect(noticeUrl('/settings/delete-account', result) as never)
    case 'confirmation-rejected':
      return deletionError(result.kind)
    case 'reauthentication-failed':
      return deletionError(result.kind)
    case 'reauthentication-locked':
      return deletionError(result.kind)
    case 'plan-invalid':
      return deletionError(result.kind)
    case 'plan-changed':
      return deletionError(result.kind)
    case 'stale':
      return deletionError(result.kind)
    case 'unavailable':
      return deletionError(result.kind)
    case 'reauthentication-incomplete':
      return deletionError(result.kind)
  }
  return unreachableResult(result)
}

function postDeletionPath(role: 'owner' | 'member'): string {
  return role === 'owner' ? '/settings' : '/sign-in'
}
