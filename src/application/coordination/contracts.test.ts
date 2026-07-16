import { describe, expect, it } from 'vitest'
import type {
  ContentLockSourceProjection,
  PreparedContentLockPlan,
  VerifiedContentLockPlan,
} from './content-lock-plan'
import { CoordinationError } from './errors'
import type {
  AuthenticatedSessionReference,
  CredentialLifecycleAuthority,
  InstallationMutationEpoch,
} from './mutation-authority'
import type { PrelockedSessionIntent, PrelockedSessionLease } from './prelocked-session'
import type {
  GlobalProductMutationRequest,
  InstanceResetRequest,
  SubjectExportRequest,
  UnitOfWork,
} from './unit-of-work'

type ReadGateways = {
  read(): Promise<void>
}

type WriteGateways = ReadGateways & {
  write(): Promise<void>
}

declare const subjectExportRequest: SubjectExportRequest
declare const unitOfWork: UnitOfWork<ReadGateways, WriteGateways>
declare const signInAuthority: CredentialLifecycleAuthority<'email-sign-in'>
declare const signInLease: PrelockedSessionLease<'email-sign-in'>
declare const methodologyIssuance: ContentLockSourceProjection<
  'issuance',
  'methodology-target'
>

function compileTimeNominalityChecks(): void {
  const plainObject = {}

  // @ts-expect-error Callback-scoped capabilities cannot be forged structurally.
  const prelocked: PrelockedSessionLease<'email-sign-in'> = plainObject
  // @ts-expect-error Lock inputs are sealed; a caller cannot select a trusted operation.
  const resetIntent: PrelockedSessionIntent<'instance-reset'> = plainObject
  // @ts-expect-error A sign-in lease cannot be consumed by instance reset.
  const resetLease: PrelockedSessionLease<'instance-reset'> = signInLease
  // @ts-expect-error Signed session identity cannot be accepted from form-shaped data.
  const session: AuthenticatedSessionReference = plainObject
  // @ts-expect-error Installation epochs are minted only by their infrastructure adapter.
  const epoch: InstallationMutationEpoch = plainObject
  // @ts-expect-error Prepared and verified plans are distinct nominal phases.
  const verified: VerifiedContentLockPlan = {} as PreparedContentLockPlan
  // @ts-expect-error Issuance projections cannot be used for transaction attestation.
  const transactionProjection: ContentLockSourceProjection<'transaction'> =
    methodologyIssuance
  // @ts-expect-error Owner-slot identity survives the opaque projection boundary.
  const programsProjection: ContentLockSourceProjection<'issuance', 'programs-current'> =
    methodologyIssuance
  // @ts-expect-error A sign-in capability cannot be relabelled as checked sign-out.
  const signOutAuthority: CredentialLifecycleAuthority<'checked-sign-out'> =
    signInAuthority

  type EpochlessExport = Omit<SubjectExportRequest, 'expectedEpoch'>
  const epochlessExport = null as unknown as EpochlessExport
  // @ts-expect-error Every request must carry its pre-queue installation epoch.
  const missingEpochRequest: SubjectExportRequest = epochlessExport

  type UnderlockedReset = Omit<InstanceResetRequest, 'productFence'> & {
    readonly productFence: 'shared'
  }
  const underlockedReset = null as unknown as UnderlockedReset
  // @ts-expect-error Instance reset is fixed to the exclusive product fence.
  const resetRequest: InstanceResetRequest = underlockedReset

  type ReleaseRevocationRequest = Extract<
    GlobalProductMutationRequest,
    { readonly operation: 'content-release-revocation' }
  >
  type RevocationWithoutPlan = Omit<ReleaseRevocationRequest, 'content'> & {
    readonly content: { readonly kind: 'none' }
  }
  const revocationWithoutPlan = null as unknown as RevocationWithoutPlan
  // @ts-expect-error Revocation cannot omit its verified release plan.
  const revocationRequest: ReleaseRevocationRequest = revocationWithoutPlan

  void unitOfWork.run(subjectExportRequest, async ({ gateways }) => {
    await gateways.read()
    // @ts-expect-error Repeatable-read scope does not expose write gateways.
    await gateways.write()
  })

  void prelocked
  void resetIntent
  void resetLease
  void session
  void epoch
  void verified
  void transactionProjection
  void programsProjection
  void signOutAuthority
  void missingEpochRequest
  void resetRequest
  void revocationRequest
}

describe('application coordination contracts', () => {
  it('preserves stable failure codes without exposing adapter details', () => {
    const error = new CoordinationError('uow.lock-timeout')

    expect(error).toMatchObject({
      name: 'CoordinationError',
      code: 'uow.lock-timeout',
      message: 'The operation could not acquire its workflow lock in time.',
      retryable: true,
      disposition: null,
    })

    expect(new CoordinationError('content-lock-plan.too-large')).toMatchObject({
      retryable: false,
      disposition: 'no-self-service',
    })
  })

  it('keeps capabilities, owners, lifecycle values, and access scopes nominal', () => {
    expect(compileTimeNominalityChecks).toBeTypeOf('function')
  })
})
