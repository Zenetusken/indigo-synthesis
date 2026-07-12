'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getAthleteProfile } from '@/modules/athletes/application/profile'
import { inputLoadToGrams } from '@/modules/athletes/domain/units'
import { requireActor } from '@/modules/identity/server/actor'
import {
  abandonWorkout,
  completeSet,
  completeWorkout,
  reportPain,
  setSessionPaused,
  skipSet,
  WorkoutCommandError,
} from '@/modules/training/application/workouts'

function workoutError(sessionId: string, code: string): never {
  redirect(`/workouts/${sessionId}?error=${encodeURIComponent(code)}` as never)
}

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

export async function completeSetAction(formData: FormData): Promise<void> {
  const actor = await requireActor()
  const sessionId = String(formData.get('sessionId') ?? '')

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
    workoutError(
      sessionId,
      error instanceof WorkoutCommandError ? error.code : 'set.save-failed',
    )
  }

  revalidatePath(`/workouts/${sessionId}`)
}

export async function skipSetAction(formData: FormData): Promise<void> {
  const actor = await requireActor()
  const sessionId = String(formData.get('sessionId') ?? '')
  try {
    await skipSet({
      userId: actor.userId,
      sessionId,
      setId: String(formData.get('setId') ?? ''),
      commandId: String(formData.get('commandId') ?? ''),
      reason: String(formData.get('reason') ?? ''),
    })
  } catch (error) {
    workoutError(
      sessionId,
      error instanceof WorkoutCommandError ? error.code : 'set.skip-failed',
    )
  }
  revalidatePath(`/workouts/${sessionId}`)
}

export async function pauseAction(formData: FormData): Promise<void> {
  const actor = await requireActor()
  const sessionId = String(formData.get('sessionId') ?? '')
  try {
    await setSessionPaused(actor.userId, sessionId, true)
  } catch (error) {
    workoutError(
      sessionId,
      error instanceof WorkoutCommandError ? error.code : 'session.pause-failed',
    )
  }
  revalidatePath(`/workouts/${sessionId}`)
}

export async function resumeAction(formData: FormData): Promise<void> {
  const actor = await requireActor()
  const sessionId = String(formData.get('sessionId') ?? '')
  try {
    await setSessionPaused(actor.userId, sessionId, false)
  } catch (error) {
    workoutError(
      sessionId,
      error instanceof WorkoutCommandError ? error.code : 'session.resume-failed',
    )
  }
  revalidatePath(`/workouts/${sessionId}`)
}

export async function reportPainAction(formData: FormData): Promise<void> {
  const actor = await requireActor()
  const sessionId = String(formData.get('sessionId') ?? '')
  try {
    await reportPain(actor.userId, sessionId, String(formData.get('details') ?? ''))
  } catch (error) {
    workoutError(
      sessionId,
      error instanceof WorkoutCommandError ? error.code : 'safety.report-failed',
    )
  }
  revalidatePath(`/workouts/${sessionId}`)
}

export async function completeWorkoutAction(formData: FormData): Promise<void> {
  const actor = await requireActor()
  const sessionId = String(formData.get('sessionId') ?? '')
  try {
    await completeWorkout({
      userId: actor.userId,
      sessionId,
      commandId: String(formData.get('commandId') ?? ''),
      noPainAttested: formData.get('noPainAttested') === 'on',
    })
  } catch (error) {
    workoutError(
      sessionId,
      error instanceof WorkoutCommandError ? error.code : 'session.complete-failed',
    )
  }
  redirect(`/history/${sessionId}` as never)
}

export async function abandonWorkoutAction(formData: FormData): Promise<void> {
  const actor = await requireActor()
  const sessionId = String(formData.get('sessionId') ?? '')
  try {
    await abandonWorkout(actor.userId, sessionId)
  } catch (error) {
    workoutError(
      sessionId,
      error instanceof WorkoutCommandError ? error.code : 'session.abandon-failed',
    )
  }
  redirect('/today')
}
