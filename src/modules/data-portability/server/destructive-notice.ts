import type {
  InstanceResetNoticeReceipt,
  InstanceResetNoticeReceiptPayload,
  SubjectDeletionNoticeReceipt,
  SubjectDeletionNoticeReceiptPayload,
} from '../infrastructure/destructive-notice-receipt'
import {
  issueInstanceResetNoticeReceipt as issueInstanceResetNoticeReceiptInternal,
  issueSubjectDeletionNoticeReceipt as issueSubjectDeletionNoticeReceiptInternal,
  verifyInstanceResetNoticeReceipt as verifyInstanceResetNoticeReceiptInternal,
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
): SubjectDeletionNoticeReceipt {
  return issueSubjectDeletionNoticeReceiptInternal(payload)
}

/** Server-shell verifier for a subject-deletion notice. */
export function verifySubjectDeletionNoticeReceipt(
  receipt: unknown,
): SubjectDeletionNoticeReceiptPayload | null {
  return verifySubjectDeletionNoticeReceiptInternal(receipt)
}

/** Server-shell issuer for an authenticated instance-reset notice. */
export function issueInstanceResetNoticeReceipt(
  payload: InstanceResetNoticeReceiptPayload,
): InstanceResetNoticeReceipt {
  return issueInstanceResetNoticeReceiptInternal(payload)
}

/** Server-shell verifier for an instance-reset notice. */
export function verifyInstanceResetNoticeReceipt(
  receipt: unknown,
): InstanceResetNoticeReceiptPayload | null {
  return verifyInstanceResetNoticeReceiptInternal(receipt)
}
