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
 *
 * ── 2026-08-09 — THE NATIVE NOTIFICATION IS A FOURTH THING DELIVER OWNS ──────
 *
 * The owner's report was about a ritual: his lock screen said `ritual:kaizen`
 * instead of the text that got posted. The first fix composed the notification in
 * the reminder OUTBOUND, which cured that message and left every other
 * out-of-turn post silent — the morning brief, the idle nudge and the overnight
 * report all reach the owner's chat through this same seam and none of them
 * notified anybody. A per-producer notification is the same shape of mistake as
 * the per-producer registry pick this module exists to have ended.
 *
 * So it lives HERE, once, and the rule is the one the owner stated: *"a ritual
 * posting is just a chat message"* — and so is a brief, and so is a nudge. If a
 * post got a DURABLE ROW, the owner is notified about it; a `durability: 'none'`
 * transient pill is not notified, because there is no row for a tap to land on.
 * A producer can no longer notify differently, or forget to.
 *
 * AND THE ROW IS STAMPED DELIVERED AFTERWARDS, which is what makes the re-emit
 * suppression below real rather than decorative. `alreadySeen` asks the ButtonStore
 * whether the owner has already been shown this row, and the store answers from
 * `delivered_at`. For one round of review nothing on this path ever WROTE
 * `delivered_at` — `markDelivered`'s only callers were the onboarding engines — so
 * `was_delivered` was structurally false for every row deliver creates,
 * `alreadySeen` could never be true, and the double-buzz the suppression was added
 * to stop still happened on every idempotent re-emit. A guard whose input is never
 * written is not a guard. `deliver.test.ts` now drives the REAL `ButtonStore`
 * against a real DB for exactly this property, because the fake that stood in for
 * it returned `was_delivered: true` from a literal and could not have caught it.
 */

import { randomUUID } from 'node:crypto'

import { buildButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import type { ButtonOption } from '@neutronai/channels/button-primitive.ts'
import type { ButtonStore } from '@neutronai/channels/button-store.ts'
import { parseAnyTopicId } from '@neutronai/channels/topic-id.ts'
import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'
import { createLogger } from '@neutronai/logger'

import { chatMessagePushScope, type ChatMessagePushSink } from '../push/chat-message-push.ts'

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
  /**
   * The owner's DEVICES — the native notification for a message that just landed
   * in chat. Fires for every post that got a durable row (`'reply'` and
   * `'inert'`) and never for `'none'`, which has no row for a tap to open.
   *
   * Absent ⇒ posts are durable + live-pushed exactly as before and no device is
   * notified: the state of a box with no registered device, and what every test
   * that does not care about push wants.
   */
  notify?: ChatMessagePushSink
  /**
   * How long the device notification may hold a delivery before it is abandoned.
   * Default 3 s.
   *
   * This is a REQUEST-PATH bound, not a tidiness one. `POST /api/app/system-notice`
   * awaits `deliver` to answer the caller (`gateway/http/system-notice-surface.ts`),
   * and the only limit underneath the notification is the Expo client's own
   * per-batch `EXPO_PUSH_TIMEOUT_MS` of 10 s (`gateway/push/expo-push-client.ts`) —
   * multiplied by however many batches the token list needs. A stalled `exp.host`
   * would therefore stall an HTTP response for tens of seconds for the sake of a
   * best-effort buzz. On timeout the notification is treated as NOT sent, so
   * `delivered_at` stays NULL and the next re-emit tries again.
   *
   * WHAT THAT COSTS, STATED RATHER THAN IMPLIED: the bound ABANDONS the
   * notification, it does not CANCEL it. The Expo POST underneath keeps running to
   * its own 10 s deadline, so a send that is merely slow can be reported here as
   * not-sent and still reach the device afterwards — and because the row was left
   * unstamped, the next idempotent re-emit notifies again. The owner sees the same
   * message buzz twice.
   *
   * That is the deliberate side to fail on. The alternative is stamping a row whose
   * notification we have no evidence arrived, which silences the re-emit FOREVER for
   * a message he may never have received. A duplicate buzz is a visible annoyance he
   * can act on; a suppressed one is invisible, and that is the failure this seam was
   * built to end. Cancelling for real needs a cancellation token threaded through
   * the sink into the Expo client — worth doing when the sink has a second caller,
   * not worth a bespoke abort path for one.
   */
  notify_timeout_ms?: number
  log?: (msg: string) => void
}

