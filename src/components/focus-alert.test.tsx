// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { FocusAlert } from './focus-alert'

describe('FocusAlert', () => {
  afterEach(cleanup)

  it('moves focus to the alert on mount so it announces on first paint', async () => {
    render(
      <FocusAlert>
        <span>Something went wrong.</span>
      </FocusAlert>,
    )

    const alert = screen.getByRole('alert')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(alert).toHaveAttribute('tabindex', '-1')
  })
})
