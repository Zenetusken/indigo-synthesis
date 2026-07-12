import { createDataExport } from '@/modules/data-portability/application/export'
import { getActor } from '@/modules/identity/server/actor'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const actor = await getActor()
  if (!actor) {
    return Response.json({ error: 'Authentication required.' }, { status: 401 })
  }

  const archive = await createDataExport(actor)
  const date = new Date().toISOString().slice(0, 10)

  return new Response(JSON.stringify(archive, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="indigo-synthesis-export-${date}.json"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
