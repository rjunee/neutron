/**
 * @neutronai/open — single-owner sidebar topic-rail surface.
 *
 * Owns `GET /api/v1/chat/topics` for the Open single-owner server. Backs
 * the chat surface's left rail (`landing/chat.ts:TopicRail`), which calls
 * this endpoint to populate the sidebar.
 *
 * WHY an Open-native surface (the bug Ryan hit dogfooding the self-host
 * install): the Managed topic surface (`gateway/http/chat-topics-surface.ts`)
 * enumerates topics from `button_prompts` rows — i.e. only topics the user
 * has already chatted in. After onboarding the owner's projects live in the
 * canonical `projects` table (migration 0038 / 0053) + on disk, but the
 * brand-new project topics have NO `button_prompts` rows yet, so the Managed
 * surface would render an empty (General-only) sidebar despite N projects
 * existing. Worse, the Open composer never even mounted a topics surface, so
 * the route 404'd → `history-hydrate-failed status=404` → empty sidebar.
 *
 * This surface lists the owner's projects DIRECTLY from the `projects` table
 * (the source of truth onboarding writes), synthesises the per-project
 * `web:<user_id>:<project_id>` topic_id the chat client + WS switch path
 * expect, and merges in any `button_prompts` metadata (last preview body,
 * last activity, unread count) when the project already has chat history.
 *
 * Topic shapes returned (same wire shape as the Managed surface so
 * `landing/chat.ts:ChatTopic` is unchanged):
 *   - `web:<user_id>`               — General (project_id: null, name: "General")
 *   - `web:<user_id>:<project_id>`  — one row per live project
 *
 * Auth: cookie-only via the injected `resolveUserClaim` hook (the same
 * `cookieToUserClaim` closure the WS upgrade + import uploads use). The
 * handler double-checks the claim's project_slug matches this instance.
 *
 * Wire response (success): `{ ok: true, topics: ChatTopic[] }` — General
 * first, then projects ordered by most-recent activity.
 * Wire response (error): `{ ok: false, code, message }` (JSON even on 500
 * so the client's `JSON.parse` never crashes).
 */

import type { ButtonStore } from '../channels/button-store.ts'
import { webTopicId } from '../gateway/http/web-topic-id.ts'
import type { ProjectDb } from '../persistence/index.ts'

/** Verified claim shape — matches `chat-topics-surface.ts:UserClaim`. */
export interface OpenUserClaim {
  project_slug: string
  user_id: string
}

/** Wire shape — mirrors `landing/chat.ts:ChatTopic`. */
export interface ChatTopic {
  topic_id: string
  project_id: string | null
  name: string
  last_body: string | null
  last_created_at: number | null
  unread_count: number
}

export interface OpenChatTopicsSurfaceOptions {
  /** Single-owner project.db — read the canonical `projects` table. */
  db: ProjectDb
  /**
   * Per-instance button-prompt store. Optional — when supplied the handler
   * merges last-activity / unread metadata onto the project rows AND surfaces
   * any chat topic that has history but no `projects` row (defensive: never
   * lose a conversation the owner already started).
   */
  buttonStore?: ButtonStore
  /** Cookie-auth resolver — the same closure the WS upgrade uses. */
  resolveUserClaim: (req: Request) => Promise<OpenUserClaim | null>
  /** The project_slug this surface is bound to (defense-in-depth check). */
  project_slug: string
  /** Wall clock injectable for test determinism. Defaults to `Date.now`. */
  now?: () => number
}

export interface OpenChatTopicsSurface {
  /** Returns `Response` for `/api/v1/chat/topics`, `null` otherwise. */
  handler: (req: Request) => Promise<Response | null>
}

const TOPICS_PATH = '/api/v1/chat/topics'

interface ProjectListRow {
  id: string
  name: string
  description: string | null
  updated_at: string
}

/** 50-char sidebar preview, matching the Managed surface's truncation. */
function truncatePreview(body: string): string {
  const trimmed = body.trim()
  if (trimmed.length <= 50) return trimmed
  return `${trimmed.slice(0, 49)}…`
}

/**
 * Humanise a project_id slug into a readable label when the project row
 * carries no name. Mirrors `chat-topics-surface.ts:humaniseProjectId`.
 */
