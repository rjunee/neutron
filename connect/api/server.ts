/**
 * Per-instance Connect API server. Mounted on a sub-path of the
 * gateway's HTTP listener (`/connect/v1/*`) so a single Bun.serve
 * port serves both the instance's local HTTP surface AND its Connect
 * API. Under the Slack-Connect model a shared project is single-hosted on
 * the host's instance; a collaborator's instance reaches the host's shared
 * session through this surface (connect-spec §1.2).
 *
 *   POST /connect/v1/messages    inbound turn from a collaborator's
 *                                instance, routed into the host session
 *   GET  /connect/v1/projects    thin shared-project list (metadata only,
 *                                connect-spec §1.7)
 *   GET  /connect/v1/health      liveness for Connect clients
 *
 * Wire prefix: `/connect/v1` is the single canonical prefix.
 *
 * Every endpoint behind `authorizeConnectRequest`. Inbound payloads arrive
 * stamped with `origin_instance` (the author attribution, connect-spec §1.5);
 * the server validates the stamp matches the JWT's resolved origin
 * (defense-in-depth: the JWT origin is authoritative, the body stamp is the
 * author attribution carried for the host session + audit).
 */

import { stampOriginInstance, isTaggedContent, type TaggedContent } from './origin-tag.ts'
import type { Author } from '@neutronai/channels/types.ts'
import {
  authorizeConnectRequest,
  type ConnectAuthContext,
  type JwtBearerMiddlewareOptions,
} from './jwt-bearer-middleware.ts'
import {
  clientIpFromRequest,
  type EdgeRateLimiter,
} from './edge-rate-limiter.ts'

/** Canonical wire prefix. */
export const CONNECT_API_PREFIX = '/connect/v1'

export interface IncomingMessage {
  /** Channel-agnostic topic id within the receiving instance. P1 places no
   *  schema on it beyond "non-empty string". */
  topic_id: string
  /** Speaker user id (echoed for receiving-instance audit logs; not load-
   *  bearing for routing). */
  speaker_user_id: string
  /** Opaque message body. The host displays it + persists it into the host's
   *  one memory, attributed to the authoring member. */
  body: unknown
  /** Optional channel hint used by the receiver to fan into a specific
   *  bound channel ("telegram" / "app-socket" / etc). */
  channel_hint?: string
  /**
   * Uniform author envelope (connect-spec §4). Set SERVER-SIDE in
   * `handlePostMessage` from the resolved member row (never trusted from the
   * wire), then carried onto the synthesized `IncomingEvent` + persisted on the
   * message row by `on-inbound-message.ts`. A client-supplied value is
   * overwritten server-side.
   */
  author?: Author
}

export interface ProjectRef {
  /** Stable project id within the OWNING instance (workspace OR user). */
  project_id: string
  display_name: string
  /** `'solo' | 'group'` — solo lives in a user instance; group lives in a
   *  workspace instance. */
  kind: 'solo' | 'group'
  /** Slug of the instance that owns this project. For group projects this
   *  is the workspace instance slug; for solo projects it's the user
   *  instance's own slug. */
  owning_instance_slug: string
}

