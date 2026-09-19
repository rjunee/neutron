import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { ReplModelError } from '@neutronai/runtime/repl-model.ts'
import { jsonError, jsonResponse, readJsonBody, resolveBearer } from './surface-kit.ts'
import { resolveScopeSegment } from './scope-segment.ts'

export interface NativeOwnerIdentity {
  projectId: string
  threadId: string
  bindingRevision: string
  generation: number
  epoch: number
  turnId: string | null
}
export type NativeOwnerAction = NativeOwnerIdentity & ({ action: 'interrupt' } | { action: 'reply'; requestId: string | number; result: unknown })

/** An authenticated owner action on an observed native turn, never a raw RPC proxy. */
export function createAppNativeOwnerControlSurface(opts: {
  auth: AppWsAuthResolver
  canAccess(userId: string, ownerSlug: string, projectId: string): Promise<boolean>
  read(projectId: string): Promise<unknown>
  act(projectId: string, request: NativeOwnerAction): Promise<unknown>
}) {
  const failure = (status: number, code: string, message: string): Response => {
    const response = jsonError(status, code, message)
    response.headers.set('cache-control', 'no-store')
    return response
  }
  return { handler: async (req: Request): Promise<Response | null> => {
    const match = /^\/api\/app\/projects\/([^/]+)\/repl-control$/.exec(new URL(req.url).pathname)
    if (!match) return null
    const auth = await resolveBearer(req, opts.auth)
    if ('code' in auth) return failure(401, auth.code, auth.message)
    const projectId = resolveScopeSegment(match[1])
    if (!projectId || projectId === '~general') return failure(400, 'invalid_project_id', 'Native controls require a project.')
    try {
      if (!await opts.canAccess(auth.user_id, auth.project_slug, projectId)) return failure(404, 'project_not_found', 'Project not found')
      let state: unknown
      if (req.method === 'GET') state = await opts.read(projectId)
      else if (req.method === 'POST') {
        const value = await readJsonBody(req)
        if (!value || typeof value !== 'object' || Array.isArray(value)) return failure(400, 'invalid_request', 'Expected a native owner action.')
        const body = value as Record<string, unknown>
        if (body.projectId !== projectId || typeof body.threadId !== 'string' || !body.threadId
          || typeof body.bindingRevision !== 'string' || !body.bindingRevision
          || !Number.isSafeInteger(body.generation) || Number(body.generation) < 1
          || !Number.isSafeInteger(body.epoch) || Number(body.epoch) < 0
          || typeof body.turnId !== 'string' || !body.turnId
          || !['interrupt', 'reply'].includes(String(body.action))
          || body.action === 'reply' && (!(typeof body.requestId === 'string' || Number.isSafeInteger(body.requestId)) || !('result' in body))) {
          return failure(400, 'invalid_request', 'Expected exact project, native thread, turn and revision identity.')
        }
        state = await opts.act(projectId, body as unknown as NativeOwnerAction)
      } else return failure(405, 'method_not_allowed', 'Expected GET or POST')
      const response = jsonResponse(200, state)
      response.headers.set('cache-control', 'no-store')
      return response
    } catch (error) {
      if (error instanceof ReplModelError) return failure(error.code === 'session-changed' || error.code === 'busy' ? 409
        : error.code === 'invalid-model' ? 400 : 503, error.code, error.message)
      return failure(503, 'unavailable', 'Native owner control is unavailable.')
    }
  } }
}
