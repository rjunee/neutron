/**
 * recovered-reply-store.ts — replay-redelivery sink for the persistent-REPL
 * substrate (substrate-lift S3, closes ISSUE #106).
 *
 * THE GAP: when a warm REPL dies mid-turn, S2's pending-respawns queue replays
 * the dropped inbound after the session resumes so conversation state advances —
 * but the recovered assistant reply landed in the replay channel, never reaching
 * the user, whose socket a crash/restart disconnected.
 *
 * THE FIX (no new outbox subsystem, no new cron, no new reconnect path): the
 * substrate's replay path captures the recovered reply and hands it to the
 * `onRecoveredReply` sink the gateway injects (the runtime layer never imports
 * the gateway delivery layer — this module IS the injected seam). The sink:
 *
 *   • DELIVER NOW if the user is online — `WebChatSenderRegistry.has(topic_id)`
 *     is the same non-destructive deliverability precheck the resume-on-reconnect
 *     cron uses; `send(topic_id, ...)` reaches the live socket.
 *   • PERSIST as an undelivered row (`delivered_at = NULL`) otherwise — mirroring
 *     the chat-bridge `delivered_at`-NULL → reconnect-re-emit pattern. The EXISTING
 *     `startSession` reconnect entry point drains it via `drainRecoveredReplies`
 *     (one more producer on the existing reconnect machine — not a parallel one).
 *
 * IDEMPOTENCY: every operation dedupes on `turn_id` (the §3 `<incarnation>:<seq>`),
 * so a reply that is delivered live AND persisted (a reconnect race) is shown the
 * user exactly once. This is why §3's stateless turn-id is the right key — the
 * three issues compose: #104 routes the key, #107 identifies the turn, #106
 * delivers it.
 *
 * STORE SCOPE NOTE (documented divergence from the brief's literal wording): the
 * brief assumed a generic `delivered_at`-NULL text-reply store to add a producer
 * to. The only such store in the gateway (`button_prompts`) is button-prompt-
 * shaped (`kind: 'buttons' | 'image-gallery'`, options, a UNIQUE idempotency
 * index, rendered via `renderButtonPromptForWeb`) and cannot faithfully carry a
 * free-text assistant reply. So this module holds the undelivered recovered
 * replies in a small in-process store keyed on `(topic_id, turn_id)`, drained by
 * the EXISTING reconnect entry point.
 *
 * DURABILITY (accepted residual — Codex r1 P2). The user's MESSAGE is durably
 * recovered: the dropped inbound rides the disk-backed pending-respawns queue and
 * is re-processed at the next watchdog tick / boot-drain, so conversation state +
 * the `claude` transcript always advance. Re-PUSHING the recovered reply is
 * best-effort: this undelivered buffer is in-process, and the pending-respawns
 * entry is removed (single-shot) BEFORE replay, so a gateway restart in the narrow
 * window AFTER replay persists an offline reply here but BEFORE the user reconnects
 * loses the proactive re-push (the next turn still carries the recovered context).
 * A durable recovered-reply table would close this, but the brief scoped out a new
 * outbox subsystem; this is the deliberate trade. Online delivery + same-process
 * reconnect (the common case) are unaffected.
 */

import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'
import type { RecoveredReply } from '@neutronai/runtime/adapters/claude-code/index.ts'
import type { WebChatSenderRegistry } from './chat-sender-registry.ts'

/** An undelivered (or delivered) recovered-reply row, keyed `(topic_id, turn_id)`. */
export interface RecoveredReplyRow {
  topic_id: string
  turn_id: string
  text: string
  project_slug?: string
  created_at: number
  /** Epoch-ms when re-delivered, or null while still pending (the `delivered_at`-
   *  NULL → reconnect-re-emit invariant). */
  delivered_at: number | null
}

export interface RecoveredReplyStore {
  /** Persist an undelivered recovered reply (`delivered_at = null`). Idempotent on
   *  `(topic_id, turn_id)` — a second persist for the same turn is a no-op. */
  persistUndelivered(input: {
    topic_id: string
    turn_id: string
    text: string
    project_slug?: string
    now: number
  }): void
  /** Record `(topic_id, turn_id)` as delivered (live send) so a later drain — or a
   *  duplicate sink call — dedupes against it. */
  markDelivered(topic_id: string, turn_id: string, now: number): void
  /** True iff `(topic_id, turn_id)` was already persisted or delivered. The dedupe
   *  guard. */
  seen(topic_id: string, turn_id: string): boolean
  /** Read every still-undelivered row for a topic (oldest first) WITHOUT marking
   *  them — the caller marks each delivered only after its send succeeds, so a row
   *  whose send throws stays pending for the next reconnect (Codex r1 P2). */
  peekUndelivered(topic_id: string): RecoveredReplyRow[]
  /** Take every still-undelivered row for a topic (oldest first), marking each
   *  delivered. Retained for callers that deliver atomically; the reconnect drain
   *  uses `peekUndelivered` + per-row `markDelivered` instead. */
  takeUndelivered(topic_id: string, now: number): RecoveredReplyRow[]
}

/** In-process `RecoveredReplyStore`. Rows live in a `topic_id → (turn_id → row)`
 *  map; delivered rows are RETAINED (with `delivered_at` set) so `seen` dedupes a
 *  live-delivered + reconnect-drained race. See the module header for why an
 *  in-process store is correct here (disk-backed pending-respawns queue is the
 *  primary durability). */
export class InMemoryRecoveredReplyStore implements RecoveredReplyStore {
  private readonly byTopic = new Map<string, Map<string, RecoveredReplyRow>>()

