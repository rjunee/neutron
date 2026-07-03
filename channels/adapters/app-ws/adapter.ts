/**
 * @neutronai/channels/app-ws — production Expo / web WebSocket adapter.
 *
 * Per SPEC.md § Phases→Steps (P5.1) and
 * docs/engineering-plan.md § B.P5 (chat surface).
 *
 * Wraps the channel-agnostic `ChannelAdapter` shape so the gateway's
 * `ChannelRouter` can dispatch `OutgoingMessage` for topics whose
 * `channel_kind === 'app_socket'` directly to a live WebSocket. The
 * Telegram adapter is the existing reference for the shape; this
 * adapter is the parallel one for the Expo app (per brief: "produce a
 * parallel channels/expo-ws/ adapter").
 *
 * Outgoing path: `ChannelRouter.send(OutgoingMessage)` →
 * `AppWsAdapter.send(msg)` → registry lookup keyed by
 * `msg.topic.channel_topic_id` → live WebSocket. The conversion from
 * `OutgoingMessage` to the locked Expo wire envelope
 * (`AppWsOutboundAgentMessage`) is pure and lives here so adapters
 * stay channel-aware in exactly one place.
 *
 * Incoming path: when the surface receives a `user_message` envelope
 * over the WebSocket, it calls `adapter.dispatchInbound(...)` which
 * normalises into a standard `IncomingEvent` and pushes through the
 * adapter's `IncomingEventReceiver` (the gateway's
 * `ChannelRouter.receive`). Echoes are emitted directly from the
 * surface to all subscribers of the topic — the topic_handler stays
 * a no-op at P5.1 (the agent loop is later P5 work).
 */

import {
  type DocLinkChannel,
  type DocRef,
  resolveDocRefs,
  rewriteDocRefsInBody,
} from '@neutronai/runtime'
import type {
  ChannelAdapter,
  ChannelAdapterManifest,
  IncomingEvent,
  IncomingEventReceiver,
  InlineChoice,
  OutgoingMessage,
} from '../../types.ts'
import type {
  AppChatEditAction,
  AppChatEditLog,
  AppChatMessageLog,
  AppChatReactionAction,
  AppChatReactionLog,
  AppChatReceiptLog,
  AppChatReceiptState,
  AppChatRow,
} from '../../../persistence/index.ts'
import { AppChatEditNotAuthorizedError } from '../../../persistence/index.ts'
import type { AppWsSessionRegistry } from './session-registry.ts'
import {
  sanitizeProjectId,
  type AppWsOutbound,
  type AppWsOutboundAgentMessage,
  type AppWsOutboundAgentMessageDocRef,
  type AppWsOutboundAgentMessageUploadAffordance,
  type AppWsOutboundEditUpdate,
  type AppWsOutboundReactionUpdate,
  type AppWsOutboundReceiptUpdate,
  type AppWsOutboundUserMessageEcho,
} from './envelope.ts'

const MANIFEST: ChannelAdapterManifest = {
  kind: 'app_socket',
  display_name: 'Expo App (WebSocket)',
  supports_inline_choices: true,
  supports_unprompted_send: true,
}

export interface AppWsAdapterOptions {
  registry: AppWsSessionRegistry
  receiver: IncomingEventReceiver
  /** Override the clock for tests. */
  now?: () => number
  /** Override the message-id generator for tests. */
  generate_message_id?: () => string
  /**
   * Chat-sync foundation — durable per-topic message log. When supplied,
   * every user echo + agent message is persisted with a monotonic per-topic
   * `seq` (stamped on the outbound envelope) and a `{type:'resume'}` request
   * can replay the gap. When ABSENT the adapter keeps its legacy
   * in-memory-only behaviour (no seq, no replay) so existing wiring + tests
   * are unaffected.
   */
  chat_log?: AppChatMessageLog
  /**
   * Track B Phase 4 — durable per-(message, device) receipt log. When supplied
   * (alongside {@link chat_log}), the adapter records a `delivered` receipt for
   * every device connected at message fan-out time (stamped inline on the
   * envelope), records `read` receipts (agent + client) via
   * {@link AppWsAdapter.recordReceipt}, and replays receipt state on resume.
   * ABSENT → no receipts (legacy behaviour); messages still carry no
   * delivered_by/read_by.
   */
  receipt_log?: AppChatReceiptLog
  /**
   * Track B Phase 4 (message reactions) — durable per-(message, device, emoji)
   * reaction log. When supplied, the adapter records add/remove reactions via
   * {@link AppWsAdapter.recordReaction} (attributing device_id to the socket)
   * and fans the full reaction aggregate as a `reaction_update`, and replays
   * reaction state on resume. ABSENT → reactions are inert (legacy behaviour).
   */
  reaction_log?: AppChatReactionLog
  /**
   * Track B Phase 4 (message edit/delete) — durable per-message edit log. When
   * supplied, the adapter records author-authorized edit/delete mutations via
   * {@link AppWsAdapter.recordEdit} and fans the message's new state as an
   * `edit_update`, and replays edit state on resume. ABSENT → edit/delete is
   * inert (legacy behaviour).
   */
  edit_log?: AppChatEditLog
}

