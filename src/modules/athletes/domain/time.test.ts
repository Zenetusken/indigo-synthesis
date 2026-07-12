import { describe, expect, it } from 'vitest'
import {
  formatDateTimeInTimezone,
  formatIsoDateInTimezone,
  formatTimeInTimezone,
} from './time'

describe('athlete timezone presentation', () => {
  const instant = new Date('2026-01-15T15:30:45.000Z')

  it('formats a workout time in the athlete IANA timezone', () => {
    expect(formatTimeInTimezone(instant, 'America/Toronto')).toBe('10:30:45 AM')
    expect(formatTimeInTimezone(instant, 'UTC')).toBe('3:30:45 PM')
  })

  it('formats history date-times in the athlete IANA timezone', () => {
    expect(formatDateTimeInTimezone(instant, 'America/Toronto')).toBe(
      'Jan 15, 2026, 10:30:45 AM',
    )
  })

  it('derives persisted local dates without crossing to the UTC calendar day', () => {
    const boundaryInstant = new Date('2026-01-01T01:30:00.000Z')

    expect(formatIsoDateInTimezone(boundaryInstant, 'America/Toronto')).toBe('2025-12-31')
    expect(formatIsoDateInTimezone(boundaryInstant, 'Asia/Tokyo')).toBe('2026-01-01')
  })
})
