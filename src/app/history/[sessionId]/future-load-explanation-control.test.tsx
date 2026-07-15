// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { explainFutureLoadDecisionAction } from './actions'
import { FutureLoadExplanationControl } from './future-load-explanation-control'
import { latePainReportedEvent } from './late-pain-client-state'

vi.mock('./actions', () => ({
  explainFutureLoadDecisionAction: vi.fn(),
}))

describe('FutureLoadExplanationControl', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.mocked(explainFutureLoadDecisionAction).mockReset()
  })

  it('does not generate prose after a late safety report', () => {
    render(
      <FutureLoadExplanationControl
        sessionId="session-1"
        decisionId="decision-1"
        disabledReason="decision-invalidated"
      />,
    )

    const button = screen.getByRole('button', { name: 'Explain in plain language' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(explainFutureLoadDecisionAction).not.toHaveBeenCalled()
    expect(
      screen.getByText(/original code remains visible as historical evidence/),
    ).toBeVisible()
  })

  it('removes already-rendered prose when a late safety report arrives', async () => {
    vi.mocked(explainFutureLoadDecisionAction).mockResolvedValue({
      status: 'available',
      prose: 'A previously cached grounded explanation.',
      modelId: 'qwen3.5-9b-q4_k_m',
      modelContentDigest: 'a'.repeat(64),
      promptVersion: 'future-load.v2',
      factBundleHash: 'b'.repeat(64),
      durationMs: 12,
      inferred: true,
      fromCache: true,
      generateDurationMs: 1000,
    })
    const rendered = render(
      <FutureLoadExplanationControl sessionId="session-1" decisionId="decision-1" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Explain in plain language' }))
    await screen.findByText('A previously cached grounded explanation.')

    rendered.rerender(
      <FutureLoadExplanationControl
        sessionId="session-1"
        decisionId="decision-1"
        disabledReason="decision-invalidated"
      />,
    )

    await waitFor(() =>
      expect(
        screen.queryByText('A previously cached grounded explanation.'),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.getByText(/original code remains visible as historical evidence/),
    ).toBeVisible()
  })

  it('removes prose immediately when the sibling late-pain report commits', async () => {
    vi.mocked(explainFutureLoadDecisionAction).mockResolvedValue({
      status: 'available',
      prose: 'A grounded explanation that must be suppressed.',
      modelId: 'qwen3.5-9b-q4_k_m',
      modelContentDigest: 'a'.repeat(64),
      promptVersion: 'future-load.v2',
      factBundleHash: 'b'.repeat(64),
      durationMs: 12,
      inferred: true,
      fromCache: true,
      generateDurationMs: 1000,
    })
    render(<FutureLoadExplanationControl sessionId="session-1" decisionId="decision-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Explain in plain language' }))
    await screen.findByText('A grounded explanation that must be suppressed.')

    act(() => {
      window.dispatchEvent(
        new CustomEvent(latePainReportedEvent, {
          detail: { sessionId: 'another-session' },
        }),
      )
    })
    expect(
      screen.getByText('A grounded explanation that must be suppressed.'),
    ).toBeVisible()

    act(() => {
      window.dispatchEvent(
        new CustomEvent(latePainReportedEvent, {
          detail: { sessionId: 'session-1' },
        }),
      )
    })

    await waitFor(() =>
      expect(
        screen.queryByText('A grounded explanation that must be suppressed.'),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.getByRole('button', { name: 'Explain in plain language' }),
    ).toBeDisabled()
  })

  it('clears busy presentation when late pain invalidates an in-flight request', async () => {
    let resolveAction: (
      result: Awaited<ReturnType<typeof explainFutureLoadDecisionAction>>,
    ) => void = () => undefined
    const actionResult = new Promise<
      Awaited<ReturnType<typeof explainFutureLoadDecisionAction>>
    >((resolve) => {
      resolveAction = resolve
    })
    vi.mocked(explainFutureLoadDecisionAction).mockReturnValue(actionResult)
    render(<FutureLoadExplanationControl sessionId="session-1" decisionId="decision-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Explain in plain language' }))
    expect(await screen.findByRole('button', { name: 'Explaining…' })).toHaveAttribute(
      'aria-busy',
      'true',
    )

    act(() => {
      window.dispatchEvent(
        new CustomEvent(latePainReportedEvent, {
          detail: { sessionId: 'session-1' },
        }),
      )
    })

    const disabledButton = screen.getByRole('button', {
      name: 'Explain in plain language',
    })
    expect(disabledButton).toBeDisabled()
    expect(disabledButton).not.toHaveAttribute('aria-busy')
    expect(
      screen.getByText(/original code remains visible as historical evidence/),
    ).toBeVisible()

    await act(async () => {
      resolveAction({
        status: 'available',
        prose: 'A late result that must remain suppressed.',
        modelId: 'qwen3.5-9b-q4_k_m',
        modelContentDigest: 'a'.repeat(64),
        promptVersion: 'future-load.v2',
        factBundleHash: 'b'.repeat(64),
        durationMs: 12,
        inferred: true,
        fromCache: false,
        generateDurationMs: 1000,
      })
      await actionResult
    })

    expect(
      screen.queryByText('A late result that must remain suppressed.'),
    ).not.toBeInTheDocument()
    expect(disabledButton).toBeDisabled()
    expect(disabledButton).not.toHaveAttribute('aria-busy')
  })

  it('explains why revoked content cannot use the optional model', () => {
    render(
      <FutureLoadExplanationControl
        sessionId="session-1"
        decisionId="decision-1"
        disabledReason="content-revoked"
      />,
    )

    expect(
      screen.getByRole('button', { name: 'Explain in plain language' }),
    ).toBeDisabled()
    expect(screen.getByText(/content release was revoked/)).toBeVisible()
    expect(
      screen.getByText(/content release was revoked/).closest('[aria-live]'),
    ).toBeNull()
    expect(explainFutureLoadDecisionAction).not.toHaveBeenCalled()
  })

  it('keeps a rejected explanation request inline and codes-only', async () => {
    vi.mocked(explainFutureLoadDecisionAction).mockRejectedValue(
      new Error('server action transport failed'),
    )
    render(<FutureLoadExplanationControl sessionId="session-1" decisionId="decision-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Explain in plain language' }))

    expect(await screen.findByText(/explanation request did not finish/)).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Explain in plain language' }),
    ).toBeEnabled()
  })
})
