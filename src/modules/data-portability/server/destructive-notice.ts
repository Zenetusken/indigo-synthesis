import type {
  InstanceResetNoticeReceipt,
  InstanceResetNoticeReceiptPayload,
  SubjectDeletionNoticeReceipt,
  SubjectDeletionNoticeReceiptPayload,
} from '../infrastructure/destructive-notice-receipt'
import {
  issueInstanceResetNoticeReceipt as issueInstanceResetNoticeReceiptInternal,
  issueSubjectDeletionNoticeReceipt as issueSubjectDeletionNoticeReceiptInternal,
  verifyInstanceResetNoticeReceiptForActor as verifyInstanceResetNoticeReceiptForActorInternal,
  verifyInstanceResetNoticeReceipt as verifyInstanceResetNoticeReceiptInternal,
  verifySubjectDeletionNoticeReceiptForActor as verifySubjectDeletionNoticeReceiptForActorInternal,
  verifySubjectDeletionNoticeReceipt as verifySubjectDeletionNoticeReceiptInternal,
} from '../infrastructure/destructive-notice-receipt'

export type {
  DestructiveNoticeFailureKind,
  InstanceResetNoticeReceipt,
  InstanceResetNoticeReceiptPayload,
  SubjectDeletionNoticeReceipt,
  SubjectDeletionNoticeReceiptPayload,
} from '../infrastructure/destructive-notice-receipt'

/** Server-shell issuer for an authenticated subject-deletion notice. */
export function issueSubjectDeletionNoticeReceipt(
  payload: SubjectDeletionNoticeReceiptPayload,
  actorUserId: string,
): SubjectDeletionNoticeReceipt {
  return issueSubjectDeletionNoticeReceiptInternal(payload, actorUserId)
}

/** Server-shell verifier for a subject-deletion notice. */
export function verifySubjectDeletionNoticeReceipt(
  receipt: unknown,
): SubjectDeletionNoticeReceiptPayload | null {
  return verifySubjectDeletionNoticeReceiptInternal(receipt)
}

/** Server-shell verifier for the exact subject-deletion notice actor. */
export function verifySubjectDeletionNoticeReceiptForActor(
  receipt: unknown,
  actorUserId: string,
): SubjectDeletionNoticeReceiptPayload | null {
  return verifySubjectDeletionNoticeReceiptForActorInternal(receipt, actorUserId)
}

/** Server-shell issuer for an authenticated instance-reset notice. */
export function issueInstanceResetNoticeReceipt(
  payload: InstanceResetNoticeReceiptPayload,
  actorUserId: string,
): InstanceResetNoticeReceipt {
  return issueInstanceResetNoticeReceiptInternal(payload, actorUserId)
}

/** Server-shell verifier for an instance-reset notice. */
export function verifyInstanceResetNoticeReceipt(
  receipt: unknown,
): InstanceResetNoticeReceiptPayload | null {
  return verifyInstanceResetNoticeReceiptInternal(receipt)
}

/** Server-shell verifier for the exact instance-reset notice actor. */
export function verifyInstanceResetNoticeReceiptForActor(
  receipt: unknown,
  actorUserId: string,
): InstanceResetNoticeReceiptPayload | null {
  return verifyInstanceResetNoticeReceiptForActorInternal(receipt, actorUserId)
}
