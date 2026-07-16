import { getServerConfig } from '@/platform/config/server'
import { verifyIdentitySessionCookie } from '../infrastructure/auth'
import {
  issueSubjectExportCommand,
  type SubjectExportCommand,
} from '../infrastructure/subject-export-authority'

export type { SubjectExportCommand }

export type SubjectExportCommandCapture =
  | Readonly<{ kind: 'captured'; command: SubjectExportCommand }>
  | Readonly<{ kind: 'rejected' }>

function sessionVerificationRequest(request: Request): Request {
  const appOrigin = getServerConfig().appOrigin
  const requestHeadersCopy = new Headers(request.headers)
  requestHeadersCopy.delete('content-length')
  requestHeadersCopy.delete('content-type')
  requestHeadersCopy.set('origin', appOrigin)
  return new Request(`${appOrigin}/api/auth/indigo/verify-session-cookie`, {
    method: 'POST',
    headers: requestHeadersCopy,
  })
}

/** Captures only server-verified cookie authority; the caller cannot submit an actor id. */
export async function captureSubjectExportCommand(
  request: Request,
): Promise<SubjectExportCommandCapture> {
  const verificationRequest = sessionVerificationRequest(request)
  const verification = await verifyIdentitySessionCookie(verificationRequest)
  if (verification.kind !== 'verified') {
    return Object.freeze({ kind: 'rejected' })
  }
  return Object.freeze({
    kind: 'captured',
    command: issueSubjectExportCommand({
      verifiedSessionToken: verification.sessionToken,
    }),
  })
}
