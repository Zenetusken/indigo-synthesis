'use server'

import { revalidatePath } from 'next/cache'
import {
  LocalUserEmailConflictError,
  LocalUserInputError,
} from '@/modules/identity/application/local-users'
import { requireActor } from '@/modules/identity/server/actor'
import { createLocalUserAsOwner } from '@/modules/identity/server/local-users'

export type LocalUserActionState = {
  readonly errors: readonly string[]
  readonly createdEmail: string | null
}

export async function createLocalUserAction(
  _previous: LocalUserActionState,
  formData: FormData,
): Promise<LocalUserActionState> {
  const actor = await requireActor()

  try {
    const created = await createLocalUserAsOwner(actor, {
      name: String(formData.get('name') ?? ''),
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
    })
    revalidatePath('/settings')
    return { errors: [], createdEmail: created.email }
  } catch (error) {
    if (error instanceof LocalUserInputError) {
      return { errors: error.issues, createdEmail: null }
    }
    if (error instanceof LocalUserEmailConflictError) {
      return { errors: [error.message], createdEmail: null }
    }
    return { errors: ['The local user could not be created.'], createdEmail: null }
  }
}
