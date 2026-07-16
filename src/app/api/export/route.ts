import { getProductionDataPortabilitySubjectExportPort } from '@/composition/data-portability-subject-export'
import { captureSubjectExportCommand } from '@/modules/identity/server/subject-export-command'

export const dynamic = 'force-dynamic'

function unavailableResponse(): Response {
  return Response.json(
    { error: 'Export is temporarily unavailable. Please try again.' },
    {
      status: 503,
      headers: { 'cache-control': 'no-store', 'retry-after': '5' },
    },
  )
}

export async function GET(request: Request): Promise<Response> {
  let capture: Awaited<ReturnType<typeof captureSubjectExportCommand>>
  try {
    capture = await captureSubjectExportCommand(request)
  } catch {
    return unavailableResponse()
  }
  if (capture.kind === 'rejected') {
    return Response.json(
      { error: 'Authentication required.' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    )
  }

  let result: Awaited<
    ReturnType<ReturnType<typeof getProductionDataPortabilitySubjectExportPort>['create']>
  >
  try {
    result = await getProductionDataPortabilitySubjectExportPort().create(
      capture.command,
      { signal: request.signal },
    )
  } catch {
    return unavailableResponse()
  }
  if (result.kind === 'stale') {
    return Response.json(
      { error: 'Authentication required.' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    )
  }
  if (result.kind === 'unavailable') {
    return unavailableResponse()
  }
  if (result.kind === 'invalid') {
    return Response.json(
      { error: 'Export could not be generated.' },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    )
  }

  const date = new Date().toISOString().slice(0, 10)

  return new Response(JSON.stringify(result.archive, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="indigo-synthesis-export-${date}.json"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
