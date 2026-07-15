import { getProductionIdentityAuthMutationPort } from '@/composition/identity-auth-mutations'
import {
  handleAuthDelete,
  handleAuthGet,
  handleAuthPatch,
  handleAuthPost,
  handleAuthPut,
} from '@/modules/identity/server/auth-handler'

export const dynamic = 'force-dynamic'

export function GET(request: Request): Promise<Response> {
  return handleAuthGet(request)
}

export function POST(request: Request): Promise<Response> {
  return handleAuthPost(request, getProductionIdentityAuthMutationPort())
}

export function PATCH(request: Request): Promise<Response> {
  return handleAuthPatch(request)
}

export function PUT(request: Request): Promise<Response> {
  return handleAuthPut(request)
}

export function DELETE(request: Request): Promise<Response> {
  return handleAuthDelete(request)
}
