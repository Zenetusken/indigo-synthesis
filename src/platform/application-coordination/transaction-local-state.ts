import type { UnitOfWorkRequest } from '@/application/coordination'

export type TransactionLocalState = {
  readonly userCreationMode: '' | 'bootstrap-owner' | 'owner-admin'
  readonly deletionMode: '' | 'instance-reset' | 'trainee-data'
}

const unprivilegedTransactionLocalState = Object.freeze({
  userCreationMode: '',
  deletionMode: '',
}) satisfies TransactionLocalState

/**
 * Maps the already captured closed request union to the complete privileged transaction state.
 * Both settings are always assigned so a reused backend cannot retain a session-level grant.
 */
export function transactionLocalStateForRequest(
  request: UnitOfWorkRequest,
): TransactionLocalState {
  switch (request.operation) {
    case 'subject-deletion':
      return Object.freeze({ userCreationMode: '', deletionMode: 'trainee-data' })
    case 'instance-reset':
      return Object.freeze({ userCreationMode: '', deletionMode: 'instance-reset' })
    case 'destructive-identity-mutation':
      return request.authority.kind === 'authenticated-destructive' &&
        request.authority.purpose === 'local-user-create'
        ? Object.freeze({ userCreationMode: 'owner-admin', deletionMode: '' })
        : unprivilegedTransactionLocalState
    case 'host-bootstrap-mutation':
      return request.authority.kind === 'host-bootstrap' &&
        request.authority.mutation === 'redemption'
        ? Object.freeze({ userCreationMode: 'bootstrap-owner', deletionMode: '' })
        : unprivilegedTransactionLocalState
    default:
      return unprivilegedTransactionLocalState
  }
}
