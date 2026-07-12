'use server'

import { redirect } from 'next/navigation'
import { requireActor } from '@/modules/identity/server/actor'
import {
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
