import { and, count, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '@/composition/identity-bootstrap-mutations'
import { saveAthleteProfile } from '@/modules/athletes/application/profile'
import {
  createSubjectDeletionPlan,
  type DeletionError,
  executeInstanceReset,
  executeSubjectDeletion,
} from '@/modules/data-portability/application/deletion'
import { destructiveReauthenticationPolicy } from '@/modules/data-portability/application/destructive-reauthentication'
import type { AuthenticatedActor } from '@/modules/identity/application/actor'
import { resetAuthForTests } from '@/modules/identity/infrastructure/auth'
import { createLocalUserAsOwner } from '@/modules/identity/infrastructure/local-users'
import { createScopedIdentityMutationGateway } from '@/modules/identity/infrastructure/scoped-mutation-auth'
import { issueOwnerRecovery } from '@/modules/identity/recovery/owner-recovery'
import { generateDraftProgram } from '@/modules/programs/application/programs'
import { getServerConfig, resetServerConfigForTests } from '@/platform/config/server'
import { closeDb, getDb } from '@/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '@/platform/db/disposable-integration-database'
import { migrateDatabase } from '@/platform/db/migrate'
import {
  account,
  athleteProfiles,
  auditEvents,
  deletionPlans,
  deletionTombstones,
  destructiveReauthenticationStates,
  installationState,
  programs,
  session,
  user,
  verification,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

const ownerPassword = 'deletion-hardening-owner-password'
const memberPassword = 'deletion-hardening-member-password'

let integrationDatabase: DisposableIntegrationDatabase | undefined
let owner: AuthenticatedActor
let member: AuthenticatedActor
let ownerSessionToken: string
let foreignAuditId: string

async function authRequest(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const origin = getServerConfig().appOrigin
  return createScopedIdentityMutationGateway(getDb()).signInEmail(
    new Request(`${origin}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    }),
  )
}

async function seedTrainingSubject(actor: AuthenticatedActor): Promise<void> {
  await saveAthleteProfile(actor.userId, {
    units: 'metric',
    timezone: 'America/Toronto',
    experience: 'familiar',
    sessionMinutes: 60,
    adultAttested: true,
    techniqueAttested: true,
    restrictionStatus: 'none',
    limitations: null,
    weekdays: [1, 3, 5],
    equipment: ['barbell', 'rack', 'bench', 'plates'],
    startingLoads: {
      'development.back-squat': 60_000,
      'development.bench-press': 40_000,
      'development.barbell-row': 40_000,
      'development.deadlift': 80_000,
      'development.overhead-press': 30_000,
    },
  })
  await generateDraftProgram(actor.userId, '2026-07-14')
}

function subjectDeletionAttempt(password: string): Promise<void> {
  return executeSubjectDeletion({
    actor: owner,
    planId: 'missing-trainee-data-plan',
    planDigest: 'missing-trainee-data-digest',
    password,
    typedConfirmation: 'DELETE',
    acknowledged: true,
  })
}

function instanceResetAttempt(password: string): Promise<void> {
  return executeInstanceReset({
    actor: owner,
    planId: 'missing-instance-reset-plan',
    planDigest: 'missing-instance-reset-digest',
    password,
    typedConfirmation: 'RESET',
    acknowledged: true,
  })
}

beforeAll(async () => {
  integrationDatabase = createDisposableIntegrationDatabase({
    administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
    suite: 'deletion_hardening',
  })
  await integrationDatabase.create()
  integrationDatabase.activateDatabaseUrl()
  resetServerConfigForTests()
  resetAuthForTests()
  await closeDb()
  await migrateDatabase()

  const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  const createdOwner = await createOwnerWithBootstrapCode({
    name: 'Deletion Hardening Owner',
    email: 'deletion-hardening-owner@example.test',
    password: ownerPassword,
    code: bootstrap.code,
  })
  owner = { ...createdOwner, userId: createdOwner.id, role: 'owner' }

  const signIn = await authRequest('/sign-in/email', {
    email: owner.email,
    password: ownerPassword,
  })
  const signInBody = (await signIn.json()) as { readonly token?: string }
  if (!signIn.ok || !signInBody.token) {
    throw new Error('Could not create the owner continuity session.')
  }
  ownerSessionToken = signInBody.token

  const createdMember = await createLocalUserAsOwner(owner, {
    name: 'Retained Local Member',
    email: 'retained-local-member@example.test',
    password: memberPassword,
  })
  member = { ...createdMember, userId: createdMember.id, role: 'member' }

  await seedTrainingSubject(owner)
  await seedTrainingSubject(member)
  await issueOwnerRecovery({ ownerEmail: owner.email, ttlMinutes: 15 })

  foreignAuditId = newUuidV7()
  await getDb().insert(auditEvents).values({
    id: foreignAuditId,
    actorUserId: owner.userId,
    subjectUserId: member.userId,
    eventType: 'owner-admin-retention-fixture',
    entityType: 'integration-fixture',
    entityId: null,
    metadata: {},
  })
})

afterAll(async () => {
  resetAuthForTests()
  await closeDb()
  integrationDatabase?.restoreDatabaseUrl()
  resetServerConfigForTests()
  await integrationDatabase?.cleanup()
})

describe.sequential('destructive deletion hardening', () => {
  it('enforces independent PostgreSQL attempt windows, lockout, expiry, audit, and success reset', async () => {
    await createSubjectDeletionPlan(owner)
    for (
      let attempt = 1;
      attempt < destructiveReauthenticationPolicy.maximumFailedAttempts;
      attempt += 1
    ) {
      await expect(subjectDeletionAttempt('wrong-password')).rejects.toMatchObject({
        code: 'deletion.reauthentication-failed',
      } satisfies Partial<DeletionError>)
    }

    await expect(subjectDeletionAttempt('wrong-password')).rejects.toMatchObject({
      code: 'deletion.reauthentication-locked',
    } satisfies Partial<DeletionError>)
    const [auditsAtLockout] = await getDb()
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'destructive-reauthentication-denied'))
    await expect(subjectDeletionAttempt(ownerPassword)).rejects.toMatchObject({
      code: 'deletion.reauthentication-locked',
    } satisfies Partial<DeletionError>)

    const [lockedSubjectState] = await getDb()
      .select()
      .from(destructiveReauthenticationStates)
      .where(eq(destructiveReauthenticationStates.purpose, 'trainee-data-deletion'))
    expect(lockedSubjectState).toMatchObject({
      failedAttempts: destructiveReauthenticationPolicy.maximumFailedAttempts,
      purpose: 'trainee-data-deletion',
    })
    expect(lockedSubjectState?.lockedUntil?.getTime()).toBeGreaterThan(Date.now())
    const [auditsAfterSuppressedAttempt] = await getDb()
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'destructive-reauthentication-denied'))
    expect(auditsAfterSuppressedAttempt?.value).toBe(auditsAtLockout?.value)
    const [subjectPlansAfterDenial] = await getDb()
      .select({ value: count() })
      .from(deletionPlans)
      .where(
        and(
          eq(deletionPlans.userId, owner.userId),
          eq(deletionPlans.scope, 'trainee-data'),
        ),
      )
    expect(subjectPlansAfterDenial?.value).toBe(0)

    await expect(instanceResetAttempt('wrong-password')).rejects.toMatchObject({
      code: 'deletion.reauthentication-failed',
    } satisfies Partial<DeletionError>)
    const purposeStates = await getDb()
      .select({ purpose: destructiveReauthenticationStates.purpose })
      .from(destructiveReauthenticationStates)
    expect(purposeStates.map((state) => state.purpose).sort()).toEqual([
      'instance-reset',
      'trainee-data-deletion',
    ])

    const expiredAt = new Date(Date.now() - 60_000)
    const expiredWindowStartedAt = new Date(
      expiredAt.getTime() -
        destructiveReauthenticationPolicy.attemptWindowMilliseconds -
        60_000,
    )
    await getDb()
      .update(destructiveReauthenticationStates)
      .set({
        windowStartedAt: expiredWindowStartedAt,
        lastAttemptAt: new Date(expiredAt.getTime() - 1_000),
        lockedUntil: expiredAt,
        updatedAt: expiredAt,
      })
      .where(eq(destructiveReauthenticationStates.id, lockedSubjectState?.id ?? ''))

    await expect(subjectDeletionAttempt(ownerPassword)).rejects.toMatchObject({
      code: 'deletion.plan-invalid',
    } satisfies Partial<DeletionError>)
    await expect(instanceResetAttempt(ownerPassword)).rejects.toMatchObject({
      code: 'deletion.plan-invalid',
    } satisfies Partial<DeletionError>)
    const [statesAfterSuccess] = await getDb()
      .select({ value: count() })
      .from(destructiveReauthenticationStates)
    expect(statesAfterSuccess?.value).toBe(0)

    await expect(subjectDeletionAttempt('wrong-password')).rejects.toMatchObject({
      code: 'deletion.reauthentication-failed',
    } satisfies Partial<DeletionError>)
    await expect(subjectDeletionAttempt('wrong-password')).rejects.toMatchObject({
      code: 'deletion.reauthentication-failed',
    } satisfies Partial<DeletionError>)
    const [partialWindow] = await getDb()
      .select()
      .from(destructiveReauthenticationStates)
      .where(eq(destructiveReauthenticationStates.purpose, 'trainee-data-deletion'))
    if (!partialWindow) throw new Error('Missing partial attempt-window fixture.')
    const oldWindowStart = new Date(
      Date.now() - destructiveReauthenticationPolicy.attemptWindowMilliseconds - 60_000,
    )
    await getDb()
      .update(destructiveReauthenticationStates)
      .set({
        windowStartedAt: oldWindowStart,
        lastAttemptAt: new Date(oldWindowStart.getTime() + 1_000),
        updatedAt: new Date(oldWindowStart.getTime() + 1_000),
      })
      .where(eq(destructiveReauthenticationStates.id, partialWindow.id))
    await expect(subjectDeletionAttempt('wrong-password')).rejects.toMatchObject({
      code: 'deletion.reauthentication-failed',
    } satisfies Partial<DeletionError>)
    const [renewedWindow] = await getDb()
      .select()
      .from(destructiveReauthenticationStates)
      .where(eq(destructiveReauthenticationStates.id, partialWindow.id))
    expect(renewedWindow?.failedAttempts).toBe(1)
    expect(renewedWindow?.windowStartedAt.getTime()).toBeGreaterThan(
      oldWindowStart.getTime(),
    )

    const deniedAudit = await getDb()
      .select({ entityId: auditEvents.entityId, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'destructive-reauthentication-denied'))
    expect(deniedAudit).toHaveLength(9)
    expect(deniedAudit.every((event) => event.entityId !== null)).toBe(true)
    expect(
      deniedAudit.map((event) => (event.metadata as { outcome?: string }).outcome),
    ).toEqual(expect.arrayContaining(['failed', 'locked']))
  })

  it('deletes owner trainee data while preserving installation identity, login continuity, and every member row', async () => {
    const [memberProgramsBefore] = await getDb()
      .select({ value: count() })
      .from(programs)
      .where(eq(programs.userId, member.userId))
    const [memberProfilesBefore] = await getDb()
      .select({ value: count() })
      .from(athleteProfiles)
      .where(eq(athleteProfiles.userId, member.userId))

    const plan = await createSubjectDeletionPlan(owner)
    expect(plan.counts).toMatchObject({
      users: 0,
      authSessions: 0,
      authAccounts: 0,
      authVerifications: 0,
      athleteProfiles: 1,
      athleteTrainingDays: 3,
      athleteEquipment: 4,
      strengthBaselines: 5,
      programs: 1,
      programRevisions: 1,
      plannedWorkouts: 6,
      auditActorReferencesRedacted: 0,
      deletionPlans: 1,
    })

    await executeSubjectDeletion({
      actor: owner,
      planId: plan.id,
      planDigest: plan.digest,
      password: ownerPassword,
      typedConfirmation: 'DELETE',
      acknowledged: true,
    })

    const [installation] = await getDb().select().from(installationState)
    const [ownerUser] = await getDb().select().from(user).where(eq(user.id, owner.userId))
    const [ownerCredential] = await getDb()
      .select({ id: account.id, password: account.password })
      .from(account)
      .where(and(eq(account.userId, owner.userId), eq(account.providerId, 'credential')))
    const [ownerSession] = await getDb()
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.userId, owner.userId), eq(session.token, ownerSessionToken)))
    const [ownerRecovery] = await getDb()
      .select({ id: verification.id })
      .from(verification)
      .where(eq(verification.identifier, `indigo:owner-recovery:${owner.userId}`))
    const [ownerProfile] = await getDb()
      .select()
      .from(athleteProfiles)
      .where(eq(athleteProfiles.userId, owner.userId))
    const [ownerProgram] = await getDb()
      .select()
      .from(programs)
      .where(eq(programs.userId, owner.userId))
    const [memberUser] = await getDb()
      .select()
      .from(user)
      .where(eq(user.id, member.userId))
    const [memberProgramsAfter] = await getDb()
      .select({ value: count() })
      .from(programs)
      .where(eq(programs.userId, member.userId))
    const [memberProfilesAfter] = await getDb()
      .select({ value: count() })
      .from(athleteProfiles)
      .where(eq(athleteProfiles.userId, member.userId))
    const [foreignAudit] = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, foreignAuditId))
    const [ownerPlans] = await getDb()
      .select({ value: count() })
      .from(deletionPlans)
      .where(eq(deletionPlans.userId, owner.userId))
    const [tombstone] = await getDb()
      .select()
      .from(deletionTombstones)
      .where(eq(deletionTombstones.scope, 'trainee-data'))

    expect(installation).toMatchObject({
      ownerUserId: owner.userId,
      bootstrapClosedAt: expect.any(Date),
    })
    expect(ownerUser).toMatchObject({ id: owner.userId, email: owner.email })
    expect(ownerCredential?.id).toBeTruthy()
    expect(ownerCredential?.password).toBeTruthy()
    expect(ownerSession?.id).toBeTruthy()
    expect(ownerRecovery?.id).toBeTruthy()
    expect(ownerProfile).toBeUndefined()
    expect(ownerProgram).toBeUndefined()
    expect(memberUser).toMatchObject({ id: member.userId, email: member.email })
    expect(memberProgramsAfter?.value).toBe(memberProgramsBefore?.value)
    expect(memberProfilesAfter?.value).toBe(memberProfilesBefore?.value)
    expect(foreignAudit).toMatchObject({
      id: foreignAuditId,
      actorUserId: owner.userId,
      subjectUserId: member.userId,
    })
    expect(ownerPlans?.value).toBe(0)
    expect(tombstone).toMatchObject({
      actorClass: 'owner',
      scope: 'trainee-data',
      rowCounts: plan.counts,
    })
  })
})
