/**
 * @neutronai/gateway/http — routed onboarding senders + web button-prompt
 * rendering + per-session/slug-shim registries.
 *
 * K11b0 (2026-07) — the legacy `/ws/chat` `ChatBridge` factory that this
 * module once exported was EXCISED. That socket was fully dead in
 * production (onboarding + chat are unified on `/ws/app/chat`); the bridge
 * `.validateStartToken/startSession/handleInbound` surface had zero prod
 * reachability while the module retained its production-live helpers. Only
 * those retained symbols remain here:
 *
 *   - `buildRoutedSendButtonPrompt` / `buildRoutedSendImportProgress` — the
 *     channel-agnostic `SendButtonPromptFn` fan-out (`web:` → the sender
 *     registry, `tg:` → the telegram sender, `app:` → the composer-filled
 *     app-ws holder) the engine still emits onboarding through.
 *   - `renderButtonPromptForWeb` — ButtonPrompt → the locked web
 *     `agent_message` `ChatOutbound` envelope.
 *   - `WebChatSessionProjectRegistry` (ISSUE #41 escalation project pin),
 *     the `OwnerRegistryLookup` adapter, and the slug-history shim trio.
 *   - K11a1 re-export shim for the sender-registry types + `webTopicId`.
 */

import { createHash } from 'node:crypto'
// K11b0 (2026-07) — the dead `/ws/chat` ChatBridge surface was excised. Only
// the RETAINED production symbols (routed senders, the web button-prompt
// renderer, the sender/slug-shim registries) remain, so the import surface
// collapses to the three types those still reference.
import type { ChatOutbound } from '../../landing/server.ts'
import type { SendButtonPromptFn } from '../../onboarding/interview/engine.ts'
import type { ButtonPrompt } from '../../channels/button-primitive.ts'

/**
 * T10 (2026-05-14) — structured-log tag for the WS upgrade chain.
 *
 * journalctl picks up `console.info` from the per-instance systemd unit by
 * default. The brief's diagnostic gap on prod was "ZERO request logs
 * post-boot": the chat-bridge had no observability at the WS upgrade
 * boundary, so a fresh-instance repro had no actionable trace. Every log
 * line in this file uses this prefix + a JSON-shaped body so an operator
 * can grep the unit journal for `[chat-bridge]` lines
 * and read the WS lifecycle line by line.
 *
 * Fields shape (all optional, included when known):
 *   instance=<slug> topic=<topic_id> jti=<jti> user=<user_id> event=<stage>
 *   delivered=<bool> outcome=<string> err=<string>
 *
 * Why `console.info` (not `console.warn`): warn pollutes operator alerts
 * for the happy path. The per-request volume is one line per WS upgrade
 * + one per inbound message, low even at peak — no log-volume risk.
 *
 * Why ALL fields up-front instead of `console.info({...})`: journalctl's
 * native rendering is line-oriented; embedding key=value pairs in the
 * message string keeps `journalctl -f` outputs human-readable without an
 * extra JSON pretty-printer.
 */
const LOG_TAG = '[chat-bridge]'

/**
 * Per-session sender registry. Production wires the in-memory variant
 * (process-local; per-instance gateway is a single Bun process). A future
 * cross-process variant (Redis pub/sub etc.) can implement the same
 * interface — for now the per-instance boundary keeps the in-memory map
 * sufficient for the M2 cohort scale (single-digit concurrent web
 * sessions per instance).
 */
// K11a1 (2026-07) — `WebChatSenderRegistry` + `InMemoryWebChatSenderRegistry`
// moved to the sibling leaf `./chat-sender-registry.ts` (pure type/impl
// extraction, no behavior change). Re-exported here so every existing
// `import ... from '.../chat-bridge.ts'` caller (internal uses below +
// the test suite) keeps resolving unchanged; new/repointed callers import
// directly from `./chat-sender-registry.ts`.
export type { WebChatSenderRegistry } from './chat-sender-registry.ts'
export { InMemoryWebChatSenderRegistry } from './chat-sender-registry.ts'
import type { WebChatSenderRegistry } from './chat-sender-registry.ts'

