import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { ReplModelError, type ReplModelState, type ReplModelSwitch } from '@neutronai/runtime/repl-model.ts'
import { GENERAL_RAIL_ID } from '@neutronai/wire-types/topic-id.ts'
import { jsonResponse, readJsonBody, resolveBearer } from './surface-kit.ts'
import { resolveScopeSegment } from './scope-segment.ts'

function jsonError(status: number, error: string, detail: string): Response {
  const response = jsonResponse(status, { error, detail })
  response.headers.set('cache-control', 'no-store')
  return response
}

export interface ReplModelScope {
  userId: string
  ownerSlug: string
  projectId: string | null
}

export interface AppReplModelSurfaceOptions {
  auth: AppWsAuthResolver
  /** Check the server-derived owner and project before touching a live session. */
  canAccess(scope: ReplModelScope): Promise<boolean>
  read(scope: ReplModelScope): Promise<ReplModelState>
  switch(scope: ReplModelScope, request: ReplModelSwitch): Promise<ReplModelState>
}

/** Both clients share one live, conditional model-control endpoint. */
export function createAppReplModelSurface(opts: AppReplModelSurfaceOptions) {
  return {
    handler: async (req: Request): Promise<Response | null> => {
      const match = /^\/api\/app\/projects\/([^/]+)\/repl-model$/.exec(new URL(req.url).pathname)
      if (match === null) return null
      const auth = await resolveBearer(req, opts.auth)
      if ('code' in auth) return jsonError(401, auth.code, auth.message)
      const segment = resolveScopeSegment(match[1])
      if (segment === null) return jsonError(400, 'invalid_project_id', 'Invalid project scope')
      const scope: ReplModelScope = {
        userId: auth.user_id,
        ownerSlug: auth.project_slug,
        projectId: segment === GENERAL_RAIL_ID ? null : segment,
      }
      try {
        if (!await opts.canAccess(scope)) return jsonError(404, 'project_not_found', 'Project not found')
        let state: ReplModelState
        if (req.method === 'GET') {
          state = await opts.read(scope)
        } else if (req.method === 'POST') {
          const body = await readJsonBody(req)
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return jsonError(400, 'invalid_request', 'Expected model and sessionId')
          }
          const { model, sessionId } = body as Record<string, unknown>
          if (typeof model !== 'string' || model.trim().length === 0 ||
              typeof sessionId !== 'string' || sessionId.length === 0) {
            return jsonError(400, 'invalid_request', 'Expected nonempty model and sessionId')
          }
          // Runtime owns the mutex, offered-model validation and native acknowledgement.
          state = await opts.switch(scope, { model, sessionId })
        } else {
          return jsonError(405, 'method_not_allowed', 'Expected GET or POST')
        }
        const response = jsonResponse(200, state)
        response.headers.set('cache-control', 'no-store')
        return response
      } catch (error) {
        if (error instanceof ReplModelError) {
          const status = error.code === 'busy' || error.code === 'session-changed' ? 409
            : error.code === 'invalid-model' ? 400 : 503
          return jsonError(status, error.code, error.message)
        }
        return jsonError(503, 'unavailable', 'Live model control is unavailable')
      }
    },
  }
}
