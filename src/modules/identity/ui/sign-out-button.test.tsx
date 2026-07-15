// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckedSignOutActionBinding } from '../application/action-binding'
import { SignOutButton } from './sign-out-button'

const actionBinding =
  'iab1.checked-sign-out.opaque-expiry.opaque-signature' as CheckedSignOutActionBinding

const authMocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: authMocks.push, refresh: authMocks.refresh }),
}))

vi.mock('./auth-client', () => ({
  authClient: { signOut: authMocks.signOut },
}))

async function expectRecoverableSignOutFailure(rawDetail: string) {
  const alert = await screen.findByRole('alert')

  expect(alert).toHaveTextContent('Sign-out did not complete. Try again.')
  expect(alert).not.toHaveTextContent(rawDetail)
  await waitFor(() => expect(alert).toHaveFocus())
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled()
  expect(authMocks.push).not.toHaveBeenCalled()
  expect(authMocks.refresh).not.toHaveBeenCalled()
}

describe('SignOutButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(cleanup)

  it('does not redirect when the provider returns an error result', async () => {
    const rawDetail = 'Session 123 failed in the private provider'
    authMocks.signOut.mockResolvedValueOnce({
      data: null,
      error: { message: rawDetail },
    })
    render(<SignOutButton actionBinding={actionBinding} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await expectRecoverableSignOutFailure(rawDetail)
  })

  it.each([
    ['transport failure', new Error('Private proxy address failed')],
    ['aborted request', new DOMException('Internal abort detail', 'AbortError')],
  ])('restores the action after a %s', async (_label, rejection) => {
    authMocks.signOut.mockRejectedValueOnce(rejection)
    render(<SignOutButton actionBinding={actionBinding} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await expectRecoverableSignOutFailure(rejection.message)
  })

  it('redirects only after an explicitly confirmed sign-out', async () => {
    authMocks.signOut.mockResolvedValueOnce({ data: { success: true }, error: null })
    render(<SignOutButton actionBinding={actionBinding} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(authMocks.push).toHaveBeenCalledWith('/sign-in?signedOut=1')
    })
    expect(authMocks.signOut).toHaveBeenCalledWith({
      fetchOptions: {
        headers: { 'x-indigo-action-binding': actionBinding },
      },
    })
    expect(authMocks.refresh).toHaveBeenCalledOnce()
  })

  it('routes an already-unauthenticated browser to sign-in without claiming success', async () => {
    authMocks.signOut.mockResolvedValueOnce({
      data: null,
      error: { message: 'No session', status: 401 },
    })
    render(<SignOutButton actionBinding={actionBinding} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(authMocks.push).toHaveBeenCalledWith('/sign-in'))
    expect(authMocks.push).not.toHaveBeenCalledWith('/sign-in?signedOut=1')
    expect(authMocks.refresh).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not redirect when success is not confirmed', async () => {
    authMocks.signOut.mockResolvedValueOnce({ data: { success: false }, error: null })
    render(<SignOutButton actionBinding={actionBinding} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await expectRecoverableSignOutFailure('success')
  })

  it('transports the opaque binding only on submission and never renders it', async () => {
    authMocks.signOut.mockResolvedValueOnce({ data: { success: true }, error: null })
    const { container } = render(<SignOutButton actionBinding={actionBinding} />)

    expect(container.innerHTML).not.toContain(actionBinding)
    expect(container.innerHTML).not.toContain('session')
    expect(container.innerHTML).not.toContain('epoch')

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(authMocks.signOut).toHaveBeenCalledOnce())
    expect(authMocks.signOut).toHaveBeenCalledWith({
      fetchOptions: {
        headers: { 'x-indigo-action-binding': actionBinding },
      },
    })
  })
})
