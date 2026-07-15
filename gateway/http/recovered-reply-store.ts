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

import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'
import type { RecoveredReply } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('recovered-reply-store')

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
   *  delivered. This is an ATOMIC claim: a concurrent `takeUndelivered` for the
   *  same topic gets `[]`, so two simultaneous reconnect drains cannot both emit
   *  the same row (the reconnect drain claims up-front, then releases on failure). */
  takeUndelivered(topic_id: string, now: number): RecoveredReplyRow[]
  /** Release a claimed row back to pending (`delivered_at → null`) — the inverse of
   *  the `takeUndelivered` claim, used when an async send fails so the row is
   *  retried on the next reconnect rather than lost. No-op if the row is gone. */
  releaseClaim(topic_id: string, turn_id: string): void
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

  releaseClaim(topic_id: string, turn_id: string): void {
    const row = this.byTopic.get(topic_id)?.get(turn_id)
    if (row !== undefined) row.delivered_at = null
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

/** Awaitable app-ws delivery for a recovered reply: sends the rendered reply and
 *  returns the adapter's RESULT id — `app-ws:*` (delivered live), `app-ws:dropped:*`
 *  (persisted to chat_log, offline), `app-ws:lost:*` (captured nowhere), or
 *  `undefined` (no adapter bound). The sink/drain classify it via
 *  {@link assertRecoveredReplyPersisted}. */
export type RecoveredReplyDelivery = (topic_id: string, event: ChatOutbound) => Promise<string | undefined>

/**
 * Build the `onRecoveredReply` sink the gateway injects into the per-instance LLM
 * substrate (#106). Deduped on `turn_id`.
 *
 * CLAIM-FIRST (Codex): the reply is persisted AND marked delivered SYNCHRONOUSLY
 * up-front, so (a) a concurrent replay or a simultaneous reconnect drain can never
 * re-emit it, and (b) it is never silently lost. Then live delivery is attempted
 * ASYNCHRONOUSLY and its REAL adapter result is classified — the previous code
 * trusted a synchronous boolean, but production's fire-and-forget bridge returns
 * `true` unconditionally, hiding an `app-ws:lost:*` (append failed AND socket
 * offline). On a lost/failed delivery we RELEASE the claim back to pending so the
 * reconnect drain retries; a delivered/persisted result stays claimed (the durable
 * chat_log row + seq de-dupe make resume show it exactly once).
 *
 * `deliver` is supplied lazily because the app-ws adapter is constructed AFTER this
 * sink's build input — a holder resolved at call time avoids a forward reference.
 * When it resolves `undefined` (no adapter yet), the row simply stays pending for
 * the reconnect drain.
 */
export function makeRecoveredReplySink(deps: {
  deliver: () => RecoveredReplyDelivery | undefined
  store: RecoveredReplyStore
  now?: () => number
}): (reply: RecoveredReply) => void {
  const clock = deps.now ?? ((): number => Date.now())
  return (reply: RecoveredReply): void => {
    // Dedupe: a live-delivered + persisted race (or a duplicate replay) shows once.
    if (deps.store.seen(reply.topic_id, reply.turn_id)) return
    // CLAIM synchronously (persist + mark) BEFORE any await, so a concurrent drain
    // can't take the same row and the reply is never lost.
    const persist: Parameters<RecoveredReplyStore['persistUndelivered']>[0] = {
      topic_id: reply.topic_id,
      turn_id: reply.turn_id,
      text: reply.text,
      now: clock(),
    }
    if (reply.instance_slug !== undefined) persist.project_slug = reply.instance_slug
    deps.store.persistUndelivered(persist)
    deps.store.markDelivered(reply.topic_id, reply.turn_id, clock())

    const send = deps.deliver()
    if (send === undefined) {
      // No adapter bound → release the claim so the reconnect drain delivers it.
      deps.store.releaseClaim(reply.topic_id, reply.turn_id)
      return
    }
    fireAndForget(
      'recovered-reply.live',
      // RAW promise: it REJECTS when the reply was captured nowhere —
      // `assertRecoveredReplyPersisted` throws on an `app-ws:lost:*` / `undefined`
      // result, and the send itself may reject. A delivered / dropped-persisted
      // result resolves → the row stays claimed.
      (async (): Promise<void> => {
        const id = await send(reply.topic_id, renderRecoveredReply(reply.text, reply.topic_id))
        assertRecoveredReplyPersisted(id)
      })(),
      // onError: captured nowhere → RELEASE the claim so the reconnect drain
      // retries rather than dropping the reply.
      () => deps.store.releaseClaim(reply.topic_id, reply.turn_id),
    )
  }
}

/**
 * Classify an app-ws adapter send RESULT for the recovered-reply drain (Codex).
 *
 * THE HAZARD: `AppWsAdapter.send` appends the reply to the durable `chat_log`
 * BEFORE attempting live socket delivery. So a real message id OR an
 * `app-ws:dropped:*` marker (persisted, but socket offline at send time) BOTH mean
 * the reply is durably captured; the client's history resume replays it exactly
 * once. Treating those as "retry" would re-run `adapter.send` on the next reconnect
 * and APPEND THE SAME REPLY AGAIN (a second durable row + a stale replay) — a
 * double-show. So they count as DELIVERED and must NOT be retried.
 *
 * A row is only RETRIED (throw → release claim) when the reply was captured
 * NOWHERE: `undefined` (the adapter was not bound → nothing ran) or an
 * `app-ws:lost:*` marker (a wired chat_log's append FAILED and no socket received
 * it — Codex's combined-failure boundary). Both mean neither persisted nor
 * delivered, so the row must stay pending for the next reconnect.
 */
export function assertRecoveredReplyPersisted(id: string | undefined): void {
  if (id === undefined || id.startsWith('app-ws:lost:')) {
    throw new Error(`recovered-reply: not captured (${id ?? 'no-adapter'}) — retry next reconnect`)
  }
}

/**
 * Drain a reconnecting topic's undelivered recovered replies — re-emit each once
 * (deduped on `turn_id`). Called from the reconnect path, alongside
 * `reEmitActiveSeedPromptIfAny`. Returns the count re-emitted.
 *
 * CONCURRENCY (Codex): every socket open starts its OWN fire-and-forget drain, and
 * `send` MAY be async (the app-ws adapter). So the drain CLAIMS the rows atomically
 * up-front via `takeUndelivered` (a synchronous mark-delivered with NO await inside
 * it) — a second simultaneous drain then gets `[]` and cannot re-emit the same row.
 * Only on a FAILED send do we `releaseClaim` the row back to pending, so a
 * rejected/dropped delivery is retried on the next reconnect rather than lost or
 * double-shown.
 */
export async function drainRecoveredReplies(deps: {
  topic_id: string
  store: RecoveredReplyStore
  /**
   * Deliver one recovered reply. MAY be async: a sender that fans through a
   * fire-and-forget path (e.g. the app-ws adapter) MUST return a promise that
   * resolves ONLY when delivery is confirmed and REJECTS on a failed/dropped send
   * — otherwise a rejected delivery would be silently dropped and the reply lost
   * (Codex). The drain `await`s it and releases the claim on rejection.
   */
  send: (event: ChatOutbound) => void | Promise<void>
  now?: () => number
  log_tag?: string
}): Promise<number> {
  const clock = deps.now ?? ((): number => Date.now())
  // ATOMIC claim (sync, no await): mark every pending row delivered up-front so a
  // concurrent drain sees none. We RELEASE a row back to pending only if its send
  // fails — claim-first + release-on-failure is what makes "shown once" hold across
  // simultaneous reconnects AND still survive a failed delivery.
  const rows = deps.store.takeUndelivered(deps.topic_id, clock())
  let emitted = 0
  for (const row of rows) {
    try {
      await deps.send(renderRecoveredReply(row.text, deps.topic_id))
      emitted += 1
    } catch (err) {
      deps.store.releaseClaim(deps.topic_id, row.turn_id)
      if (deps.log_tag !== undefined) {
        moduleLog.warn('drain_recovered_replies_fail', {
          log_tag: deps.log_tag,
          topic: deps.topic_id,
          turn: row.turn_id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
  return emitted
}