// `webTopicId` now lives in the dependency-free leaf `./web-topic-id.ts`
// (R5 / audit P1-2 — broke the chat-bridge ↔ build-onboarding-handoff
// cycle). Re-exported so existing `import { webTopicId } from
// '.../chat-bridge.ts'` callers are unchanged.
import { webTopicId } from './web-topic-id.ts'
export { webTopicId }

/**
 * ISSUE #41 — per-session "current chat project_id" tracker.
 *
 * The chat composer is per-instance (one engine per WS session, NOT
 * per-project), but inline-comment escalations from the docs UI are
 * per-project: a POST against
 * `/api/app/projects/<project_id>/docs/comments/<event_id>/escalate`
 * appends an `escalate_to_chat` event into THAT project's
 * `.comments/comments.db` sidecar. Before this registry the chat
 * composer's escalation-loader was hardcoded to read the `default`
 * project, so any escalation from a non-default project silently
 * disappeared on the next chat turn (UI returned 200; chat had no
 * awareness).
 *
 * The escalate POST handler in `gateway/http/app-docs-surface.ts`
 * calls `setActive(user_id, project_id)` after successfully appending
 * the event. The chat composer's per-turn LLM wrapper invokes the
 * closure built around `getActive(user_id)` so the next chat turn
 * reads pending escalations from the SAME project the user just
 * escalated from. Falls back to `default` when the user has not yet
 * escalated anything in this gateway-process lifetime — same string
 * the pre-#41 hardcode used, so regression-free behaviour for
 * single-project owners is byte-identical.
 *
 * Lifetime: per-instance in-memory map. A gateway restart loses the
 * pointer; the next escalation re-pins it. Acceptable because a) the
 * pre-fix behaviour was a hardcoded `default` constant (no durable
 * non-default state ever existed) and b) escalations are user-driven
 * — the next click re-pins.
 */
export interface WebChatSessionProjectRegistry {
  /**
   * Pin the user's current chat-side project to `project_id`. Called by
   * the docs escalate handler after a successful `escalate_to_chat`
   * event append.
   */
  setActive(user_id: string, project_id: string): void
  /**
   * Returns the currently pinned project_id for this user, or null if
   * the user has not yet escalated anything in this gateway-process
   * lifetime. The chat composer's resolver falls back to `'default'`
   * on a null return.
   */
  getActive(user_id: string): string | null
}

export class InMemoryWebChatSessionProjectRegistry
  implements WebChatSessionProjectRegistry
{
  private readonly active = new Map<string, string>()

  setActive(user_id: string, project_id: string): void {
    this.active.set(user_id, project_id)
  }

  getActive(user_id: string): string | null {
    return this.active.get(user_id) ?? null
  }
}

// K11a1 (2026-07) — `LiveAgentTurnRequest` + `LiveAgentTurnRunner` moved to
// the sibling leaf `./chat-sender-registry.ts` (pure type extraction, no
// behavior change). Re-exported here so every existing
// `import ... from '.../chat-bridge.ts'` caller (internal uses below +
// the test suite) keeps resolving unchanged; new/repointed callers import
// directly from `./chat-sender-registry.ts`.
export type {
  LiveAgentTurnRequest,
  LiveAgentTurnRunner,
} from './chat-sender-registry.ts'

/**
 * Convert a channel-agnostic ButtonPrompt into the locked web envelope
 * (Sprint 16 P2 S5 § 2.5). Adapters that emit on the web chat surface
 * (`/ws/app/chat`) use this shape so the cross-channel parity test stays
 * satisfied:
 *
 *   { v:1, type:'agent_message', body, prompt_id?, options[]?, allow_freeform? }
 *
 * The landing client (`landing/chat.ts`) parses `type:'agent_message'`
 * + `options` to render the keyboard locally.
 */
