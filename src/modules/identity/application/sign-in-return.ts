const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function workoutPathForSessionId(value: unknown): string | null {
  if (typeof value !== 'string' || !uuidV7Pattern.test(value)) {
    return null
  }

  return `/workouts/${value.toLowerCase()}`
}

export function workoutSignInReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/workouts/')) {
    return null
  }

  return workoutPathForSessionId(value.slice('/workouts/'.length))
}

export function expiredWorkoutSignInLocation(sessionId: unknown): string {
  const returnTo = workoutPathForSessionId(sessionId)
  if (!returnTo) return '/sign-in'

  const query = new URLSearchParams({ expired: '1', returnTo })
  return `/sign-in?${query.toString()}`
}
