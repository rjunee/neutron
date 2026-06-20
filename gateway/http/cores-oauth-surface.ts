/**
 * @neutronai/gateway/http — Cores OAuth secret-resolution surface.
 *
 * Owns four routes on the per-instance gateway:
 *
 *   - `GET  /api/cores/oauth/google/start`              start a grant
 *   - `POST /api/cores/oauth/google/ingest`             identity → gateway code-exchange hand-off
 *   - `POST /api/cores/oauth/google/disconnect/<label>` revoke + clean up
 *   - `GET  /api/cores/oauth/google/status`             admin tab view
 *
 * The ingest route is gated by a platform-signed bearer (the same
 * shared-secret HMAC pattern install-token uses) — identity is the only
 * caller. Every other route is gated by the standard `AppWsAuthResolver`
 * bearer.
 *
 * Per docs/plans/cores-oauth-secret-resolution-sprint-brief.md § 4.
 */

import type { AppWsAuthResolver } from '../../channels/adapters/app-ws/auth.ts'
import { ownerSlugMismatch } from './auth-helpers.ts'
// Sprint B (2026-05-20) — HMAC + PKCE helpers lifted from
// `identity/oauth/*` to `runtime/` so this core HTTP surface no longer
// takes an import edge on the Managed `identity/` tree. The legacy
// `identity/oauth/internal-signature.ts` + `identity/oauth/pkce.ts`
// now re-export from `runtime/` so identity-side callers keep working.
import {
  signInternalRequest,
  verifyInternalRequest,
} from '../../runtime/internal-signature.ts'
import { generateOAuthState, generatePkce } from '../../runtime/oauth-pkce.ts'
import type { BundledRegistryEvent } from '../../cores/runtime/bundled-registry.ts'
import type { CoresModuleState } from '../cores/composer-state.ts'
import type { CoresOAuthPendingStore } from '../cores/oauth-pending-store.ts'
import {
  refreshLabel,
  metaLabel,
  OAuthRefreshError,
  type OAuthTokenManager,
  type OAuthTokenStatus,
} from '../cores/oauth-token-manager.ts'
import {
  reinstallFailedCore,
  updateInstallState,
  SecretsStorePrompter,
  type CoreBackendFactoryMap,
  type InstallBundledCoresResult,
  type InstallTelemetryEvent,
} from '../cores/install-bundled.ts'
import type { SecretsStore } from '../../auth/secrets-store.ts'
import type { ProjectDb } from '../../persistence/index.ts'
import type { ToolRegistry } from '../../tools/registry.ts'

const PATH_BASE = '/api/cores/oauth/google'

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

/** Required env vars for the connectors Google OAuth client. */
export const ENV_CLIENT_ID = 'NEUTRON_CORES_GOOGLE_CLIENT_ID'
export const ENV_CLIENT_SECRET = 'NEUTRON_CORES_GOOGLE_CLIENT_SECRET'

/**
 * Resolved label declared by at least one bundled Core's manifest. Used
 * by `/start` and `/disconnect` to bound the input to known surfaces.
 */
export interface BundledLabelEntry {
  label: string
  /** Manifest-declared scope string. */
  scope: string
  /** Slugs of every bundled Core that declares this label. */
  core_slugs: string[]
}

