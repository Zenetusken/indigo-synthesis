import { describe, expect, it } from 'vitest'
import { commandReceiptMatches, trainingCommandRequestHash } from './command-receipt'

const command = {
  commandType: 'complete-set' as const,
  userId: '0198a6e4-0000-7000-8000-000000000001',
  sessionId: '0198a6e4-0000-7000-8000-000000000002',
  targetId: '0198a6e4-0000-7000-8000-000000000003',
  payload: {
    actualLoadGrams: 50_000,
    actualRepetitions: 5,
    rpe: 8,
    note: null,
  },
} as const

describe('training command receipt contract', () => {
  it('hashes canonical payload semantics rather than object insertion order', () => {
    const reordered = {
      ...command,
      payload: {
        note: null,
        rpe: 8,
        actualRepetitions: 5,
        actualLoadGrams: 50_000,
      },
    }

    expect(trainingCommandRequestHash(command)).toBe(
      trainingCommandRequestHash(reordered),
    )
  })

  it('binds command kind, actor, session, target, and exact normalized payload', () => {
    const baseline = trainingCommandRequestHash(command)
    const variants = [
      { ...command, commandType: 'skip-set' as const },
      { ...command, userId: `${command.userId}-other` },
      { ...command, sessionId: `${command.sessionId}-other` },
      { ...command, targetId: `${command.targetId}-other` },
      { ...command, payload: { ...command.payload, actualLoadGrams: 51_000 } },
    ]

    for (const variant of variants) {
      expect(trainingCommandRequestHash(variant)).not.toBe(baseline)
    }
  })

  it('recognizes only an exact successful receipt replay', () => {
    const requestHash = trainingCommandRequestHash(command)
    const receipt = { ...command, requestHash }

    expect(commandReceiptMatches(receipt, command)).toBe(true)
    expect(
      commandReceiptMatches(receipt, {
        ...command,
        payload: { ...command.payload, note: 'changed' },
      }),
    ).toBe(false)
  })
})
