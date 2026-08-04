/**
 * @neutronai/gateway/http — the Cores Google-OAuth BROKER.
 *
 * THE PIECE THAT WAS NEVER BUILT. `cores-oauth-surface.ts:359` has always POSTed
 * its pending state to `/oauth/cores/pending/register` and then sent the user to
 * Google. Until now that path existed in exactly two places in either repo: that
 * caller, and a test stub that faked it. Nothing served it, so no owner could
 * ever complete a Google grant, and three of the nine bundled Cores — calendar,
 * email, google-workspace — failed to install on every boot of every install
 * (ISSUES #448). This module is the counterpart.
 *
 * WHY THE ROLE EXISTS. Google only redirects to a redirect_uri pre-registered on
 * the OAuth client, so a deployment serving many instances cannot give each one
 * its own. They share one registered URI, and whatever sits behind it must work
 * out which instance a callback belongs to. `state` is the handle; this module
 * is the lookup.
 *
 * ONE FLOW, TWO DEPLOYMENTS (SPEC § Decisions Log 2026-08-02). The broker is the
 * same code either way — only WHERE it runs differs:
 *
 *   - **Open self-host** — the instance is its own broker. It registers state
 *     with itself, Google redirects to it, and it relays the code to itself. The
 *     owner registers their own Google client; `identityBaseUrl` is their own
 *     base URL.
 *   - **Managed** — one client for the deployment, one registered redirect at the
 *     central identity host, which routes each callback to the right instance.
 *
 * This is deliberately NOT two code paths: the difference is entirely
 * configuration, which is what makes it legal under the no-dual-path rule and
 * what the owner asked for ("I don't know why it would be a separate path").
 *
 * IT HOLDS NO OAUTH SECRET. The broker stores a routing row and relays
 * `{code, state}`. The CLIENT SECRET lives on the instance inside
 * `OAuthTokenManager`, which performs the exchange. A compromised broker
 * therefore leaks routing metadata, never a credential that can mint tokens —
 * which is precisely why one central broker can serve many instances safely.
 *
 * DEFENCES, and what each one is actually for:
 *   - register is HMAC-signed with a ±5 min timestamp, so only a real instance
 *     can plant a routing row;
 *   - register is INSERT-ONLY / SAME-OWNER, so a row that exists can never
 *     change hands: signature possession lets you create a registration, never
 *     take one over (SPEC § Decisions Log 2026-08-04);
 *   - the row is SINGLE-USE and short-lived, so a replayed `state` finds nothing;
 *   - the relay is HMAC-signed too, so an instance's `/ingest` accepts the code
 *     only from its broker;
 *   - the callback returns a plain HTML page and NEVER echoes `code` or `state`
 *     back into the response body, so a grant cannot leak through a screenshot,
 *     a shared URL bar, or a referrer.
 */

import { createHash } from 'node:crypto'
import type { SQLQueryBindings } from 'bun:sqlite'

import {
  signInternalRequest,
  verifyInternalRequest,
} from '@neutronai/runtime/internal-signature.ts'
import { jsonResponse } from './surface-kit.ts'

/**
 * The ONLY database capability the broker needs.
 *
 * Declared structurally rather than as `ProjectDb` so the SAME broker runs in
 * both deployments the flow supports. An Open self-host passes its `ProjectDb`;
 * Managed's central identity host — whose store is a raw `bun:sqlite` Database,
 * not a `ProjectDb` — passes a handful of lines of adapter.
 *
 * The params type is `SQLQueryBindings[]` and NOT `unknown[]` for a reason worth
 * keeping: `unknown[]` is WIDER, so by parameter contravariance a method that
 * accepts `SQLQueryBindings[]` is not assignable to one declared to accept
 * `unknown[]`, and `ProjectDb` — the very type this exists to accommodate —
 * failed to satisfy it. The first draft asserted in this comment that ProjectDb
 * "satisfies this shape as-is"; the typechecker disagreed. Matching the binding
 * type is what makes the claim true rather than merely written down. Without this the "one flow, two deployments" decision
 * (SPEC § Decisions Log 2026-08-02) would have been aspirational: the broker
 * would have been mountable only where a `ProjectDb` happened to exist, and
 * Managed would have needed a second implementation, which is the dual code path
 * that decision exists to prevent.
 */
export interface CoresOAuthBrokerDb {
  get<R>(sql: string, params: SQLQueryBindings[]): R | null
  run(sql: string, params: SQLQueryBindings[]): Promise<void>
  runSync(sql: string, params: SQLQueryBindings[]): unknown
}

/** Path the instance registers its pending state on. Must stay in lockstep with
 *  `cores-oauth-surface.ts`'s `registerPath`. */
export const BROKER_REGISTER_PATH = '/oauth/cores/pending/register'
/** Path Google is configured to redirect to. This is the URI registered on the
 *  OAuth client, so changing it is a deployment migration, not a refactor. */
