import { and, asc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { formatIsoDateInTimezone } from '@/modules/athletes/domain/time'
import type { DisplayUnits } from '@/modules/athletes/domain/units'
import { getDb } from '@/platform/db/client'
import {
  athleteEquipment,
  athleteProfiles,
  athleteTrainingDays,
  auditEvents,
  safetyHolds,
  strengthBaselines,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

export const exerciseCodes = [
  'development.back-squat',
  'development.bench-press',
  'development.barbell-row',
  'development.deadlift',
  'development.overhead-press',
] as const

export const equipmentCodes = ['barbell', 'rack', 'bench', 'plates'] as const

const timezoneSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value })
        return true
      } catch {
        return false
      }
    },
    { message: 'Choose a valid IANA timezone.' },
  )

export const athleteSetupSchema = z
  .object({
    units: z.enum(['metric', 'imperial']),
    timezone: timezoneSchema,
    experience: z.enum(['familiar', 'experienced']),
    sessionMinutes: z.number().int().min(30).max(120),
    adultAttested: z.literal(true, { error: 'Confirm that you are at least 18.' }),
    techniqueAttested: z.literal(true, {
      error: 'Confirm that you are familiar with the listed exercises.',
    }),
    restrictionStatus: z.enum(['none', 'present', 'uncertain']),
    limitations: z.string().trim().max(2_000).nullable(),
    weekdays: z.array(z.number().int().min(0).max(6)).length(3),
    equipment: z.array(z.enum(equipmentCodes)).min(1),
    startingLoads: z.record(
      z.enum(exerciseCodes),
      z.number().int().min(0).max(1_000_000),
    ),
  })
  .superRefine((input, context) => {
    if (new Set(input.weekdays).size !== 3) {
      context.addIssue({
        code: 'custom',
        path: ['weekdays'],
        message: 'Choose three different training days.',
      })
    }

    if (input.restrictionStatus !== 'none' && !input.limitations) {
      context.addIssue({
        code: 'custom',
        path: ['limitations'],
        message: 'Describe the restriction or uncertainty without diagnosing it.',
      })
    }
  })

export type AthleteSetupInput = z.infer<typeof athleteSetupSchema>

export class ProfileAlreadyExistsError extends Error {
  constructor() {
    super('The first-slice profile is immutable after confirmation.')
    this.name = 'ProfileAlreadyExistsError'
  }
}

export async function getAthleteProfile(userId: string) {
  const db = getDb()
  const [profile, days, equipment, baselines, activeHold] = await Promise.all([
    db.query.athleteProfiles.findFirst({ where: eq(athleteProfiles.userId, userId) }),
    db
      .select()
      .from(athleteTrainingDays)
      .where(eq(athleteTrainingDays.userId, userId))
      .orderBy(asc(athleteTrainingDays.ordinal)),
    db.select().from(athleteEquipment).where(eq(athleteEquipment.userId, userId)),
    db.select().from(strengthBaselines).where(eq(strengthBaselines.userId, userId)),
    db.query.safetyHolds.findFirst({
      where: and(eq(safetyHolds.userId, userId), isNull(safetyHolds.clearedAt)),
    }),
  ])

  if (!profile) return null

  return {
    profile: { ...profile, units: profile.units as DisplayUnits },
    days,
    equipment,
    baselines,
    activeHold: activeHold ?? null,
  }
}

export async function saveAthleteProfile(
  actorUserId: string,
  rawInput: AthleteSetupInput,
): Promise<void> {
  const input = athleteSetupSchema.parse(rawInput)
  const now = new Date()

  await getDb().transaction(async (transaction) => {
    const [existingProfile] = await transaction
      .select({ userId: athleteProfiles.userId })
      .from(athleteProfiles)
      .where(eq(athleteProfiles.userId, actorUserId))
      .for('update')
      .limit(1)
    if (existingProfile) throw new ProfileAlreadyExistsError()

    await transaction.insert(athleteProfiles).values({
      userId: actorUserId,
      units: input.units,
      timezone: input.timezone,
      goal: 'general-strength',
      experience: input.experience,
      sessionMinutes: input.sessionMinutes,
      adultAttested: input.adultAttested,
      techniqueAttested: input.techniqueAttested,
      restrictionStatus: input.restrictionStatus,
      limitations: input.limitations,
      confirmedAt: now,
      updatedAt: now,
    })

    await transaction
      .delete(athleteTrainingDays)
      .where(eq(athleteTrainingDays.userId, actorUserId))
    await transaction.insert(athleteTrainingDays).values(
      [...input.weekdays]
        .sort((left, right) => left - right)
        .map((weekday, index) => ({
          userId: actorUserId,
          weekday,
          ordinal: index + 1,
        })),
    )

    await transaction
      .delete(athleteEquipment)
      .where(eq(athleteEquipment.userId, actorUserId))
    await transaction.insert(athleteEquipment).values(
      input.equipment.map((equipmentCode) => ({
        userId: actorUserId,
        equipmentCode,
      })),
    )

    await transaction
      .delete(strengthBaselines)
      .where(eq(strengthBaselines.userId, actorUserId))
    await transaction.insert(strengthBaselines).values(
      exerciseCodes.map((exerciseCode) => ({
        id: newUuidV7(),
        userId: actorUserId,
        exerciseCode,
        loadGrams: input.startingLoads[exerciseCode],
        repetitions: 1,
        protocol: 'trainee-selected-starting-load',
        testedOn: formatIsoDateInTimezone(now, input.timezone),
        provenance: 'user-attested',
      })),
    )

    const [existingEligibilityHold] = await transaction
      .select({ id: safetyHolds.id })
      .from(safetyHolds)
      .where(
        and(
          eq(safetyHolds.userId, actorUserId),
          eq(safetyHolds.reasonCode, 'eligibility-restriction'),
          isNull(safetyHolds.clearedAt),
        ),
      )
      .limit(1)

    if (input.restrictionStatus === 'none') {
      if (existingEligibilityHold) {
        await transaction
          .update(safetyHolds)
          .set({ clearedAt: now })
          .where(eq(safetyHolds.id, existingEligibilityHold.id))
      }
    } else if (!existingEligibilityHold) {
      await transaction.insert(safetyHolds).values({
        id: newUuidV7(),
        userId: actorUserId,
        reasonCode: 'eligibility-restriction',
        details: input.limitations,
      })
    }

    await transaction.insert(auditEvents).values({
      id: newUuidV7(),
      actorUserId,
      subjectUserId: actorUserId,
      eventType: 'athlete-profile-confirmed',
      entityType: 'athlete-profile',
      entityId: actorUserId,
      metadata: {
        restrictionStatus: input.restrictionStatus,
        provenance: 'user-attested',
      },
    })
  })
}
