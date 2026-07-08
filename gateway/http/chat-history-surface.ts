/**
 * @neutronai/gateway/http — chat-history hydration surface.
 *
 * Owns `GET /api/v1/chat/history?before=<unix_ms>&before_prompt_id=<id>&limit=<n>`.
 * Backs the chat surface's WS-open hydration + scroll-up lazy-load (see
 * `landing/chat.ts:hydrateInitialHistory` and `loadOlderBatch`).
 *
 * Per `docs/plans/2026-05-28-001-feat-chat-history-hydration-plan.md`.
 *
 * Auth: cookie-only via the injected `resolveUserClaim` hook (production
 * wires the same `cookieToUserClaim` closure the WS upgrade uses — see
 * `gateway/index.ts:2923`). The closure already asserts
 * `cookie.project_slug === opts.project_slug` before returning a claim, so
 * a stolen cross-instance cookie cannot deserialize on this gateway. The
 * handler additionally double-checks `claim.project_slug ===
 * opts.project_slug` as defense-in-depth, mirroring the bearer-auth
 * surfaces that re-assert instance binding before mutating.
 *
 * Path / method gate: returns `null` for anything but
 * `GET /api/v1/chat/history`, so the `compose.ts` dispatch falls through
 * to the next handler in the chain on a sibling-owned route.
 *
 * Topic isolation: the handler derives the General topic
 * (`webTopicId(claim.user_id)`) from the verified claim, and accepts an
 * OPTIONAL `?topic_id=` query parameter for the per-project sidebar
 * sprint (2026-05-28). When supplied, the value MUST be either the
 * General topic itself OR start with `web:<user_id>:` — anything else
 * is rejected as 400 so a crafted `?topic_id=` can't leak another
 * user's history. When omitted (legacy callers / pre-sidebar clients),
 * the handler defaults to General with byte-identical behaviour.
 *
 * Pagination: composite cursor `(before, before_prompt_id)`. First page
 * call passes `before = Date.now()` (server default when omitted),
 * `before_prompt_id` omitted; subsequent calls pass the response's
 * `oldest_returned_at` + `oldest_returned_prompt_id`. The composite
 * cursor handles ms-collisions on `created_at` (multiple prompts
 * created in the same millisecond during a phase burst).
 *
 * Wire response (success):
 *
 *   {
 *     ok: true,
 *     turns: ChatHistoryTurn[],   // DESC by (created_at, prompt_id)
 *     has_more: boolean,
 *     oldest_returned_at: number | null,
 *     oldest_returned_prompt_id: string | null
 *   }
 *
 * Wire response (error): `{ ok: false, code, message }` with a
 * JSON-shaped body even on 500 so the client's `JSON.parse` never
 * crashes (the chat-side hydrator log-and-continues on non-200, but a
 * crash here would leak into the broader UX).
 */

import type { ButtonStore, ChatHistoryTurn } from '@neutronai/channels/button-store.ts'
import { ownerIdentityMismatch, type OwnerHandleResolver } from './auth-helpers.ts'
import { webTopicId } from './chat-bridge.ts'

/**
 * Verified claim shape — matches `cookieToUserClaim`'s return type
 * (`gateway/index.ts:2923`). The `set_cookie` field travels on the WS
 * upgrade path only; the chat-history handler doesn't refresh cookies
 * itself (the per-instance auth-gate's sliding refresh already handles
 * that on every authenticated HTTP request).
 */
export interface UserClaim {
  project_slug: string
  user_id: string
  set_cookie?: string
}

export interface ChatHistorySurfaceOptions {
  /** Per-project button-prompt store the handler reads history from. */
  store: ButtonStore
  /**
   * Cookie-auth resolver. Returns `{ project_slug, user_id }` on
   * success, `null` on missing/invalid/cross-instance cookies. Production
   * wires the same closure the WS upgrade uses. Tests pass a stub.
   */
  resolveUserClaim: (req: Request) => Promise<UserClaim | null>
  /**
   * The project_slug this surface is bound to. Used as the defense-in-
   * depth double-check on the resolved claim (the underlying closure
   * already asserts this, but a handler-level assertion catches future
   * regressions to the resolver).
   */
  project_slug: string
  /**
   * Canonical slug → internal_handle resolver (2026-06-10 slug-rename
   * P0). Production wires `buildOwnerHandleResolver(ownersRegistry)`
   * so the identity guard compares frozen internal handles, not
   * renameable url_slugs. When unset the guard degrades to the raw
   * timing-safe compare (registry-less test compositions).
   */
  resolveOwnerHandle?: OwnerHandleResolver
  /** Wall clock injectable for test determinism. Defaults to `Date.now`. */
  now?: () => number
}

export interface ChatHistorySurface {
  /**
   * Dispatcher returns `Response` for the owned route, `null` for
   * anything else (so `composeHttpHandler` falls through to the next
   * handler in the chain). Mirrors the sibling-surface contract used
   * by `appTasks`, `appLauncher`, etc.
   */
  handler: (req: Request) => Promise<Response | null>
}

const HISTORY_PATH = '/api/v1/chat/history'