export const BROKER_CALLBACK_PATH = '/oauth/cores/google/callback'

/** How long a routing row stays usable when the instance supplies no expiry. */
const DEFAULT_TTL_MS = 10 * 60 * 1_000

interface BrokerRow {
  state: string
  project_slug: string
  dispatch_url: string
  expires_at: number
}

export interface CoresOAuthBrokerOptions {
  db: CoresOAuthBrokerDb
  /** Shared HMAC secret — the same value the instances sign with. */
  internalSharedSecret: string
  /** Injected for tests. */
  now?: () => number
  /** Injected for tests; the relay to the instance's `/ingest`. */
  fetch?: typeof globalThis.fetch
  log?: (event: { kind: string; [k: string]: unknown }) => void
}

export interface CoresOAuthBroker {
  /** Returns a `Response` for an owned path, or `null` to fall through. */
  handler: (req: Request) => Promise<Response | null>
}

/**
 * A terminal page for the human. Deliberately text-only and self-contained: no
 * `code`, no `state`, no external assets. The owner's next step lives in the app,
 * not here.
 */
function page(title: string, detail: string, status: number): Response {
  const esc = (s: string): string =>
    s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`)
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.25rem">${esc(title)}</h1><p>${esc(detail)}</p>` +
      `<p style="color:#666">You can close this tab and return to Neutron.</p></body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

export function createCoresOAuthBroker(opts: CoresOAuthBrokerOptions): CoresOAuthBroker {
  const { db, internalSharedSecret } = opts
  const now = opts.now ?? ((): number => Date.now())
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const log = opts.log ?? ((): void => {})

  function sweep(): void {
    db.runSync('DELETE FROM cores_oauth_broker_pending WHERE expires_at <= ?', [now()])
  }

  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname

      // ── register ────────────────────────────────────────────────────────────
      if (pathname === BROKER_REGISTER_PATH && req.method === 'POST') {
        const rawBody = await req.text()
        const verification = verifyInternalRequest({
          method: 'POST',
          path: BROKER_REGISTER_PATH,
          body: rawBody,
          shared_secret: internalSharedSecret,
          supplied_signature: (req.headers.get('x-internal-signature') ?? '').trim(),
          supplied_timestamp_header: (req.headers.get('x-internal-timestamp') ?? '').trim(),
          now_ms: now(),
        })
        if (!verification.ok) {
          // Never say WHICH check failed — a probing caller learns nothing about
          // the secret or the clock from the response.
          return jsonResponse(401, { ok: false, code: 'unauthorized' })
        }
        let body: { state?: unknown; project_slug?: unknown; dispatch_url?: unknown; expires_at?: unknown }
        try {
          body = JSON.parse(rawBody) as typeof body
        } catch {
          return jsonResponse(400, { ok: false, code: 'malformed_json' })
        }
        const state = typeof body.state === 'string' ? body.state : ''
        const project_slug = typeof body.project_slug === 'string' ? body.project_slug : ''
        const dispatch_url = typeof body.dispatch_url === 'string' ? body.dispatch_url : ''
        if (state.length === 0 || project_slug.length === 0 || dispatch_url.length === 0) {
          return jsonResponse(400, { ok: false, code: 'missing_fields' })
        }
        // Only ever relay to http(s). A `file:`/`data:` dispatch_url from a
        // compromised or buggy caller must not become an SSRF primitive.
        let parsed: URL
        try {
          parsed = new URL(dispatch_url)
        } catch {
          return jsonResponse(400, { ok: false, code: 'invalid_dispatch_url' })
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return jsonResponse(400, { ok: false, code: 'invalid_dispatch_url' })
        }
        const expires_at =
          typeof body.expires_at === 'number' && Number.isFinite(body.expires_at)
            ? body.expires_at
            : now() + DEFAULT_TTL_MS
        sweep()
        // INSERT-ONLY / SAME-OWNER (SPEC § Decisions Log 2026-08-04).
        //
        // This clause used to overwrite `project_slug` as well as `dispatch_url`,
        // which handed any holder of the shared secret who learned another
        // instance's `state` a REPOINT primitive: re-register that state with
        // your own slug and your own dispatch_url, and the row — owner and
        // callback target both — became yours. PKCE meant the relayed code was
        // unexchangeable by the thief (`cores-oauth-surface.ts:371` mints the
        // verifier into the LOCAL pending store only), so the payoff was denial
        // of one in-flight grant rather than credential theft. That is a reason
        // the blast radius was small, not a reason to keep the primitive.
        //
        // The `WHERE` is what removes it: on a conflict the row is updated only
        // while the stored owner equals the incoming one, so an existing
        // registration can never change hands. `project_slug` is dropped from
        // the SET for the same reason — under this guard the two values are
        // already equal, and not writing the column at all is the stronger
        // statement.
        //
        // Retry idempotency, which is why the upsert exists, is untouched: a
        // legitimate retry re-registers the SAME state for the SAME slug and
        // still refreshes its dispatch_url and expiry. An honest re-start always
        // mints a fresh 192-bit random state (`cores-oauth-surface.ts:369`), so
        // a cross-owner collision never happens legitimately — which is why
        // rejecting one costs nothing and a self-host, having exactly one owner,
        // can never trip it.
        await db.run(
          `INSERT INTO cores_oauth_broker_pending
             (state, project_slug, dispatch_url, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(state) DO UPDATE SET
             dispatch_url = excluded.dispatch_url,
             expires_at   = excluded.expires_at
           WHERE cores_oauth_broker_pending.project_slug = excluded.project_slug`,
          [state, project_slug, dispatch_url, expires_at, now()],
        )
        // The guard above makes the mismatch a silent no-op at the SQL level, so
        // the caller is told by reading back what actually stands. Answering 200
        // to a registration that was refused would be the worse failure: the
        // instance would send its owner to Google against a state the broker
        // will never route.
        const stored = db.get<{ project_slug: string }>(
          'SELECT project_slug FROM cores_oauth_broker_pending WHERE state = ?',
          [state],
        )
        if (stored === null || stored.project_slug !== project_slug) {
          log({ kind: 'cores_oauth_broker_register_owner_mismatch', project_slug })
          return jsonResponse(409, { ok: false, code: 'state_owner_mismatch' })
        }
        log({ kind: 'cores_oauth_broker_registered', project_slug })
        return jsonResponse(200, { ok: true })
      }

      // ── Google's callback ───────────────────────────────────────────────────
      if (pathname === BROKER_CALLBACK_PATH && req.method === 'GET') {
        const state = url.searchParams.get('state') ?? ''
        const code = url.searchParams.get('code') ?? ''
        const googleError = url.searchParams.get('error')
        if (googleError !== null && googleError.length > 0) {
          // The owner declined, or Google refused. Not our failure — say so
          // plainly rather than reporting an internal error.
          log({ kind: 'cores_oauth_broker_google_error', error: googleError })
          return page('Not connected', `Google reported: ${googleError}.`, 400)
        }
        if (state.length === 0 || code.length === 0) {
          return page('Not connected', 'The callback was missing its code or state.', 400)
        }
        sweep()
        const row = db.get<BrokerRow>(
          `SELECT state, project_slug, dispatch_url, expires_at
             FROM cores_oauth_broker_pending WHERE state = ?`,
          [state],
        )
        // Consume BEFORE relaying: single-use must hold even if the relay then
        // fails, otherwise a retried callback is a replay window.
        if (row !== null) {
          db.runSync('DELETE FROM cores_oauth_broker_pending WHERE state = ?', [state])
        }
        if (row === null || row.expires_at <= now()) {
          log({ kind: 'cores_oauth_broker_unknown_state' })
          return page(
            'Not connected',
            'This sign-in link has expired or was already used. Start the connection again from Neutron.',
            400,
          )
        }
        const relayBody = JSON.stringify({ code, state })
        const timestamp_ms = now()
        const dispatchPath = new URL(row.dispatch_url).pathname
        const sig = signInternalRequest({
          method: 'POST',
          path: dispatchPath,
          body: relayBody,
          shared_secret: internalSharedSecret,
          timestamp_ms,
        })
        let relayed: Response
        try {
          relayed = await fetchImpl(row.dispatch_url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-internal-signature': sig,
              'x-internal-timestamp': String(timestamp_ms),
            },
            body: relayBody,
          })
        } catch (err) {
          log({
            kind: 'cores_oauth_broker_relay_threw',
            error: err instanceof Error ? err.message : String(err),
          })
          return page('Not connected', 'Neutron could not be reached to finish connecting.', 502)
        }
        if (!relayed.ok) {
          log({ kind: 'cores_oauth_broker_relay_failed', status: relayed.status })
          return page('Not connected', 'Neutron refused the connection attempt.', 502)
        }
        log({ kind: 'cores_oauth_broker_relayed', project_slug: row.project_slug })
        return page('Connected', 'Your Google account is now connected to Neutron.', 200)
      }

      return null
    },
  }
}

/**
 * Derive the broker HMAC secret for a CO-LOCATED (Open self-host) deployment.
 *
 * When the instance is its own broker the signature authenticates the instance
 * to itself, so the secret needs to be stable across restarts and unguessable —
 * not shared with anyone. Deriving it from the instance's existing AES keyfile
 * means there is no NEW secret to generate, store, back up, or leak; if that
 * keyfile is present the broker secret exists, and if it is absent the instance
 * already cannot decrypt any stored credential.
 *
 * A REMOTE (Managed) broker does NOT use this — there the secret is genuinely
 * shared between two hosts and is supplied by deployment config.
 */
export function deriveColocatedBrokerSecret(instance_key: string): string {
  return createHash('sha256')
    .update(`neutron/cores-oauth-broker/v1\n${instance_key}`, 'utf8')
    .digest('hex')
}