export interface CoresOAuthSurfaceOptions {
  /** Composed bundled-Cores state — drives label whitelist + reinstall dispatch. */
  cores: InstallBundledCoresResult
  /** Pending-flow store (cores_oauth_pending). */
  pending: CoresOAuthPendingStore
  /** Token manager for the per-project SecretsStore. */
  tokens: OAuthTokenManager
  /** Per-project SecretsStore — used by SecretsStorePrompter on reinstall. */
  secretsStore: SecretsStore
  /** Project DB — used by reinstall + install_state writes. */
  projectDb: ProjectDb
  /** Per-instance data dir (`<owner_home>`). Threaded through to the
   *  lifecycle's `installCore(...)` on reinstall so sidecar Cores
   *  re-allocate against the right directory. */
  dataDir: string
  /** Tool registry — passed through to reinstall. */
  tools: ToolRegistry
  /** Backend factories — passed through to reinstall. */
  backends?: CoreBackendFactoryMap
  /** Frozen internal_handle for this instance. */
  project_slug: string
  /** Public base URL of identity (e.g. https://auth.example.test). */
  identityBaseUrl: string
  /** Instance gateway's public base URL (e.g. https://<slug>.example.test). */
  ownerBaseUrl: string
  /** Single registered redirect URI — same value on Google and identity. */
  redirectUri: string
  /** OAuth client id + secret (read once at boot from env). */
  clientId: string
  /** Shared HMAC secret used by identity → gateway ingest auth. */
  internalSharedSecret: string
  /** App bearer resolver for /start, /disconnect, /status. */
  auth: AppWsAuthResolver
  /** Optional logger override (testing seam). */
  log?: (event: BundledRegistryEvent | InstallTelemetryEvent) => void
  /** Optional fetch override for identity hand-off (testing seam). */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** Optional Date.now override. */
  now?: () => number
  /** Optional state generator override. */
  generateState?: () => string
  /** Optional PKCE generator override. */
  generatePkce?: () => { codeVerifier: string; codeChallenge: string }
}

export interface CoresOAuthSurface {
  handler: (req: Request) => Promise<Response | null>
}

export function createCoresOAuthSurface(
  opts: CoresOAuthSurfaceOptions,
): CoresOAuthSurface {
  const {
    cores,
    pending,
    tokens,
    secretsStore,
    projectDb,
    dataDir,
    tools,
    backends,
    project_slug,
    identityBaseUrl,
    ownerBaseUrl,
    redirectUri,
    clientId,
    internalSharedSecret,
    auth,
  } = opts
  const now = opts.now ?? ((): number => Date.now())
  const fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const genState = opts.generateState ?? generateOAuthState
  const genPkce = opts.generatePkce ?? generatePkce
  const log = opts.log
  const knownLabels = collectKnownLabels(cores)

  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith(PATH_BASE)) return null

      // /ingest is the only route that does NOT use the user bearer —
      // identity hits this with a platform HMAC. Handle it first.
      if (pathname === `${PATH_BASE}/ingest` && req.method === 'POST') {
        return await handleIngest({
          req,
          internalSharedSecret,
          pending,
          tokens,
          cores,
          ownerBaseUrl,
          project_slug,
          secretsStore,
          projectDb,
          dataDir,
          tools,
          ...(backends !== undefined ? { backends } : {}),
          redirectUri,
          now,
          ...(log !== undefined ? { log } : {}),
        })
      }

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

      if (pathname === `${PATH_BASE}/start` && req.method === 'GET') {
        return await handleStart({
          url,
          knownLabels,
          pending,
          project_slug,
          identityBaseUrl,
          ownerBaseUrl,
          redirectUri,
          clientId,
          internalSharedSecret,
          fetch: fetchImpl,
          now,
          generateState: genState,
          generatePkce: genPkce,
        })
      }

      if (pathname === `${PATH_BASE}/status` && req.method === 'GET') {
        return await handleStatus({ tokens, knownLabels })
      }

      const disconnectMatch = /^\/api\/cores\/oauth\/google\/disconnect\/([A-Za-z0-9_\-:.]+)\/?$/.exec(
        pathname,
      )
      if (disconnectMatch !== null && req.method === 'POST') {
        const label = disconnectMatch[1] ?? ''
        return await handleDisconnect({
          label,
          knownLabels,
          tokens,
          cores,
          projectDb,
          project_slug,
        })
      }

      return jsonResponse(404, {
        ok: false,
        code: 'unknown_route',
        message: `no Cores OAuth route at ${pathname}`,
      })
    },
  }
}

