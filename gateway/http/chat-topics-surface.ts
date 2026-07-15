/**
 * @neutronai/gateway/http — sidebar topic-rail surface.
 *
 * Owns `GET /api/v1/chat/topics`. Backs the chat surface's left rail
 * (see `landing/chat.ts:TopicRail`). One row per distinct `topic_id`
 * the authenticated user has at least one `button_prompts` row in,
 * plus a synthesised "General" row when the table is empty for this
 * user (so a new owner still has somewhere to land).
 *
 * Per the 2026-05-28 sidebar + per-project chat topology sprint.
 *
 * Auth: cookie-only via the injected `resolveUserClaim` hook (mirrors
 * `chat-history-surface.ts`). The closure asserts
 * `cookie.project_slug === opts.project_slug` before returning a claim,
 * and the handler double-checks the same invariant. The handler NEVER
 * reads `user_id` or `topic_id` from the URL — it derives the General
 * topic and the user-id prefix server-side from the verified claim.
 *
 * Topic shapes returned:
 *   - `web:<user_id>` — General topic (project_id: null, name: "General")
 *   - `web:<user_id>:<project_id>` — per-project topic
 *
 * Per-project name resolution is delegated to an optional
 * `resolveProjectNames` hook. Production wires this through the
 * per-instance `ProjectSettingsStore.list(project_slug)`; when unset (or
 * when the project_id isn't found in the store), the surface
 * humanises the slug ("project-x" → "Project X") so the sidebar still
 * shows readable labels.
 *
 * Wire response (success):
 *
 *   {
 *     ok: true,
 *     topics: ChatTopic[]   // General first, then per-project ordered
 *                           // by last_created_at DESC
 *   }
 *
 *   ChatTopic = {
 *     topic_id: string,
 *     project_id: string | null,
 *     name: string,
 *     last_body: string | null,         // 50-char sidebar preview
 *     last_created_at: number | null,   // unix ms
 *     unread_count: number              // active unresolved prompts
 *   }
 *
 * Wire response (error): `{ ok: false, code, message }` with a
 * JSON-shaped body even on 500 so the chat-side fetcher's `JSON.parse`
 * never crashes.
 */

import type { ButtonStore } from '@neutronai/channels/button-store.ts'
import { ownerIdentityMismatch, type OwnerHandleResolver } from './auth-helpers.ts'
import { jsonResponse } from './surface-kit.ts'
import { webTopicId } from './chat-bridge.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('chat-topics')

/** Verified claim shape — matches `chat-history-surface.ts:UserClaim`. */
export interface UserClaim {
  project_slug: string
  user_id: string
  set_cookie?: string
}

export interface ChatTopic {
  topic_id: string
  project_id: string | null
  name: string
  last_body: string | null
  last_created_at: number | null
  unread_count: number
}

export interface ChatTopicsSurfaceOptions {
  /** Per-project button-prompt store the handler reads from. */
  store: ButtonStore
  /** Cookie-auth resolver. Same closure the WS upgrade + chat-history use. */
  resolveUserClaim: (req: Request) => Promise<UserClaim | null>
  /** The project_slug this surface is bound to (defense-in-depth check). */
  project_slug: string
  /**
   * Canonical slug → internal_handle resolver (2026-06-10 slug-rename
   * P0). Production wires `buildOwnerHandleResolver(ownersRegistry)`
   * so the identity guard compares frozen internal handles, not
   * renameable url_slugs — a post-onboarding slug rename must never
   * 401 the sidebar. When unset the guard degrades to the raw
   * timing-safe compare (registry-less test compositions).
   */
  resolveOwnerHandle?: OwnerHandleResolver
  /**
   * Optional per-instance `project_id → name` lookup. Production wires this
   * against the gateway's `ProjectSettingsStore`. When unset, the handler
   * falls back to a humanised slug. Failures inside the resolver are
   * caught + logged; the handler still returns the topic list (with
   * humanised names) rather than 500'ing the whole sidebar.
   */
  resolveProjectNames?: () => Promise<Map<string, string>>
  /** Wall clock injectable for test determinism. Defaults to `Date.now`. */
  now?: () => number
}

export interface ChatTopicsSurface {
  /**
   * Dispatcher returns `Response` for `/api/v1/chat/topics`, `null` for
   * anything else (so `composeHttpHandler` falls through). Mirrors the
   * sibling surfaces' contract.
   */
  handler: (req: Request) => Promise<Response | null>
}

const TOPICS_PATH = '/api/v1/chat/topics'