export function renderButtonPromptForWeb(prompt: ButtonPrompt, topic_id?: string): ChatOutbound {
  // Sprint 28 Codex r4 P1 — propagate `kind` + per-option `image_url`
  // so the image-gallery picker actually renders thumbnails on the
  // web client. Pre-Sprint-28 prompts have neither field set; the
  // ChatOutbound contract treats both as optional.
  //
  // P2 v2 § 6.2 (S4) — propagate the `upload_affordance` metadata bag
  // so the web client renders a file-picker + drag-drop overlay for
  // the `import_upload_pending` phase. Adapters that don't understand
  // the field (Telegram) skip it.
  const out: ChatOutbound = {
    type: 'agent_message',
    body: prompt.body,
    prompt_id: prompt.prompt_id,
    options: prompt.options.map((o) => {
      const opt: { label: string; body: string; value: string; image_url?: string } = {
        label: o.label,
        body: o.body,
        value: o.value,
      }
      if (o.image_url !== undefined) opt.image_url = o.image_url
      return opt
    }),
    allow_freeform: prompt.allow_freeform,
  }
  if (prompt.kind !== undefined) out.kind = prompt.kind
  const upload = normalizeUploadAffordance(prompt.metadata?.['upload_affordance'])
  if (upload !== null) {
    out.upload_affordance = upload
  }
  // P1a — stamp the owning topic so the per-topic client drop-guard routes this
  // prompt to ITS topic, not whatever is focused (notification misrouting).
  if (topic_id !== undefined) out.topic_id = topic_id
  return out
}

/**
 * Coerce a stored `upload_affordance` metadata bag into the narrowed
 * wire shape. Returns null for anything that doesn't carry a recognised
 * source.
 *
 * remove-both-import-option (2026-06-06, Codex r1): a prompt EMITTED
 * before this deploy in the (removed) two-upload 'both' flow persisted
 * `{source:'both'}`. On a post-deploy reconnect the gateway REPLAYS that
 * stored envelope verbatim via `reEmitActiveSeedPromptIfAny`. Dropping
 * the affordance for a stale 'both' would hide the upload bar while the
 * body still asks for a ZIP — a deploy-window dead-end. Instead we
 * NORMALIZE legacy 'both' to 'chatgpt' (the exact single-source fallback
 * the rebuild path `buildImportUploadPendingPromptSpec` uses for a stale
 * 'both'), so the user keeps a working upload affordance. The next engine
 * turn rebuilds the prompt fresh against the narrowed source.
 */
function normalizeUploadAffordance(
  value: unknown,
): { source: 'chatgpt' | 'claude' } | null {
  if (typeof value !== 'object' || value === null) return null
  const src = (value as { source?: unknown }).source
  if (src === 'chatgpt' || src === 'claude') return { source: src }
  if (src === 'both') return { source: 'chatgpt' }
  return null
}

/**
 * Narrow registry interface used by the JWT validator (Change 3 — accept
 * a new-slug JWT against a gateway whose `expected_project_slug` is still
 * the OLD slug, by looking up the registry's CURRENT `url_slug` for the
 * frozen `internal_handle` and accepting iff the claim matches it).
 *
 * Implemented by `buildOwnerRegistryLookupFromRegistry(ownersRegistry)`
 * against a `OwnersRegistry`; tests can pass an in-memory stub.
 */
export interface OwnerRegistryLookup {
  /**
   * Returns the CURRENT `url_slug` for the given `internal_handle`, or
   * null when the instance row is missing. Hot-path: every JWT-mismatch
   * connect runs this once; backing store is a single indexed SQLite
   * SELECT.
   */
  getCurrentUrlSlugByInternalHandle(internal_handle: string): string | null
}

/**
 * Adapter from the platform instances registry to the narrow lookup
 * interface above. Keeps `chat-bridge.ts` decoupled from the full
 * registry surface (insert/update/etc.) so a test can pass a tiny
 * stub without instantiating the SQLite-backed registry.
 *
 * Sprint B (2026-05-20) — accepts a structural subset of
 * `OwnersRegistry` so this Open-classified module no longer takes
 * an import edge on the Managed registry concrete. The Managed
 * production `OwnersRegistry` structurally satisfies the parameter
 * shape; tests can pass an in-memory `{ getByInternalHandle: ... }`
 * stub.
 */
