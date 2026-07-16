import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubjectDeletionMutationResult } from '@/composition/data-portability-destructive-mutations'
import { createAccountDeletionPreviewAction, deleteAccountAction } from './actions'

const actionMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  createPlan: vi.fn(),
  deleteSubject: vi.fn(),
  issueNotice: vi.fn(),
  redirect: vi.fn(),
  requireActor: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: actionMocks.redirect }))
vi.mock('@/composition/data-portability-destructive-mutations', () => ({
  getProductionDataPortabilityDestructiveMutationPort: () => ({
    deleteSubject: actionMocks.deleteSubject,
  }),
}))
vi.mock('@/modules/data-portability/application/deletion', () => ({
  createSubjectDeletionPlan: actionMocks.createPlan,
  DeletionError: class DeletionError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  },
}))
vi.mock('@/modules/data-portability/server/destructive-notice', () => ({
  issueSubjectDeletionNoticeReceipt: actionMocks.issueNotice,
}))
vi.mock('@/modules/identity/server/actor', () => ({
  requireActor: actionMocks.requireActor,
}))
vi.mock('@/modules/identity/server/destructive-command', () => ({
  captureTraineeDataDeletionMutationCommand: actionMocks.capture,
}))

const command = Object.freeze({ nominal: true })

function formData(): FormData {
  const form = new FormData()
  form.set('actionBinding', 'opaque-binding')
  form.set('planId', 'plan-id')
  form.set('planDigest', 'plan-digest')
  form.set('password', 'private-password')
  form.set('typedConfirmation', 'DELETE')
  form.set('acknowledged', 'on')
  return form
}