export interface ConnectApiHandlers {
  /** Receive an inbound message. Returns the receiver's local message id
   *  (or any opaque ack identifier). Throws on unrecoverable failure.
   *  Optional — when omitted (e.g. real-mode composer with no fan-out
   *  consumer wired yet), `POST /messages` returns 501 Not Implemented
   *  rather than 500 from a `throw "not_yet_wired"` stub. */
  on_inbound_message?: (
    ctx: ConnectAuthContext,
    msg: TaggedContent<IncomingMessage>,
  ) => Promise<{ ack_id: string }>
  /** Return the projects visible to the calling user inside the receiving
   *  instance. The receiving instance filters by membership.
   *  Optional — when omitted, `GET /projects` returns 501 Not Implemented. */
  list_projects?: (
    ctx: ConnectAuthContext,
  ) => Promise<ProjectRef[]>
  /**
   * Neutron Connect (M2.6 Ph2) member-identity resolver. CONNECT-NODE ONLY —
   * undefined on every other deployment shape (so non-connect instances behave
   * exactly as before). When set, `POST /messages` resolves the JWT-authenticated
   * caller to its meeting-point member identity AFTER auth and re-namespaces the
   * routed turn to the member's `local_slug` before handing it to
   * `on_inbound_message`. A revoked / unknown caller is refused with the
   * resolver's 403 — this is the gate that makes the member-identity layer
   * load-bearing (brief § 3.1, test #5). The JWT is still authoritative for
   * authentication; this hook layers meeting-point membership ON TOP of it.
   */
  resolve_member?: (ctx: ConnectAuthContext) => Promise<MemberResolution>
  /**
   * Neutron Connect (M2.6 Ph3) public guest-auth handshake — CONNECT-NODE ONLY.
   * When set, `POST /connect/v1/connect/guest-auth` is exposed on the
   * PUBLIC (pre-authenticated) edge: an OSS guest redeems a single-use owner
   * invite and the connect node mints + returns a guest bearer (brief § 2.1,
   * § 3.7). Undefined on every non-connect shape, where the route 404s. This is
   * the ONLY pre-authenticated endpoint; everything else stays behind
   * `jwt-bearer-middleware`.
   */
  guest_auth?: (req: Request) => Promise<Response>
  /**
   * Neutron Connect (M2.6 Ph5) public, read-only, NON-CONSUMING invite preview —
   * CONNECT-NODE ONLY. Backs `GET /connect/v1/connect/invite-preview`. The
   * guest accept page calls it (with the SHA-256 hash of its raw token) to render
   * the LOCKED data-locality disclosure BEFORE the single-use handshake. Mounted
   * on the PUBLIC (pre-auth) edge alongside `guest_auth`, rate-limited per-IP. It
   * NEVER claims the invite (single-use preserved); undefined elsewhere → 404.
   */
  invite_preview?: (req: Request) => Promise<Response>
  /**
   * Neutron Connect (M2.6 Ph5) guest-bearer refresh — CONNECT-NODE ONLY. Backs
   * `POST /connect/v1/connect/guest-refresh`. Runs AFTER the bearer
   * middleware (the guest presents its still-valid bearer); re-mints a fresh
   * 30-min bearer for the SAME active member (403 if revoked). Never re-uses the
   * consumed invite, never widens scope/class. Undefined elsewhere → 404.
   */
  guest_refresh?: (ctx: ConnectAuthContext) => Promise<Response>
  /**
   * Neutron Connect (M2.6 Ph5) cross-instance TRUSTED-member accept —
   * CONNECT-NODE ONLY. Backs `POST /connect/v1/connect/trusted-accept`. Runs
   * AFTER the bearer middleware (the presented cross-instance bearer IS the M2.5
   * OAuth gate); verifies + single-use-claims the connect invite and calls
   * `acceptTrustedMember` with the invitee's AUTHENTICATED cross-instance
   * identity. Undefined elsewhere → 404.
   */
  trusted_accept?: (ctx: ConnectAuthContext, req: Request) => Promise<Response>
}

/**
 * Result of `resolve_member`. `ok:true` carries the meeting-point-assigned
 * `local_slug` the turn is re-namespaced to, plus the SERVER-RESOLVED `role`,
 * `access`, and `display_name` (all read from the stored member row — NEVER from
 * a token claim; brief § 3.4 invariant 1). `role` is display-only; `access`
 * (read|write) drives the post-boundary gate (connect-spec §1.4 — a `read`
 * member's POST /messages is refused); `display_name` seeds the uniform `author`
 * envelope (connect-spec §4). `ok:false` carries the 403 the server returns
 * (e.g. a revoked member). Status is pinned to 403 — an
 * authenticated-but-not-a-member caller is an authorization failure.
 */
export type MemberResolution =
  | {
      ok: true
      local_slug: string
      role?: 'owner' | 'collaborator'
      access?: 'read' | 'write'
      display_name?: string
    }
  | { ok: false; status: 403; reason: string }

export interface ConnectApiServerOptions {
  receiving_instance_slug: string
  auth: JwtBearerMiddlewareOptions
  handlers: ConnectApiHandlers
  /**
   * Public-edge rate limiter (M2.6 Ph3, 3.11). CONNECT-NODE ONLY — wired only
   * where the public ingress exists. When set, the server rejects at the edge
   * (429), BEFORE `resolve_member` / the ingress run (brief § 2.2, test #5):
   *   - per-IP on the unauthenticated `/connect/guest-auth`
   *   - per-authenticated-caller on `POST /messages`
   * Undefined on non-connect instances → the trusted fan-out path keeps its exact
   * pre-Ph3 posture.
   */
  rate_limiter?: EdgeRateLimiter
}

/**
 * Build a fetch-style handler that dispatches the cross-instance API
 * endpoints. The returned handler returns `null` for paths that don't
 * match `CONNECT_API_PREFIX` so the caller can chain it with other surfaces
 * (e.g. an OAuth callback handler, a /healthz handler).
 */
