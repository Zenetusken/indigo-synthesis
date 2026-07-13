'use client'

export const latePainReportedEvent = 'indigo:late-pain-reported'

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
