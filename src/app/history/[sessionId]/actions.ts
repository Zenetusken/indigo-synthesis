'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/modules/identity/server/actor'
import {
  explainFutureLoadDecision,
  type FutureLoadExplanationResult,
} from '@/modules/training/application/future-load-explanation'
import { reportPain, WorkoutCommandError } from '@/modules/training/application/workouts'

const explanationRequestSchema = z.object({
  sessionId: z.string().min(1).max(128),
  decisionId: z.string().min(1).max(128),
})

export type PostCompletionSafetyReportState = {
  readonly errorCode: string | null
  readonly success: boolean
  readonly values: {
    readonly details: string
  }
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

export async function explainFutureLoadDecisionAction(input: {
  readonly sessionId: string
  readonly decisionId: string
}): Promise<FutureLoadExplanationResult> {
  const actor = await requireActor()
  const parsed = explanationRequestSchema.safeParse(input)
  if (!parsed.success) {
    return {
      status: 'unavailable',
      reason: 'decision-not-found',
      detail: 'Invalid session or decision identifier.',
      durationMs: 0,
    }
  }

  return explainFutureLoadDecision({
    userId: actor.userId,
    sessionId: parsed.data.sessionId,
    decisionId: parsed.data.decisionId,
  })
}
