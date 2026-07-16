import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceResetMutationResult } from '@/composition/data-portability-destructive-mutations'
import { createResetPreviewAction, resetInstanceAction } from './actions'

const actionMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  createPlan: vi.fn(),
  issueNotice: vi.fn(),
  redirect: vi.fn(),
  requireActor: vi.fn(),
  resetInstance: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: actionMocks.redirect }))
vi.mock('@/composition/data-portability-destructive-mutations', () => ({
  getProductionDataPortabilityDestructiveMutationPort: () => ({
    resetInstance: actionMocks.resetInstance,
  }),
}))
vi.mock('@/modules/data-portability/application/deletion', () => ({
  createInstanceResetPlan: actionMocks.createPlan,
  DeletionError: class DeletionError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  },
}))
vi.mock('@/modules/data-portability/server/destructive-notice', () => ({
  issueInstanceResetNoticeReceipt: actionMocks.issueNotice,
}))
vi.mock('@/modules/identity/server/actor', () => ({
  requireActor: actionMocks.requireActor,
}))
vi.mock('@/modules/identity/server/destructive-command', () => ({
  captureInstanceResetMutationCommand: actionMocks.capture,
}))

const command = Object.freeze({ nominal: true })

function formData(): FormData {
  const form = new FormData()
  form.set('actionBinding', 'opaque-binding')
  form.set('planId', 'plan-id')
  form.set('planDigest', 'plan-digest')
  form.set('password', 'private-password')
  form.set('typedConfirmation', 'RESET')
  form.set('acknowledged', 'on')
  return form
}

