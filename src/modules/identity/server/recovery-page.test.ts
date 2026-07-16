import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getMemberResetPageInstallation,
  getOwnerRecoveryPageInstallation,
} from './recovery-page'

const mocks = vi.hoisted(() => ({
  getInstallation: vi.fn(),
  issueMemberBinding: vi.fn(),
  issueOwnerBinding: vi.fn(),
}))

vi.mock('../infrastructure/installation', () => ({
  getServerRecoveryPageInstallationState: mocks.getInstallation,
}))
vi.mock('../infrastructure/action-binding', () => ({
  issueMemberResetRedemptionActionBinding: mocks.issueMemberBinding,
  issueOwnerRecoveryRedemptionActionBinding: mocks.issueOwnerBinding,
}))

describe('public recovery page installation bindings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns no proof for either purpose while the installation is open', async () => {
    mocks.getInstallation.mockResolvedValue({ kind: 'open' })

    await expect(getMemberResetPageInstallation()).resolves.toEqual({ kind: 'open' })
    await expect(getOwnerRecoveryPageInstallation()).resolves.toEqual({ kind: 'open' })
    expect(mocks.issueMemberBinding).not.toHaveBeenCalled()
    expect(mocks.issueOwnerBinding).not.toHaveBeenCalled()
  })

  it('turns one coherent closed generation into purpose-separated opaque proofs', async () => {
    mocks.getInstallation.mockResolvedValue({
      kind: 'closed',
      productMutationEpoch: 'private-installation-generation',
    })
    mocks.issueMemberBinding.mockReturnValue('opaque-member-redemption-binding')
    mocks.issueOwnerBinding.mockReturnValue('opaque-owner-redemption-binding')

    const memberPage = await getMemberResetPageInstallation()
    const ownerPage = await getOwnerRecoveryPageInstallation()

    expect(memberPage).toEqual({
      kind: 'closed',
      actionBinding: 'opaque-member-redemption-binding',
    })
    expect(ownerPage).toEqual({
      kind: 'closed',
      actionBinding: 'opaque-owner-redemption-binding',
    })
    expect(mocks.issueMemberBinding).toHaveBeenCalledWith({
      expectedEpoch: 'private-installation-generation',
    })
    expect(mocks.issueOwnerBinding).toHaveBeenCalledWith({
      expectedEpoch: 'private-installation-generation',
    })
    expect(JSON.stringify([memberPage, ownerPage])).not.toContain(
      'private-installation-generation',
    )
  })
})
