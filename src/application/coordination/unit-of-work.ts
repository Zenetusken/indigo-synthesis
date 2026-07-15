import type {
  ContentLockedUnitOfWorkExecution,
  ContentLockPlanBindings,
  ContentLockPlanShape,
  ContentLockTransactionScope,
  LockedContentPlanAttestor,
  VerifiedContentLockPlan,
} from './content-lock-plan'
import type {
  AuthenticatedDestructiveAuthority,
  AuthenticatedSessionAuthority,
  CredentialLifecycleMutationAuthority,
  CredentialLifecycleMutationKind,
  DestructivePurpose,
  DestructiveReauthenticationAttemptAuthority,
  ExpiredSessionMaintenanceAuthority,
  HostBootstrapMutationAuthority,
  HostBootstrapMutationKind,
  InstallationMutationEpoch,
  OwnerRecoveryIssueAuthority,
} from './mutation-authority'
import type {
  PrelockedSessionLease,
  PrelockedSessionOperation,
} from './prelocked-session'

export type ReadCommittedReadWrite = {
  readonly isolation: 'read-committed'
  readonly access: 'read-write'
}

export type SerializableReadWrite = {
  readonly isolation: 'serializable'
  readonly access: 'read-write'
}

export type RepeatableReadReadOnly = {
  readonly isolation: 'repeatable-read'
  readonly access: 'read-only'
}

export type ReadWriteTransactionMode = ReadCommittedReadWrite | SerializableReadWrite
export type ReadOnlyTransactionMode = RepeatableReadReadOnly
export type TransactionMode = ReadWriteTransactionMode | ReadOnlyTransactionMode

type NoContentLockPlan = { readonly kind: 'none' }

type VerifiedContentLockPlanInput<Shape extends ContentLockPlanShape> = {
  readonly kind: 'verified'
  readonly plan: VerifiedContentLockPlan<Shape>
  /** Exact server-issued values re-bound privately by Platform before UoW admission. */
  readonly bindings: ContentLockPlanBindings & { readonly shape: Shape }
}

export type UnitOfWorkContent =
  | NoContentLockPlan
  | {
      [Shape in ContentLockPlanShape]: VerifiedContentLockPlanInput<Shape>
    }[ContentLockPlanShape]

type RequestLifecycle = {
  readonly expectedEpoch: InstallationMutationEpoch
  readonly signal?: AbortSignal
}

type OrdinarySession = { readonly kind: 'ordinary' }
type PrelockedSession<Operation extends PrelockedSessionOperation> = {
  readonly kind: 'prelocked'
  readonly lease: PrelockedSessionLease<Operation>
}

type OrdinaryProductMutationBase = RequestLifecycle & {
  readonly authority: AuthenticatedSessionAuthority
  readonly session: OrdinarySession
  /** Server-selected workflow identity, independently rebound to the sealed plan purpose. */
  readonly workflowPurpose: string
  readonly productFence: 'shared'
  readonly mode: ReadCommittedReadWrite
}

/** Global operations are content-free only through a verified `none` plan. */
export type GlobalProductMutationRequest = Omit<
  OrdinaryProductMutationBase,
  'authority'
> & {
  readonly authority: AuthenticatedSessionAuthority & { readonly expectedRole: 'owner' }
} & (
    | {
        readonly operation: 'global-product-mutation'
        readonly subjectLock: null
        readonly content: VerifiedContentLockPlanInput<'none'>
      }
    | {
        readonly operation: 'content-release-revocation'
        readonly subjectLock: null
        readonly content: VerifiedContentLockPlanInput<'release-revocation'>
      }
  )

type ExclusiveSubjectLock = {
  readonly subjectUserId: string
  readonly mode: 'exclusive'
}

/** Every subject mutation names the exact content-plan shape it must consume. */
export type SubjectProductMutationRequest = OrdinaryProductMutationBase & {
  readonly subjectLock: ExclusiveSubjectLock
} & (
    | {
        readonly operation: 'subject-product-mutation'
        readonly content: VerifiedContentLockPlanInput<'none'>
      }
    | {
        readonly operation: 'current-publication.initial'
        readonly content: VerifiedContentLockPlanInput<'current-publication.initial'>
      }
    | {
        readonly operation: 'current-publication.existing'
        readonly content: VerifiedContentLockPlanInput<'current-publication.existing'>
      }
    | {
        readonly operation: 'stale-regeneration'
        readonly content: VerifiedContentLockPlanInput<'stale-regeneration'>
      }
    | {
        readonly operation: 'correction-closure'
        readonly content: VerifiedContentLockPlanInput<'correction-closure'>
      }
  )

