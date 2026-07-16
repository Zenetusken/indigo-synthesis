// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoldResolutionAvailability } from '@/modules/training/application/workouts'
import TodayPage from './page'

const pageMocks = vi.hoisted(() => ({
  getAthleteProfile: vi.fn(),
  getTodayState: vi.fn(),
  requireUiActor: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}))
vi.mock('@/components', () => ({
  InlineStatus: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PageHeading: ({ title }: { title: string }) => <h1>{title}</h1>,
  ProductFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/modules/athletes/application/profile', () => ({
  getAthleteProfile: pageMocks.getAthleteProfile,
}))
vi.mock('@/modules/identity/server/actor', () => ({
  requireUiActor: pageMocks.requireUiActor,
}))
vi.mock('@/modules/training/application/workouts', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/modules/training/application/workouts')>()
  return { ...original, getTodayState: pageMocks.getTodayState }
})
vi.mock('@/platform/ids/uuid-v7', () => ({
  newUuidV7: () => '019b5d4d-0600-7000-8000-000000000001',
}))
vi.mock('./safety-hold-resolution-form', () => ({
  SafetyHoldResolutionForm: () => <button type="button">Resolve safety hold</button>,
}))

async function renderHold(resolutionAvailability: HoldResolutionAvailability) {
  pageMocks.getTodayState.mockResolvedValue({
    kind: 'hold',
    holdId: 'hold-id',
    sourceSessionId: 'session-id',
    sourceSessionStatus: 'abandoned',
    resolutionAvailability,
  })

  render(await TodayPage({ searchParams: Promise.resolve({}) }))
}

describe('Today safety-hold state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pageMocks.requireUiActor.mockResolvedValue({
      userId: 'owner-id',
      checkedSignOutActionBinding: 'opaque-sign-out-binding',
    })
    pageMocks.getAthleteProfile.mockResolvedValue({
      profile: { timezone: 'UTC', units: 'metric' },
    })
  })

  afterEach(cleanup)

  it('offers only source-session abandonment while the hold is live', async () => {
    await renderHold({ kind: 'requires-abandonment', sessionId: 'session-id' })

    expect(
      screen.getByRole('link', { name: 'Open it and abandon the session' }),
    ).toHaveAttribute('href', '/workouts/session-id')
    expect(
      screen.queryByRole('button', { name: 'Resolve safety hold' }),
    ).not.toBeInTheDocument()
  })

  it.each([
    ['not-session-pain-hold', 'was not created from a session pain report'],
    ['source-session-missing', 'source workout record is unavailable'],
    [
      'completed-source-awaiting-invalidation',
      'progression has not yet been safely invalidated',
    ],
  ] as const)('fails closed for %s', async (reason, expectedCopy) => {
    await renderHold({ kind: 'blocked', reason })

    expect(screen.getByText(new RegExp(expectedCopy))).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Resolve safety hold' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'Open it and abandon the session' }),
    ).not.toBeInTheDocument()
  })

  it('offers resolution only for an eligible abandoned source', async () => {
    await renderHold({ kind: 'available' })

    expect(screen.getByRole('button', { name: 'Resolve safety hold' })).toBeVisible()
  })

  it('routes an invalidated live session to factual review instead of resume', async () => {
    pageMocks.getTodayState.mockResolvedValue({
      kind: 'active',
      sessionId: 'invalidated-session-id',
      status: 'paused',
      progressionInvalidated: true,
      contentEligibility: { eligible: true },
    })

    render(await TodayPage({ searchParams: Promise.resolve({}) }))

    expect(
      screen.getByRole('heading', { name: 'Workout progression invalidated.' }),
    ).toBeVisible()
    expect(
      screen.getByRole('link', { name: 'Review invalidated session' }),
    ).toHaveAttribute('href', '/workouts/invalidated-session-id')
    expect(screen.queryByRole('link', { name: 'Resume workout' })).not.toBeInTheDocument()
  })
})
