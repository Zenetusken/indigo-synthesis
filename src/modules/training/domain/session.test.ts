import { describe, expect, it } from 'vitest'
import {
  canTransitionSession,
  InvalidSessionTransitionError,
  transitionSession,
} from './session'

describe('workout session lifecycle', () => {
  it.each([
    ['active', 'paused'],
    ['paused', 'active'],
    ['active', 'completed'],
    ['paused', 'completed'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransitionSession(from, to)).toBe(true)
    expect(transitionSession(from, to)).toBe(to)
  })

  it('does not let a completed session become active again', () => {
    expect(() => transitionSession('completed', 'active')).toThrow(
      InvalidSessionTransitionError,
    )
  })

  it.each([
    'completed',
    'abandoned',
  ] as const)('treats %s as a terminal state', (status) => {
    expect(canTransitionSession(status, 'active')).toBe(false)
  })
})