describe('subject-deletion actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    actionMocks.redirect.mockImplementation((location: string) => {
      throw new Error(`redirect:${location}`)
    })
    actionMocks.capture.mockResolvedValue({ kind: 'captured', command })
    actionMocks.issueNotice.mockImplementation(
      (payload: { kind: string; actorRole?: string; warning?: string | null }) =>
        `subject-${payload.kind}-${payload.actorRole ?? 'none'}-${payload.warning ?? 'none'}`,
    )
    actionMocks.requireActor.mockResolvedValue({ userId: 'member-id', role: 'member' })
  })

  const resultCases = [
    [
      { kind: 'deleted', actorRole: 'owner', warning: null },
      '/settings?notice=subject-deleted-owner-none',
    ],
    [
      { kind: 'deleted', actorRole: 'member', warning: 'cleanup-failed' },
      '/sign-in?notice=subject-deleted-member-cleanup-failed',
    ],
    [
      { kind: 'outcome-unknown', actorRole: 'member' },
      '/sign-in?notice=subject-outcome-unknown-member-none',
    ],
    [
      { kind: 'outcome-unknown', actorRole: 'owner' },
      '/settings/delete-account?notice=subject-outcome-unknown-owner-none',
    ],
    [
      { kind: 'confirmation-rejected' },
      '/settings/delete-account?notice=subject-confirmation-rejected-none-none',
    ],
    [
      { kind: 'reauthentication-failed' },
      '/settings/delete-account?notice=subject-reauthentication-failed-none-none',
    ],
    [
      { kind: 'reauthentication-locked' },
      '/settings/delete-account?notice=subject-reauthentication-locked-none-none',
    ],
    [
      { kind: 'plan-invalid' },
      '/settings/delete-account?notice=subject-plan-invalid-none-none',
    ],
    [
      { kind: 'plan-changed' },
      '/settings/delete-account?notice=subject-plan-changed-none-none',
    ],
    [{ kind: 'stale' }, '/settings/delete-account?notice=subject-stale-none-none'],
    [
      { kind: 'unavailable' },
      '/settings/delete-account?notice=subject-unavailable-none-none',
    ],
    [
      { kind: 'reauthentication-incomplete' },
      '/settings/delete-account?notice=subject-reauthentication-incomplete-none-none',
    ],
  ] as const satisfies readonly (readonly [SubjectDeletionMutationResult, string])[]

  it.each(
    resultCases,
  )('maps the closed result %# to a truthful redirect', async (result, url) => {
    actionMocks.deleteSubject.mockResolvedValueOnce(result)

    await expect(deleteAccountAction(formData())).rejects.toThrow(`redirect:${url}`)

    expect(actionMocks.capture).toHaveBeenCalledWith({
      formData: expect.any(FormData),
      commandEnteredAt: expect.any(Date),
    })
    expect(actionMocks.capture).toHaveBeenCalledBefore(actionMocks.requireActor)
    expect(actionMocks.requireActor).toHaveBeenCalledOnce()
    expect(actionMocks.deleteSubject).toHaveBeenCalledWith(command)
    expect(actionMocks.issueNotice).toHaveBeenCalledOnce()
    expect(actionMocks.issueNotice).toHaveBeenCalledWith(expect.anything(), 'member-id')
  })

  it('maps request rejection and unclassified failure without claiming rollback', async () => {
    actionMocks.capture.mockResolvedValueOnce({ kind: 'rejected' })
    await expect(deleteAccountAction(formData())).rejects.toThrow(
      'redirect:/settings/delete-account?notice=subject-stale-none-none',
    )
    expect(actionMocks.deleteSubject).not.toHaveBeenCalled()
    expect(actionMocks.issueNotice).toHaveBeenNthCalledWith(
      1,
      { kind: 'stale' },
      'member-id',
    )

    actionMocks.capture.mockResolvedValueOnce({ kind: 'captured', command })
    actionMocks.deleteSubject.mockRejectedValueOnce(new Error('unclassified'))
    await expect(deleteAccountAction(formData())).rejects.toThrow(
      'redirect:/settings/delete-account?notice=subject-execution-failed-none-none',
    )
    expect(actionMocks.issueNotice).toHaveBeenNthCalledWith(
      2,
      { kind: 'execution-failed' },
      'member-id',
    )
    expect(actionMocks.capture).toHaveBeenCalledBefore(actionMocks.requireActor)
    expect(actionMocks.requireActor).toHaveBeenCalledTimes(2)
  })

  it('reports command-capture failure as verified not to have started', async () => {
    actionMocks.capture.mockRejectedValueOnce(new Error('capture unavailable'))

    await expect(deleteAccountAction(formData())).rejects.toThrow(
      'redirect:/settings/delete-account?notice=subject-request-not-verified-none-none',
    )
    expect(actionMocks.deleteSubject).not.toHaveBeenCalled()
    expect(actionMocks.issueNotice).toHaveBeenCalledWith(
      {
        kind: 'request-not-verified',
      },
      'member-id',
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
    actionMocks.deleteSubject.mockResolvedValueOnce({
      kind: 'deleted',
      actorRole: 'member',
      warning: null,
    })
    const submittedForm = formData()

    const pendingAction = deleteAccountAction(submittedForm)

    expect(actionMocks.capture).toHaveBeenCalledWith({
      formData: submittedForm,
      commandEnteredAt: expect.any(Date),
    })
    expect(actionMocks.requireActor).not.toHaveBeenCalled()

    releaseCapture()
    await expect(pendingAction).rejects.toThrow(
      'redirect:/sign-in?notice=subject-deleted-member-none',
    )
    expect(actionMocks.capture).toHaveBeenCalledBefore(actionMocks.requireActor)
    expect(actionMocks.issueNotice).toHaveBeenCalledWith(
      {
        kind: 'deleted',
        actorRole: 'member',
        warning: null,
      },
      'member-id',
    )
  })

  it('authenticates ordinary preview creation', async () => {
    await expect(createAccountDeletionPreviewAction()).rejects.toThrow(
      'redirect:/settings/delete-account',
    )

    expect(actionMocks.requireActor).toHaveBeenCalledOnce()
    expect(actionMocks.createPlan).toHaveBeenCalledOnce()
    expect(actionMocks.capture).not.toHaveBeenCalled()
  })

  it('authenticates preview failure before redirecting it back to the page', async () => {
    actionMocks.createPlan.mockRejectedValueOnce(new Error('count failed'))

    await expect(createAccountDeletionPreviewAction()).rejects.toThrow(
      'redirect:/settings/delete-account?notice=subject-preview-failed-none-none',
    )
    expect(actionMocks.issueNotice).toHaveBeenCalledWith(
      { kind: 'preview-failed' },
      'member-id',
    )
  })
})