export function createConnectApiHandler(
  options: ConnectApiServerOptions,
): (req: Request) => Promise<Response | null> {
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url)
    if (!url.pathname.startsWith(CONNECT_API_PREFIX)) {
      return null
    }
    const sub = url.pathname.slice(CONNECT_API_PREFIX.length)

    // /health is intentionally unauthed — callers use it to confirm the
    // instance's process is up before retrying a delivery. Returns the slug
    // so the cross-instance client can distinguish a Caddy-routed-to-wrong-
    // instance misconfig from a healthy upstream.
    if (sub === '/health' && req.method === 'GET') {
      return jsonResponse(200, {
        status: 'ok',
        receiving_instance_slug: options.receiving_instance_slug,
      })
    }

    // M2.6 Ph3 — the public guest-auth handshake is the ONE pre-authenticated
    // endpoint (a guest has no Managed JWT yet). It is rate-limited PER-IP at
    // the edge BEFORE the handler runs, so an unauthenticated flood never
    // reaches the invite store / acceptGuestMember (brief § 2.2, test #5). The
    // route only exists when a connect node wired `guest_auth`; otherwise 404.
    if (sub === '/connect/guest-auth' && req.method === 'POST') {
      const guestAuth = options.handlers.guest_auth
      if (guestAuth === undefined) {
        return jsonResponse(404, { error: 'not_found', path: sub })
      }
      if (
        options.rate_limiter !== undefined &&
        !options.rate_limiter.check('guest-auth', clientIpFromRequest(req))
      ) {
        return jsonResponse(429, { error: 'rate_limited', surface: 'guest_auth' })
      }
      return guestAuth(req)
    }

    // M2.6 Ph5 — the public, read-only, NON-CONSUMING invite preview. Like
    // guest-auth it is pre-authenticated (the guest holds no JWT yet) and
    // rate-limited PER-IP at the edge. It NEVER claims the invite. The route
    // only exists when a connect node wired `invite_preview`; otherwise 404.
    if (sub === '/connect/invite-preview' && req.method === 'GET') {
      const invitePreview = options.handlers.invite_preview
      if (invitePreview === undefined) {
        return jsonResponse(404, { error: 'not_found', path: sub })
      }
      if (
        options.rate_limiter !== undefined &&
        !options.rate_limiter.check('invite-preview', clientIpFromRequest(req))
      ) {
        return jsonResponse(429, { error: 'rate_limited', surface: 'invite_preview' })
      }
      return invitePreview(req)
    }

    const auth = await authorizeConnectRequest(req, options.auth)
    if (!auth.ok) {
      return jsonResponse(auth.status, { error: auth.reason })
    }

    if (sub === '/messages' && req.method === 'POST') {
      // Public-edge per-caller limit (brief § 2.2). Keyed on the authenticated
      // subject so a compromised guest bearer cannot flood the owner's session.
      // Enforced AFTER auth (we need a stable caller key) but BEFORE
      // resolve_member / the ingress — a throttled request never reaches
      // routing (test #5).
      if (
        options.rate_limiter !== undefined &&
        !options.rate_limiter.check('messages', auth.context.origin_user_id)
      ) {
        return jsonResponse(429, { error: 'rate_limited', surface: 'messages' })
      }
      return handlePostMessage(req, options, auth.context)
    }
    if (sub === '/projects' && req.method === 'GET') {
      return handleGetProjects(options, auth.context)
    }
    // M2.6 Ph5 — guest-bearer refresh. The guest presents its still-valid bearer
    // (validated by the middleware above); the handler re-mints for the SAME
    // active member (403 if revoked). Per-caller throttled like /messages.
    if (sub === '/connect/guest-refresh' && req.method === 'POST') {
      const guestRefresh = options.handlers.guest_refresh
      if (guestRefresh === undefined) {
        return jsonResponse(404, { error: 'not_found', path: sub })
      }
      if (
        options.rate_limiter !== undefined &&
        !options.rate_limiter.check('guest-refresh', auth.context.origin_user_id)
      ) {
        return jsonResponse(429, { error: 'rate_limited', surface: 'guest_refresh' })
      }
      return guestRefresh(auth.context)
    }
    // M2.6 Ph5 — cross-instance trusted-member accept. The presented bearer is
    // the M2.5 OAuth gate (its aud proves it was minted for this meeting point);
    // the handler verifies + single-use-claims the connect invite and calls
    // acceptTrustedMember with the invitee's authenticated cross-instance identity.
    if (sub === '/connect/trusted-accept' && req.method === 'POST') {
      const trustedAccept = options.handlers.trusted_accept
      if (trustedAccept === undefined) {
        return jsonResponse(404, { error: 'not_found', path: sub })
      }
      return trustedAccept(auth.context, req)
    }
    return jsonResponse(404, { error: 'not_found', path: sub })
  }
}

