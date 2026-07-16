import { eq } from 'drizzle-orm'
import {
  getProductionDataPortabilityDestructiveMutationPort,
  type InstanceResetMutationResult,
  type SubjectDeletionMutationResult,
} from '@/composition/data-portability-destructive-mutations'
import {
  issueInstanceResetActionBinding,
  issueTraineeDataDeletionActionBinding,
} from '@/modules/identity/infrastructure/action-binding'
import {
  issueInstanceResetMutationCommand,
  issueTraineeDataDeletionMutationCommand,
} from '@/modules/identity/infrastructure/destructive-mutation'
import { getDb } from '@/platform/db/client'
import { installationState, session } from '@/platform/db/schema'

export type DestructivePlanSubmission = Readonly<{
  id: string
  digest: string
  expiresAt: Date
}>

type DestructiveSubmission = Readonly<{
  sessionToken: string
  plan: DestructivePlanSubmission
  password: string
  commandEnteredAt?: Date
  acknowledged?: boolean
  renderedBinding?: RenderedDestructiveBinding
}>

export type RenderedDestructiveBinding = Readonly<{
  actionBinding: string
}>

const requestContext = Object.freeze({
  channel: 'web' as const,
  clientAddress: '192.0.2.254',
})

async function currentAuthority(sessionToken: string): Promise<
  Readonly<{
    expectedEpoch: string
    sessionId: string
    actorUserId: string
    sessionExpiresAt: Date
  }>
> {
  const rows = await getDb()
    .select({
      expectedEpoch: installationState.productMutationEpoch,
      sessionId: session.id,
      actorUserId: session.userId,
      sessionExpiresAt: session.expiresAt,
    })
    .from(installationState)
    .innerJoin(session, eq(session.token, sessionToken))
    .where(eq(installationState.singleton, 1))
    .limit(2)
  const authority = rows[0]
  if (rows.length !== 1 || !authority) {
    throw new Error(
      'Integration destructive command requires one current session authority.',
    )
  }
  return Object.freeze({
    ...authority,
    sessionExpiresAt: new Date(authority.sessionExpiresAt.getTime()),
  })
}

export async function renderSubjectDeletionIntegrationBinding(input: {
  readonly sessionToken: string
  readonly plan: DestructivePlanSubmission
  readonly renderedAt?: Date
}): Promise<RenderedDestructiveBinding> {
  const renderedAt = new Date((input.renderedAt ?? new Date()).getTime())
  const authority = await currentAuthority(input.sessionToken)
  return Object.freeze({
    actionBinding: issueTraineeDataDeletionActionBinding(
      {
        ...authority,
        planId: input.plan.id,
        planDigest: input.plan.digest,
        planExpiresAt: input.plan.expiresAt,
      },
      renderedAt,
    ),
  })
}

export async function renderInstanceResetIntegrationBinding(input: {
  readonly sessionToken: string
  readonly plan: DestructivePlanSubmission
  readonly renderedAt?: Date
}): Promise<RenderedDestructiveBinding> {
  const renderedAt = new Date((input.renderedAt ?? new Date()).getTime())
  const authority = await currentAuthority(input.sessionToken)
  return Object.freeze({
    actionBinding: issueInstanceResetActionBinding(
      {
        ...authority,
        planId: input.plan.id,
        planDigest: input.plan.digest,
        planExpiresAt: input.plan.expiresAt,
      },
      renderedAt,
    ),
  })
}

/**
 * Enters the real production subject-deletion composition with the same opaque form
 * binding and nominal Identity command that a server action would supply. The raw
 * session token exists only in this integration-only issuer and is re-attested by the
 * production capture/recheck path.
 */
export async function submitSubjectDeletionThroughProductionPort(
  input: DestructiveSubmission,
): Promise<SubjectDeletionMutationResult> {
  const commandEnteredAt = new Date((input.commandEnteredAt ?? new Date()).getTime())
  const renderedBinding =
    input.renderedBinding ??
    (await renderSubjectDeletionIntegrationBinding({
      sessionToken: input.sessionToken,
      plan: input.plan,
      renderedAt: commandEnteredAt,
    }))
  const command = issueTraineeDataDeletionMutationCommand({
    actionBinding: renderedBinding.actionBinding,
    planId: input.plan.id,
    planDigest: input.plan.digest,
    currentPassword: input.password,
    typedConfirmation: 'DELETE',
    acknowledged: input.acknowledged ?? true,
    commandEnteredAt,
    requestContext,
    verifiedSessionToken: input.sessionToken,
  })
  return getProductionDataPortabilityDestructiveMutationPort().deleteSubject(command)
}

/** Enters the real production reset composition through an owner-bound nominal command. */
export async function submitInstanceResetThroughProductionPort(
  input: DestructiveSubmission,
): Promise<InstanceResetMutationResult> {
  const commandEnteredAt = new Date((input.commandEnteredAt ?? new Date()).getTime())
  const renderedBinding =
    input.renderedBinding ??
    (await renderInstanceResetIntegrationBinding({
      sessionToken: input.sessionToken,
      plan: input.plan,
      renderedAt: commandEnteredAt,
    }))
  const command = issueInstanceResetMutationCommand({
    actionBinding: renderedBinding.actionBinding,
    planId: input.plan.id,
    planDigest: input.plan.digest,
    currentPassword: input.password,
    typedConfirmation: 'RESET',
    acknowledged: input.acknowledged ?? true,
    commandEnteredAt,
    requestContext,
    verifiedSessionToken: input.sessionToken,
  })
  return getProductionDataPortabilityDestructiveMutationPort().resetInstance(command)
}
