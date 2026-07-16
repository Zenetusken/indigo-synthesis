import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSignInPageInstallation } from './sign-in-page'

const mocks = vi.hoisted(() => ({
  getInstallation: vi.fn(),
  issueBinding: vi.fn(),
}))

vi.mock('../infrastructure/installation', () => ({
  getServerSignInInstallationState: mocks.getInstallation,
}))
vi.mock('../infrastructure/action-binding', () => ({
  issueEmailSignInActionBinding: mocks.issueBinding,
}))

describe('sign-in page installation binding', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns no binding while bootstrap is open', async () => {
    mocks.getInstallation.mockResolvedValue({ kind: 'open' })

    await expect(getSignInPageInstallation()).resolves.toEqual({ kind: 'open' })
    expect(mocks.issueBinding).not.toHaveBeenCalled()
  })

  it('turns the raw closed-instance epoch into one opaque page binding', async () => {
    mocks.getInstallation.mockResolvedValue({
      kind: 'closed',
      productMutationEpoch: 'private-installation-epoch',
    })
    mocks.issueBinding.mockReturnValue('opaque-sign-in-binding')

    await expect(getSignInPageInstallation()).resolves.toEqual({
      kind: 'closed',
      actionBinding: 'opaque-sign-in-binding',
    })
    expect(mocks.issueBinding).toHaveBeenCalledWith({
      expectedEpoch: 'private-installation-epoch',
    })
  })
})