export class AppWsAdapter implements ChannelAdapter {
  readonly manifest = MANIFEST
  private readonly registry: AppWsSessionRegistry
  private readonly receiver: IncomingEventReceiver
  private readonly now: () => number
  private readonly generate_message_id: () => string
  private readonly chat_log: AppChatMessageLog | undefined
  private readonly receipt_log: AppChatReceiptLog | undefined
  private readonly reaction_log: AppChatReactionLog | undefined
  private readonly edit_log: AppChatEditLog | undefined

  constructor(opts: AppWsAdapterOptions) {
    this.registry = opts.registry
    this.receiver = opts.receiver
    this.now = opts.now ?? (() => Date.now())
    this.generate_message_id = opts.generate_message_id ?? (() => crypto.randomUUID())
    this.chat_log = opts.chat_log
    this.receipt_log = opts.receipt_log
    this.reaction_log = opts.reaction_log
    this.edit_log = opts.edit_log
  }

  /** Whether a durable message log is wired (enables seq + resume). */
  get hasChatLog(): boolean {
    return this.chat_log !== undefined
  }

  /** Whether the receipt log is wired (enables delivery + read receipts). */
  get hasReceipts(): boolean {
    return this.receipt_log !== undefined
  }

  /** Whether the reaction log is wired (enables emoji reactions). */
  get hasReactions(): boolean {
    return this.reaction_log !== undefined
  }

  /** Whether the edit log is wired (enables message edit/delete). */
  get hasEdits(): boolean {
    return this.edit_log !== undefined
  }