/** Default {@link CreateDeliverInput.notify_timeout_ms}. */
export const DEFAULT_NOTIFY_TIMEOUT_MS = 3_000

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Resolve `work`, or `false` once `budget_ms` has passed — whichever is first.
 *
 * `unref()` on the timer so a pending bound can never hold the process open, and
 * `clearTimeout` on the settle so a fast notification does not leave a live timer
 * behind on every delivery. The abandoned promise is left to settle on its own with
 * a no-op catch attached: dropping the reference without one would surface an Expo
 * outage as an unhandled rejection AFTER we had already reported not-sent.
 */
async function withTimeout(work: Promise<boolean>, budget_ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), budget_ms)
    timer.unref?.()
  })
  work.catch(() => undefined)
  try {
    return await Promise.race([work, bound])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Build the {@link Deliver} seam every out-of-turn producer posts through.
 */
export function createDeliver(input: CreateDeliverInput): Deliver {
  const { buttonStore, push } = input
  const log = input.log ?? ((msg: string): void => moduleLog.warn(msg))
  const notify_timeout_ms = input.notify_timeout_ms ?? DEFAULT_NOTIFY_TIMEOUT_MS
  // VALIDATED AT CONSTRUCTION, for the same reason `ExpoPushClient` validates its
  // own `timeout_ms` and `batch_size` there: a bad deadline is a config mistake, and
  // a config mistake should be one loud error at boot rather than a silent
  // behaviour change on every fire.
  //
  // `??` only defaults `undefined`, so a literal `0` — or a `NaN` arriving from a
  // parsed setting — passes straight through to `withTimeout`, where `setTimeout(0)`
  // (Node clamps NaN to 0 too) resolves the bound on the very next macrotask. The
  // race is then decided BEFORE the notification can possibly answer, so every
  // notification reports not-sent, no row is ever stamped, and the re-emit
  // suppression this whole seam exists for is silently off — the one failure mode
  // that looks exactly like working code.
  if (!Number.isFinite(notify_timeout_ms) || notify_timeout_ms <= 0) {
    throw new Error('createDeliver: notify_timeout_ms must be a positive number')
  }

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

  /**
   * Notify the owner's devices that this landed in chat. Best-effort in the same
   * sense the live push is, and swallowed HERE rather than at the producer —
   * because of what a throw would mean upstream. `buildButtonStoreReminderOutbound`
   * reports `persisted` as "the post happened", and the reminder tick reads a false
   * there as "revert the claim and fire again next tick" (`reminders/tick.ts` #319).
   * An Expo outage that escaped this line would double-post every reminder.
   */
  const notifyDevices = async (
    topic_id: string,
    message_id: string,
    body: string,
  ): Promise<boolean> => {
    if (input.notify === undefined) return false
    try {
      return await withTimeout(
        input.notify({ ...chatMessagePushScope(topic_id), message_id, body }),
        notify_timeout_ms,
      )
    } catch (err) {
      log(
        `${LOG_TAG} device notification failed (durable row is the guarantee) topic=${topic_id}: ${errMsg(err)}`,
      )
      return false
    }
  }

  /**
   * Stamp the durable row as shown to the owner, so the NEXT idempotent re-emit
   * can suppress a second buzz.
   *
   * Only for `durability: 'reply'`: that is the one mode whose row is created by
   * `ButtonStore.emit` with `delivered_at` NULL. `persistInertAgentTurn` stamps its
   * own row at insert time (`channels/button-store.ts` — "delivered_at is stamped
   * because the caller only persists what it already sent"), so an `inert` post has
   * nothing left to record.
   *
   * Swallows its own failure. The stamp is an AUDIT write on a row that already
   * exists and whose message the owner already has; letting a locked DB here
   * surface would revert the reminder tick's claim and re-post the message
   * (`reminders/tick.ts` #319) — trading a possible duplicate buzz for a certain
   * duplicate post.
   */
  const stampDelivered = async (prompt_id: string): Promise<void> => {
    try {
      await buttonStore.markDelivered(prompt_id)
    } catch (err) {
      log(`${LOG_TAG} could not stamp delivered_at prompt=${prompt_id}: ${errMsg(err)}`)
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
    /** True when this post collapsed onto a row the owner has already been shown. */
    let alreadySeen = false
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
        // AN IDEMPOTENT RE-EMIT MUST NOT BUZZ TWICE. `(topic_id,
        // idempotency_key)` is unique, so a re-emit collapses onto the existing
        // row and returns `was_new: false` — the owner already has this message.
        // `was_delivered` is the exception the ButtonStore contract spells out:
        // both false means the row landed in the DB but never reached him, so it
        // still needs rendering AND still needs the notification. Same rule the
        // channel adapters apply to the re-render, applied to the push.
        //
        // THIS SUPPRESSES A LATER RE-EMIT, NOT A SIMULTANEOUS ONE, and the gap is
        // deliberate. There is no atomic claim between `emit` and `markDelivered`,
        // so two deliveries sharing an `idempotency_key` that overlap in flight can
        // both read `was_delivered: false` and both buzz. Closing it means a
        // claim-on-emit in the ButtonStore contract, which every existing caller
        // would inherit.
        //
        // Not taken, because the exposure is one duplicate buzz and the reachable
        // producers do not race: the reminder tick claims its row before dispatch
        // (`reminders/tick.ts`), and the keys in play are per-artifact and
        // per-producer (`ritual-approval:<content_id>`,
        // `ritual-egress-approval:<egress_id>`, a credential incident id), so two
        // concurrent posts of the SAME key need one producer to re-enter itself.
        // Worth revisiting if a request-driven producer ever mints a shared key.
        alreadySeen = !emitted.was_new && emitted.was_delivered
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
    // AFTER the live push, and UNCONDITIONALLY on its result. A live socket is not
    // evidence the owner is looking: Android keeps the app-ws socket open while the
    // app sits in the background, so gating the notification on `delivered_live`
    // would silence exactly the case a notification exists for. `alreadySeen` is a
    // different question and the only thing that suppresses it: an idempotent
    // re-emit of a message he already has.
    if (!alreadySeen) {
      const notified = await notifyDevices(topic_id, prompt_id, body)
      // RECORD that he was shown it, so the next re-emit of the same
      // `idempotency_key` reads `was_delivered: true` and stays quiet. Gated on the
      // owner having ACTUALLY been reached — by a device notification or by a live
      // socket — because the ButtonStore contract's exception is load-bearing: a row
      // that persisted while every transport failed must still buzz on the retry,
      // and stamping unconditionally would silence it forever.
      //
      // THE COST OF THE `|| delivered` ARM, NAMED RATHER THAN LEFT TO BE FOUND.
      // Twenty lines up, a live socket is declared NOT to be evidence the owner is
      // looking; here it is accepted as evidence he was REACHED. Both are meant, but
      // the pair has a seam: a backgrounded phone holding an open socket while Expo
      // is down gives `delivered: true, notified: false`, so the row is stamped and
      // the ALERT for that key is gone for good — a `ritual-approval` or credential
      // incident then waits silently until he next opens the app.
      //
      // Accepted, because the message itself is not lost: the socket handed it to the
      // client and it is in the transcript, so this delays an alert rather than
      // dropping information. The alternative — requiring `notified` — makes the
      // stamp unreachable on any install with no registered device, which is every
      // fresh one, and there the re-emit would re-notify forever with nothing able to
      // buzz. Stamping on "reached by some transport" is the honest reading of
      // `delivered_at`. Revisit if a key ever needs an alert guarantee STRONGER than
      // the transcript, because that is a different contract and wants a different
      // field, not a tweak to this condition.
      if (durability === 'reply' && (notified || delivered)) await stampDelivered(prompt_id)
    }
    return { prompt_id, persisted: true, delivered_live: delivered }
  }
}
