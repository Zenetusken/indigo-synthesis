import { eq, sql } from 'drizzle-orm'
import type { AuthenticatedActor } from '@/modules/identity/application/actor'
import { assertOwner } from '@/modules/identity/application/actor'
import { type Database, type DatabaseTransaction, getDb } from '@/platform/db/client'
import {
  auditEvents,
  contentReleaseRevocations,
  programRevisions,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

export type ContentReleaseKind = 'methodology' | 'template'

type ContentReleaseLockTarget = {
  readonly contentKind: ContentReleaseKind
  readonly contentId: string
  readonly contentVersion: string
}

export class ContentRevocationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ContentRevocationError'
  }
}

function normalizeReason(reason: string): string {
  const normalized = reason.trim()
  if (normalized.length < 1 || normalized.length > 300) {
    throw new ContentRevocationError(
      'content-revocation.reason-invalid',
      'Revocation reason must be between 1 and 300 characters.',
    )
  }
  return normalized
}

function contentReleaseLockKey(target: ContentReleaseLockTarget): string {
  return `${target.contentKind}:${target.contentId}:${target.contentVersion}`
}

async function lockContentReleases(
  transaction: DatabaseTransaction,
  targets: ReadonlyArray<ContentReleaseLockTarget>,
): Promise<void> {
  const sortedTargets = [...targets].sort((left, right) =>
    contentReleaseLockKey(left).localeCompare(contentReleaseLockKey(right)),
  )

  for (const target of sortedTargets) {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${contentReleaseLockKey(target)}, 0))`,
    )
  }
}

export async function lockContentRelease(
  transaction: DatabaseTransaction,
  contentKind: ContentReleaseKind,
  contentId: string,
  contentVersion: string,
): Promise<void> {
  await lockContentReleases(transaction, [{ contentKind, contentId, contentVersion }])
}

export async function lockProgramRevisionContentReleases(
  transaction: DatabaseTransaction,
  revisionId: string,
): Promise<boolean> {
  const [revision] = await transaction
    .select({
      methodologyId: programRevisions.methodologyId,
      methodologyVersion: programRevisions.methodologyVersion,
      templateId: programRevisions.templateId,
      templateVersion: programRevisions.templateVersion,
    })
    .from(programRevisions)
    .where(eq(programRevisions.id, revisionId))
    .limit(1)

  if (!revision) return false

  await lockContentReleases(transaction, [
    {
      contentKind: 'methodology',
      contentId: revision.methodologyId,
      contentVersion: revision.methodologyVersion,
    },
    {
      contentKind: 'template',
      contentId: revision.templateId,
      contentVersion: revision.templateVersion,
    },
  ])
  return true
}

export async function revokeContentRelease(input: {
  readonly actor: AuthenticatedActor
  readonly contentKind: ContentReleaseKind
  readonly contentId: string
  readonly contentVersion: string
  readonly reason: string
}): Promise<string> {
  assertOwner(input.actor)
  const id = newUuidV7()
  const reason = normalizeReason(input.reason)

  await getDb().transaction(async (transaction) => {
    await lockContentRelease(
      transaction,
      input.contentKind,
      input.contentId,
      input.contentVersion,
    )
    await transaction.insert(contentReleaseRevocations).values({
      id,
      contentKind: input.contentKind,
      contentId: input.contentId,
      contentVersion: input.contentVersion,
      reason,
      actorUserId: input.actor.userId,
    })
    await transaction.insert(auditEvents).values({
      id: newUuidV7(),
      actorUserId: input.actor.userId,
      subjectUserId: null,
      eventType: 'content-release-revoked',
      entityType: 'content-release',
      entityId: `${input.contentKind}:${input.contentId}:${input.contentVersion}`,
      metadata: {
        contentKind: input.contentKind,
        contentId: input.contentId,
        contentVersion: input.contentVersion,
        revocationId: id,
      },
    })
  })

  return id
}

export function contentRevokedForProgramRevisionSql() {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${contentReleaseRevocations} AS revocation
    WHERE (
        revocation.content_kind = 'methodology'
        AND revocation.content_id = program_revision.methodology_id
        AND revocation.content_version = program_revision.methodology_version
      )
      OR (
        revocation.content_kind = 'template'
        AND revocation.content_id = program_revision.template_id
        AND revocation.content_version = program_revision.template_version
      )
  )`
}

export async function programRevisionContentIsRevoked(
  transaction: Database | DatabaseTransaction,
  revisionId: string,
): Promise<boolean> {
  const [row] = await transaction
    .select({
      revoked: contentRevokedForProgramRevisionSql(),
    })
    .from(programRevisions)
    .where(eq(programRevisions.id, revisionId))
    .limit(1)
  return row?.revoked ?? false
}
