// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignInForm } from './sign-in-form'

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

  it('focuses a safe alert, retains email, and clears a rejected credential', async () => {
    authMocks.signInEmail.mockResolvedValueOnce({
      data: null,
      error: { message: 'Provider says account 991 has a bad password hash' },
    })
    render(<SignInForm />)

    const { email, password } = fillSignInForm()
    const alert = await screen.findByRole('alert')

    expect(alert).toHaveTextContent('The email or password was not accepted.')
    expect(alert).not.toHaveTextContent('account 991')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(email).toHaveValue('athlete@example.test')
    expect(password).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
    expect(authMocks.push).not.toHaveBeenCalled()
  })

  it.each([
    ['thrown request', new Error('Private upstream endpoint failed')],
    ['aborted request', new DOMException('Internal abort detail', 'AbortError')],
  ])('recovers safely from a %s', async (_label, rejection) => {
    authMocks.signInEmail.mockRejectedValueOnce(rejection)
    render(<SignInForm />)

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
})
