import { toNextJsHandler } from 'better-auth/next-js'
import { getAuth } from '@/modules/identity/infrastructure/auth'

export const dynamic = 'force-dynamic'

function handlers() {
  return toNextJsHandler(getAuth())
}

export function GET(request: Request): Promise<Response> {
  return handlers().GET(request)
}

export function POST(request: Request): Promise<Response> {
  return handlers().POST(request)
}

export function PATCH(request: Request): Promise<Response> {
  return handlers().PATCH(request)
}

export function PUT(request: Request): Promise<Response> {
  return handlers().PUT(request)
}

export function DELETE(request: Request): Promise<Response> {
  return handlers().DELETE(request)
}
