import { describe, expect, it } from 'vitest'
import { canonicalSha256 } from '@/modules/methodology/domain/canonical'
import { type DataExportError, dataExportFileKeys, finalizeDataExport } from './export'

function files() {
  return {
    identity: { id: 'subject-1' },
    profile: { profile: null },
    programs: [],
    sessions: [],
    contentReleaseRevocations: [],
    auditEvents: [],
    provenance: { contract: 'test' },
  } as const
}

describe('data export archive contract', () => {
  it('finalizes the exact application-owned file set without allowing manifest override', () => {
    const archive = finalizeDataExport('subject-1', files())

    expect(Object.keys(archive)).toEqual(['manifest', ...dataExportFileKeys])
    expect(Object.keys(archive.manifest.hashes)).toEqual(dataExportFileKeys)
    expect(archive.manifest).toMatchObject({
      schemaVersion: '1.6.0-development',
      subjectUserId: 'subject-1',
      scope: 'authenticated-subject',
    })
    expect(archive.identity).toEqual({ id: 'subject-1' })
    for (const key of dataExportFileKeys) {
      expect(archive.manifest.hashes[key]).toBe(canonicalSha256(files()[key]))
    }
  })

  it.each([
    [
      'reserved manifest override',
      { ...files(), manifest: { schemaVersion: 'hostile' } },
    ],
    ['unexpected file', { ...files(), credentials: { passwordHash: 'hostile' } }],
    ['missing file', (({ auditEvents: _auditEvents, ...missing }) => missing)(files())],
  ] as const)('rejects a %s before hashing or assembly', (_label, value) => {
    expect(() => finalizeDataExport('subject-1', value as never)).toThrow(
      expect.objectContaining<DataExportError>({
        name: 'DataExportError',
        code: 'export.files-invalid',
        message: expect.any(String),
      }),
    )
  })
})