export type SubjectExportRequest = RequestLifecycle & {
  readonly operation: 'subject-export'
  readonly authority: AuthenticatedSessionAuthority
  readonly session: OrdinarySession
  readonly productFence: 'shared'
  readonly subjectLock: {
    readonly subjectUserId: string
    readonly mode: 'shared'
  }
  readonly content: NoContentLockPlan
  readonly mode: RepeatableReadReadOnly
}

export type SubjectDeletionRequest = RequestLifecycle & {
  readonly operation: 'subject-deletion'
  readonly authority: Extract<
    AuthenticatedDestructiveAuthority,
    { readonly purpose: 'trainee-data-deletion' }
  >
  readonly session: PrelockedSession<'subject-deletion'>
  readonly productFence: 'shared'
  readonly subjectLock: ExclusiveSubjectLock
  readonly content: NoContentLockPlan
  readonly mode: SerializableReadWrite
}

export type InstanceResetRequest = RequestLifecycle & {
  readonly operation: 'instance-reset'
  readonly authority: Extract<
    AuthenticatedDestructiveAuthority,
    { readonly purpose: 'instance-reset' }
  >
  readonly session: PrelockedSession<'instance-reset'>
  readonly productFence: 'exclusive'
  readonly subjectLock: null
  readonly content: NoContentLockPlan
  readonly mode: SerializableReadWrite
}

type DestructivePrelockedOperationByPurpose = {
  readonly 'trainee-data-deletion': 'subject-deletion'
  readonly 'instance-reset': 'instance-reset'
  readonly 'member-reset-issue': 'member-reset-issue'
  readonly 'local-user-create': 'local-user-create'
}

type DestructiveCredentialRequestBase<Operation extends PrelockedSessionOperation> =
  RequestLifecycle & {
    readonly session: PrelockedSession<Operation>
    readonly productFence: 'shared'
    readonly subjectLock: null
    readonly content: NoContentLockPlan
  }

type DestructiveReauthenticationAttemptRequestFor<Purpose extends DestructivePurpose> =
  DestructiveCredentialRequestBase<DestructivePrelockedOperationByPurpose[Purpose]> & {
    readonly operation: 'destructive-reauthentication-attempt'
    readonly authority: Extract<
      DestructiveReauthenticationAttemptAuthority,
      { readonly purpose: Purpose }
    >
    readonly mode: ReadCommittedReadWrite
  }

export type DestructiveReauthenticationAttemptRequest = {
  [Purpose in DestructivePurpose]: DestructiveReauthenticationAttemptRequestFor<Purpose>
}[DestructivePurpose]

type DestructiveIdentityMutationRequestFor<
  Purpose extends 'member-reset-issue' | 'local-user-create',
> = DestructiveCredentialRequestBase<DestructivePrelockedOperationByPurpose[Purpose]> & {
  readonly operation: 'destructive-identity-mutation'
  readonly authority: Extract<
    AuthenticatedDestructiveAuthority,
    { readonly purpose: Purpose }
  >
  readonly mode: Purpose extends 'member-reset-issue'
    ? SerializableReadWrite
    : ReadCommittedReadWrite
}

export type DestructiveIdentityMutationRequest = {
  [Purpose in
    | 'member-reset-issue'
    | 'local-user-create']: DestructiveIdentityMutationRequestFor<Purpose>
}['member-reset-issue' | 'local-user-create']

type CredentialLifecycleTransactionModeByMutation = {
  readonly 'email-sign-in': ReadCommittedReadWrite
  readonly 'checked-sign-out': ReadCommittedReadWrite
  readonly 'member-reset-redemption': SerializableReadWrite
  readonly 'owner-recovery-web-redemption': SerializableReadWrite
  readonly 'owner-recovery-cli-redemption': SerializableReadWrite
}

type CredentialLifecycleMutationRequestFor<
  Mutation extends CredentialLifecycleMutationKind,
