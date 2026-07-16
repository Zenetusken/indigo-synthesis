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

function noticeUrl(path: string, payload: InstanceResetNoticeReceiptPayload): string {
  const receipt = issueInstanceResetNoticeReceipt(payload)
  return `${path}?notice=${encodeURIComponent(receipt)}`
}

function resetError(kind: DestructiveNoticeFailureKind): never {
  redirect(noticeUrl('/settings/delete', { kind }) as never)
}

function unreachableResult(value: never): never {
  throw new TypeError(`Unexpected instance-reset result: ${String(value)}`)
}

export async function createResetPreviewAction(): Promise<void> {
  const actor = await requireActor()
  try {
    await createInstanceResetPlan(actor)
  } catch {
    resetError('preview-failed')
  }
  redirect('/settings/delete')
}

export async function resetInstanceAction(formData: FormData): Promise<void> {
  const commandEnteredAt = new Date()
  let captured: Awaited<ReturnType<typeof captureInstanceResetMutationCommand>>
  try {
    captured = await captureInstanceResetMutationCommand({
      formData,
      commandEnteredAt,
    })
  } catch {
    resetError('request-not-verified')
  }
  if (captured.kind === 'rejected') resetError('stale')

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
    resetError('execution-failed')
  }

  switch (result.kind) {
    case 'reset': {
      return redirect(noticeUrl('/bootstrap', result) as never)
    }
    case 'outcome-unknown':
      return redirect(noticeUrl('/sign-in', result) as never)
    case 'confirmation-rejected':
      return resetError(result.kind)
    case 'reauthentication-failed':
      return resetError(result.kind)
    case 'reauthentication-locked':
      return resetError(result.kind)
    case 'plan-invalid':
      return resetError(result.kind)
    case 'plan-changed':
      return resetError(result.kind)
    case 'stale':
      return resetError(result.kind)
    case 'unavailable':
      return resetError(result.kind)
    case 'reauthentication-incomplete':
      return resetError(result.kind)
  }
  return unreachableResult(result)
}