export function buildOwnerRegistryLookupFromRegistry(registry: {
  getByInternalHandle(
    internal_handle: string,
  ): { url_slug: string } | undefined
}): OwnerRegistryLookup {
  return {
    getCurrentUrlSlugByInternalHandle(internal_handle: string): string | null {
      const row = registry.getByInternalHandle(internal_handle)
      if (row === undefined) return null
      return row.url_slug
    },
  }
}

/**
 * Onboarding consolidation (2026-06-26) — a late-bound app-socket sender holder.
 *
 * The Open composer builds the app-ws registry AFTER `buildLandingStack`
 * constructs the engine (the engine's `sendButtonPrompt` is fixed at
 * construction), so the `app:` route can't be a concrete function at engine
 * build time. The composer passes this MUTABLE holder into the routed sender and
 * fills `.send` once the app-ws adapter/registry exist. The routed closure reads
 * `holder.send` at CALL time, so the late binding is safe — the first socket
 * connects long after boot fills the holder. This keeps ONE engine + ONE routed
 * sender across web/telegram/app-socket (no second onboarding path).
 */
export interface AppSocketButtonPromptRouter {
  send?: SendButtonPromptFn
}

export interface BuildRoutedSendButtonPromptOptions {
  webRegistry: WebChatSenderRegistry
  /**
   * Telegram sender wired by the gateway boot when a TelegramAdapter is
   * composed. When omitted (web-only deploy), prompts addressed to a
   * `tg:` topic_id are returned was_new=false so the engine's retry
   * path stays consistent.
   */
  telegramSender?: SendButtonPromptFn
  /**
   * Onboarding consolidation — app-socket (`app:<user_id>`) route. The Open
   * composer fills the holder's `.send` after the app-ws registry is built so
   * onboarding prompts emit over the SAME `/ws/app/chat` socket the steady-state
   * chat uses. Absent on the Managed/web-only path (prompts to an `app:` topic
   * return was_new=false; the engine retries).
   */
  appSocketRouter?: AppSocketButtonPromptRouter
}

/**
 * Build a `SendButtonPromptFn` that routes by `topic_id` prefix. The
 * engine constructs with one sender; this factory hides the per-channel
 * fan-out so the engine code itself stays channel-agnostic.
 *
 * Routing:
 *   - `web:<user_id>`               → web registry (this module)
 *   - `tg:<chat_id>[:<thread_id>]`  → telegramSender (optional)
 *   - everything else               → was_new=false (the engine retries
 *                                      next emit; telemetry sees the gap)
 */
/**
 * 2026-05-21 (Bug 1, v0.1.75) — `sendImportProgress` factory.
 *
 * Mirrors `buildRoutedSendButtonPrompt` shape but routes the UI-only
 * `import_progress` envelope. Web: through `WebChatSenderRegistry`.
 * Telegram: silent drop today (no `telegramSender` wired for progress;
 * Telegram users get the import-completion `agent_message` once the
 * runner terminates — no mid-flight progress UX). Unknown channels:
 * dropped with a warn log.
 *
 * The progress envelope carries no audit identity, so repeat sends on a
 * closed WS are benign — the registry returns false, the engine ignores
 * the return value, and the next 5 s tick re-emits.
 */
/**
 * Onboarding consolidation (2026-06-26) — app-socket import-progress holder.
 * Same late-bind rationale as {@link AppSocketButtonPromptRouter}. The composer
 * fills `.send` to translate the UI-only `import_progress` event onto the
 * `/ws/app/chat` socket so the onboarding import phase renders live progress in
 * the React client.
 */
export interface AppSocketImportProgressRouter {
  send?: (input: SendImportProgressArgs) => Promise<{ delivered: boolean }>
}

export interface BuildRoutedSendImportProgressOptions {
  webRegistry: WebChatSenderRegistry
  /** Onboarding consolidation — `app:<user_id>` route (composer-filled holder). */
  appSocketRouter?: AppSocketImportProgressRouter
}

