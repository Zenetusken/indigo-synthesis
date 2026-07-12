// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RestCountdown } from './rest-countdown'

describe('RestCountdown', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('advances from server time with monotonic elapsed time despite wall-clock skew', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'))

    render(
      <RestCountdown
        confirmedAt="2026-01-15T15:30:00.000Z"
        prescribedSeconds={90}
        serverNow="2026-01-15T15:30:30.000Z"
      />,
    )

    expect(screen.getByText('1:00 remaining')).toBeInTheDocument()
    expect(
      screen.getByText(/0:30 elapsed since the last set was saved/),
    ).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(30_000)
    })

    expect(screen.getByText('0:30 remaining')).toBeInTheDocument()
    expect(
      screen.getByText(/1:00 elapsed since the last set was saved/),
    ).toBeInTheDocument()
  })
})