describe('instance-reset actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    actionMocks.redirect.mockImplementation((location: string) => {
      throw new Error(`redirect:${location}`)
    })
    actionMocks.capture.mockResolvedValue({ kind: 'captured', command })
    actionMocks.issueNotice.mockImplementation(
      (payload: { kind: string; warning?: string | null }) =>
        `reset-${payload.kind}-${payload.warning ?? 'none'}`,
    )
    actionMocks.requireActor.mockResolvedValue({ userId: 'owner-id', role: 'owner' })
  })

  const resultCases = [
    [{ kind: 'reset', warning: null }, '/bootstrap?notice=reset-reset-none'],
    [
      { kind: 'reset', warning: 'cleanup-failed' },
      '/bootstrap?notice=reset-reset-cleanup-failed',
    ],
    [{ kind: 'outcome-unknown' }, '/sign-in?notice=reset-outcome-unknown-none'],
    [
      { kind: 'confirmation-rejected' },
      '/settings/delete?notice=reset-confirmation-rejected-none',
    ],
    [
      { kind: 'reauthentication-failed' },
      '/settings/delete?notice=reset-reauthentication-failed-none',
    ],
    [
      { kind: 'reauthentication-locked' },
      '/settings/delete?notice=reset-reauthentication-locked-none',
    ],
    [{ kind: 'plan-invalid' }, '/settings/delete?notice=reset-plan-invalid-none'],
    [{ kind: 'plan-changed' }, '/settings/delete?notice=reset-plan-changed-none'],
    [{ kind: 'stale' }, '/settings/delete?notice=reset-stale-none'],
    [{ kind: 'unavailable' }, '/settings/delete?notice=reset-unavailable-none'],
    [
      { kind: 'reauthentication-incomplete' },
      '/settings/delete?notice=reset-reauthentication-incomplete-none',
    ],
  ] as const satisfies readonly (readonly [InstanceResetMutationResult, string])[]

  it.each(
    resultCases,
  )('maps the closed result %# to a truthful redirect', async (result, url) => {
    actionMocks.resetInstance.mockResolvedValueOnce(result)

    await expect(resetInstanceAction(formData())).rejects.toThrow(`redirect:${url}`)

    expect(actionMocks.capture).toHaveBeenCalledWith({
      formData: expect.any(FormData),
      commandEnteredAt: expect.any(Date),
    })
    expect(actionMocks.capture).toHaveBeenCalledBefore(actionMocks.requireActor)
    expect(actionMocks.requireActor).toHaveBeenCalledOnce()
    expect(actionMocks.resetInstance).toHaveBeenCalledWith(command)
    expect(actionMocks.issueNotice).toHaveBeenCalledOnce()
    expect(actionMocks.issueNotice).toHaveBeenCalledWith(expect.anything(), 'owner-id')
  })

  it('keeps preview creation ordinary and treats unclassified execution as uncertain', async () => {
    await expect(createResetPreviewAction()).rejects.toThrow('redirect:/settings/delete')
    expect(actionMocks.requireActor).toHaveBeenCalledOnce()
    expect(actionMocks.createPlan).toHaveBeenCalledOnce()

    actionMocks.resetInstance.mockRejectedValueOnce(new Error('unclassified'))
    await expect(resetInstanceAction(formData())).rejects.toThrow(
      'redirect:/settings/delete?notice=reset-execution-failed-none',
    )
    expect(actionMocks.issueNotice).toHaveBeenCalledWith(
      { kind: 'execution-failed' },
      'owner-id',
    )
  })

  it('binds rejected command snapshots to the owner who submitted them', async () => {
    actionMocks.capture.mockResolvedValueOnce({ kind: 'rejected' })

    await expect(resetInstanceAction(formData())).rejects.toThrow(
      'redirect:/settings/delete?notice=reset-stale-none',
    )

    expect(actionMocks.resetInstance).not.toHaveBeenCalled()
    expect(actionMocks.capture).toHaveBeenCalledBefore(actionMocks.requireActor)
    expect(actionMocks.issueNotice).toHaveBeenCalledWith({ kind: 'stale' }, 'owner-id')
  })

  it('reports command-capture failure as verified not to have started', async () => {
    actionMocks.capture.mockRejectedValueOnce(new Error('capture unavailable'))

    await expect(resetInstanceAction(formData())).rejects.toThrow(
      'redirect:/settings/delete?notice=reset-request-not-verified-none',
    )
    expect(actionMocks.resetInstance).not.toHaveBeenCalled()
    expect(actionMocks.issueNotice).toHaveBeenCalledWith(
      {
        kind: 'request-not-verified',
      },
      'owner-id',
    )
    expect(actionMocks.capture).toHaveBeenCalledBefore(actionMocks.requireActor)
  })

  it('finishes the form snapshot before reading the request actor', async () => {
    let releaseCapture = () => {}
    actionMocks.capture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCapture = () => resolve({ kind: 'captured', command })
        }),
    )
    actionMocks.resetInstance.mockResolvedValueOnce({ kind: 'reset', warning: null })
    const submittedForm = formData()

    const pendingAction = resetInstanceAction(submittedForm)

    expect(actionMocks.capture).toHaveBeenCalledWith({
      formData: submittedForm,
      commandEnteredAt: expect.any(Date),
    })
    expect(actionMocks.requireActor).not.toHaveBeenCalled()

    releaseCapture()
    await expect(pendingAction).rejects.toThrow(
      'redirect:/bootstrap?notice=reset-reset-none',
    )
    expect(actionMocks.capture).toHaveBeenCalledBefore(actionMocks.requireActor)
    expect(actionMocks.issueNotice).toHaveBeenCalledWith(
      { kind: 'reset', warning: null },
      'owner-id',
    )
  })

  it('authenticates preview failure before redirecting it back to the page', async () => {
    actionMocks.createPlan.mockRejectedValueOnce(new Error('count failed'))

    await expect(createResetPreviewAction()).rejects.toThrow(
      'redirect:/settings/delete?notice=reset-preview-failed-none',
    )
    expect(actionMocks.issueNotice).toHaveBeenCalledWith(
      { kind: 'preview-failed' },
      'owner-id',
    )
  })
})