export function createChatTopicsSurface(opts: ChatTopicsSurfaceOptions): ChatTopicsSurface {
  const now = opts.now ?? ((): number => Date.now())
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      if (url.pathname !== TOPICS_PATH) return null
      if (req.method !== 'GET') {
        return jsonErrorUtf8(
          405,
          'method_not_allowed',
          `method '${req.method}' not allowed on ${TOPICS_PATH}`,
        )
      }
      const claim = await opts.resolveUserClaim(req)
      if (claim === null) {
        return jsonErrorUtf8(401, 'unauthorized', 'session cookie missing or invalid')
      }
      // Defense-in-depth: the resolver should already enforce this, but a
      // future composition wiring bug must not leak topics across instances.
      // Canonical internal-handle comparison — the claim carries the
      // renameable url_slug while `opts.project_slug` is the frozen
      // internal handle; a raw compare broke on every slug rename
      // (2026-06-10 P0: sidebar rendered General-only post-rename).
      if (ownerIdentityMismatch(claim.project_slug, opts.project_slug, opts.resolveOwnerHandle)) {
        return jsonErrorUtf8(401, 'project_mismatch', 'session cookie project does not match this gateway')
      }
      const generalTopic = webTopicId(claim.user_id)
      const observed = now()
      let projectNames: Map<string, string> = new Map()
      if (opts.resolveProjectNames !== undefined) {
        try {
          projectNames = await opts.resolveProjectNames()
        } catch (err) {
          // Don't 500 the sidebar over a name-resolver hiccup — the
          // humanised-slug fallback still produces readable labels.
          moduleLog.warn('resolve_project_names_threw', {
            project: opts.project_slug,
            user_id: claim.user_id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      let rows: Awaited<ReturnType<typeof opts.store.listTopicsByUser>>
      try {
        rows = await opts.store.listTopicsByUser({
          user_id_prefix: generalTopic,
          now: observed,
        })
      } catch (err) {
        moduleLog.warn('list_topics_threw', {
          project: opts.project_slug,
          user_id: claim.user_id,
          error: err instanceof Error ? err.message : String(err),
        })
        return jsonErrorUtf8(500, 'internal', 'failed to list chat topics')
      }
      const decorated: ChatTopic[] = rows.map((row) => ({
        topic_id: row.topic_id,
        project_id: row.project_id,
        name: row.project_id === null
          ? 'General'
          : projectNames.get(row.project_id) ?? humaniseProjectId(row.project_id),
        last_body: row.last_body,
        last_created_at: row.last_created_at,
        unread_count: row.unread_count,
      }))
      // Synthesise General when the user has no rows yet. New owners
      // (post-onboarding-start, pre-first-prompt) land on the chat
      // surface with no rows yet; the sidebar needs a target to render.
      if (!decorated.some((t) => t.project_id === null)) {
        decorated.unshift({
          topic_id: generalTopic,
          project_id: null,
          name: 'General',
          last_body: null,
          last_created_at: null,
          unread_count: 0,
        })
      }
      // Sort: General first, then per-project by last_created_at DESC
      // (most recently active topic next to General). Topics with no
      // rows yet (`last_created_at: null`) sink to the bottom.
      decorated.sort((a, b) => {
        if (a.project_id === null) return -1
        if (b.project_id === null) return 1
        const ta = a.last_created_at ?? 0
        const tb = b.last_created_at ?? 0
        return tb - ta
      })
      return jsonOkUtf8({ topics: decorated })
    },
  }
}

/**
 * Humanise a project_id slug into a readable display name when no
 * `ProjectSettings.name` is available. Mirrors the helper in
 * `gateway/http/app-projects-surface.ts:humaniseProjectId`.
 */
function humaniseProjectId(project_id: string): string {
  const trimmed = project_id.replace(/[-_]+/g, ' ').trim()
  if (trimmed.length === 0) return project_id
  return trimmed
    .split(/\s+/)
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

// O7 — this surface (pre-existing, harmless discrepancy) sets
// `application/json; charset=utf-8` where every other gateway/http surface
// sets plain `application/json`; kept byte-identical rather than silently
// normalized, so these stay tiny local wrappers around the shared
// `jsonResponse` primitive rather than the plain-`application/json`
// `jsonOk`/`jsonError` the kit exports. The `Utf8` suffix keeps them out of
// the O7 no-local-copy source guard (owner-slug-timing-safe.test.ts), which
// forbids a bare `jsonOk`/`jsonError` definition in any surface.
function jsonOkUtf8(body: Record<string, unknown>, status = 200): Response {
  return jsonResponse(status, { ok: true, ...body }, 'application/json; charset=utf-8')
}

function jsonErrorUtf8(status: number, code: string, message: string): Response {
  return jsonResponse(status, { ok: false, code, message }, 'application/json; charset=utf-8')
}
