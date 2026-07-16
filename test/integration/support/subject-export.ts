import {
  getProductionDataPortabilitySubjectExportPort,
  type SubjectExportResult,
} from '@/composition/data-portability-subject-export'
import { issueSubjectExportCommand } from '@/modules/identity/infrastructure/subject-export-authority'

/** Enters the production export composition using integration-owned verified token material. */
export async function createSubjectExportThroughProductionPort(
  verifiedSessionToken: string,
): Promise<Extract<SubjectExportResult, { kind: 'exported' }>['archive']> {
  const result = await getProductionDataPortabilitySubjectExportPort().create(
    issueSubjectExportCommand({ verifiedSessionToken }),
  )
  if (result.kind !== 'exported') {
    throw new Error(`Subject export failed in integration proof: ${result.kind}`)
  }
  return result.archive
}
