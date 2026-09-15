import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { jsonError, jsonOk, readJsonBody, resolveBearer } from './surface-kit.ts'

export function createEmailDigestSettingsSurface(input: {
  auth: AppWsAuthResolver
  readEnabled: () => boolean
  writeEnabled: (enabled: boolean) => Promise<void>
}): { handler: (req: Request) => Promise<Response | null> } {
  const path = '/api/app/email-digest'
  return { handler: async (req) => {
    if (new URL(req.url).pathname !== path) return null
    const resolved = await resolveBearer(req, input.auth)
    if ('code' in resolved) return jsonError(401, resolved.code, resolved.message)
    if (req.method === 'GET') return jsonOk({ enabled: input.readEnabled() })
    if (req.method !== 'PUT') return jsonError(405, 'method_not_allowed', `method '${req.method}' not allowed on ${path}`)
    const body = await readJsonBody(req) as Record<string, unknown> | null
    if (typeof body?.['enabled'] !== 'boolean') return jsonError(400, 'invalid_enabled', 'enabled must be boolean')
    await input.writeEnabled(body.enabled)
    return jsonOk({ enabled: input.readEnabled() })
  } }
}
