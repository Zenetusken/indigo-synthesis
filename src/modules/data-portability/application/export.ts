import {
  type CanonicalValue,
  canonicalSha256,
} from '@/modules/methodology/domain/canonical'

export const exportSchemaVersion = '1.6.0-development'

export const dataExportFileKeys = Object.freeze([
  'identity',
  'profile',
  'programs',
  'sessions',
  'contentReleaseRevocations',
  'auditEvents',
  'provenance',
] as const)

export type DataExportFileKey = (typeof dataExportFileKeys)[number]

/** Data Portability owns the closed top-level archive contract. */
export type DataExportFiles = Readonly<Record<DataExportFileKey, unknown>>

type ExactDataExportFiles<Files extends DataExportFiles> = Files &
  Readonly<Record<Exclude<keyof Files, DataExportFileKey>, never>>

export type DataExportManifest = Readonly<{
  schemaVersion: string
  product: 'indigo-synthesis'
  generatedAt: string
  subjectUserId: string
  scope: 'authenticated-subject'
  format: 'application/json'
  hashAlgorithm: 'SHA-256'
  hashes: Readonly<Record<DataExportFileKey, string>>
  omissions: readonly Readonly<{ category: string; reason: string }>[]
}>

export type FinalizedDataExport<Files extends DataExportFiles> = Readonly<{
  manifest: DataExportManifest
  identity: Files['identity']
  profile: Files['profile']
  programs: Files['programs']
  sessions: Files['sessions']
  contentReleaseRevocations: Files['contentReleaseRevocations']
  auditEvents: Files['auditEvents']
  provenance: Files['provenance']
}>

function canonical(value: unknown): CanonicalValue {
  return JSON.parse(JSON.stringify(value)) as CanonicalValue
}

export class DataExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DataExportError'
  }
}

function assertExactDataExportFiles(value: unknown): asserts value is DataExportFiles {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DataExportError(
      'export.files-invalid',
      'The subject export file set is invalid.',
    )
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.some((key) => typeof key !== 'string') ||
    keys.length !== dataExportFileKeys.length ||
    dataExportFileKeys.some((key) => !keys.includes(key))
  ) {
    throw new DataExportError(
      'export.files-invalid',
      'The subject export file set does not match the versioned contract.',
    )
  }
}

/** Adds archive-level integrity metadata only after the read-only UnitOfWork commits. */
export function finalizeDataExport<Files extends DataExportFiles>(
  subjectUserId: string,
  files: ExactDataExportFiles<Files>,
): FinalizedDataExport<Files> {
  assertExactDataExportFiles(files)
  const hashes = Object.fromEntries(
    dataExportFileKeys.map((name) => [name, canonicalSha256(canonical(files[name]))]),
  ) as Record<DataExportFileKey, string>

  return {
    manifest: {
      schemaVersion: exportSchemaVersion,
      product: 'indigo-synthesis',
      generatedAt: new Date().toISOString(),
      subjectUserId,
      scope: 'authenticated-subject',
      format: 'application/json',
      hashAlgorithm: 'SHA-256',
      hashes,
      omissions: [
        {
          category: 'authentication-material',
          reason:
            'Password hashes, credential-provider records, active sessions, recovery codes, verification values, and tokens are never exported.',
        },
        {
          category: 'other-local-users',
          reason:
            'Other accounts and their product records are outside this subject-scoped archive.',
        },
        {
          category: 'methodology-and-template-source-material',
          reason:
            'Installed source libraries and release documents are not redistributed. Every owned prescription retains the versions, review status, hashes, and generated output needed to interpret it.',
        },
        {
          category: 'administrative-workflow-state',
          reason:
            'Installation bootstrap and mutation-epoch state, deletion previews, and non-personal deletion tombstones are operational records rather than subject data.',
        },
      ],
    },
    identity: files.identity,
    profile: files.profile,
    programs: files.programs,
    sessions: files.sessions,
    contentReleaseRevocations: files.contentReleaseRevocations,
    auditEvents: files.auditEvents,
    provenance: files.provenance,
  }
}