function humaniseProjectId(project_id: string): string {
  const trimmed = project_id.replace(/[-_]+/g, ' ').trim()
  if (trimmed.length === 0) return project_id
  return trimmed
    .split(/\s+/)
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

export function createOpenChatTopicsSurface(
  opts: OpenChatTopicsSurfaceOptions,
): OpenChatTopicsSurface {
  const now = opts.now ?? ((): number => Date.now())
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      if (url.pathname !== TOPICS_PATH) return null
      if (req.method !== 'GET') {
        return jsonError(
          405,
          'method_not_allowed',
          `method '${req.method}' not allowed on ${TOPICS_PATH}`,
        )
      }
      const claim = await opts.resolveUserClaim(req)
      if (claim === null) {
        return jsonError(401, 'unauthorized', 'session cookie missing or invalid')
      }
      // Defense-in-depth: a single-owner cookie is signed for THIS slug; a
      // stale / cross-instance cookie must not enumerate topics.
      if (claim.project_slug !== opts.project_slug) {
        return jsonError(
          401,
          'project_mismatch',
          'session cookie project does not match this gateway',
        )
      }

      const general = webTopicId(claim.user_id)
      const observed = now()

      // ── Chat-activity metadata (optional) ──────────────────────────────
      // Map topic_id → { last_body, last_created_at } from button_prompts so
      // a project the owner has already chatted in shows a preview. Failures
      // degrade to "no metadata" — never 500 the sidebar over a hiccup.
      //
      // 2026-06-20 (chat-polish B, owner live-dogfood) — `unread_count` is
      // DELIBERATELY NOT surfaced. THE BUG: every project sidebar showed a
      // perpetual "1" badge that "always reset to 1". `listTopicsByUser`
      // derives `unread_count` as the count of UNRESOLVED + unexpired
      // `button_prompts` — and every freshly-materialized project carries
      // exactly ONE unresolved opening seed prompt, so the badge sat at 1
      // forever. That is NOT unread tracking: there is no per-topic
      // last-read / last-seen marker persisted anywhere, so "unread" cannot
      // be computed honestly. Per the owner's standing no-fake-indicators
      // rule we REMOVE the badge at the source rather than ship a
      // meaningless count — the surface reports `unread_count: 0`, so the
      // client's badge (which hides at 0) never paints a fake "1". Wiring a
      // real last-read seam is out of scope for go-live.
      const activity = new Map<
        string,
        { last_body: string | null; last_created_at: number | null }
      >()
      if (opts.buttonStore !== undefined) {
        try {
          const rows = await opts.buttonStore.listTopicsByUser({
            user_id_prefix: general,
            now: observed,
          })
          for (const row of rows) {
            activity.set(row.topic_id, {
              last_body: row.last_body,
              last_created_at: row.last_created_at,
            })
          }
        } catch (err) {
          console.warn(
            `[open-chat-topics] project=${opts.project_slug} listTopicsByUser threw — sidebar renders without activity metadata:`,
            err,
          )
        }
      }

      // ── Project rows (source of truth) ─────────────────────────────────
      let projectRows: ProjectListRow[]
      try {
        projectRows = opts.db
          .prepare<ProjectListRow, []>(
            `SELECT id, name, description, updated_at
               FROM projects
              WHERE deleted_at IS NULL
              ORDER BY updated_at DESC, id ASC`,
          )
          .all()
      } catch (err) {
        console.warn(
          `[open-chat-topics] project=${opts.project_slug} projects query threw:`,
          err,
        )
        return jsonError(500, 'internal', 'failed to list projects')
      }

      const topics: ChatTopic[] = []
      const seen = new Set<string>()

      // General first — synthesised so a fresh owner (no projects, no chat)
      // still lands somewhere. Carry General's own chat metadata if present.
      const generalMeta = activity.get(general)
      topics.push({
        topic_id: general,
        project_id: null,
        name: 'General',
        last_body: generalMeta?.last_body ?? null,
        last_created_at: generalMeta?.last_created_at ?? null,
        // No honest last-read seam exists — never surface a fake unread
        // badge (chat-polish B). The wire field stays for client compat.
        unread_count: 0,
      })
      seen.add(general)

      for (const row of projectRows) {
        const topic_id = `${general}:${row.id}`
        seen.add(topic_id)
        const meta = activity.get(topic_id)
        const name = row.name.trim().length > 0 ? row.name.trim() : humaniseProjectId(row.id)
        topics.push({
          topic_id,
          project_id: row.id,
          name,
          // Prefer a real chat preview; otherwise fall back to the project's
          // one-line description so the sidebar still reads as informative.
          last_body:
            meta?.last_body ??
            (row.description !== null && row.description.trim().length > 0
              ? truncatePreview(row.description)
              : null),
          last_created_at: meta?.last_created_at ?? null,
          // chat-polish B — no fake unread badge (see metadata block above).
          unread_count: 0,
        })
      }

      // Defensive: surface any chat topic with history but no projects row
      // (e.g. a soft-deleted project the owner still has scrollback in) so a
      // started conversation is never silently dropped from the rail.
      for (const [topic_id, meta] of activity.entries()) {
        if (seen.has(topic_id)) continue
        const project_id = topic_id.slice(general.length + 1)
        topics.push({
          topic_id,
          project_id,
          name: humaniseProjectId(project_id),
          last_body: meta.last_body,
          last_created_at: meta.last_created_at,
          // chat-polish B — no fake unread badge (see metadata block above).
          unread_count: 0,
        })
      }

      // Sort: General first, then by most-recent activity DESC. Projects with
      // no chat activity fall back to their `updated_at` so freshly-seeded
      // projects still order by recency rather than collapsing to one bucket.
      const updatedAtMs = new Map<string, number>()
      for (const row of projectRows) {
        const t = Date.parse(row.updated_at)
        updatedAtMs.set(`${general}:${row.id}`, Number.isFinite(t) ? t : 0)
      }
      topics.sort((a, b) => {
        if (a.project_id === null) return -1
        if (b.project_id === null) return 1
        const ta = a.last_created_at ?? updatedAtMs.get(a.topic_id) ?? 0
        const tb = b.last_created_at ?? updatedAtMs.get(b.topic_id) ?? 0
        return tb - ta
      })

      return jsonOk({ topics })
    },
  }
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