export interface SendImportProgressArgs {
  project_slug: string
  topic_id: string
  event: {
    type: 'import_progress'
    job_id: string
    status:
      | 'queued'
      | 'pass1-running'
      | 'pass2-running'
      | 'rate_limit_cooling_off'
      | 'rate_limit_paused'
      | 'completed'
      | 'failed'
      | 'cancelled'
    pass: 1 | 2
    pct: number
    /**
     * 2026-05-22 — pre-count fix follow-up to PR #264. Disambiguates
     * "stable denominator, render N/M" from "still streaming, render
     * count-only". Mirrors `ImportJob.chunks_total_known` end-to-end:
     * runner row → engine envelope → gateway route → server WS frame →
     * client bubble.
     */
    chunks_total_known: boolean
    body?: string
  }
}

export function buildRoutedSendImportProgress(
  opts: BuildRoutedSendImportProgressOptions,
): (input: SendImportProgressArgs) => Promise<{ delivered: boolean }> {
  return async ({ project_slug, topic_id, event }) => {
    if (topic_id.startsWith('web:')) {
      const ok = opts.webRegistry.send(topic_id, event)
      // Light-touch observability — no body content, just shape +
      // delivery boolean. Surfaces in journalctl as
      // `[chat-bridge] sendImportProgress event=route ...`.
      console.info(
        `[chat-bridge] sendImportProgress event=route channel=web project=${project_slug} topic=${topic_id} job=${event.job_id} status=${event.status} pass=${event.pass} pct=${event.pct.toFixed(2)} known=${event.chunks_total_known} delivered=${ok}`,
      )
      return { delivered: ok }
    }
    // Onboarding consolidation (2026-06-26) — app-socket route.
    if (topic_id.startsWith('app:') && opts.appSocketRouter?.send !== undefined) {
      return await opts.appSocketRouter.send({ project_slug, topic_id, event })
    }
    // Telegram + unknown channels: silent drop. The terminal-state
    // agent_message still lands on these channels via the regular
    // `sendButtonPrompt` path.
    if (!topic_id.startsWith('tg:') && !topic_id.startsWith('app:')) {
      console.warn(
        `[chat-bridge] sendImportProgress event=drop reason=unknown-channel project=${project_slug} topic=${topic_id} job=${event.job_id}`,
      )
    }
    return { delivered: false }
  }
}

export function buildRoutedSendButtonPrompt(
  opts: BuildRoutedSendButtonPromptOptions,
): SendButtonPromptFn {
  return async ({ project_slug, topic_id, prompt }) => {
    if (topic_id.startsWith('web:')) {
      const ok = opts.webRegistry.send(topic_id, renderButtonPromptForWeb(prompt))
      // T10 — observability for the welcome-emit chain. `delivered=false`
      // is the smoking-gun trace for the "engine emitted but registry had
      // no sender" silent-drop scenario (T10 bug class).
      //
      // T10 r4 (Codex P1, 2026-05-15) — body bytes MUST NOT enter logs.
      // The prior excerpt-style field leaked user-derived content because
      // re-emit branches (e.g. reEmitImportOfferedPaste) echo the user's
      // pasted text into `prompt.body`. Operators only need a content-
      // free fingerprint to correlate "is this the static fallback vs.
      // an LLM-rephrased body" across log lines; `body_sha8` (first 8
      // hex of sha256) is deterministic, content-free, and matches the
      // static spec's hash exactly when the fallback fires. `body_len`
      // is included as a cheap secondary signal (length variance also
      // distinguishes static vs LLM-rephrased without leaking bytes).
      const body_sha8 = createHash('sha256').update(prompt.body).digest('hex').slice(0, 8)
      console.info(
        `[chat-bridge] sendButtonPrompt event=route channel=web project=${project_slug} topic=${topic_id} prompt=${prompt.prompt_id} options=${prompt.options.length} delivered=${ok} body_len=${prompt.body.length} body_sha8=${body_sha8}`,
      )
      return { message_id: prompt.prompt_id, was_new: ok }
    }
    if (topic_id.startsWith('tg:') && opts.telegramSender !== undefined) {
      return await opts.telegramSender({ project_slug, topic_id, prompt })
    }
    // Onboarding consolidation (2026-06-26) — app-socket route. Onboarding
    // prompts addressed to `app:<user_id>` fan out over the unified
    // `/ws/app/chat` socket via the composer-supplied holder. The holder
    // translates the ButtonPrompt → the app-ws `agent_message` envelope (which
    // already carries options/prompt_id/allow_freeform/kind/upload_affordance).
    if (topic_id.startsWith('app:') && opts.appSocketRouter?.send !== undefined) {
      return await opts.appSocketRouter.send({ project_slug, topic_id, prompt })
    }
    // No sender for this topic_id. Surface explicitly so a misrouted
    // prefix (Telegram instance on a web-only deploy, or a future
    // app-socket prefix not wired here) doesn't silently drop the
    // emit. The engine treats was_new=false as "delivered, no need
    // to re-send" which is misleading when there's nothing on the
    // far side — this log line gives the operator a foothold.
    console.warn(
      `[chat-bridge] sendButtonPrompt event=drop reason=unknown-channel-or-no-sender project=${project_slug} topic=${topic_id} prompt=${prompt.prompt_id}`,
    )
    return { message_id: prompt.prompt_id, was_new: false }
  }
}

