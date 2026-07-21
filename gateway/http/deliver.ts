/**
 * @neutronai/gateway/http — the ONE out-of-turn delivery seam (F5).
 *
 * Before F5 every TIMER/CRON producer that posts a message to the owner
 * OUTSIDE a request/response turn (fired reminders, the proactive morning
 * brief, the substrate notice-family bubbles) each took its OWN
 * `WebChatSenderRegistry` and did its own persist-then-push. That is the
 * "pick the wrong registry" hazard the PR #105 deliver-to-nobody bug lived in
 * (a reminder delivered to the dead `web:` registry while the only client was
 * bound to `app:`), and it was worked around per-producer (the composer handed
 * each one a bespoke app-ws-forwarding shim).
 *
 * `deliver(topic, envelope)` folds all three onto ONE seam so a producer can
 * no longer name — or mis-pick — a registry. It owns:
 *   1. DURABLE-ROW-FIRST — persist the durable history row BEFORE the
 *      best-effort live push, so a push failure never costs the durable record
 *      (persist-before-send). The durable primitive is chosen by
 *      `envelope.durability` (a resolvable reply row vs. an inert history turn
 *      vs. no row for a transient pill).
 *   2. PUSH-BEST-EFFORT, ROUTED BY GRAMMAR — resolve the live sender from the
 *      topic grammar via {@link parseAnyTopicId} (`app:` → the app-ws session
 *      registry; `web:` → the web chat registry) and swallow its throw. The
 *      out-of-turn producers are durable-first best-effort: the durable row is
 *      the guarantee, the live push is the nicety.
 *   3. EVICTION POLICY (unchanged, per-registry) — deliver only PICKS which
 *      registry a topic routes to; each registry keeps its own LOAD-BEARING
 *      failure semantics untouched. The app-ws session registry EVICTS a
 *      throwing (closed-socket) sender and CONTINUES the multi-device fan-out;
 *      the web chat registry is single-sender. deliver never converts one into
 *      the other. (The onboarding engine's `sendButtonPrompt` web path — where a
 *      throw MUST propagate so a durable row stays unresolved for reconnect
 *      re-emit — is REQUEST-driven and deliberately NOT routed here; it keeps
 *      its propagate semantics in `routed-senders.ts`.)
 *
 * The composer wires deliver ONCE at the composition root (the sole place that
 * names the concrete registries) and injects it into every producer.
 */

import { randomUUID } from 'node:crypto'

import { buildButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import type { ButtonOption } from '@neutronai/channels/button-primitive.ts'
import type { ButtonStore } from '@neutronai/channels/button-store.ts'
import { parseAnyTopicId } from '@neutronai/channels/topic-id.ts'
import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('deliver')

const LOG_TAG = '[deliver]'

/** Reply rows are HISTORY, not pending questions — never expire them out of
 *  hydration. Ten years ≈ never (mirrors build-live-agent-turn's TTL). */
const REPLY_ROW_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1_000

/**
 * How the durable record is written before the best-effort live push:
 *   - `reply`  — a resolvable zero-option `allow_freeform` reply row
 *     (`ButtonStore.emit`), the shape a fired reminder uses so the owner can
 *     reply to it in chat.
 *   - `inert`  — an already-resolved agent history turn
 *     (`ButtonStore.persistInertAgentTurn`): pure history that never becomes the
 *     topic's active prompt the next user message attaches to (the morning
 *     brief / nudge shape).
 *   - `none`   — no durable row; a TRANSIENT live-only `system_notice` pill
 *     (the substrate notice-family bubbles). `delivered_live` reflects the real
 *     awaited fan-out result.
 */
export type DeliveryDurability = 'reply' | 'inert' | 'none'

export interface DeliveryEnvelope {
  body: string
  durability: DeliveryDurability
  /**
   * Plan task 8 — optional tappable options carried on a `durability: 'reply'`
   * post (the ritual-approval prompt: an out-of-turn, ButtonStore-persisted
   * choice the owner taps to approve/deny). Honored ONLY on `'reply'` (the sole
   * durability that builds a resolvable ButtonPrompt); ignored on `'inert'` /
   * `'none'`. Absent ⇒ byte-identical to the pre-task-8 zero-option reply.
   */
  options?: ButtonOption[]
  /** Idempotency key threaded onto the reply prompt (collapses re-emits). */
  idempotency_key?: string
  /** Open-shape prompt-level metadata bag threaded onto the reply prompt. */
  metadata?: Record<string, unknown>
}

export interface DeliveryResult {
  /** The durable row id, or `null` when `durability: 'none'` or persist failed. */
  prompt_id: string | null
  /** True when the durable record was written (always true for `durability: 'none'`). */
  persisted: boolean
  /** True when a live sender received the push (false when offline / no target). */
  delivered_live: boolean
}

export type Deliver = (topic_id: string, envelope: DeliveryEnvelope) => Promise<DeliveryResult>

/**
 * Per-grammar best-effort live senders. Each is a concrete registry's `send`:
 *   - `app` — the app-ws session registry fan-out (multi-device; EVICTS a
 *     throwing sender and CONTINUES). In Open this is the steady-state agent
 *     reply path (`buildAppWsSendReply` → the router-registered `AppWsAdapter`),
 *     so an out-of-turn post lands exactly like a live reply.
 *   - `web` — the web chat registry (single sender). Effectively dead in Open
 *     (no socket registers on it); present for the Managed / web deploy.
 * deliver routes by {@link parseAnyTopicId} and swallows either's throw. Absent
 * targets (or a `tg:` / unrecognised grammar) route to no push — a drop, never
 * a throw.
 */
export interface DeliverPushTargets {
  // MAY be async: the app target awaits the app-ws adapter and classifies its real
  // result marker (`app-ws:<id>` delivered vs `app-ws:dropped:`/`app-ws:lost:` not)
  // so `delivered_live` reflects the TRUE fan-out, not a stale registered-sender
  // snapshot (O6: never trust a pre-send sync boolean for a fire-and-forget transport).
  app?: (topic_id: string, event: ChatOutbound) => boolean | Promise<boolean>
  web?: (topic_id: string, event: ChatOutbound) => boolean | Promise<boolean>
}

export interface CreateDeliverInput {
  buttonStore: ButtonStore
  push: DeliverPushTargets
  log?: (msg: string) => void
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Build the {@link Deliver} seam every out-of-turn producer posts through.
 */
export function createDeliver(input: CreateDeliverInput): Deliver {
  const { buttonStore, push } = input
  const log = input.log ?? ((msg: string): void => moduleLog.warn(msg))

  /**
   * Route the live push by topic grammar and swallow the sender's throw
   * (durable-first best-effort). Returns true iff a live sender received it.
   */
  const routedPush = async (topic_id: string, event: ChatOutbound): Promise<boolean> => {
    const parsed = parseAnyTopicId(topic_id)
    const sender =
      parsed?.kind === 'app' ? push.app : parsed?.kind === 'web' ? push.web : undefined
    // `tg:` / unrecognised grammar / no registered target → drop (no live
    // push). The durable row — when there is one — is the guarantee.
    if (sender === undefined) return false
    try {
      return await sender(topic_id, event)
    } catch (err) {
      // The app-ws registry evicts a throwing sender internally and never
      // throws OUT; the web registry can propagate a closed-socket throw. Either
      // way an out-of-turn post swallows it — the durable row already recovers
      // the owner on the next hydration.
      log(`${LOG_TAG} live push failed (durable row is the guarantee) topic=${topic_id}: ${errMsg(err)}`)
      return false
    }
  }

  return async (topic_id, envelope): Promise<DeliveryResult> => {
    const { body, durability } = envelope
    // Plan task 8 — options/idempotency/metadata ride ONLY on a 'reply' post; on
    // every other durability they are ignored (byte-identical legacy behavior).
    const replyOptions: ButtonOption[] =
      durability === 'reply' && envelope.options !== undefined ? envelope.options : []

    // durability 'none' — a TRANSIENT live-only system_notice pill: no durable
    // row; AWAIT the routed push so delivered_live is the real fan-out result, and
    // never let a push failure surface (routedPush swallows throws).
    if (durability === 'none') {
      const delivered = await routedPush(topic_id, {
        type: 'agent_message',
        body,
        topic_id,
        // Live-only pill — the app-ws adapter skips the durable chat_log row, so
        // a reload can't re-hydrate a stale state notice as a stray bubble.
        system_notice: true,
      })
      return { prompt_id: null, persisted: true, delivered_live: delivered }
    }

    // DURABLE-ROW-FIRST — persist BEFORE the best-effort live push.
    let prompt_id: string
    try {
      if (durability === 'reply') {
        const prompt = buildButtonPrompt({
          body,
          options: replyOptions,
          allow_freeform: true,
          expires_in_ms: REPLY_ROW_TTL_MS,
          uuid: randomUUID,
          ...(envelope.idempotency_key !== undefined
            ? { idempotency_key: envelope.idempotency_key }
            : {}),
          ...(envelope.metadata !== undefined ? { metadata: envelope.metadata } : {}),
        })
        const emitted = await buttonStore.emit(prompt, { topic_id })
        prompt_id = emitted.prompt_id
      } else {
        const persisted = await buttonStore.persistInertAgentTurn({ topic_id, body })
        prompt_id = persisted.prompt_id
      }
    } catch (err) {
      log(`${LOG_TAG} durable persist failed topic=${topic_id} durability=${durability}: ${errMsg(err)}`)
      // `inert` SURFACES the throw so the proactive brief/nudge treats it as a
      // delivery failure and retries (no day/dedupe ledger write). `reply`
      // SWALLOWS it: without a durable row there is nothing to recover, and a
      // live-only push to a topic with no open socket would silently drop — so
      // the reminder reports not-delivered and skips the push.
      if (durability === 'inert') throw err instanceof Error ? err : new Error(String(err))
      return { prompt_id: null, persisted: false, delivered_live: false }
    }

    const delivered = await routedPush(topic_id, {
      type: 'agent_message',
      body,
      topic_id,
      // Plan task 8 — the SAME options the durable reply row carries, so a live
      // client renders the ritual-approval buttons immediately (empty ⇒ the
      // legacy zero-option push, byte-identical).
      options: replyOptions,
      allow_freeform: true,
      prompt_id,
    })
    return { prompt_id, persisted: true, delivered_live: delivered }
  }
}
