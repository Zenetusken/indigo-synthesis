import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { describe, expect, it } from 'vitest'
import { DataExportError } from '../application/export'
import {
  createScopedSubjectExportGateway,
  SubjectExportGatewayScopeError,
  subjectExportReadManifest,
} from './scoped-subject-export'

function subjectMissingDatabase(): NodePgDatabase {
  const limit = async () => []
  const where = () => ({ limit })
  const from = () => ({ where })
  return { select: () => ({ from }) } as unknown as NodePgDatabase
}

describe('scoped subject export adapter', () => {
  it('pins the exact temporary SELECT-only table breadth', () => {
    expect(subjectExportReadManifest).toEqual([
      'adjustment_decision',
      'adjustment_decision_invalidation',
      'athlete_equipment',
      'athlete_profile',
      'athlete_training_day',
      'audit_event',
      'content_release_revocation',
      'exercise_prescription',
      'future_load_explanation_cache',
      'performed_set',
      'performed_set_correction',
      'planned_workout',
      'program',
      'program_revision',
      'program_revision_invalidation',
      'program_revision_lineage',
      'safety_hold',
      'safety_hold_resolution',
      'session_exercise',
      'session_feedback',
      'session_feedback_correction',
      'set_prescription',
      'strength_baseline',
      'training_command_receipt',
      'training_fact_correction',
      'user',
      'workout_session',
    ])
    expect(Object.isFrozen(subjectExportReadManifest)).toBe(true)
  })

  it('consumes its subject-bound gateway exactly once even when the read fails', async () => {
    const gateway = createScopedSubjectExportGateway(subjectMissingDatabase(), {
      subjectUserId: 'subject-1',
    })

    await expect(gateway.readFiles()).rejects.toBeInstanceOf(DataExportError)
    await expect(gateway.readFiles()).rejects.toBeInstanceOf(
      SubjectExportGatewayScopeError,
    )
  })

  it.each([
    '',
    'invalid\0subject',
  ])('rejects invalid subject binding %j before constructing a gateway', (subjectUserId) => {
    expect(() =>
      createScopedSubjectExportGateway(subjectMissingDatabase(), {
        subjectUserId,
      }),
    ).toThrow(TypeError)
  })
})
