'use server'

import { redirect } from 'next/navigation'
import { ZodError } from 'zod'
import {
  type AthleteSetupInput,
  exerciseCodes,
  saveAthleteProfile,
} from '@/modules/athletes/application/profile'
import { inputLoadToGrams } from '@/modules/athletes/domain/units'
import { requireActor } from '@/modules/identity/server/actor'

export type SetupActionState = {
  readonly errors: readonly string[]
}

function numberFrom(formData: FormData, name: string): number {
  const value = Number(formData.get(name))
  return Number.isFinite(value) ? value : Number.NaN
}

export async function saveSetupAction(
  _previousState: SetupActionState,
  formData: FormData,
): Promise<SetupActionState> {
  const actor = await requireActor()
  const units = String(formData.get('units')) as AthleteSetupInput['units']
  const startingLoads = Object.fromEntries(
    exerciseCodes.map((exerciseCode) => [
      exerciseCode,
      inputLoadToGrams(numberFrom(formData, `load-${exerciseCode}`), units),
    ]),
  ) as AthleteSetupInput['startingLoads']

  const input = {
    units,
    timezone: String(formData.get('timezone') ?? ''),
    experience: String(formData.get('experience')),
    sessionMinutes: numberFrom(formData, 'sessionMinutes'),
    adultAttested: formData.get('adultAttested') === 'on',
    techniqueAttested: formData.get('techniqueAttested') === 'on',
    restrictionStatus: String(formData.get('restrictionStatus')),
    limitations: String(formData.get('limitations') ?? '').trim() || null,
    weekdays: formData.getAll('weekdays').map(Number),
    equipment: formData.getAll('equipment').map(String),
    startingLoads,
  }

  try {
    await saveAthleteProfile(actor.userId, input as AthleteSetupInput)
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        errors: error.issues.map((issue) => issue.message),
      }
    }

    return {
      errors: ['The profile could not be saved. Your existing data was not changed.'],
    }
  }

  redirect('/program')
}
