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
