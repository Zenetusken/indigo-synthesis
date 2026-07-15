// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerBootstrapActionBinding } from '../application/action-binding'
import { BootstrapForm } from './bootstrap-form'

const actionBinding =
  'iab1.owner-bootstrap.test.bootstrap-binding' as OwnerBootstrapActionBinding
const refreshedActionBinding =
  'iab1.owner-bootstrap.refreshed.bootstrap-binding' as OwnerBootstrapActionBinding

const bootstrapMocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  bootstrapOwner: vi.fn(),
  getOwnerBootstrapStatus: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: bootstrapMocks.push,
    replace: bootstrapMocks.replace,
    refresh: bootstrapMocks.refresh,
  }),
}))

vi.mock('../server/bootstrap', () => ({
  bootstrapOwner: bootstrapMocks.bootstrapOwner,
  getOwnerBootstrapStatus: bootstrapMocks.getOwnerBootstrapStatus,
}))

function submitBootstrapForm() {
  fireEvent.change(screen.getByLabelText(/^Host-issued bootstrap code/), {
    target: { value: `indigo_b1_${'a'.repeat(43)}` },
  })
  fireEvent.change(screen.getByLabelText('Name'), {
    target: { value: 'Local Owner' },
  })
  fireEvent.change(screen.getByLabelText('Local sign-in email'), {
    target: { value: 'owner@example.test' },
  })
  fireEvent.change(screen.getByLabelText(/^Password/), {
    target: { value: 'correct-horse-battery-staple' },
  })
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: 'correct-horse-battery-staple' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create owner account' }))
}

async function expectDeparture(url: string) {
  await waitFor(() => expect(bootstrapMocks.replace).toHaveBeenCalledWith(url))
  expect(bootstrapMocks.refresh).not.toHaveBeenCalled()
  expect(bootstrapMocks.push).not.toHaveBeenCalled()
}

describe('BootstrapForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(cleanup)

  it('replaces the one-time bootstrap route after creating the owner', async () => {
    bootstrapMocks.bootstrapOwner.mockResolvedValueOnce({ kind: 'created' })
    render(<BootstrapForm actionBinding={actionBinding} />)

    submitBootstrapForm()

    await expectDeparture('/sign-in?created=1')
    expect(bootstrapMocks.bootstrapOwner).toHaveBeenCalledWith(
      expect.objectContaining({ actionBinding }),
    )
  })

  it('replaces the one-time bootstrap route when another request already claimed it', async () => {
    bootstrapMocks.bootstrapOwner.mockResolvedValueOnce({ kind: 'closed' })
    render(<BootstrapForm actionBinding={actionBinding} />)

    submitBootstrapForm()

    await expectDeparture('/sign-in?claimed=1')
  })

  it('replaces the route when a transport interruption resolves to a closed instance', async () => {
    bootstrapMocks.bootstrapOwner.mockRejectedValueOnce(new Error('request interrupted'))
    bootstrapMocks.getOwnerBootstrapStatus.mockResolvedValueOnce('closed')
    render(<BootstrapForm actionBinding={actionBinding} />)

    submitBootstrapForm()

    await expectDeparture('/sign-in?claimed=1')
  })

  it('keeps entries, reloads a rejected page, and submits its replacement binding', async () => {
    bootstrapMocks.bootstrapOwner
      .mockResolvedValueOnce({ kind: 'rejected' })
      .mockResolvedValueOnce({ kind: 'created' })
    const { rerender } = render(<BootstrapForm actionBinding={actionBinding} />)

    submitBootstrapForm()
    const alert = await screen.findByRole('alert')

    expect(alert).toHaveTextContent('The page may have expired')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(screen.getByLabelText('Local sign-in email')).toHaveValue('owner@example.test')
    expect(bootstrapMocks.replace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload bootstrap' }))
    expect(bootstrapMocks.refresh).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Bootstrap reloaded.'),
    )

    rerender(<BootstrapForm actionBinding={refreshedActionBinding} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create owner account' }))

    await waitFor(() => expect(bootstrapMocks.bootstrapOwner).toHaveBeenCalledTimes(2))
    expect(bootstrapMocks.bootstrapOwner).toHaveBeenLastCalledWith(
      expect.objectContaining({ actionBinding: refreshedActionBinding }),
    )
    await waitFor(() =>
      expect(bootstrapMocks.replace).toHaveBeenCalledWith('/sign-in?created=1'),
    )
  })

  it('keeps entered values when an interrupted request resolves to an open instance', async () => {
    bootstrapMocks.bootstrapOwner.mockRejectedValueOnce(new Error('request interrupted'))
    bootstrapMocks.getOwnerBootstrapStatus.mockResolvedValueOnce('open')
    render(<BootstrapForm actionBinding={actionBinding} />)

    submitBootstrapForm()
    const alert = await screen.findByRole('alert')

    expect(alert).toHaveTextContent('Creation did not complete. Your entries remain')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(screen.getByLabelText('Local sign-in email')).toHaveValue('owner@example.test')
    expect(bootstrapMocks.replace).not.toHaveBeenCalled()
    expect(bootstrapMocks.refresh).not.toHaveBeenCalled()
  })
})
