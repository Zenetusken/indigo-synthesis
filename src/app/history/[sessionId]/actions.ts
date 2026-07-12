'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/modules/identity/server/actor'
import { reportPain, WorkoutCommandError } from '@/modules/training/application/workouts'

export type PostCompletionSafetyReportState = {
  readonly errorCode: string | null
  readonly success: boolean
  readonly values: {
    readonly details: string
  }
}

export const initialPostCompletionSafetyReportState: PostCompletionSafetyReportState = {
  errorCode: null,
  success: false,
  values: { details: '' },
}

export async function reportPostCompletionSafetyIssueAction(
  _previousState: PostCompletionSafetyReportState,
  formData: FormData,
): Promise<PostCompletionSafetyReportState> {
  const actor = await requireActor()
  const sessionId = String(formData.get('sessionId') ?? '')
  const values = { details: String(formData.get('details') ?? '') }

  try {
    await reportPain({
      userId: actor.userId,
      sessionId,
      commandId: String(formData.get('commandId') ?? ''),
      details: values.details,
    })
  } catch (error) {
    return {
      errorCode:
        error instanceof WorkoutCommandError ? error.code : 'safety.report-failed',
      success: false,
      values,
    }
  }

  revalidatePath(`/history/${sessionId}`)
  revalidatePath('/history')
  revalidatePath('/today')
  return { errorCode: null, success: true, values: { details: '' } }
}