> = RequestLifecycle & {
  readonly operation: 'credential-lifecycle-mutation'
  readonly authority: Extract<
    CredentialLifecycleMutationAuthority,
    { readonly mutation: Mutation }
  >
  readonly session: PrelockedSession<Mutation>
  readonly productFence: 'shared'
  readonly subjectLock: null
  readonly content: NoContentLockPlan
  readonly mode: CredentialLifecycleTransactionModeByMutation[Mutation]
}

export type CredentialLifecycleMutationRequest = {
  [Mutation in CredentialLifecycleMutationKind]: CredentialLifecycleMutationRequestFor<Mutation>
}[CredentialLifecycleMutationKind]

type HostBootstrapPrelockedOperationByMutation = {
  readonly issuance: 'bootstrap-issuance'
  readonly redemption: 'bootstrap-redemption'
}

type HostBootstrapMutationRequestFor<Mutation extends HostBootstrapMutationKind> =
  RequestLifecycle & {
    readonly operation: 'host-bootstrap-mutation'
    readonly authority: Extract<
      HostBootstrapMutationAuthority,
      { readonly mutation: Mutation }
    >
    readonly session: PrelockedSession<
      HostBootstrapPrelockedOperationByMutation[Mutation]
    >
    readonly productFence: 'shared'
    readonly subjectLock: null
    readonly content: NoContentLockPlan
    readonly mode: SerializableReadWrite
  }

export type HostBootstrapMutationRequest = {
  [Mutation in HostBootstrapMutationKind]: HostBootstrapMutationRequestFor<Mutation>
}[HostBootstrapMutationKind]

export type HostMaintenanceRequest = RequestLifecycle &
  (
    | {
        readonly operation: 'host-maintenance'
        readonly authority: OwnerRecoveryIssueAuthority
        readonly session: PrelockedSession<'owner-recovery-issue'>
        readonly productFence: 'shared'
        readonly subjectLock: null
        readonly content: NoContentLockPlan
        readonly mode: SerializableReadWrite
      }
    | {
        readonly operation: 'host-maintenance'
        readonly authority: ExpiredSessionMaintenanceAuthority
        readonly session: PrelockedSession<'expired-session-maintenance'>
        readonly productFence: 'shared'
        readonly subjectLock: null
        readonly content: NoContentLockPlan
        readonly mode: ReadCommittedReadWrite
      }
  )

export type ReadOnlyUnitOfWorkRequest = SubjectExportRequest

export type ContentLockedUnitOfWorkRequest =
  | GlobalProductMutationRequest
  | SubjectProductMutationRequest

export type ReadWriteUnitOfWorkRequest =
  | ContentLockedUnitOfWorkRequest
  | SubjectDeletionRequest
  | InstanceResetRequest
  | DestructiveReauthenticationAttemptRequest
  | DestructiveIdentityMutationRequest
  | CredentialLifecycleMutationRequest
  | HostBootstrapMutationRequest
  | HostMaintenanceRequest

export type UnitOfWorkRequest = ReadOnlyUnitOfWorkRequest | ReadWriteUnitOfWorkRequest

export type UnitOfWorkContentScope =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'verified'
      readonly transactionScope: ContentLockTransactionScope
      readonly attestor: LockedContentPlanAttestor
    }

export type UnitOfWorkScope<Gateways> = {
  readonly gateways: Gateways
  readonly content: UnitOfWorkContentScope
}

/**
 * Infrastructure-free transaction boundary. The closed request union fixes every legal
 * authority/session/fence/subject/content/isolation combination. Write gateways extend the read
 * aggregate, while repeatable-read callbacks see only the read aggregate.
 */
export interface UnitOfWork<ReadGateways, WriteGateways extends ReadGateways> {
  run<Result>(
    request: ContentLockedUnitOfWorkRequest,
    callback: (scope: UnitOfWorkScope<WriteGateways>) => Promise<Result>,
  ): ContentLockedUnitOfWorkExecution<Result>

  run<Result>(
    request: ReadOnlyUnitOfWorkRequest,
    callback: (scope: UnitOfWorkScope<ReadGateways>) => Promise<Result>,
  ): Promise<Result>

  run<Result>(
    request: Exclude<ReadWriteUnitOfWorkRequest, ContentLockedUnitOfWorkRequest>,
    callback: (scope: UnitOfWorkScope<WriteGateways>) => Promise<Result>,
  ): Promise<Result>
}
