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

function sessionVerificationRequest(requestHeaders: Headers): Request {
  const requestHeadersCopy = new Headers(requestHeaders)
  requestHeadersCopy.delete('content-length')
  requestHeadersCopy.delete('content-type')
  return new Request(
    `${getServerConfig().appOrigin}/api/auth/indigo/verify-session-cookie`,
    { method: 'POST', headers: requestHeadersCopy },
  )
}

/** Captures only server-verified cookie authority; the caller cannot submit an actor id. */
export async function captureSubjectExportCommand(
  request: Request,
): Promise<SubjectExportCommandCapture> {
  const requestHeaders = new Headers(request.headers)
  const verification = await verifyIdentitySessionCookie(
    sessionVerificationRequest(requestHeaders),
  )
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
