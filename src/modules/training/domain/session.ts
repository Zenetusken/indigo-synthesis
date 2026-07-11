export type WorkoutSessionStatus = 'active' | 'paused' | 'completed' | 'abandoned'

const allowedTransitions: Readonly<
  Record<WorkoutSessionStatus, readonly WorkoutSessionStatus[]>
> = {
  active: ['paused', 'completed', 'abandoned'],
  paused: ['active', 'completed', 'abandoned'],
  completed: [],
  abandoned: [],
}

export class InvalidSessionTransitionError extends Error {
  constructor(
    readonly from: WorkoutSessionStatus,
    readonly to: WorkoutSessionStatus,
  ) {
    super(`Cannot transition a workout session from ${from} to ${to}.`)
    this.name = 'InvalidSessionTransitionError'
  }
}

export function canTransitionSession(
  from: WorkoutSessionStatus,
  to: WorkoutSessionStatus,
): boolean {
  return allowedTransitions[from].includes(to)
}

export function transitionSession(
  from: WorkoutSessionStatus,
  to: WorkoutSessionStatus,
): WorkoutSessionStatus {
  if (!canTransitionSession(from, to)) {
    throw new InvalidSessionTransitionError(from, to)
  }

  return to
}
