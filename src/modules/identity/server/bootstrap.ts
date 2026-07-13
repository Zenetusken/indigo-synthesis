'use server'

import { revalidatePath } from 'next/cache'
import { getInstallationStatus } from '../application/installation'
import {
  createOwnerWithBootstrapCode,
  OwnerBootstrapError,
} from '../bootstrap/owner-bootstrap'

export type BootstrapOwnerResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'rejected' }

export async function bootstrapOwner(input: {
  readonly name: string
  readonly email: string
  readonly password: string
  readonly code: string
}): Promise<BootstrapOwnerResult> {
  try {
    await createOwnerWithBootstrapCode(input)
    revalidatePath('/', 'layout')
    return { kind: 'created' }
  } catch (error) {
    if (
      error instanceof OwnerBootstrapError &&
      error.code === 'owner-bootstrap.instance-closed'
    ) {
      revalidatePath('/', 'layout')
      return { kind: 'closed' }
    }
    return { kind: 'rejected' }
  }
}

export async function getOwnerBootstrapStatus(): Promise<'open' | 'closed'> {
  const status = (await getInstallationStatus()).kind
  if (status === 'closed') revalidatePath('/', 'layout')
  return status
}
