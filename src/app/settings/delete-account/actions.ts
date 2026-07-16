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

function noticeUrl(
  path: string,
  payload: SubjectDeletionNoticeReceiptPayload,
  actorUserId: string,
): string {
  const receipt = issueSubjectDeletionNoticeReceipt(payload, actorUserId)
  return `${path}?notice=${encodeURIComponent(receipt)}`
}

function deletionError(kind: DestructiveNoticeFailureKind, actorUserId: string): never {
  redirect(noticeUrl('/settings/delete-account', { kind }, actorUserId) as never)
}

function unreachableResult(value: never): never {
  throw new TypeError(`Unexpected subject-deletion result: ${String(value)}`)
}

export async function createAccountDeletionPreviewAction(): Promise<void> {
  const actor = await requireActor()
  try {
    await createSubjectDeletionPlan(actor)
  } catch {
    deletionError('preview-failed', actor.userId)
  }
  redirect('/settings/delete-account' as never)
}

export async function deleteAccountAction(formData: FormData): Promise<void> {
  const commandEnteredAt = new Date()
  let captured: Awaited<
    ReturnType<typeof captureTraineeDataDeletionMutationCommand>
  > | null = null
  try {
    captured = await captureTraineeDataDeletionMutationCommand({
      formData,
      commandEnteredAt,
    })
  } catch {
    captured = null
  }

  // Form-owned fields are captured before this second request-bound read. Retain the
  // exact actor so every result receipt remains bound after a destructive commit.
  const actor = await requireActor()
  if (!captured) deletionError('request-not-verified', actor.userId)
  if (captured.kind === 'rejected') deletionError('stale', actor.userId)

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
    deletionError('execution-failed', actor.userId)
  }

  switch (result.kind) {
    case 'deleted':
      return redirect(
        noticeUrl(postDeletionPath(result.actorRole), result, actor.userId) as never,
      )
    case 'outcome-unknown':
      if (result.actorRole === 'member') {
        return redirect(noticeUrl('/sign-in', result, actor.userId) as never)
      }
      return redirect(
        noticeUrl('/settings/delete-account', result, actor.userId) as never,
      )
    case 'confirmation-rejected':
      return deletionError(result.kind, actor.userId)
    case 'reauthentication-failed':
      return deletionError(result.kind, actor.userId)
    case 'reauthentication-locked':
      return deletionError(result.kind, actor.userId)
    case 'plan-invalid':
      return deletionError(result.kind, actor.userId)
    case 'plan-changed':
      return deletionError(result.kind, actor.userId)
    case 'stale':
      return deletionError(result.kind, actor.userId)
    case 'unavailable':
      return deletionError(result.kind, actor.userId)
    case 'reauthentication-incomplete':
      return deletionError(result.kind, actor.userId)
  }
  return unreachableResult(result)
}

function postDeletionPath(role: 'owner' | 'member'): string {
  return role === 'owner' ? '/settings' : '/sign-in'
}