/** Wire-side default + max per the deepening pass. */
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export function createChatHistorySurface(
  opts: ChatHistorySurfaceOptions,
): ChatHistorySurface {
  const now = opts.now ?? ((): number => Date.now())
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      if (url.pathname !== HISTORY_PATH) return null
      if (req.method !== 'GET') {
        return jsonError(405, 'method_not_allowed', `method '${req.method}' not allowed on ${HISTORY_PATH}`)
      }

      const claim = await opts.resolveUserClaim(req)
      if (claim === null) {
        return jsonError(401, 'unauthorized', 'session cookie missing or invalid')
      }
      // Defense-in-depth: the resolver should never return a
      // mismatched project_slug (the underlying cookieToUserClaim asserts
      // this before returning), but re-checking here means a future
      // resolver bug or alternate composition wiring can't silently
      // breach instance isolation through this surface.
      // Canonical internal-handle comparison — the claim carries the
      // renameable url_slug while `opts.project_slug` is the frozen
      // internal handle; a raw compare broke on every slug rename
      // (2026-06-10 P0).
      if (ownerIdentityMismatch(claim.project_slug, opts.project_slug, opts.resolveOwnerHandle)) {
        return jsonError(401, 'project_mismatch', 'session cookie project does not match this gateway')
      }

      const limit = parseLimit(url.searchParams.get('limit'))
      const before = parseBefore(url.searchParams.get('before'), now())
      // `before_prompt_id` is optional on the first call; subsequent
      // calls thread the prior response's `oldest_returned_prompt_id`
      // through to handle ms-collisions on `created_at`.
      const before_prompt_id_raw = url.searchParams.get('before_prompt_id')
      const before_prompt_id =
        before_prompt_id_raw !== null && before_prompt_id_raw.length > 0
          ? before_prompt_id_raw
          : null

      // Sidebar sprint (2026-05-28) — optional `?topic_id=` query
      // param. Strict allowlist: either General (exact `web:<user_id>`)
      // OR a per-project descendant (`web:<user_id>:<project_id>`).
      // Anything else is rejected as 400 so a crafted param can't
      // surface another user's history. When omitted, fall back to
      // General for byte-identical pre-sidebar behaviour.
      const generalTopic = webTopicId(claim.user_id)
      const topic_param = url.searchParams.get('topic_id')
      let topic_id: string
      if (topic_param === null || topic_param.length === 0) {
        topic_id = generalTopic
      } else if (
        topic_param === generalTopic ||
        topic_param.startsWith(`${generalTopic}:`)
      ) {
        topic_id = topic_param
      } else {
        return jsonError(
          400,
          'invalid_topic_id',
          `topic_id must be '${generalTopic}' or a 'web:<user_id>:<project_id>' descendant`,
        )
      }
      let turns: ChatHistoryTurn[]
      let has_more: boolean
      try {
        const out = await opts.store.listHistoryByTopic({
          topic_id,
          before,
          before_prompt_id,
          limit,
          now: now(),
        })
        turns = out.turns
        has_more = out.has_more
      } catch (err) {
        // Defensive — listHistoryByTopic shouldn't throw on a healthy
        // DB, but if it does (e.g. transient lock contention surfaces
        // as a SQLITE_BUSY) we still ship a well-formed JSON response
        // so the chat-side hydrator's `res.ok` branch can short-circuit
        // cleanly. The console.warn surfaces the underlying issue in
        // server logs.
        console.warn(
          `[chat-history-surface] project=${opts.project_slug} user_id=${claim.user_id} listHistoryByTopic threw:`,
          err,
        )
        return jsonError(500, 'internal', 'failed to read chat history')
      }

      // `turns.length > 0` plus a non-undefined narrowing — `at(-1)`
      // returns `T | undefined` even after the length check under
      // `--noUncheckedIndexedAccess`, so guard explicitly.
      const last = turns.length > 0 ? turns[turns.length - 1] : undefined
      const oldest_returned_at = last !== undefined ? last.created_at : null
      const oldest_returned_prompt_id = last !== undefined ? last.prompt_id : null

      return jsonOk({
        turns,
        has_more,
        oldest_returned_at,
        oldest_returned_prompt_id,
      })
    },
  }
}

/**
 * Clamp the limit to `[1, MAX_LIMIT]`. Non-numeric / missing / negative
 * / zero / NaN all fall back to `DEFAULT_LIMIT` so a bad client query
 * can't break the surface.
 */
function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_LIMIT
  const floored = Math.floor(n)
  if (floored < 1) return DEFAULT_LIMIT
  if (floored > MAX_LIMIT) return MAX_LIMIT
  return floored
}

/**
 * Default the `before` cursor to wall-clock-now when missing or
 * malformed. Negative / NaN values also fall back to now (a non-positive
 * cursor would return an empty page on any topic, which is a confusing
 * client-side symptom for what's actually a bad query).
 */
function parseBefore(raw: string | null, nowMs: number): number {
  if (raw === null) return nowMs
  const n = Number(raw)
  if (!Number.isFinite(n)) return nowMs
  if (n <= 0) return nowMs
  return Math.floor(n)
}

function jsonOk(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