async function handlePostMessage(
  req: Request,
  options: ConnectApiServerOptions,
  ctx: ConnectAuthContext,
): Promise<Response> {
  // Argus r1 BLOCKER fix (B2): an unconfigured handler surfaces as 501
  // Not Implemented, not 500 from a `throw "not_yet_wired"` stub. We
  // bail BEFORE parsing the body so accidental real traffic gets a
  // documented status code instead of a parse-then-dispatch-then-throw
  // dance through five layers.
  const handler = options.handlers.on_inbound_message
  if (handler === undefined) {
    return jsonResponse(501, {
      error: 'not_implemented',
      surface: 'connect.on_inbound_message',
      message:
        'this instance does not have an inbound-message handler wired yet',
    })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonResponse(400, { error: 'invalid_json' })
  }
  if (!isTaggedContent(body)) {
    return jsonResponse(400, { error: 'missing_origin_instance_stamp' })
  }
  // Defense-in-depth: the body's `origin_instance` MUST equal the auth
  // context's resolved origin. The JWT is authoritative; the body stamp is
  // the author attribution carried into the host session + audit
  // (connect-spec §1.5). A mismatch is an attacker forging the stamp; reject.
  if (body.origin_instance !== ctx.origin_instance_slug) {
    return jsonResponse(403, {
      error: 'origin_stamp_mismatch',
      jwt_origin: ctx.origin_instance_slug,
      body_origin: body.origin_instance,
    })
  }
  const payload = body.payload as Partial<IncomingMessage>
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.topic_id !== 'string' ||
    payload.topic_id.length === 0 ||
    typeof payload.speaker_user_id !== 'string' ||
    payload.speaker_user_id.length === 0
  ) {
    return jsonResponse(400, { error: 'invalid_message_shape' })
  }
  // Neutron Connect (M2.6 Ph2): on a connect node the JWT-authenticated caller
  // is resolved to its meeting-point member identity, and the routed turn is
  // re-namespaced to that member's collision-free `local_slug`. A revoked /
  // unknown caller is refused with 403. On non-connect nodes `resolve_member`
  // is undefined and attribution stays the caller's JWT origin slug (unchanged
  // behaviour). The member's local_slug — never the raw caller slug — becomes
  // the `origin_instance` the owner's session attributes the turn by.
  let attributedOrigin = ctx.origin_instance_slug
  let routedCtx = ctx
  // Author #0 default for non-connect nodes: the JWT origin is both id + label.
  let author: Author = {
    id: ctx.origin_instance_slug,
    display: ctx.origin_instance_slug,
  }
  if (options.handlers.resolve_member !== undefined) {
    const resolution = await options.handlers.resolve_member(ctx)
    if (!resolution.ok) {
      return jsonResponse(resolution.status, {
        error: 'member_not_resolved',
        reason: resolution.reason,
      })
    }
    // Post-boundary read/write gate (connect-spec §1.4): a `read` collaborator
    // observes the session but cannot post. `access` is server-resolved from the
    // stored member row (never a token claim) — a `read` POST /messages is
    // refused HERE, before the turn ever reaches the host session.
    if (resolution.access === 'read') {
      return jsonResponse(403, {
        error: 'read_only_member',
        reason: 'member_access_read',
      })
    }
    attributedOrigin = resolution.local_slug
    routedCtx = { ...ctx, origin_instance_slug: resolution.local_slug }
    // Uniform author envelope (connect-spec §4), server-derived from the
    // resolved member row. `display_name` falls back to the slug if absent.
    author = {
      id: resolution.local_slug,
      display: resolution.display_name ?? resolution.local_slug,
    }
  }
  // Re-stamp internally so downstream consumers see the canonical
  // TaggedContent<IncomingMessage> shape (payload narrowed), attributed by the
  // resolved member local_slug on a connect node (else the caller's JWT origin).
  // The uniform author (§4) is stamped server-side, OVERWRITING any
  // client-supplied `author`, so a collaborator can never post as another author.
  const authoredPayload: IncomingMessage = {
    ...(payload as IncomingMessage),
    author,
  }
  const stamped = stampOriginInstance<IncomingMessage>(
    authoredPayload,
    attributedOrigin,
  )
  let result: { ack_id: string }
  try {
    result = await handler(routedCtx, stamped)
  } catch (err) {
    return jsonResponse(500, {
      error: 'handler_failed',
      message: err instanceof Error ? err.message : 'unknown',
    })
  }
  return jsonResponse(202, result)
}

async function handleGetProjects(
  options: ConnectApiServerOptions,
  ctx: ConnectAuthContext,
): Promise<Response> {
  // Same 501-not-500 shape as POST /messages — see comment above.
  const handler = options.handlers.list_projects
  if (handler === undefined) {
    return jsonResponse(501, {
      error: 'not_implemented',
      surface: 'connect.list_projects',
      message:
        'this instance does not have a project-list handler wired yet',
    })
  }
  let projects: ProjectRef[]
  try {
    projects = await handler(ctx)
  } catch (err) {
    return jsonResponse(500, {
      error: 'handler_failed',
      message: err instanceof Error ? err.message : 'unknown',
    })
  }
  return jsonResponse(200, { projects })
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