/**
 * P1.5 § 1.5.5 — slug-history lookup for the JWT shim. Caches positive
 * matches in an LRU; on rename the renameUrlSlug orchestrator pushes a
 * cache-invalidate so the entry refreshes from the DB on next access.
 */
export interface SlugHistoryShimStore {
  /**
   * Returns the row matching (`old_slug`, `internal_handle`) when
   * present and non-expired, else null.
   */
  lookup(input: {
    old_slug: string
    internal_handle: string
    now_ms: number
  }): Promise<{ expires_at_ms: number } | null>
}

export class InMemorySlugHistoryCache implements SlugHistoryShimStore {
  private readonly cache = new Map<string, { expires_at_ms: number; cached_at_ms: number }>()
  private readonly inner: SlugHistoryShimStore
  private readonly ttl_ms: number
  private readonly now: () => number

  constructor(input: {
    inner: SlugHistoryShimStore
    /** Pull-style TTL fallback if push-invalidate misses. Default 5min. */
    ttl_ms?: number
    now?: () => number
  }) {
    this.inner = input.inner
    this.ttl_ms = input.ttl_ms ?? 5 * 60 * 1000
    this.now = input.now ?? ((): number => Date.now())
  }

  async lookup(input: {
    old_slug: string
    internal_handle: string
    now_ms: number
  }): Promise<{ expires_at_ms: number } | null> {
    const key = `${input.old_slug}::${input.internal_handle}`
    const cached = this.cache.get(key)
    if (cached !== undefined && this.now() - cached.cached_at_ms < this.ttl_ms) {
      if (cached.expires_at_ms >= input.now_ms) {
        return { expires_at_ms: cached.expires_at_ms }
      }
      // Expired during cache validity — drop.
      this.cache.delete(key)
      return null
    }
    const fresh = await this.inner.lookup(input)
    if (fresh !== null) {
      this.cache.set(key, {
        expires_at_ms: fresh.expires_at_ms,
        cached_at_ms: this.now(),
      })
    }
    return fresh
  }

  /** Push-style invalidate fired by the rename orchestrator. */
  invalidateInternalHandle(internal_handle: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.endsWith(`::${internal_handle}`)) {
        this.cache.delete(key)
      }
    }
  }

  invalidateAll(): void {
    this.cache.clear()
  }
}

/**
 * Adapter from the registry's SlugHistoryStore (sync, returns expires_at
 * in unix-seconds) to the shim's async expires_at_ms shape.
 */
export function buildSlugHistoryShimFromRegistry(input: {
  /** Function returning a slug_history row (sync, like SlugHistoryStore.lookup). */
  lookup: (
    old_slug: string,
    internal_handle: string,
  ) => { expires_at: number } | undefined
}): SlugHistoryShimStore {
  return {
    async lookup({ old_slug, internal_handle, now_ms }) {
      const row = input.lookup(old_slug, internal_handle)
      if (row === undefined) return null
      const expires_at_ms = row.expires_at * 1000
      if (expires_at_ms < now_ms) return null
      return { expires_at_ms }
    },
  }
}
