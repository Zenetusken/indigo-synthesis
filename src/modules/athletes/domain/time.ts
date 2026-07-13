const timeFormatterOptions = {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
} as const

export function formatIsoDateInTimezone(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? ''

  return `${part('year')}-${part('month')}-${part('day')}`
}

/**
 * Formats a persisted `YYYY-MM-DD` calendar-date string for display without ever
 * reparsing it through a local `Date` (which would shift the day across timezones).
 * The parts are anchored at UTC midnight and formatted in UTC, so the rendered day
 * always matches the stored day. Returns the input unchanged if it is not a plain
 * ISO calendar date.
 */
export function formatCalendarDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!match) return isoDate
  const [, year, month, day] = match
  const anchored = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(anchored)
}

export function formatTimeInTimezone(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    ...timeFormatterOptions,
    timeZone: timezone,
  }).format(value)
}

export function formatDateTimeInTimezone(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: timezone,
  }).format(value)
}
