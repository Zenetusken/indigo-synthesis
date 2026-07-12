// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkoutSessionView,
  WorkoutSetView,
} from '@/modules/training/application/workouts'
import { WorkoutClient } from './workout-client'

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: { pathname: string } }) => (
    <a href={href.pathname}>{children}</a>
  ),
}))
vi.mock('./actions', () => ({
  abandonWorkoutAction: vi.fn(),
  completeSetAction: vi.fn(),
  completeWorkoutAction: vi.fn(),
  pauseAction: vi.fn(),
  proposeExerciseSubstitutionAction: vi.fn(),
  reportPainAction: vi.fn(),
  resumeAction: vi.fn(),
  skipSetAction: vi.fn(),
}))

afterEach(cleanup)

const pendingSet: WorkoutSetView = {
  id: '01900000-0000-7000-8000-000000000101',
  ordinal: 1,
  status: 'pending',
  targetLoadGrams: 60_000,
  targetRepetitions: 5,
  restSeconds: 120,
  actualLoadGrams: null,
  actualRepetitions: null,
  rpe: null,
  confirmedAt: null,
  skippedAt: null,
  skipReason: null,
  note: null,
  original: {
    status: 'pending',
    actualLoadGrams: null,
    actualRepetitions: null,
    rpe: null,
    confirmedAt: null,
    skippedAt: null,
    skipReason: null,
    note: null,
  },
  correction: null,
}

const invalidatedSession: WorkoutSessionView = {
  id: '01900000-0000-7000-8000-000000000100',
  status: 'paused',
  startedAt: new Date('2026-07-12T12:00:00.000Z'),
  pausedAt: new Date('2026-07-12T12:05:00.000Z'),
  completedAt: null,
  optimisticVersion: 2,
  progressionInvalidated: true,
  contentEligibility: { eligible: true },
  plannedWorkout: {
    id: '01900000-0000-7000-8000-000000000102',
    name: 'Invalidated saved workout',
    scheduledDate: '2026-07-12',
    slotCode: 'A',
  },
  exercises: [
    {
      id: '01900000-0000-7000-8000-000000000103',
      exerciseCode: 'development.back-squat',
      exerciseName: 'Back squat — development fixture',
      ordinal: 1,
      rationaleCode: 'development.fixture-instantiation',
      priorComparablePerformance: null,
      sets: [pendingSet],
    },
  ],
  feedback: null,
}

describe('invalidated workout continuation', () => {
  it('keeps facts inspectable and exposes only abandonment', () => {
    render(
      <WorkoutClient
        session={invalidatedSession}
        units="metric"
        unitLabel="kg"
        timezone="UTC"
        pendingSets={[pendingSet]}
        currentSetId={null}
        continuationTargetId={null}
        previousPerformedSet={null}
        initialError={null}
        serverNow="2026-07-12T12:06:00.000Z"
      />,
    )

    expect(
      screen.getByRole('heading', { name: 'This workout progression was invalidated.' }),
    ).toBeVisible()
    expect(screen.getByText('60 kg × 5')).toBeVisible()
    expect(screen.getByText('Session blocked · 1 unresolved sets')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Abandon workout' })).toBeVisible()

    for (const name of [
      'Complete set',
      'Skip set',
      'Propose substitute',
      'Pause workout',
      'Resume workout',
      'Complete workout',
      'Stop and report issue',
    ]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
    expect(
      screen.queryByRole('link', { name: 'Report pain or an issue' }),
    ).not.toBeInTheDocument()
  })
})
