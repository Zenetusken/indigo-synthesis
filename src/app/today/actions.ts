'use server'

import { redirect } from 'next/navigation'
import { requireActor } from '@/modules/identity/server/actor'
import {
  resolveSafetyHold,
  startWorkout,
  WorkoutCommandError,
} from '@/modules/training/application/workouts'

export async function startWorkoutAction(formData: FormData): Promise<void> {
  const actor = await requireActor()
  let sessionId: string
  try {
    sessionId = await startWorkout(
      actor.userId,
      String(formData.get('plannedWorkoutId') ?? ''),
      String(formData.get('commandId') ?? ''),
    )
  } catch (error) {
    const code =
      error instanceof WorkoutCommandError ? error.code : 'session.start-failed'
    redirect(`/today?error=${encodeURIComponent(code)}` as never)
  }

  redirect(`/workouts/${sessionId}` as never)
}

export type SafetyHoldResolutionActionState = {
  readonly errorCode: string | null
  readonly values: {
    readonly acknowledged: boolean
    readonly reason: string
  }
}

export async function resolveSafetyHoldAction(
  _previousState: SafetyHoldResolutionActionState,
  formData: FormData,
): Promise<SafetyHoldResolutionActionState> {
  const actor = await requireActor()
  const values = {
    acknowledged: formData.get('acknowledged') === 'on',
    reason: String(formData.get('reason') ?? ''),
  }

  if (!values.reason.trim()) {
    return { errorCode: 'hold.reason-required', values }
  }
  if (!values.acknowledged) {
    return { errorCode: 'hold.ack-required', values }
  }

  try {
    await resolveSafetyHold({
      userId: actor.userId,
      holdId: String(formData.get('holdId') ?? ''),
      commandId: String(formData.get('commandId') ?? ''),
      reason: values.reason,
      acknowledged: values.acknowledged,
    })
  } catch (error) {
    const code = error instanceof WorkoutCommandError ? error.code : 'hold.resolve-failed'
    return { errorCode: code, values }
  }

  redirect('/today?notice=hold-resolved')
}