  private topic(topic_id: string): Map<string, RecoveredReplyRow> {
    let m = this.byTopic.get(topic_id)
    if (m === undefined) {
      m = new Map<string, RecoveredReplyRow>()
      this.byTopic.set(topic_id, m)
    }
    return m
  }

  persistUndelivered(input: {
    topic_id: string
    turn_id: string
    text: string
    project_slug?: string
    now: number
  }): void {
    const m = this.topic(input.topic_id)
    if (m.has(input.turn_id)) return // idempotent on (topic_id, turn_id)
    const row: RecoveredReplyRow = {
      topic_id: input.topic_id,
      turn_id: input.turn_id,
      text: input.text,
      created_at: input.now,
      delivered_at: null,
    }
    if (input.project_slug !== undefined) row.project_slug = input.project_slug
    m.set(input.turn_id, row)
  }

  markDelivered(topic_id: string, turn_id: string, now: number): void {
    const m = this.topic(topic_id)
    const existing = m.get(turn_id)
    if (existing !== undefined) {
      if (existing.delivered_at === null) existing.delivered_at = now
      return
    }
    // Record a delivered-only marker so `seen` dedupes a later persist/drain.
    m.set(turn_id, {
      topic_id,
      turn_id,
      text: '',
      created_at: now,
      delivered_at: now,
    })
  }

  seen(topic_id: string, turn_id: string): boolean {
    return this.byTopic.get(topic_id)?.has(turn_id) ?? false
  }

  peekUndelivered(topic_id: string): RecoveredReplyRow[] {
    const m = this.byTopic.get(topic_id)
    if (m === undefined) return []
    return [...m.values()]
      .filter((r) => r.delivered_at === null)
      .sort((a, b) => a.created_at - b.created_at)
  }

  takeUndelivered(topic_id: string, now: number): RecoveredReplyRow[] {
    const pending = this.peekUndelivered(topic_id)
    for (const r of pending) r.delivered_at = now
    return pending
  }
}

/** Render a recovered reply as the plain assistant-message wire envelope (no
 *  buttons) — what an ordinary completed conversational turn ships. P1a: stamp
 *  the owning `topic_id` so the client's per-topic drop-guard routes the
 *  recovered reply to ITS topic, not whatever is focused on reconnect (a
 *  recovered reply is replayed exactly when the user may be on another topic —
 *  the canonical misrouting case). */
export function renderRecoveredReply(text: string, topic_id: string): ChatOutbound {
  return { type: 'agent_message', body: text, topic_id }
}

/**
 * Build the `onRecoveredReply` sink the gateway injects into the per-instance LLM
 * substrate (#106). Deliver-or-persist, deduped on `turn_id`.
 *
 * `registry` is supplied lazily (`() => WebChatSenderRegistry | undefined`)
 * because the gateway's shared sender registry is constructed AFTER the per-instance
 * LLM substrate's build input — a holder resolved at call time avoids a forward
 * reference without reordering instance setup.
 */
export function makeRecoveredReplySink(deps: {
  registry: () => WebChatSenderRegistry | undefined
  store: RecoveredReplyStore
  now?: () => number
}): (reply: RecoveredReply) => void {
  const clock = deps.now ?? ((): number => Date.now())
  return (reply: RecoveredReply): void => {
    const t = clock()
    // Dedupe: a live-delivered + persisted race (or a duplicate replay) shows once.
    if (deps.store.seen(reply.topic_id, reply.turn_id)) return
    const registry = deps.registry()
    if (registry !== undefined && registry.has(reply.topic_id)) {
      try {
        const delivered = registry.send(reply.topic_id, renderRecoveredReply(reply.text, reply.topic_id))
        if (delivered) {
          deps.store.markDelivered(reply.topic_id, reply.turn_id, t)
          return
        }
      } catch {
        // The registry propagates a closed-socket send throw, and the socket can
        // close between `has()` and `send()`. Fall through to PERSIST so the reply
        // is recovered on the next reconnect rather than lost (Codex r1 P2).
      }
    }
    const persist: Parameters<RecoveredReplyStore['persistUndelivered']>[0] = {
      topic_id: reply.topic_id,
      turn_id: reply.turn_id,
      text: reply.text,
      now: t,
    }
    if (reply.instance_slug !== undefined) persist.project_slug = reply.instance_slug
    deps.store.persistUndelivered(persist)
  }
}

/**
 * Drain a reconnecting topic's undelivered recovered replies — re-emit each once
 * (deduped on `turn_id` by the store marking them delivered). Called from the
 * EXISTING `startSession` reconnect path, alongside `reEmitActiveSeedPromptIfAny`.
 * Returns the count re-emitted. Best-effort: a `send` throw on one row does not
 * block the rest.
 */
export function drainRecoveredReplies(deps: {
  topic_id: string
  store: RecoveredReplyStore
  send: (event: ChatOutbound) => void
  now?: () => number
  log_tag?: string
}): number {
  const clock = deps.now ?? ((): number => Date.now())
  // Peek (do NOT pre-mark) → send → mark delivered ONLY on success, so a row whose
  // send throws stays pending and a later reconnect retries it (Codex r1 P2).
  const rows = deps.store.peekUndelivered(deps.topic_id)
  let emitted = 0
  for (const row of rows) {
    try {
      deps.send(renderRecoveredReply(row.text, deps.topic_id))
      deps.store.markDelivered(deps.topic_id, row.turn_id, clock())
      emitted += 1
    } catch (err) {
      if (deps.log_tag !== undefined) {
        console.warn(
          `${deps.log_tag} drainRecoveredReplies event=fail topic=${deps.topic_id} turn=${row.turn_id} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  }
  return emitted
}
