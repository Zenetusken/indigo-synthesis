import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapOwner } from './bootstrap'

const mocks = vi.hoisted(() => ({
  admitLoadShedder: vi.fn(),
  createOwner: vi.fn(),
  getCredentialContext: vi.fn(),
  getInstallationStatus: vi.fn(),
  getServerInstallation: vi.fn(),
  issueBinding: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock('@/composition/identity-bootstrap-mutations', () => ({
  createOwnerFromWebWithBootstrapCode: mocks.createOwner,
}))
vi.mock('../application/installation', () => ({
  getInstallationStatus: mocks.getInstallationStatus,
}))
vi.mock('../infrastructure/action-binding', () => ({
  issueOwnerBootstrapActionBinding: mocks.issueBinding,
}))
vi.mock('../infrastructure/credential-load-shedder', () => ({
  admitCredentialLoadShedder: mocks.admitLoadShedder,
}))
vi.mock('../infrastructure/installation', () => ({
  getServerBootstrapInstallationState: mocks.getServerInstallation,
}))
vi.mock('./web-credential-context', () => ({
  getWebCredentialContext: mocks.getCredentialContext,
}))

const validInput = Object.freeze({
  name: 'Owner',
  email: 'owner@example.test',
  password: 'long-enough-password',
  code: 'indigo_b1_host_capability',
  actionBinding: 'opaque-bootstrap-binding',
})

describe('owner bootstrap server admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCredentialContext.mockResolvedValue({
      channel: 'web',
      clientAddress: '198.51.100.8',
    })
    mocks.admitLoadShedder.mockReturnValue({ admitted: true })
    mocks.createOwner.mockResolvedValue({ id: 'owner-id' })
  })

  it('admits the web address and submitted email before trusted capture', async () => {
    await expect(bootstrapOwner(validInput)).resolves.toEqual({ kind: 'created' })

    expect(mocks.admitLoadShedder).toHaveBeenCalledWith({
      purpose: 'owner-bootstrap',
      email: validInput.email,
      clientAddress: '198.51.100.8',
    })
    expect(mocks.admitLoadShedder.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createOwner.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
    expect(mocks.createOwner).toHaveBeenCalledWith(validInput)
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout')
  })

  it('uniformly rejects an unresolved address without allocating trusted capture', async () => {
    mocks.getCredentialContext.mockResolvedValue(null)

    await expect(bootstrapOwner(validInput)).resolves.toEqual({ kind: 'rejected' })
    expect(mocks.admitLoadShedder).not.toHaveBeenCalled()
    expect(mocks.createOwner).not.toHaveBeenCalled()
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  it('uniformly rejects local load shedding without allocating trusted capture', async () => {
    mocks.admitLoadShedder.mockReturnValue({
      admitted: false,
      reason: 'throttled',
      scope: 'owner-bootstrap:address',
    })

    await expect(bootstrapOwner(validInput)).resolves.toEqual({ kind: 'rejected' })
    expect(mocks.createOwner).not.toHaveBeenCalled()
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  it('does not disguise an admitted infrastructure failure as a credential rejection', async () => {
    mocks.createOwner.mockRejectedValue(new Error('capture infrastructure failed'))

    await expect(bootstrapOwner(validInput)).rejects.toThrow(
      'capture infrastructure failed',
    )
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })
})
