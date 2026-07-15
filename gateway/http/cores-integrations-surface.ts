/**
 * @neutronai/gateway/http — unified Integrations admin surface (WAVE 2 Track A).
 *
 * Owns two route families, BOTH bearer-auth-gated:
 *
 *   - `GET    /api/cores/integrations`        → unified status: per-Core
 *       Google OAuth accounts + standalone API-key slots (no secrets).
 *   - `POST   /api/cores/api-keys/<label>`    → store/rotate a `byo_api_key`.
 *   - `DELETE /api/cores/api-keys/<label>`    → clear a stored key.
 *
 * Mounted independent of the Google-OAuth client gate (Argus PR #13
 * IMPORTANT #2). These routes only need the bundled-Cores registry +
 * SecretsStore — NOT a Google OAuth client — so a deployment with Cores +
 * bearer auth but no Google OAuth client still gets full standalone
 * API-key management (e.g. Research Core's Tavily key). Previously these
 * routes lived inside `cores-oauth-surface.ts` and silently 404'd on that
 * supported config. OAuth status for declared `oauth_token` slots still
 * renders (always-disconnected when no Google client is wired) via the
 * token manager's secret-store reads.
 *
 * Shared brain: `gateway/cores/integrations.ts` (same `setApiKey` /
 * `deleteApiKey` / `buildIntegrationsStatus` the agent-native chat tools
 * call). The OAuth-specific routes (`/api/cores/oauth/google/*`) stay in
 * `cores-oauth-surface.ts`.
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { jsonResponse, ownerSlugMismatch, resolveBearer } from './surface-kit.ts'
import {
  buildIntegrationsStatus,
  deleteApiKey,
  setApiKey,
  IntegrationsError,
  type IntegrationsRegistryView,
} from '../cores/integrations.ts'
import type { OAuthTokenManager } from '../cores/oauth-token-manager.ts'

const INTEGRATIONS_PATH = '/api/cores/integrations'
const API_KEYS_BASE = '/api/cores/api-keys'

export interface CoresIntegrationsSurfaceOptions {
  /** Bundled-Cores registry view — drives the slot whitelist + status. */
  registry: IntegrationsRegistryView
  /** Token manager for OAuth-slot status reads (no client creds required). */
  tokens: OAuthTokenManager
  /** Per-project SecretsStore — api-key set/clear + presence checks. */
  secretsStore: SecretsStore
  /**
   * Per-project DB — lets `api_key_store`-backed system slots (the OpenAI key)
   * route set/delete through `ApiKeyStore` so the secret + metadata row stay
   * consistent. Optional: Core slots are secret-only.
   */
  db?: ProjectDb
  /** Frozen internal_handle for this instance. */
  project_slug: string
  /** App bearer resolver. */
  auth: AppWsAuthResolver
}

export interface CoresIntegrationsSurface {
  /** HTTP dispatcher — returns null for non-owned paths so the chain
   *  falls through. */
  handler: (req: Request) => Promise<Response | null>
}

/** True for any path this surface owns. */
function ownsPath(pathname: string): boolean {
  return (
    pathname === INTEGRATIONS_PATH ||
    pathname === API_KEYS_BASE ||
    pathname.startsWith(`${API_KEYS_BASE}/`)
  )
}

export function createCoresIntegrationsSurface(
  opts: CoresIntegrationsSurfaceOptions,
): CoresIntegrationsSurface {
  const { registry, tokens, secretsStore, db, project_slug, auth } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!ownsPath(pathname)) return null

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonResponse(401, {
          ok: false,
          code: resolved.code,
          message: resolved.message,
        })
      }
      if (ownerSlugMismatch(resolved.project_slug, project_slug)) {
        return jsonResponse(403, {
          ok: false,
          code: 'project_mismatch',
          message: `bearer project '${resolved.project_slug}' does not match gateway project '${project_slug}'`,
        })
      }

      if (pathname === INTEGRATIONS_PATH) {
        if (req.method !== 'GET') {
          return jsonResponse(405, {
            ok: false,
            code: 'method_not_allowed',
            message: `${req.method} not allowed on ${pathname}`,
          })
        }
        const status = await buildIntegrationsStatus({
          registry,
          tokens,
          secretsStore,
          project_slug,
        })
        return jsonResponse(200, { ok: true, ...status })
      }

      // `<label>` is a manifest-declared `byo_api_key` slot (e.g. `tavily`).
      const apiKeyMatch = /^\/api\/cores\/api-keys\/([A-Za-z0-9_\-:.]+)\/?$/.exec(
        pathname,
      )
      if (apiKeyMatch !== null) {
        const label = apiKeyMatch[1] ?? ''
        const dbOpt = db !== undefined ? { db } : {}
        if (req.method === 'POST') {
          return await handleSetApiKey({ req, label, registry, secretsStore, ...dbOpt, project_slug })
        }
        if (req.method === 'DELETE') {
          return await handleDeleteApiKey({ label, registry, secretsStore, ...dbOpt, project_slug })
        }
        return jsonResponse(405, {
          ok: false,
          code: 'method_not_allowed',
          message: `${req.method} not allowed on ${pathname}`,
        })
      }

      // Owned prefix but no route shape matched — structured 404.
      return jsonResponse(404, {
        ok: false,
        code: 'unknown_route',
        message: `no Cores integrations route at ${pathname}`,
      })
    },
  }
}

async function handleSetApiKey(input: {
  req: Request
  label: string
  registry: IntegrationsRegistryView
  secretsStore: SecretsStore
  db?: ProjectDb
  project_slug: string
}): Promise<Response> {
  let body: { value?: unknown }
  try {
    body = (await input.req.json()) as { value?: unknown }
  } catch {
    return jsonResponse(400, {
      ok: false,
      code: 'malformed_json',
      message: 'request body must be JSON with a `value` field',
    })
  }
  const value = typeof body.value === 'string' ? body.value : ''
  try {
    await setApiKey({
      registry: input.registry,
      secretsStore: input.secretsStore,
      ...(input.db !== undefined ? { db: input.db } : {}),
      project_slug: input.project_slug,
      label: input.label,
      value,
    })
  } catch (err) {
    return integrationsErrorResponse(err)
  }
  return jsonResponse(200, { ok: true, label: input.label, connected: true })
}

async function handleDeleteApiKey(input: {
  label: string
  registry: IntegrationsRegistryView
  secretsStore: SecretsStore
  db?: ProjectDb
  project_slug: string
}): Promise<Response> {
  try {
    const { deleted } = await deleteApiKey({
      registry: input.registry,
      secretsStore: input.secretsStore,
      ...(input.db !== undefined ? { db: input.db } : {}),
      project_slug: input.project_slug,
      label: input.label,
    })
    return jsonResponse(200, { ok: true, label: input.label, deleted })
  } catch (err) {
    return integrationsErrorResponse(err)
  }
}

function integrationsErrorResponse(err: unknown): Response {
  if (err instanceof IntegrationsError) {
    const status = err.code === 'unknown_label' ? 400 : 422
    return jsonResponse(status, { ok: false, code: err.code, message: err.message })
  }
  throw err
}

