'use server'

import { revalidatePath } from 'next/cache'
import {
  LocalUserCredentialError,
  LocalUserEmailConflictError,
  LocalUserInputError,
} from '@/modules/identity/application/local-users'
import {
  issueMemberReset,
  MemberResetError,
} from '@/modules/identity/recovery/member-reset'
import { requireActor } from '@/modules/identity/server/actor'
import { isCredentialLifecycleRejection } from '@/modules/identity/server/credential-lifecycle'
import { createLocalUserAsOwner } from '@/modules/identity/server/local-users'
import { getWebCredentialContext } from '@/modules/identity/server/web-credential-context'

export type LocalUserActionState = {
  readonly errors: readonly string[]
  readonly createdEmail: string | null
}

export type MemberResetIssueActionState = {
  readonly errors: readonly string[]
  readonly issued: {
    readonly targetUserId: string
    readonly code: string
    readonly expiresAt: string
  } | null
}

export async function createLocalUserAction(
  _previous: LocalUserActionState,
  formData: FormData,
): Promise<LocalUserActionState> {
  const actor = await requireActor()
  const requestContext = await getWebCredentialContext()
  if (!requestContext) {
    return { errors: ['Authentication request denied.'], createdEmail: null }
  }

  try {
    const created = await createLocalUserAsOwner({
      actor,
      name: String(formData.get('name') ?? ''),
      email: String(formData.get('email') ?? ''),
      initialPassword: String(formData.get('initialPassword') ?? ''),
      currentPassword: String(formData.get('currentPassword') ?? ''),
      requestContext,
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
    if (error instanceof LocalUserCredentialError) {
      return {
        errors: ['The owner password was not accepted.'],
        createdEmail: null,
      }
    }
    if (isCredentialLifecycleRejection(error)) {
      return { errors: ['Authentication request denied.'], createdEmail: null }
    }
    throw error
  }
}

export async function issueMemberResetAction(
  _previous: MemberResetIssueActionState,
  formData: FormData,
): Promise<MemberResetIssueActionState> {
  const actor = await requireActor()
  const requestContext = await getWebCredentialContext()
  if (!requestContext) {
    return { errors: ['Authentication request denied.'], issued: null }
  }

  const targetUserId = String(formData.get('targetUserId') ?? '')
  try {
    const issued = await issueMemberReset({
      actor,
      targetUserId,
      currentPassword: String(formData.get('currentPassword') ?? ''),
      requestContext,
    })
    return {
      errors: [],
      issued: {
        targetUserId,
        code: issued.code,
        expiresAt: issued.expiresAt.toISOString(),
      },
    }
  } catch (error) {
    if (error instanceof MemberResetError) {
      return { errors: [error.message], issued: null }
    }
    if (isCredentialLifecycleRejection(error)) {
      return { errors: ['Authentication request denied.'], issued: null }
    }
    throw error
  }
}
