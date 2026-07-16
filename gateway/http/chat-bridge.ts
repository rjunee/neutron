/**
 * @neutronai/gateway/http — chat-bridge cluster barrel + the per-session
 * escalation-project registry and JWT owner-slug lookup adapter.
 *
 * K11b0 (2026-07) — the legacy `/ws/chat` `ChatBridge` factory that this
 * module once exported was EXCISED. That socket was fully dead in
 * production (onboarding + chat are unified on `/ws/app/chat`); the bridge
 * `.validateStartToken/startSession/handleInbound` surface had zero prod
 * reachability while the module retained its production-live helpers.
 *
 * D3 (2026-07) — the retained production-live helpers were split into
 * cohesive sibling leaves (pure moves, no behavior change). This module is
 * now the barrel: it re-exports each leaf so every existing
 * `import ... from '.../chat-bridge.ts'` caller keeps resolving unchanged,
 * and it still HOMES the two symbols that have no dedicated leaf —
 * `WebChatSessionProjectRegistry` (ISSUE #41 escalation project pin) and the
 * `OwnerRegistryLookup` JWT owner-slug adapter. New/repointed callers should
 * import the split symbols directly from their leaf modules:
 *
 *   - `./chat-sender-registry.ts` — `WebChatSenderRegistry`,
 *     `InMemoryWebChatSenderRegistry`, `LiveAgentTurnRequest/Runner`.
 *   - `./web-topic-id.ts` — `webTopicId`.
 *   - `./render-outbound.ts` — `renderButtonPromptForWeb`.
 *   - `./routed-senders.ts` — `buildRoutedSendButtonPrompt`,
 *     `buildRoutedSendImportProgress` + their option/arg/router types.
 *   - `./slug-history-shim.ts` — `SlugHistoryShimStore`,
 *     `InMemorySlugHistoryCache`, `buildSlugHistoryShimFromRegistry`.
 */

// K11a1 (2026-07) — `WebChatSenderRegistry` + `InMemoryWebChatSenderRegistry`
// live in the sibling leaf `./chat-sender-registry.ts` (pure type/impl
// extraction, no behavior change). Re-exported here so every existing
// `import ... from '.../chat-bridge.ts'` caller (the test suite + external
// callers) keeps resolving unchanged; new/repointed callers import
// directly from `./chat-sender-registry.ts`.
export type { WebChatSenderRegistry } from './chat-sender-registry.ts'
export { InMemoryWebChatSenderRegistry } from './chat-sender-registry.ts'

// K11a1 (2026-07) — `LiveAgentTurnRequest` + `LiveAgentTurnRunner` moved to
// the sibling leaf `./chat-sender-registry.ts` (pure type extraction, no
// behavior change). Re-exported for the same unchanged-import reason.
export type {
  LiveAgentTurnRequest,
  LiveAgentTurnRunner,
} from './chat-sender-registry.ts'

// `webTopicId` now lives in the dependency-free leaf `./web-topic-id.ts`
// (R5 / audit P1-2 — broke the chat-bridge ↔ build-onboarding-handoff
// cycle). Re-exported so existing `import { webTopicId } from
// '.../chat-bridge.ts'` callers are unchanged.
export { webTopicId } from './web-topic-id.ts'

// D3 (2026-07) — the web button-prompt renderer now lives in the sibling
// leaf `./render-outbound.ts`. Re-exported for unchanged imports.
export { renderButtonPromptForWeb } from './render-outbound.ts'

// D3 (2026-07) — the channel-agnostic routed onboarding senders now live in
// the sibling leaf `./routed-senders.ts`. Re-exported for unchanged imports.
export {
  buildRoutedSendButtonPrompt,
  buildRoutedSendImportProgress,
} from './routed-senders.ts'
export type {
  AppSocketButtonPromptRouter,
  BuildRoutedSendButtonPromptOptions,
  AppSocketImportProgressRouter,
  BuildRoutedSendImportProgressOptions,
  SendImportProgressArgs,
} from './routed-senders.ts'

// D3 (2026-07) — the slug-history shim + LRU cache now live in the sibling
// leaf `./slug-history-shim.ts`. Re-exported for unchanged imports.
export {
  InMemorySlugHistoryCache,
  buildSlugHistoryShimFromRegistry,
} from './slug-history-shim.ts'
export type { SlugHistoryShimStore } from './slug-history-shim.ts'

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

/**
 * Narrow registry interface used by the JWT validator (Change 3 — accept
 * a new-slug JWT against a gateway whose `expected_project_slug` is still
 * the OLD slug, by looking up the registry's CURRENT `url_slug` for the
 * frozen `owner_handle` and accepting iff the claim matches it).
 *
 * Implemented by `buildOwnerRegistryLookupFromRegistry(ownersRegistry)`
 * against a `OwnersRegistry`; tests can pass an in-memory stub.
 */
export interface OwnerRegistryLookup {
  /**
   * Returns the CURRENT `url_slug` for the given `owner_handle`, or
   * null when the instance row is missing. Hot-path: every JWT-mismatch
   * connect runs this once; backing store is a single indexed SQLite
   * SELECT.
   */
  getCurrentUrlSlugByOwnerHandle(owner_handle: string): string | null
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
 * shape; tests can pass an in-memory `{ getByOwnerHandle: ... }`
 * stub.
 */
export function buildOwnerRegistryLookupFromRegistry(registry: {
  getByOwnerHandle(
    owner_handle: string,
  ): { url_slug: string } | undefined
}): OwnerRegistryLookup {
  return {
    getCurrentUrlSlugByOwnerHandle(owner_handle: string): string | null {
      const row = registry.getByOwnerHandle(owner_handle)
      if (row === undefined) return null
      return row.url_slug
    },
  }
}
