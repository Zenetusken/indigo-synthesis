import { z } from 'zod'

const recordIdSchema = z.uuid()
const commandIdSchema = z.string().trim().min(1).max(200)

export const startWorkoutCommandSchema = z.object({
  plannedWorkoutId: recordIdSchema,
  commandId: commandIdSchema,
})

export const completeSetCommandSchema = z.object({
  sessionId: recordIdSchema,
  setId: recordIdSchema,
  commandId: commandIdSchema,
  actualLoadGrams: z.number().finite().int().min(0).max(1_000_000),
  actualRepetitions: z.number().finite().int().min(1).max(100),
  rpe: z.number().finite().int().min(1).max(10).nullable(),
  note: z.string().trim().max(500).nullable(),
})

export const skipSetCommandSchema = z.object({
  sessionId: recordIdSchema,
  setId: recordIdSchema,
  commandId: commandIdSchema,
  reason: z.string().trim().min(1).max(300),
})

export const sessionPauseCommandSchema = z.object({
  sessionId: recordIdSchema,
  paused: z.boolean(),
})

export const reportPainCommandSchema = z.object({
  sessionId: recordIdSchema,
  details: z.string().trim().max(1_000),
})

export const completeWorkoutCommandSchema = z.object({
  sessionId: recordIdSchema,
  commandId: commandIdSchema,
  noPainAttested: z.boolean(),
})

export const abandonWorkoutCommandSchema = z.object({
  sessionId: recordIdSchema,
})
