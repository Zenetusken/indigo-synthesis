'use client'

import { useEffect, useState } from 'react'
import styles from './workout.module.css'

function clock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function RestCountdown({
  confirmedAt,
  prescribedSeconds,
  serverNow,
}: {
  readonly confirmedAt: string
  readonly prescribedSeconds: number
  readonly serverNow: string
}) {
  const [estimatedServerNow, setEstimatedServerNow] = useState(() =>
    Date.parse(serverNow),
  )

  useEffect(() => {
    const serverAnchor = Date.parse(serverNow)
    setEstimatedServerNow(serverAnchor)
    const monotonicStart = performance.now()
    const updateElapsed = () => {
      setEstimatedServerNow(
        serverAnchor + Math.max(0, performance.now() - monotonicStart),
      )
    }
    const interval = window.setInterval(updateElapsed, 1_000)
    return () => window.clearInterval(interval)
  }, [serverNow])

  const elapsedSeconds = Math.max(
    0,
    Math.floor((estimatedServerNow - Date.parse(confirmedAt)) / 1_000),
  )
  const remainingSeconds = Math.max(0, prescribedSeconds - elapsedSeconds)

  return (
    <section className={styles.restContext} aria-labelledby="rest-context-heading">
      <div>
        <span>Timestamp-derived rest context</span>
        <strong id="rest-context-heading">
          {remainingSeconds > 0
            ? `${clock(remainingSeconds)} remaining`
            : 'Prescribed rest elapsed'}
        </strong>
      </div>
      <p>
        {clock(elapsedSeconds)} elapsed since the last set was saved ·{' '}
        {clock(prescribedSeconds)} prescribed. Backgrounding does not pause this clock.
      </p>
    </section>
  )
}
