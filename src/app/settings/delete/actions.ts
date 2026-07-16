'use server'

import { redirect } from 'next/navigation'
import { getProductionDataPortabilityDestructiveMutationPort } from '@/composition/data-portability-destructive-mutations'
import { createInstanceResetPlan } from '@/modules/data-portability/application/deletion'
import {
  type DestructiveNoticeFailureKind,
  type InstanceResetNoticeReceiptPayload,
  issueInstanceResetNoticeReceipt,
} from '@/modules/data-portability/server/destructive-notice'
import { requireActor } from '@/modules/identity/server/actor'
import { captureInstanceResetMutationCommand } from '@/modules/identity/server/destructive-command'

function noticeUrl(
  path: string,
  payload: InstanceResetNoticeReceiptPayload,
  actorUserId: string,
): string {
  const receipt = issueInstanceResetNoticeReceipt(payload, actorUserId)
  return `${path}?notice=${encodeURIComponent(receipt)}`
}

function resetError(kind: DestructiveNoticeFailureKind, actorUserId: string): never {
  redirect(noticeUrl('/settings/delete', { kind }, actorUserId) as never)
}

function unreachableResult(value: never): never {
  throw new TypeError(`Unexpected instance-reset result: ${String(value)}`)
}

export async function createResetPreviewAction(): Promise<void> {
  const actor = await requireActor()
  try {
    await createInstanceResetPlan(actor)
  } catch {
    resetError('preview-failed', actor.userId)
  }
  redirect('/settings/delete')
}

export async function resetInstanceAction(formData: FormData): Promise<void> {
  const commandEnteredAt = new Date()
  let captured: Awaited<ReturnType<typeof captureInstanceResetMutationCommand>> | null =
    null
  try {
    captured = await captureInstanceResetMutationCommand({
      formData,
      commandEnteredAt,
    })
  } catch {
    captured = null
  }

  // Form-owned fields are captured before this second request-bound read. Retain the
  // exact owner so every result receipt remains bound after a destructive commit.
  const actor = await requireActor()
  if (!captured) resetError('request-not-verified', actor.userId)
  if (captured.kind === 'rejected') resetError('stale', actor.userId)

  let result: Awaited<
    ReturnType<
      ReturnType<
        typeof getProductionDataPortabilityDestructiveMutationPort
      >['resetInstance']
    >
  >
  try {
    result = await getProductionDataPortabilityDestructiveMutationPort().resetInstance(
      captured.command,
    )
  } catch {
    resetError('execution-failed', actor.userId)
  }

  switch (result.kind) {
    case 'reset': {
      return redirect(noticeUrl('/bootstrap', result, actor.userId) as never)
    }
    case 'outcome-unknown':
      return redirect(noticeUrl('/sign-in', result, actor.userId) as never)
    case 'confirmation-rejected':
      return resetError(result.kind, actor.userId)
    case 'reauthentication-failed':
      return resetError(result.kind, actor.userId)
    case 'reauthentication-locked':
      return resetError(result.kind, actor.userId)
    case 'plan-invalid':
      return resetError(result.kind, actor.userId)
    case 'plan-changed':
      return resetError(result.kind, actor.userId)
    case 'stale':
      return resetError(result.kind, actor.userId)
    case 'unavailable':
      return resetError(result.kind, actor.userId)
    case 'reauthentication-incomplete':
      return resetError(result.kind, actor.userId)
  }
  return unreachableResult(result)
}
