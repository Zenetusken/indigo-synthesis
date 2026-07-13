'use client'

export const latePainReportedEvent = 'indigo:late-pain-reported'
const latePainSubmissionKeyPrefix = 'indigo:late-pain-submission:'

function latePainSubmissionKey(sessionId: string): string {
  return `${latePainSubmissionKeyPrefix}${sessionId}`
}

export function markLatePainSubmissionPending(sessionId: string): void {
  try {
    window.sessionStorage.setItem(latePainSubmissionKey(sessionId), 'pending')
  } catch {
    // Focus continuity is progressive enhancement; the authoritative action still runs.
  }
}

export function clearLatePainSubmissionPending(sessionId: string): void {
  try {
    window.sessionStorage.removeItem(latePainSubmissionKey(sessionId))
  } catch {
    // Storage may be unavailable in a hardened browser context.
  }
}

export function consumeLatePainSubmissionPending(sessionId: string): boolean {
  try {
    const key = latePainSubmissionKey(sessionId)
    const pending = window.sessionStorage.getItem(key) === 'pending'
    window.sessionStorage.removeItem(key)
    return pending
  } catch {
    return false
  }
}

export function announceLatePainReported(sessionId: string): void {
  window.dispatchEvent(
    new CustomEvent(latePainReportedEvent, {
      detail: { sessionId },
    }),
  )
}

export function eventReportsPainForSession(event: Event, sessionId: string): boolean {
  return (
    event instanceof CustomEvent &&
    typeof event.detail === 'object' &&
    event.detail !== null &&
    'sessionId' in event.detail &&
    event.detail.sessionId === sessionId
  )
}
