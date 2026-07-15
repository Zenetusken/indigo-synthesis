'use server'

import { revalidatePath } from 'next/cache'
import { createOwnerFromWebWithBootstrapCode } from '@/composition/identity-bootstrap-mutations'
import type { OwnerBootstrapActionBinding } from '../application/action-binding'
import { getInstallationStatus } from '../application/installation'
import { OwnerBootstrapError } from '../bootstrap/owner-bootstrap'
import { issueOwnerBootstrapActionBinding } from '../infrastructure/action-binding'
import { admitCredentialLoadShedder } from '../infrastructure/credential-load-shedder'
import { getServerBootstrapInstallationState } from '../infrastructure/installation'
import { getWebCredentialContext } from './web-credential-context'

export type BootstrapOwnerResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'rejected' }

export type BootstrapPageInstallation =
  | { readonly kind: 'closed' }
  | {
      readonly kind: 'open'
      readonly actionBinding: OwnerBootstrapActionBinding
    }

export async function bootstrapOwner(input: {
  readonly name: string
  readonly email: string
  readonly password: string
  readonly code: string
  readonly actionBinding: unknown
}): Promise<BootstrapOwnerResult> {
  const requestContext = await getWebCredentialContext()
  if (
    !requestContext ||
    !admitCredentialLoadShedder({
      purpose: 'owner-bootstrap',
      email: input.email,
      clientAddress: requestContext.clientAddress,
    }).admitted
  ) {
    return { kind: 'rejected' }
  }

  try {
    await createOwnerFromWebWithBootstrapCode(input)
    revalidatePath('/', 'layout')
    return { kind: 'created' }
  } catch (error) {
    if (error instanceof OwnerBootstrapError) {
      if (error.code === 'owner-bootstrap.instance-closed') {
        revalidatePath('/', 'layout')
        return { kind: 'closed' }
      }
      return { kind: 'rejected' }
    }
    throw error
  }
}

/** Returns no raw installation lifecycle value to the page or browser. */
export async function getBootstrapPageInstallation(): Promise<BootstrapPageInstallation> {
  const installation = await getServerBootstrapInstallationState()
  if (installation.kind === 'closed') return installation
  return {
    kind: 'open',
    actionBinding: issueOwnerBootstrapActionBinding({
      expectedEpoch: installation.productMutationEpoch,
    }),
  }
}

export async function getOwnerBootstrapStatus(): Promise<'open' | 'closed'> {
  const status = (await getInstallationStatus()).kind
  if (status === 'closed') revalidatePath('/', 'layout')
  return status
}