async function handleStart(input: {
  url: URL
  knownLabels: Map<string, BundledLabelEntry>
  pending: CoresOAuthPendingStore
  project_slug: string
  identityBaseUrl: string
  ownerBaseUrl: string
  redirectUri: string
  clientId: string
  internalSharedSecret: string
  fetch: (input: string, init: RequestInit) => Promise<Response>
  now: () => number
  generateState: () => string
  generatePkce: () => { codeVerifier: string; codeChallenge: string }
}): Promise<Response> {
  const labelsRaw = input.url.searchParams.get('labels') ?? ''
  const labels = labelsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (labels.length === 0) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_labels',
      message: 'query param `labels` is required (comma-separated label list)',
    })
  }
  for (const l of labels) {
    if (!input.knownLabels.has(l)) {
      return jsonResponse(400, {
        ok: false,
        code: 'unknown_label',
        message: `label='${l}' is not declared by any bundled Core's manifest.secrets[]`,
      })
    }
  }
  const scopes = new Set<string>()
  for (const l of labels) {
    const entry = input.knownLabels.get(l)
    if (entry !== undefined && entry.scope.length > 0) {
      // Google accepts repeated scopes; deduplicate via Set.
      scopes.add(entry.scope)
    }
  }
  const state = input.generateState()
  const { codeVerifier, codeChallenge } = input.generatePkce()
  const persisted = await input.pending.put({
    state,
    project_slug: input.project_slug,
    code_verifier: codeVerifier,
    labels,
    redirect_uri: input.redirectUri,
  })

  // Pre-register the dispatch with identity so the Google redirect-back
  // can resolve `state → owner_gateway`.
  const dispatchPath = `${input.ownerBaseUrl.replace(/\/+$/, '')}${PATH_BASE}/ingest`
  const registerPath = '/oauth/cores/pending/register'
  const registerBody = JSON.stringify({
    state,
    project_slug: input.project_slug,
    dispatch_url: dispatchPath,
    expires_at: persisted.expires_at,
  })
  const timestamp_ms = input.now()
  const sig = signInternalRequest({
    method: 'POST',
    path: registerPath,
    body: registerBody,
    shared_secret: input.internalSharedSecret,
    timestamp_ms,
  })
  const registerRes = await input.fetch(
    `${input.identityBaseUrl.replace(/\/+$/, '')}${registerPath}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-signature': sig,
        'x-internal-timestamp': String(timestamp_ms),
      },
      body: registerBody,
    },
  )
  if (!registerRes.ok) {
    return jsonResponse(502, {
      ok: false,
      code: 'identity_register_failed',
      message: `identity dispatch register returned ${registerRes.status}`,
    })
  }

  const authorize = new URL(GOOGLE_AUTHORIZE_URL)
  authorize.searchParams.set('client_id', input.clientId)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('scope', [...scopes].join(' '))
  authorize.searchParams.set('redirect_uri', input.redirectUri)
  authorize.searchParams.set('state', state)
  authorize.searchParams.set('code_challenge', codeChallenge)
  authorize.searchParams.set('code_challenge_method', 'S256')
  authorize.searchParams.set('access_type', 'offline')
  // `prompt=consent` forces Google to return a refresh_token even on
  // repeat grants by the same user. Without it, a re-consent flow with
  // an existing grant returns access_token only and refresh stays NULL,
  // which would break getAccessToken's refresh path on the next expiry.
  authorize.searchParams.set('prompt', 'consent')

  return jsonResponse(200, {
    ok: true,
    authorize_url: authorize.toString(),
    state,
    expires_at: persisted.expires_at,
  })
}

async function handleIngest(input: {
  req: Request
  internalSharedSecret: string
  pending: CoresOAuthPendingStore
  tokens: OAuthTokenManager
  cores: InstallBundledCoresResult
  ownerBaseUrl: string
  project_slug: string
  secretsStore: SecretsStore
  projectDb: ProjectDb
  dataDir: string
  tools: ToolRegistry
  backends?: CoreBackendFactoryMap
  redirectUri: string
  now: () => number
  log?: (event: BundledRegistryEvent | InstallTelemetryEvent) => void
}): Promise<Response> {
  const rawBody = await input.req.text()
  const supplied = (input.req.headers.get('x-internal-signature') ?? '').trim()
  const suppliedTs = (input.req.headers.get('x-internal-timestamp') ?? '').trim()
  // Argus PR #210 minor #3 — require + verify a ±5 min timestamp so a
  // captured /ingest payload can't be replayed before the underlying
  // pending row's single-use consume kicks in. Single-use defends after
  // consume; the timestamp defends BEFORE consume against an in-flight
  // race or duplicate-deliver.
  const verification = verifyInternalRequest({
    method: 'POST',
    path: `${PATH_BASE}/ingest`,
    body: rawBody,
    shared_secret: input.internalSharedSecret,
    supplied_signature: supplied,
    supplied_timestamp_header: suppliedTs,
    now_ms: input.now(),
  })
  if (!verification.ok) {
    return jsonResponse(401, {
      ok: false,
      code: mapVerifyCode(verification.code),
      message: ingestRejectMessage(verification.code),
    })
  }
  let body: { code?: unknown; state?: unknown }
  try {
    body = JSON.parse(rawBody) as { code?: unknown; state?: unknown }
  } catch {
    return jsonResponse(400, {
      ok: false,
      code: 'malformed_json',
      message: 'ingest body must be JSON',
    })
  }
  const code = typeof body.code === 'string' ? body.code : ''
  const state = typeof body.state === 'string' ? body.state : ''
  if (code.length === 0 || state.length === 0) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_fields',
      message: 'ingest body requires non-empty `code` and `state`',
    })
  }
  const row = await input.pending.consume(state)
  if (row === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'unknown_state',
      message: 'no pending OAuth row for state (expired, replayed, or never registered)',
    })
  }
  if (ownerSlugMismatch(row.project_slug, input.project_slug)) {
    return jsonResponse(400, {
      ok: false,
      code: 'project_mismatch',
      message: `pending row project='${row.project_slug}' does not match gateway project='${input.project_slug}'`,
    })
  }
  try {
    await input.tokens.exchangeAndPersist({
      code,
      code_verifier: row.code_verifier,
      redirect_uri: row.redirect_uri,
      labels: row.labels,
    })
  } catch (err) {
    if (err instanceof OAuthRefreshError) {
      return jsonResponse(400, {
        ok: false,
        code: err.code === 'invalid_grant' ? 'invalid_grant' : 'google_token_exchange_failed',
        message: err.message,
      })
    }
    throw err
  }
  // Re-install every Core whose manifest declares one of the just-
  // written labels. Idempotent: a Core that's already installed
  // returns `{updated:false}`. Errors are swallowed onto the failures
  // list — the OAuth flow itself succeeded.
  const reinstalled: string[] = []
  for (const label of row.labels) {
    for (const core of input.cores.registry.list()) {
      if (core.manifest.secrets.some((s) => s.label === label)) {
        try {
          const result = await reinstallFailedCore({
            slug: core.slug,
            state: input.cores,
            project_slug: input.project_slug,
            projectDb: input.projectDb,
            dataDir: input.dataDir,
            tools: input.tools,
            secretsStore: input.secretsStore,
            prompter: new SecretsStorePrompter({
              secretsStore: input.secretsStore,
              project_slug: input.project_slug,
            }),
            ...(input.backends !== undefined ? { backends: input.backends } : {}),
            ...(input.log !== undefined ? { log: input.log } : {}),
          })
          if (result.updated) reinstalled.push(core.slug)
        } catch {
          // already recorded onto state.failures by reinstallFailedCore;
          // don't fail the whole ingest on a single Core's lifecycle
          // throw.
        }
      }
    }
  }

  return jsonResponse(200, {
    ok: true,
    labels: row.labels,
    reinstalled,
  })
}

async function handleDisconnect(input: {
  label: string
  knownLabels: Map<string, BundledLabelEntry>
  tokens: OAuthTokenManager
  cores: InstallBundledCoresResult
  projectDb: ProjectDb
  project_slug: string
}): Promise<Response> {
  if (!input.knownLabels.has(input.label)) {
    return jsonResponse(400, {
      ok: false,
      code: 'unknown_label',
      message: `label='${input.label}' is not declared by any bundled Core's manifest.secrets[]`,
    })
  }
  const { deleted } = await input.tokens.disconnect(input.label)
  const affectedCores: string[] = []
  for (const core of input.cores.registry.list()) {
    if (core.manifest.secrets.some((s) => s.label === input.label)) {
      affectedCores.push(core.slug)
      // Mark every affected Core's runtime row as dependency-missing.
      // We also remove the Core from the in-process `installed` map so
      // subsequent /api/cores reads surface the dependency_missing
      // state via the cores-surface mapping; the install row stays
      // (its history is intentional).
      try {
        await updateInstallState(
          input.projectDb,
          input.project_slug,
          core.slug,
          'install_failed_dependency_missing',
        )
      } catch {
        // best-effort
      }
    }
  }
  return jsonResponse(200, {
    ok: true,
    disconnected: deleted ? [input.label] : [],
    affected_cores: affectedCores,
  })
}

