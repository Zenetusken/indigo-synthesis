import {
  type CanonicalValue,
  canonicalSha256,
} from '@/modules/methodology/domain/canonical'

export const trainingCommandTypes = [
  'complete-set',
  'skip-set',
  'complete-workout',
  'report-pain',
] as const

export type TrainingCommandType = (typeof trainingCommandTypes)[number]

export type TrainingCommandRequest = {
  readonly commandType: TrainingCommandType
  readonly userId: string
  readonly sessionId: string
  readonly targetId: string
  readonly payload: CanonicalValue
}

export type TrainingCommandReceipt = {
  readonly commandType: string
  readonly userId: string
  readonly sessionId: string
  readonly targetId: string
  readonly requestHash: string
}

export function trainingCommandRequestHash(input: TrainingCommandRequest): string {
  return canonicalSha256({
    hashMaterialVersion: 'training-command-request-v1',
    commandType: input.commandType,
    userId: input.userId,
    sessionId: input.sessionId,
    targetId: input.targetId,
    payload: input.payload,
  })
}

export function commandReceiptMatches(
  receipt: TrainingCommandReceipt,
  request: TrainingCommandRequest,
): boolean {
  return (
    receipt.commandType === request.commandType &&
    receipt.userId === request.userId &&
    receipt.sessionId === request.sessionId &&
    receipt.targetId === request.targetId &&
    receipt.requestHash === trainingCommandRequestHash(request)
  )
}
