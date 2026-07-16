// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailSignInActionBinding } from '../application/action-binding'
import { SignInForm } from './sign-in-form'

const actionBinding =
  'iab1.email-sign-in.opaque-expiry.opaque-signature' as EmailSignInActionBinding
const refreshedActionBinding =
  'iab1.email-sign-in.refreshed-expiry.refreshed-signature' as EmailSignInActionBinding

const authMocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  signInEmail: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: authMocks.push, refresh: authMocks.refresh }),
}))

vi.mock('./auth-client', () => ({
  authClient: { signIn: { email: authMocks.signInEmail } },
}))

function fillSignInForm() {
  const email = screen.getByLabelText('Email')
  const password = screen.getByLabelText('Password')

  fireEvent.change(email, { target: { value: 'athlete@example.test' } })
  fireEvent.change(password, { target: { value: 'test-password-123' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

  return { email, password }
}

describe('SignInForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(cleanup)

  it('focuses a safe alert, reloads visibly, and submits a replacement binding', async () => {
    authMocks.signInEmail
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'Provider says account 991 has a bad password hash' },
      })
      .mockResolvedValueOnce({ data: { user: {} }, error: null })
    const { rerender } = render(<SignInForm actionBinding={actionBinding} />)

    const { email, password } = fillSignInForm()
    const alert = await screen.findByRole('alert')

    expect(alert).toHaveTextContent('The email or password was not accepted.')
    expect(alert).not.toHaveTextContent('account 991')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(email).toHaveValue('athlete@example.test')
    expect(password).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
    expect(authMocks.push).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload sign-in' }))
    expect(authMocks.refresh).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Sign-in reloaded.'),
    )

    rerender(<SignInForm actionBinding={refreshedActionBinding} />)
    fireEvent.change(password, { target: { value: 'test-password-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(authMocks.signInEmail).toHaveBeenCalledTimes(2))
    expect(authMocks.signInEmail).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fetchOptions: {
          headers: { 'x-indigo-action-binding': refreshedActionBinding },
        },
      }),
    )
  })

  it.each([
    ['thrown request', new Error('Private upstream endpoint failed')],
    ['aborted request', new DOMException('Internal abort detail', 'AbortError')],
  ])('recovers safely from a %s', async (_label, rejection) => {
    authMocks.signInEmail.mockRejectedValueOnce(rejection)
    render(<SignInForm actionBinding={actionBinding} />)

    const { email, password } = fillSignInForm()
    const alert = await screen.findByRole('alert')

    expect(alert).toHaveTextContent('Sign-in did not complete. Try again.')
    expect(alert).not.toHaveTextContent(rejection.message)
    await waitFor(() => expect(alert).toHaveFocus())
    expect(email).toHaveValue('athlete@example.test')
    expect(password).toHaveValue('test-password-123')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
    expect(authMocks.push).not.toHaveBeenCalled()
  })

  it('returns an authenticated athlete to the server-approved saved workout', async () => {
    authMocks.signInEmail.mockResolvedValueOnce({ data: { user: {} }, error: null })
    const returnTo = '/workouts/0198f6d2-7c31-7f14-8f01-123456789abc'
    render(<SignInForm actionBinding={actionBinding} returnTo={returnTo} />)

    fillSignInForm()

    await waitFor(() => expect(authMocks.push).toHaveBeenCalledWith(returnTo))
    expect(authMocks.signInEmail).toHaveBeenCalledWith({
      email: 'athlete@example.test',
      password: 'test-password-123',
      rememberMe: true,
      fetchOptions: {
        headers: { 'x-indigo-action-binding': actionBinding },
      },
    })
    expect(authMocks.refresh).toHaveBeenCalledOnce()
  })
})