  /**
   * ChannelAdapter.send — invoked by `ChannelRouter` for any topic
   * whose `channel_kind === 'app_socket'`. We render the
   * channel-agnostic `OutgoingMessage` into the locked Expo envelope
   * and push it to the live socket via the session registry.
   *
   * Chat-sync foundation: when a durable log is wired, the agent message is
   * persisted FIRST (assigning the per-topic `seq`) and the `seq` is stamped
   * on the envelope before fan-out, so every live device — and any later
   * `resume` replay — sees the same ordering key.
   */
  async send(message: OutgoingMessage): Promise<string> {
    const envelope = this.outgoingToEnvelope(message)
    // FIX #333 — a TRANSIENT system notification (the cold-start "Waking up…"
    // ack) is EPHEMERAL: fan it out to the live socket so the client shows the
    // pill, but NEVER persist it (no chat_log row, no seq, no delivered receipt),
    // so a reload/project-switch can't re-hydrate it as a stray chat bubble.
    if (envelope.system_notice === true) {
      const delivered = this.registry.send(message.topic.channel_topic_id, envelope)
      return delivered ? `app-ws:${envelope.message_id}` : `app-ws:dropped:${envelope.message_id}`
    }
    if (this.chat_log !== undefined) {
      try {
        const result = await this.chat_log.append({
          topic_id: message.topic.channel_topic_id,
          message_id: envelope.message_id,
          role: 'agent',
          body: envelope.body,
          project_id: envelope.project_id ?? null,
          created_at: envelope.ts,
        })
        envelope.seq = result.row.seq
      } catch (err) {
        // Persistence failure must not drop a live agent reply — fall back
        // to the legacy in-memory fan-out (no seq) and log. A client that
        // later resumes simply won't see this message in the replay; it's
        // still rendered live.
        console.warn(
          `[app-ws] topic=${message.topic.channel_topic_id} agent-message persist failed — emitting without seq: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    // Track B Phase 4 — record `delivered` for every device connected right
    // now + stamp them inline so each receiving device knows it's delivered.
    await this.stampDelivered(message.topic.channel_topic_id, envelope)
    const delivered = this.registry.send(message.topic.channel_topic_id, envelope)
    if (!delivered) {
      // Mirror landing/server's silent-drop posture: no live socket for
      // this topic_id means the client is offline. The agent's emit
      // remains accountable via the topic_handler's own bookkeeping (or
      // a future reconnect-replay queue). For P5.1 we surface the drop
      // through the returned message id so test harnesses can assert.
      return `app-ws:dropped:${envelope.message_id}`
    }
    return `app-ws:${envelope.message_id}`
  }

  /**
   * Surface hook: convert a raw inbound `user_message` envelope into an
   * `IncomingEvent` and push it through the receiver. Throws when the
   * surface caller already validated the envelope shape.
   *
   * P5.2 — `project_id` rides on `IncomingEvent.adapter_metadata` so a
   * topic handler (or the eventual agent loop) can read it and echo
   * the value on its outbound. Per sprint roadmap § 4: per-project
   * routing inside the agent loop is a later P5.x sprint, but we
   * lay the wiring NOW so the loop can be tagged when it lands
   * without retro-fitting the receiver path. The complementary
   * outbound read lives in `outgoingToEnvelope` below.
   */
  async dispatchInbound(input: {
    user_id: string
    channel_topic_id: string
    body: string
    received_at?: number
    event_id?: string
    project_id?: string
    /** P5.1 — image attachment URLs from the inbound envelope. */
    attachments?: ReadonlyArray<string>
  }): Promise<void> {
    const event: IncomingEvent = {
      channel_kind: 'app_socket',
      channel_topic_id: input.channel_topic_id,
      user: {
        channel_user_id: input.user_id,
        display_name: input.user_id,
      },
      body: { text: input.body },
      event_id: input.event_id ?? `app-ws:${this.generate_message_id()}`,
      received_at: input.received_at ?? this.now(),
    }
    const metadata: Record<string, unknown> = {}
    if (input.project_id !== undefined) {
      metadata['project_id'] = input.project_id
    }
    if (input.attachments !== undefined && input.attachments.length > 0) {
      metadata['attachments'] = [...input.attachments]
    }
    if (Object.keys(metadata).length > 0) {
      event.adapter_metadata = metadata
    }
    await this.receiver.receive(event)
  }

  /**
   * Surface hook: emit the locked user-message echo envelope to every
   * live socket on `channel_topic_id`. Returns the synthesised message
   * id so the surface caller can correlate with telemetry.
   *
   * P5.2 — when `project_id` is set, echo it on the envelope so the
   * client renders the message in the right project's transcript.
   */
  emitUserMessageEcho(input: {
    channel_topic_id: string
    user_id: string
    body: string
    client_msg_id?: string
    project_id?: string
    /** P5.1 — echo attachments so the optimistic client bubble reconciles. */
    attachments?: ReadonlyArray<string>
  }): string {
    const message_id = this.generate_message_id()
    const env: AppWsOutboundUserMessageEcho = {
      v: 1,
      type: 'user_message',
      user_id: input.user_id,
      body: input.body,
      message_id,
      ts: this.now(),
    }
    if (input.client_msg_id !== undefined) env.client_msg_id = input.client_msg_id
    if (input.project_id !== undefined) env.project_id = input.project_id
    if (input.attachments !== undefined && input.attachments.length > 0) {
      env.attachments = [...input.attachments]
    }
    this.registry.send(input.channel_topic_id, env)
    return message_id
  }

  /**
   * Chat-sync foundation — durable counterpart to {@link emitUserMessageEcho}.
   * Persists the inbound user message (assigning the per-topic `seq` and
   * de-duplicating on `client_msg_id`), stamps `seq` on the echo, then fans
   * the echo out to every live device. Returns the canonical id + seq so the
   * surface can render the HTTP-fallback echo identically.
   *
   * `was_new` is the idempotency verdict the surface MUST honour: when the
   * durable log de-dupes a re-sent `client_msg_id` (offline-queue flush,
   * double-tap, HTTP-fallback racing the WS echo) it returns the existing row
   * with `was_new:false`. The surface gates its side-effecting work — the
   * chat-command filter and the agent `dispatchInbound` — on this flag so a
   * re-send NEVER fires the agent / a command twice (Argus + Codex P1
   * double-dispatch blocker, PR #6). The echo is still re-emitted (the client
   * de-dupes it on `client_msg_id`) so a reconnecting device reconciles.
   *
   * When NO durable log is wired this delegates to the legacy
   * {@link emitUserMessageEcho} (no seq) so the in-memory-only path is
   * unchanged; `was_new` is `true` (there's no persistence to de-dupe against,
   * so every send is dispatched, preserving legacy behaviour). A persist
   * failure likewise reports `was_new:true` — we couldn't establish that the
   * message was a duplicate, so we dispatch rather than silently drop it.
   */
  async ingestUserMessage(input: {
    channel_topic_id: string
    user_id: string
    body: string
    client_msg_id?: string
    project_id?: string
    attachments?: ReadonlyArray<string>
  }): Promise<{ message_id: string; seq: number | null; was_new: boolean }> {
    if (this.chat_log === undefined) {
      const message_id = this.emitUserMessageEcho(input)
      return { message_id, seq: null, was_new: true }
    }
    const message_id = this.generate_message_id()
    const ts = this.now()
    let seq: number | null = null
    let canonical_id = message_id
    let was_new = true
    try {
      const result = await this.chat_log.append({
        topic_id: input.channel_topic_id,
        message_id,
        role: 'user',
        body: input.body,
        client_msg_id: input.client_msg_id ?? null,
        project_id: input.project_id ?? null,
        attachments: input.attachments ?? null,
        created_at: ts,
      })
      seq = result.row.seq
      // Idempotent re-send: an existing row owns the canonical id, so the
      // echo correlates to the message the client already holds.
      canonical_id = result.row.message_id
      was_new = result.was_new
    } catch (err) {
      console.warn(
        `[app-ws] topic=${input.channel_topic_id} user-message persist failed — echoing without seq: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    const env: AppWsOutboundUserMessageEcho = {
      v: 1,
      type: 'user_message',
      user_id: input.user_id,
      body: input.body,
      message_id: canonical_id,
      ts,
    }
    if (input.client_msg_id !== undefined) env.client_msg_id = input.client_msg_id
    if (input.project_id !== undefined) env.project_id = input.project_id
    if (input.attachments !== undefined && input.attachments.length > 0) {
      env.attachments = [...input.attachments]
    }
    if (seq !== null) env.seq = seq
    // Track B Phase 4 — record `delivered` for every connected device + stamp
    // them inline. On an idempotent re-send (`was_new === false`) this still
    // records delivered for any device that's now connected but wasn't when the
    // message was first sent — closing the gap for a device that came online
    // after the original fan-out.
    await this.stampDelivered(input.channel_topic_id, env)
    this.registry.send(input.channel_topic_id, env)
    return { message_id: canonical_id, seq, was_new }
  }

  /**
   * Track B Phase 4 — record a `delivered` receipt for every device connected
   * to the topic right now, and stamp the resulting set inline on the outbound
   * message envelope (`delivered_by`). No-op when the receipt log isn't wired
   * or no device reports an id. Failure-isolated: a receipt persist error never
   * blocks the live message fan-out.
   */
  private async stampDelivered(
    channel_topic_id: string,
    env: AppWsOutboundUserMessageEcho | AppWsOutboundAgentMessage,
  ): Promise<void> {
    if (this.receipt_log === undefined) return
    const devices = this.registry.devices(channel_topic_id)
    if (devices.length === 0) return
    const at = this.now()
    const delivered = new Set<string>()
    for (const device_id of devices) {
      try {
        const agg = await this.receipt_log.record({
          topic_id: channel_topic_id,
          message_id: env.message_id,
          device_id,
          state: 'delivered',
          at,
        })
        for (const d of agg.delivered_by) delivered.add(d)
        if (agg.read_by.length > 0) env.read_by = [...agg.read_by]
      } catch (err) {
        console.warn(
          `[app-ws] topic=${channel_topic_id} delivered-receipt persist failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    if (delivered.size > 0) env.delivered_by = [...delivered].sort()
  }

  /**
   * Track B Phase 4 — record a receipt for a message (a client `read`, or the
   * agent reading an inbound user message) and fan a `receipt_update` carrying
   * the FULL post-record aggregate to EVERY device on the topic, so the
   * sender's bubble advances. Returns the fanned envelope (for tests /
   * telemetry), or `null` when the receipt log isn't wired. The fan-out is
   * unconditional even if `delivered`/`read` didn't change — the client merge
   * is idempotent, and re-emitting keeps a device that missed the prior frame
   * in sync.
   */
  async recordReceipt(input: {
    channel_topic_id: string
    message_id: string
    device_id: string
    state: AppChatReceiptState
    project_id?: string
  }): Promise<AppWsOutboundReceiptUpdate | null> {
    if (this.receipt_log === undefined) return null
    if (input.message_id.length === 0 || input.device_id.length === 0) return null
    let agg
    try {
      agg = await this.receipt_log.record({
        topic_id: input.channel_topic_id,
        message_id: input.message_id,
        device_id: input.device_id,
        state: input.state,
        at: this.now(),
      })
    } catch (err) {
      console.warn(
        `[app-ws] topic=${input.channel_topic_id} receipt persist failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return null
    }
    const env: AppWsOutboundReceiptUpdate = {
      v: 1,
      type: 'receipt_update',
      message_id: input.message_id,
      delivered_by: agg.delivered_by,
      read_by: agg.read_by,
      ts: this.now(),
    }
    if (agg.seq > 0) env.seq = agg.seq
    if (input.project_id !== undefined) env.project_id = input.project_id
    this.registry.send(input.channel_topic_id, env)
    return env
  }

  /**
   * Track B Phase 4 — replay receipt state to a reconnecting device after the
   * message replay. Returns one `receipt_update` per message (with seq >
   * after_seq) that has any receipt, ascending by seq. The surface sends these
   * to the single requesting socket so its ladder reflects current state.
   * `[]` when the receipt log isn't wired.
   */
  async replayReceiptsAfter(
    channel_topic_id: string,
    after_seq: number,
  ): Promise<AppWsOutboundReceiptUpdate[]> {
    if (this.receipt_log === undefined) return []
    const aggregates = await this.receipt_log.aggregatesAfter(channel_topic_id, after_seq)
    const ts = this.now()
    return aggregates.map((agg) => {
      const env: AppWsOutboundReceiptUpdate = {
        v: 1,
        type: 'receipt_update',
        message_id: agg.message_id,
        delivered_by: agg.delivered_by,
        read_by: agg.read_by,
        ts,
      }
      if (agg.seq > 0) env.seq = agg.seq
      return env
    })
  }

  /**
   * Track B Phase 4 (message reactions) — record an add/remove reaction for a
   * message (attributed to the supplied device id, which the surface sets from
   * the socket) and fan a `reaction_update` carrying the FULL post-record
   * aggregate (+ monotonic `rev`) to EVERY device on the topic, so each
   * device's chips converge. Returns the fanned envelope (for tests /
   * telemetry), or `null` when the reaction log isn't wired / the input is
   * empty. Failure-isolated: a persist error returns `null` rather than
   * throwing into the socket loop.
   */
  async recordReaction(input: {
    channel_topic_id: string
    message_id: string
    device_id: string
    emoji: string
    action: AppChatReactionAction
    project_id?: string
  }): Promise<AppWsOutboundReactionUpdate | null> {
    if (this.reaction_log === undefined) return null
    if (input.message_id.length === 0 || input.device_id.length === 0) return null
    if (input.emoji.length === 0) return null
    let agg
    try {
      agg = await this.reaction_log.record({
        topic_id: input.channel_topic_id,
        message_id: input.message_id,
        device_id: input.device_id,
        emoji: input.emoji,
        action: input.action,
        at: this.now(),
      })
    } catch (err) {
      console.warn(
        `[app-ws] topic=${input.channel_topic_id} reaction persist failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return null
    }
    const env: AppWsOutboundReactionUpdate = {
      v: 1,
      type: 'reaction_update',
      message_id: input.message_id,
      rev: agg.rev,
      reactions: agg.reactions.map((r) => ({ emoji: r.emoji, device_id: r.device_id })),
      ts: this.now(),
    }
    if (agg.seq > 0) env.seq = agg.seq
    if (input.project_id !== undefined) env.project_id = input.project_id
    this.registry.send(input.channel_topic_id, env)
    return env
  }

  /**
   * Track B Phase 4 (message reactions) — replay reaction state to a
   * reconnecting device after the message replay. Returns one `reaction_update`
   * per message (with seq > after_seq) that has any reaction, ascending by seq.
   * `[]` when the reaction log isn't wired.
   */
  async replayReactionsAfter(
    channel_topic_id: string,
    after_seq: number,
  ): Promise<AppWsOutboundReactionUpdate[]> {
    if (this.reaction_log === undefined) return []
    const aggregates = await this.reaction_log.aggregatesAfter(channel_topic_id, after_seq)
    const ts = this.now()
    return aggregates.map((agg) => {
      const env: AppWsOutboundReactionUpdate = {
        v: 1,
        type: 'reaction_update',
        message_id: agg.message_id,
        rev: agg.rev,
        reactions: agg.reactions.map((r) => ({ emoji: r.emoji, device_id: r.device_id })),
        ts,
      }
      if (agg.seq > 0) env.seq = agg.seq
      return env
    })
  }

  /**
   * Track B Phase 4 (message edit/delete) — record an author-authorized edit or
   * delete (the editor device is set from the socket, or
   * `APP_CHAT_AGENT_DEVICE_ID` for an agent-issued edit) and fan an `edit_update`
   * carrying the message's new body + tombstone flag + monotonic `rev` to EVERY
   * device on the topic, so each device converges. Returns the fanned envelope
   * (for tests / telemetry), or `null` when the edit log isn't wired / the input
   * is empty. RE-THROWS {@link AppChatEditNotAuthorizedError} so the surface can
   * answer the editor with a `not_authorized` frame; any other persist error is
   * failure-isolated (warn + `null`) rather than thrown into the socket loop.
   */
  async recordEdit(input: {
    channel_topic_id: string
    message_id: string
    editor_device_id: string
    action: AppChatEditAction
    body?: string
    project_id?: string
  }): Promise<AppWsOutboundEditUpdate | null> {
    if (this.edit_log === undefined) return null
    if (input.message_id.length === 0 || input.editor_device_id.length === 0) return null
    const body = input.action === 'edit' ? (input.body ?? '') : ''
    if (input.action === 'edit' && body.length === 0) return null
    let agg
    try {
      agg = await this.edit_log.record({
        topic_id: input.channel_topic_id,
        message_id: input.message_id,
        editor_device_id: input.editor_device_id,
        action: input.action,
        body,
        at: this.now(),
      })
    } catch (err) {
      // Authorization failures are the editor's problem, not the socket's — let
      // the surface map them to a `not_authorized` error frame.
      if (err instanceof AppChatEditNotAuthorizedError) throw err
      console.warn(
        `[app-ws] topic=${input.channel_topic_id} edit persist failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return null
    }
    const env: AppWsOutboundEditUpdate = {
      v: 1,
      type: 'edit_update',
      message_id: input.message_id,
      rev: agg.rev,
      body: agg.body,
      deleted: agg.deleted,
      edited_at: agg.edited_at,
      ts: this.now(),
    }
    if (agg.seq > 0) env.seq = agg.seq
    if (input.project_id !== undefined) env.project_id = input.project_id
    this.registry.send(input.channel_topic_id, env)
    return env
  }

  /**
   * Track B Phase 4 (message edit/delete) — replay edit state to a reconnecting
   * device after the message replay. Returns one `edit_update` per edited/deleted
   * message (with seq > after_seq), ascending by seq. `[]` when the edit log
   * isn't wired.
   */
  async replayEditsAfter(
    channel_topic_id: string,
    after_seq: number,
  ): Promise<AppWsOutboundEditUpdate[]> {
    if (this.edit_log === undefined) return []
    const aggregates = await this.edit_log.aggregatesAfter(channel_topic_id, after_seq)
    const ts = this.now()
    return aggregates.map((agg) => {
      const env: AppWsOutboundEditUpdate = {
        v: 1,
        type: 'edit_update',
        message_id: agg.message_id,
        rev: agg.rev,
        body: agg.body,
        deleted: agg.deleted,
        edited_at: agg.edited_at,
        ts,
      }
      if (agg.seq > 0) env.seq = agg.seq
      return env
    })
  }

  /**
   * Chat-sync foundation — replay every persisted message after `after_seq`
   * for a topic as wire envelopes, ascending by seq. The surface sends these
   * to the single requesting socket (NOT a fan-out) so a reconnecting device
   * fills its gap without re-broadcasting to other devices. Returns `[]` when
   * no durable log is wired.
   */
  async replayAfter(channel_topic_id: string, after_seq: number): Promise<AppWsOutbound[]> {
    if (this.chat_log === undefined) return []
    const rows = await this.chat_log.replayAfter(channel_topic_id, after_seq)
    return rows.map((r) => appChatRowToEnvelope(r))
  }

  /** Chat-sync foundation — highest persisted seq for a topic (0 when none /
   *  no durable log), for `session_ready.last_seen_seq`. */
  async currentMaxSeq(channel_topic_id: string): Promise<number> {
    if (this.chat_log === undefined) return 0
    return this.chat_log.maxSeq(channel_topic_id)
  }

  /**
   * Surface hook: push an arbitrary outbound envelope (e.g.
   * `session_ready`, `error`) on a topic. Used by the surface itself,
   * NOT by ChannelRouter.send (which always converts from
   * OutgoingMessage).
   */
  emitDirect(channel_topic_id: string, envelope: AppWsOutbound): boolean {
    return this.registry.send(channel_topic_id, envelope)
  }

  private outgoingToEnvelope(message: OutgoingMessage): AppWsOutboundAgentMessage {
    // P7.3 — rewrite inline `[label](docs:/<project_id>/<path>)`
    // markers in the body so the Expo client's RenderMarkdown link
    // tokeniser produces an onPress that calls Linking.openURL on
    // the right URL shape for the client platform.
    //
    // Argus BLOCKING #2: web clients (React Native Web build) can't
    // dispatch `neutron://` custom-scheme URLs — `Linking.openURL`
    // on web calls `window.open`, which only handles standard web
    // schemes. The session registry stashes the client's reported
    // platform at WS upgrade time; we read it here and pick the
    // matching `DocLinkChannel`. Sessions without a registered
    // platform (legacy P5.1 clients, HTTP-only callers, dropped
    // sockets) fall through to 'app' (neutron://) for back-compat.
    const platform = this.registry.getPlatform(message.topic.channel_topic_id)
    const docChannel: DocLinkChannel = platform === 'web' ? 'web' : 'app'
    const body = rewriteDocRefsInBody(message.text, docChannel)
    const env: AppWsOutboundAgentMessage = {
      v: 1,
      type: 'agent_message',
      body,
      message_id: this.generate_message_id(),
      ts: this.now(),
    }
    if (message.inline_choices && message.inline_choices.length > 0) {
      // The web client renders the option's `body` (`optionText` = body||label),
      // and this adapter projects an `InlineChoice`'s human-readable `label` into
      // BOTH `label` and `body` — so the producer MUST put the display text in
      // `InlineChoice.label` (not an "A"/"B" legend). See `optionsToInlineChoices`.
      env.options = message.inline_choices.map((c) => ({
        label: c.label,
        body: c.label,
        value: c.callback_data,
      }))
      env.allow_freeform = false
    }
    // adapter_options is the per-adapter pass-through slot; we honour
    // a few common keys that we'd want from the Expo client side.
    const opts = message.adapter_options
    if (opts !== undefined) {
      const promptId = opts['prompt_id']
      if (typeof promptId === 'string' && promptId.length > 0) {
        env.prompt_id = promptId
      }
      const kind = opts['kind']
      if (kind === 'buttons' || kind === 'image-gallery') {
        env.kind = kind
      }
      const citations = opts['citations']
      if (Array.isArray(citations)) {
        const cleaned: { title: string; url: string }[] = []
        for (const c of citations) {
          if (c !== null && typeof c === 'object') {
            const r = c as { title?: unknown; url?: unknown }
            if (typeof r.title === 'string' && typeof r.url === 'string') {
              cleaned.push({ title: r.title, url: r.url })
            }
          }
        }
        if (cleaned.length > 0) env.citations = cleaned
      }
      const imageUrls = opts['image_urls']
      if (Array.isArray(imageUrls)) {
        const cleaned = imageUrls.filter((u): u is string => typeof u === 'string' && u.length > 0)
        if (cleaned.length > 0) env.image_urls = cleaned
      }
      // P7.3 — resolve structured doc_refs against the channel the
      // client can dispatch ('web' →
      // https://app.example.test/projects/<id>/docs?path=…,
      // 'native' → neutron://docs/…). The Expo client renders each
      // entry as a tap-to-open link that fires `Linking.openURL(url)`.
      const docRefs = readDocRefs(opts['doc_refs'])
      if (docRefs.length > 0) {
        const resolved = resolveDocRefs(docRefs, docChannel)
        if (resolved.length > 0) {
          env.doc_refs = resolved.map(
            (r): AppWsOutboundAgentMessageDocRef => ({
              label: r.label,
              url: r.url,
              project_id: r.project_id,
              path: r.path,
            }),
          )
        }
      }
      const allowFreeform = opts['allow_freeform']
      if (typeof allowFreeform === 'boolean') env.allow_freeform = allowFreeform
      // FIX #333 — transient system-notice (cold-start ack) marker. Drives the
      // client's quiet-pill render AND `send()`'s ephemeral (no-persist) path.
      if (opts['system_notice'] === true) env.system_notice = true
      // P5.2 — agent topic-handlers carry `project_id` from the
      // inbound `IncomingEvent.adapter_metadata` onto their outbound
      // OutgoingMessage.adapter_options so the agent reply lands in
      // the originating project's transcript. Sanitised so a bad
      // value from a topic handler can't push junk into the wire
      // envelope.
      const cleaned_project_id = sanitizeProjectId(opts['project_id'])
      if (cleaned_project_id !== null) env.project_id = cleaned_project_id
      // M2 chat-upload UX — mirror the landing client's `upload_affordance`
      // surfacing onto the Expo wire envelope. Source values match the
      // `phase-prompts.import_upload_pending.metadata.upload_affordance`
      // contract; anything else is silently dropped so a malformed
      // adapter_option from a future phase prompt can't push junk through
      // to the client (matches the citations / image_urls cleaning posture).
      const upload_affordance = sanitizeUploadAffordance(opts['upload_affordance'])
      if (upload_affordance !== null) env.upload_affordance = upload_affordance
    }
    return env
  }
}

/**
 * Chat-sync foundation — reconstruct a wire envelope from a persisted row so
 * a `resume` replay re-emits the message in its original `user_message` /
 * `agent_message` shape, carrying its `seq` for ordering + cursor advance.
 */
export function appChatRowToEnvelope(row: AppChatRow): AppWsOutbound {
  if (row.role === 'user') {
    const env: AppWsOutboundUserMessageEcho = {
      v: 1,
      type: 'user_message',
      // The persisted user message has no separate user_id column (topic is
      // app:<user_id>); the client keys its own bubbles by client_msg_id /
      // message_id, so an empty user_id on replay is harmless. Derive it from
      // the topic when shaped that way so the field is still populated.
      user_id: topicUserId(row.topic_id),
      body: row.body,
      message_id: row.message_id,
      ts: row.created_at,
      seq: row.seq,
    }
    if (row.client_msg_id !== null) env.client_msg_id = row.client_msg_id
    if (row.project_id !== null) env.project_id = row.project_id
    if (row.attachments !== null && row.attachments.length > 0) {
      env.attachments = [...row.attachments]
    }
    return env
  }
  const env: AppWsOutboundAgentMessage = {
    v: 1,
    type: 'agent_message',
    body: row.body,
    message_id: row.message_id,
    ts: row.created_at,
    seq: row.seq,
  }
  if (row.project_id !== null) env.project_id = row.project_id
  return env
}

/** Best-effort `app:<user_id>` or `app:<user_id>:<project_id>` → `<user_id>`;
 *  returns '' on a non-app topic. The per-project web topic carries a
 *  `:<project_id>` suffix, so strip at the first colon after the `app:` prefix. */
function topicUserId(topic_id: string): string {
  if (!topic_id.startsWith('app:')) return ''
  const rest = topic_id.slice('app:'.length)
  const colon = rest.indexOf(':')
  return colon === -1 ? rest : rest.slice(0, colon)
}

/**
 * Map agent-message options (`{ label legend, body display, value }`) → the
 * app-ws `InlineChoice` wire shape (`{ label, callback_data }`).
 *
 * The app-ws adapter projects an `InlineChoice.label` into BOTH the rendered
 * option's `label` AND its `body` (the field the React client actually paints),
 * so the HUMAN-READABLE display text — the option's `body` — MUST ride in
 * `label`, NOT the "A"/"B" legend. Putting the legend there paints live
 * onboarding buttons as bare letters until a reload hydrates the full text from
 * `button_prompts` (Codex P2, 2026-06-30). Falls back to the legend label only
 * when a caller left `body` empty.
 */
export function optionsToInlineChoices(
  options: ReadonlyArray<{ label: string; body?: string; value: string }>,
): InlineChoice[] {
  return options.map((o) => ({
    label: o.body !== undefined && o.body.length > 0 ? o.body : o.label,
    callback_data: o.value,
  }))
}

/**
 * M2 chat-upload UX — coerce the loose `adapter_options.upload_affordance`
 * slot into the typed wire shape. Returns null for anything that doesn't
 * carry a recognised `source` enum value.
 */
function sanitizeUploadAffordance(
  raw: unknown,
): AppWsOutboundAgentMessageUploadAffordance | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as { source?: unknown }
  if (r.source === 'chatgpt' || r.source === 'claude') {
    return { source: r.source }
  }
  // remove-both-import-option (2026-06-06, Codex r1): normalize a legacy
  // 'both' affordance (persisted by the removed two-upload flow, replayed
  // verbatim on a post-deploy reconnect) to 'chatgpt' rather than dropping
  // it — otherwise the Expo client hides the upload bar while the body
  // still asks for a ZIP (deploy-window dead-end). Mirrors the landing
  // `normalizeUploadAffordance` + the `buildImportUploadPendingPromptSpec`
  // stale-'both' → 'chatgpt' rebuild fallback.
  if (r.source === 'both') {
    return { source: 'chatgpt' }
  }
  return null
}

/**
 * P7.3 — coerce the loose `adapter_options.doc_refs` slot into a
 * typed `DocRef[]`. Anything that fails the per-entry shape check
 * gets dropped silently (matches the existing `citations` /
 * `image_urls` cleaning conventions in `outgoingToEnvelope`).
 */
function readDocRefs(raw: unknown): DocRef[] {
  if (!Array.isArray(raw)) return []
  const out: DocRef[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const r = entry as Record<string, unknown>
    const path = r['path']
    if (typeof path !== 'string') continue
    const ref: DocRef = { path }
    const label = r['label']
    if (typeof label === 'string') ref.label = label
    const project_id = r['project_id']
    if (typeof project_id === 'string') ref.project_id = project_id
    else if (project_id === null) ref.project_id = null
    out.push(ref)
  }
  return out
}
