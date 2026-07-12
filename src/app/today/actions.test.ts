import { beforeEach, describe, expect, it, vi } from 'vitest'

const actionMocks = vi.hoisted(() => {
  class WorkoutCommandError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }

  return {
    redirect: vi.fn(),
    requireActor: vi.fn(),
    resolveSafetyHold: vi.fn(),
    WorkoutCommandError,
  }
})

vi.mock('next/navigation', () => ({ redirect: actionMocks.redirect }))
vi.mock('@/modules/identity/server/actor', () => ({
  requireActor: actionMocks.requireActor,
}))
vi.mock('@/modules/training/application/workouts', () => ({
  resolveSafetyHold: actionMocks.resolveSafetyHold,
  startWorkout: vi.fn(),
  WorkoutCommandError: actionMocks.WorkoutCommandError,
}))

import { resolveSafetyHoldAction, type SafetyHoldResolutionActionState } from './actions'

const initialState: SafetyHoldResolutionActionState = {
  errorCode: null,
  values: { acknowledged: false, reason: '' },
}

function submission(values: { reason?: string; acknowledged?: boolean } = {}): FormData {
  const formData = new FormData()
  formData.set('holdId', '019b5d4d-0600-7000-8000-000000000002')
  formData.set('commandId', '019b5d4d-0600-7000-8000-000000000001')
  formData.set('reason', values.reason ?? '')
  if (values.acknowledged) formData.set('acknowledged', 'on')
  return formData
}

describe('resolveSafetyHoldAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    actionMocks.requireActor.mockResolvedValue({ userId: 'owner-id' })
    actionMocks.redirect.mockImplementation((destination: string) => {
      throw new Error(`redirect:${destination}`)
    })
  })

  it('returns typed, value-preserving validation errors before persistence', async () => {
    await expect(resolveSafetyHoldAction(initialState, submission())).resolves.toEqual({
      errorCode: 'hold.reason-required',
      values: { acknowledged: false, reason: '' },
    })
    await expect(
      resolveSafetyHoldAction(
        initialState,
        submission({ reason: 'Independent decision.' }),
      ),
    ).resolves.toEqual({
      errorCode: 'hold.ack-required',
      values: { acknowledged: false, reason: 'Independent decision.' },
    })
    expect(actionMocks.resolveSafetyHold).not.toHaveBeenCalled()
  })

  it('preserves values and maps backend failures without exposing raw messages', async () => {
    actionMocks.resolveSafetyHold.mockRejectedValueOnce(
      new actionMocks.WorkoutCommandError('hold.live-session-not-abandoned'),
    )

    await expect(
      resolveSafetyHoldAction(
        initialState,
        submission({ reason: 'Independent decision.', acknowledged: true }),
      ),
    ).resolves.toEqual({
      errorCode: 'hold.live-session-not-abandoned',
      values: { acknowledged: true, reason: 'Independent decision.' },
    })
  })

  it('redirects successful resolution to explicit confirmation', async () => {
    actionMocks.resolveSafetyHold.mockResolvedValueOnce(undefined)

    await expect(
      resolveSafetyHoldAction(
        initialState,
        submission({ reason: 'Independent decision.', acknowledged: true }),
      ),
    ).rejects.toThrow('redirect:/today?notice=hold-resolved')
    expect(actionMocks.resolveSafetyHold).toHaveBeenCalledWith({
      acknowledged: true,
      commandId: '019b5d4d-0600-7000-8000-000000000001',
      holdId: '019b5d4d-0600-7000-8000-000000000002',
      reason: 'Independent decision.',
      userId: 'owner-id',
    })
  })
})
