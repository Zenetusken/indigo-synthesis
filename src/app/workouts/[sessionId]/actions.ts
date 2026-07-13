'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import { inputLoadToGrams } from '@/modules/athletes/domain/units'
import { requireActorForWorkout } from '@/modules/identity/server/actor'
import {
  abandonWorkout,
  completeSet,
  completeWorkout,
  proposeExerciseSubstitution,
  reportPain,
  setSessionPaused,
  skipSet,
  WorkoutCommandError,
} from '@/modules/training/application/workouts'

export type WorkoutActionResult =
  | { success: true }
  | { success: false; code: string; values?: Record<string, string> }

function finiteNumber(formData: FormData, name: string): number {
  const rawValue = formData.get(name)
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    throw new WorkoutCommandError('input.invalid-number', `Invalid ${name}.`)
  }
  const value = Number(rawValue)
  if (!Number.isFinite(value))
    throw new WorkoutCommandError('input.invalid-number', `Invalid ${name}.`)
  return value
}

function captureFormValues(formData: FormData, names: string[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (const name of names) {
    const value = formData.get(name)
    if (typeof value === 'string') values[name] = value
  }
  return values
}

export async function completeSetAction(
  formData: FormData,
): Promise<WorkoutActionResult> {
  const sessionId = String(formData.get('sessionId') ?? '')
  const actor = await requireActorForWorkout(sessionId)

  try {
    const profile = await getAthleteProfile(actor.userId)
    if (!profile) throw new WorkoutCommandError('profile.missing', 'Profile not found.')
    const rpeValue = String(formData.get('rpe') ?? '').trim()
    await completeSet({
      userId: actor.userId,
      sessionId,
      setId: String(formData.get('setId') ?? ''),
      commandId: String(formData.get('commandId') ?? ''),
      actualLoadGrams: inputLoadToGrams(
        finiteNumber(formData, 'actualLoad'),
        profile.profile.units,
      ),
      actualRepetitions: finiteNumber(formData, 'actualRepetitions'),
      rpe: rpeValue ? Number(rpeValue) : null,
      note: String(formData.get('note') ?? '').trim() || null,
    })
  } catch (error) {
    return {
      success: false,
      code: error instanceof WorkoutCommandError ? error.code : 'set.save-failed',
      values: captureFormValues(formData, [
        'actualLoad',
        'actualRepetitions',
        'rpe',
        'note',
      ]),
    }
  }

  revalidatePath(`/workouts/${sessionId}`)
  return { success: true }
}

export async function skipSetAction(formData: FormData): Promise<WorkoutActionResult> {
  const sessionId = String(formData.get('sessionId') ?? '')
  const actor = await requireActorForWorkout(sessionId)
  try {
    await skipSet({
      userId: actor.userId,
      sessionId,
      setId: String(formData.get('setId') ?? ''),
      commandId: String(formData.get('commandId') ?? ''),
      reason: String(formData.get('reason') ?? ''),
    })
  } catch (error) {
    return {
      success: false,
      code: error instanceof WorkoutCommandError ? error.code : 'set.skip-failed',
      values: captureFormValues(formData, ['reason']),
    }
  }
  revalidatePath(`/workouts/${sessionId}`)
  return { success: true }
}

export async function proposeExerciseSubstitutionAction(
  formData: FormData,
): Promise<WorkoutActionResult> {
  const sessionId = String(formData.get('sessionId') ?? '')
  const actor = await requireActorForWorkout(sessionId)
  try {
    await proposeExerciseSubstitution({
      userId: actor.userId,
      sessionId,
      sessionExerciseId: String(formData.get('sessionExerciseId') ?? ''),
      commandId: String(formData.get('commandId') ?? ''),
      requestedExerciseCode: String(formData.get('requestedExerciseCode') ?? ''),
    })
  } catch (error) {
    return {
      success: false,
      code:
        error instanceof WorkoutCommandError
          ? error.code
          : 'substitution.proposal-failed',
      values: captureFormValues(formData, ['requestedExerciseCode']),
    }
  }

  return { success: false, code: 'substitution.unapproved' }
}

export async function pauseAction(formData: FormData): Promise<WorkoutActionResult> {
  const sessionId = String(formData.get('sessionId') ?? '')
  const actor = await requireActorForWorkout(sessionId)
  try {
    await setSessionPaused(actor.userId, sessionId, true)
  } catch (error) {
    return {
      success: false,
      code: error instanceof WorkoutCommandError ? error.code : 'session.pause-failed',
    }
  }
  revalidatePath(`/workouts/${sessionId}`)
  return { success: true }
}

export async function resumeAction(formData: FormData): Promise<WorkoutActionResult> {
  const sessionId = String(formData.get('sessionId') ?? '')
  const actor = await requireActorForWorkout(sessionId)
  try {
    await setSessionPaused(actor.userId, sessionId, false)
  } catch (error) {
    return {
      success: false,
      code: error instanceof WorkoutCommandError ? error.code : 'session.resume-failed',
    }
  }
  revalidatePath(`/workouts/${sessionId}`)
  return { success: true }
}

export async function reportPainAction(formData: FormData): Promise<WorkoutActionResult> {
  const sessionId = String(formData.get('sessionId') ?? '')
  const actor = await requireActorForWorkout(sessionId)
  try {
    await reportPain({
      userId: actor.userId,
      sessionId,
      commandId: String(formData.get('commandId') ?? ''),
      details: String(formData.get('details') ?? ''),
    })
  } catch (error) {
    return {
      success: false,
      code: error instanceof WorkoutCommandError ? error.code : 'safety.report-failed',
      values: captureFormValues(formData, ['details']),
    }
  }
  revalidatePath(`/workouts/${sessionId}`)
  return { success: true }
}

export async function completeWorkoutAction(
  formData: FormData,
): Promise<WorkoutActionResult> {
  const sessionId = String(formData.get('sessionId') ?? '')
  const actor = await requireActorForWorkout(sessionId)
  try {
    await completeWorkout({
      userId: actor.userId,
      sessionId,
      commandId: String(formData.get('commandId') ?? ''),
      noPainAttested: formData.get('noPainAttested') === 'on',
    })
  } catch (error) {
    return {
      success: false,
      code: error instanceof WorkoutCommandError ? error.code : 'session.complete-failed',
      values: captureFormValues(formData, ['noPainAttested']),
    }
  }
  redirect(`/history/${sessionId}`)
}

export async function abandonWorkoutAction(
  formData: FormData,
): Promise<WorkoutActionResult> {
  const sessionId = String(formData.get('sessionId') ?? '')
  const actor = await requireActorForWorkout(sessionId)
  const reason = String(formData.get('reason') ?? '')
  try {
    await abandonWorkout(actor.userId, sessionId, reason)
  } catch (error) {
    return {
      success: false,
      code: error instanceof WorkoutCommandError ? error.code : 'session.abandon-failed',
      values: { reason },
    }
  }
  redirect('/today')
}