async function handleStatus(input: {
  tokens: OAuthTokenManager
  knownLabels: Map<string, BundledLabelEntry>
}): Promise<Response> {
  const labels: OAuthTokenStatus[] = []
  for (const label of input.knownLabels.keys()) {
    labels.push(await input.tokens.getStatus(label))
  }
  const connected = labels.some((l) => l.connected)
  return jsonResponse(200, {
    ok: true,
    google: { connected, labels },
  })
}

function collectKnownLabels(
  cores: InstallBundledCoresResult,
): Map<string, BundledLabelEntry> {
  const map = new Map<string, BundledLabelEntry>()
  for (const core of cores.registry.list()) {
    for (const secret of core.manifest.secrets) {
      if (secret.kind !== 'oauth_token') continue
      const existing = map.get(secret.label)
      if (existing === undefined) {
        map.set(secret.label, {
          label: secret.label,
          scope: secret.scope ?? '',
          core_slugs: [core.slug],
        })
      } else if (!existing.core_slugs.includes(core.slug)) {
        existing.core_slugs.push(core.slug)
      }
    }
  }
  return map
}

interface ResolvedAuth {
  user_id: string
  project_slug: string
}

interface AuthFailure {
  code: string
  message: string
}

async function resolveBearer(
  req: Request,
  auth: AppWsAuthResolver,
): Promise<ResolvedAuth | AuthFailure> {
  const header = req.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) {
    return { code: 'missing_bearer', message: 'expected Authorization: Bearer <token>' }
  }
  const token = header.slice('bearer '.length).trim()
  const resolved = await auth.resolve(token)
  if ('code' in resolved) return { code: resolved.code, message: resolved.message }
  return { user_id: resolved.user_id, project_slug: resolved.project_slug }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mapVerifyCode(
  code:
    | 'missing_timestamp'
    | 'invalid_timestamp'
    | 'stale_timestamp'
    | 'invalid_signature',
): string {
  switch (code) {
    case 'missing_timestamp':
      return 'missing_internal_timestamp'
    case 'invalid_timestamp':
      return 'invalid_internal_timestamp'
    case 'stale_timestamp':
      return 'stale_internal_timestamp'
    case 'invalid_signature':
      return 'invalid_internal_signature'
  }
}

function ingestRejectMessage(
  code:
    | 'missing_timestamp'
    | 'invalid_timestamp'
    | 'stale_timestamp'
    | 'invalid_signature',
): string {
  switch (code) {
    case 'missing_timestamp':
      return 'identity-side x-internal-timestamp header missing'
    case 'invalid_timestamp':
      return 'identity-side x-internal-timestamp is not a parseable unix-ms integer'
    case 'stale_timestamp':
      return 'identity-side x-internal-timestamp is outside the ±5 min replay window'
    case 'invalid_signature':
      return 'identity-side HMAC over METHOD+PATH+TIMESTAMP+body did not verify'
  }
}

// Re-export label helpers for tests + clients that want to construct
// the suffix shape without importing from oauth-token-manager.
export { refreshLabel, metaLabel }
