// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SafetyHoldResolutionForm } from './safety-hold-resolution-form'

const actionMock = vi.hoisted(() => vi.fn())

vi.mock('./actions', () => ({
  resolveSafetyHoldAction: actionMock,
}))

const props = {
  commandId: '019b5d4d-0600-7000-8000-000000000001',
  holdId: '019b5d4d-0600-7000-8000-000000000002',
}

function controls() {
  return {
    acknowledgement: screen.getByLabelText(
      'I understand that this product does not assess or clear symptoms.',
    ),
    button: screen.getByRole('button', { name: 'Resolve safety hold' }),
    reason: screen.getByLabelText('Factual reason for resolving the hold (required)'),
  }
}

describe('SafetyHoldResolutionForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(cleanup)

  it('preserves submitted values and focuses a safe server-error alert', async () => {
    actionMock.mockResolvedValueOnce({
      errorCode: 'hold.resolve-failed',
      values: {
        acknowledged: true,
        reason: 'Symptoms are no longer present; I choose to continue independently.',
      },
    })
    render(<SafetyHoldResolutionForm {...props} />)
    const { acknowledgement, button, reason } = controls()

    fireEvent.change(reason, {
      target: {
        value: 'Symptoms are no longer present; I choose to continue independently.',
      },
    })
    fireEvent.click(acknowledgement)
    fireEvent.click(button)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The hold could not be resolved. Try again.')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(reason).toHaveValue(
      'Symptoms are no longer present; I choose to continue independently.',
    )
    expect(acknowledgement).toBeChecked()
    expect(button).toBeEnabled()
  })

  it('locks every control and exposes pending state while resolution is in flight', async () => {
    const pendingResult = Promise.withResolvers<{
      errorCode: string | null
      values: { acknowledged: boolean; reason: string }
    }>()
    actionMock.mockImplementationOnce(() => pendingResult.promise)
    render(<SafetyHoldResolutionForm {...props} />)
    const { acknowledgement, button, reason } = controls()

    fireEvent.change(reason, { target: { value: 'Independent decision recorded.' } })
    fireEvent.click(acknowledgement)
    fireEvent.click(button)

    expect(await screen.findByRole('button', { name: 'Resolving safety hold…' })).toBe(
      button,
    )
    // The submit control keeps focus (aria-disabled) instead of going natively
    // disabled, so mid-submit focus is not dropped to the body.
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(reason).toBeDisabled()
    expect(acknowledgement).toBeDisabled()
    expect(button.closest('form')).toHaveAttribute('aria-busy', 'true')

    // Double-submit guard: re-activating the busy control must not enqueue a
    // second resolution. Native `disabled` used to prevent this for free; now
    // the button's own activation guard does. Without it, this queued click
    // would run a second action once the first resolves.
    fireEvent.click(button)

    await act(async () => {
      pendingResult.resolve({
        errorCode: 'hold.resolve-failed',
        values: { acknowledged: true, reason: 'Independent decision recorded.' },
      })
      await pendingResult.promise
    })

    expect(actionMock).toHaveBeenCalledTimes(1)
  })

  it('focuses actionable validation feedback without relying on native bubbles', async () => {
    actionMock
      .mockResolvedValueOnce({
        errorCode: 'hold.reason-required',
        values: { acknowledged: false, reason: '' },
      })
      .mockResolvedValueOnce({
        errorCode: 'hold.ack-required',
        values: { acknowledged: false, reason: 'I made an independent decision.' },
      })
    render(<SafetyHoldResolutionForm {...props} />)
    const { button, reason } = controls()

    fireEvent.click(button)
    let alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Enter a factual reason')
    await waitFor(() => expect(alert).toHaveFocus())

    fireEvent.change(reason, { target: { value: 'I made an independent decision.' } })
    fireEvent.click(button)
    alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('does not assess or clear symptoms')
    await waitFor(() => expect(alert).toHaveFocus())
  })
})
