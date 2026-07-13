import { describe, expect, it } from 'vitest'
import {
  expiredWorkoutSignInLocation,
  workoutPathForSessionId,
  workoutSignInReturnTo,
} from './sign-in-return'

const sessionId = '0198f6d2-7c31-7f14-8f01-123456789abc'

describe('workout sign-in return targets', () => {
  it('accepts only an RFC 9562 UUIDv7 workout route', () => {
    expect(workoutPathForSessionId(sessionId)).toBe(`/workouts/${sessionId}`)
    expect(workoutPathForSessionId(sessionId.toUpperCase())).toBe(
      `/workouts/${sessionId}`,
    )

    expect(workoutPathForSessionId('/settings')).toBeNull()
    expect(workoutPathForSessionId('0198f6d2-7c31-6f14-8f01-123456789abc')).toBeNull()
    expect(workoutPathForSessionId(`${sessionId}/../../settings`)).toBeNull()
    expect(workoutPathForSessionId(`//evil.example/${sessionId}`)).toBeNull()

    expect(workoutSignInReturnTo(`/workouts/${sessionId}`)).toBe(`/workouts/${sessionId}`)
    expect(workoutSignInReturnTo(`/workouts/${sessionId}/../../settings`)).toBeNull()
    expect(workoutSignInReturnTo(`//evil.example/workouts/${sessionId}`)).toBeNull()
  })

  it('builds the expired-session location only from a valid workout ID', () => {
    expect(expiredWorkoutSignInLocation(sessionId)).toBe(
      `/sign-in?expired=1&returnTo=%2Fworkouts%2F${sessionId}`,
    )
    expect(expiredWorkoutSignInLocation('/settings')).toBe('/sign-in')
  })
})
