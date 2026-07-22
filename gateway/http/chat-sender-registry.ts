/**
 * @neutronai/gateway/http — web chat sender registry + live-agent turn shapes.
 *
 * K11a1 (2026-07) — extracted out of `chat-bridge.ts` as a pure type/impl
 * move (no behavior change). `chat-bridge.ts` re-exports these 4 symbols so
 * existing internal + external `import ... from '.../chat-bridge.ts'`
 * callers keep resolving unchanged; new/repointed callers should import
 * directly from this sibling leaf module instead.
 */

import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'

/**
 * Per-session sender registry. Production wires the in-memory variant
 * (process-local; per-instance gateway is a single Bun process). A future
 * cross-process variant (Redis pub/sub etc.) can implement the same
 * interface — for now the per-instance boundary keeps the in-memory map
 * sufficient for the M2 cohort scale (single-digit concurrent web
 * sessions per instance).
 */
export interface WebChatSenderRegistry {
  /** Register the per-session send callback for a topic_id. Replaces any
   *  existing registration so reconnect on the same topic_id wins. */
  register(topic_id: string, send: (event: ChatOutbound) => void): void
  /**
   * Identity-aware unregister: only delete the entry when the currently
   * registered sender is reference-equal to `send`. This prevents a
   * losing-tap's catch path or an old socket's close-fire from
   * accidentally deleting a newer registration's sender (Argus
   * Sprint 18 r1 BLOCKING: reconnect / concurrent-tap race).
   */
  unregister(topic_id: string, send: (event: ChatOutbound) => void): void
  /** Returns true when a sender was found and called; false otherwise. */
  send(topic_id: string, event: ChatOutbound): boolean
  /**
   * Trident 6 (2026-05-13) — non-destructive deliverability precheck.
   * Used by the resume-on-reconnect cron to skip a row when the
   * instance's WS is currently offline (no live sender for the topic_id).
   * Returns true iff `send(topic_id, ...)` would deliver right now.
   */
  has(topic_id: string): boolean
}

export class InMemoryWebChatSenderRegistry implements WebChatSenderRegistry {
  private readonly senders = new Map<string, (event: ChatOutbound) => void>()

  register(topic_id: string, send: (event: ChatOutbound) => void): void {
    this.senders.set(topic_id, send)
  }

  unregister(topic_id: string, send: (event: ChatOutbound) => void): void {
    // Compare-and-delete: only erase the entry when it still points at
    // the sender being torn down. A no-op when a newer register has
    // already replaced the entry — that newer socket gets to keep its
    // routing.
    if (this.senders.get(topic_id) === send) {
      this.senders.delete(topic_id)
    }
  }

  send(topic_id: string, event: ChatOutbound): boolean {
    const sender = this.senders.get(topic_id)
    if (sender === undefined) return false
    // T10 — sender throws (e.g. landing-server's per-socket lambda on a
    // closed WS) propagate UP through `sendButtonPrompt` so every emit
    // path's existing try/catch converts to `InterviewError('send_failed')`
    // and the bridge tears down with a 4001. Codex review r1 P1 rationale:
    // catching here would silently downgrade closed-socket failures to
    // `was_new=false` for ALL prompt paths (reuseActivePrompt,
    // emitResumePrompt, advance-time phase emits), but only
    // `InterviewEngine.start()` inspects `was_new` to gate `markDelivered`.
    // Throwing instead lets the existing engine-side error handling work
    // uniformly: every sendButtonPrompt call site is already wrapped in
    // the InterviewError shape, the row's `delivered_at` stays NULL,
    // and reconnect re-emit recovers the user.
    sender(event)
    return true
  }

  has(topic_id: string): boolean {
    return this.senders.has(topic_id)
  }
}

/**
 * ISSUES #204 — one live-agent chat turn, as the bridge sees it. The
 * runner (`gateway/wiring/build-live-agent-turn.ts`) loads the
 * owner persona, dispatches the warm per-(instance, topic) CC session over
 * the substrate, streams the reply onto `send`, and persists it as a
 * `button_prompts` row. The bridge type is structural so the http layer
 * never takes a static wiring import edge.
 */
export interface LiveAgentTurnRequest {
  project_slug: string
  user_id: string
  /** Wire topic the turn belongs to (`web:<uid>` or `web:<uid>:<project>`). */
  topic_id: string
  /** Set for project topics — parsed from the `web:<uid>:<project>` id. */
  project_id?: string
  user_text: string
  /**
   * M2 modality threading — the attachment upload URLs the client sent with
   * this turn (`/api/app/upload/<user>/<hash>.<ext>`), as read from the inbound
   * `adapter_metadata.attachments`. The turn runner resolves each to its local
   * blob path and injects a `<user_attachments>` prompt fragment so the agent
   * can `Read` them (the CC REPL renders images AND PDFs natively). Omitted /
   * empty on a text-only turn. Prompt-only — never mutates `user_text`.
   */
  attachments?: ReadonlyArray<string>
  send: (event: ChatOutbound) => void
  observed_at: number
  /**
   * Path 1 onboarding auto-start: a synthetic system-origin turn that seeds
   * the FIRST onboarding question on connect (composer `on_session_open`).
   * The `user_text` is a system instruction, not a real user message — the
   * runner composes + dispatches it normally but does NOT persist it as a user
   * bubble and does NOT run the post-turn scribe over it (nothing to extract).
   */
  seed_turn?: boolean
}

export type LiveAgentTurnRunner = (input: LiveAgentTurnRequest) => Promise<unknown>
