// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionButton } from './action-button'

describe('ActionButton', () => {
  afterEach(cleanup)

  it('invokes its onClick when idle', () => {
    const onClick = vi.fn()
    render(<ActionButton onClick={onClick}>Go</ActionButton>)

    fireEvent.click(screen.getByRole('button', { name: 'Go' }))

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('stays focusable but blocks activation while busy', () => {
    const onClick = vi.fn()
    render(
      <ActionButton busy onClick={onClick}>
        Go
      </ActionButton>,
    )
    const button = screen.getByRole('button', { name: 'Go' })

    // Focusable (aria-disabled, not native `disabled`) so keyboard/SR focus is
    // not dropped to the body mid-submit…
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-busy', 'true')
    button.focus()
    expect(button).toHaveFocus()

    // …but re-activation is suppressed, which is what guards double-submit now
    // that the native `disabled` lock is gone.
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('prevents implicit form submission while busy', () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) =>
      event.preventDefault(),
    )
    render(
      <form onSubmit={onSubmit}>
        <ActionButton busy type="submit">
          Save
        </ActionButton>
      </form>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits its form when idle', () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) =>
      event.preventDefault(),
    )
    render(
      <form onSubmit={onSubmit}>
        <ActionButton type="submit">Save</ActionButton>
      </form>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('honours an explicit disabled prop', () => {
    const onClick = vi.fn()
    render(
      <ActionButton disabled onClick={onClick}>
        Go
      </ActionButton>,
    )
    const button = screen.getByRole('button', { name: 'Go' })

    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })
})
