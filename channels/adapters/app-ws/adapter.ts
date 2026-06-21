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
  OutgoingMessage,
} from '../../types.ts'
import type { AppChatMessageLog, AppChatRow } from '../../../persistence/index.ts'
import type { AppWsSessionRegistry } from './session-registry.ts'
import {
  sanitizeProjectId,
  type AppWsOutbound,
  type AppWsOutboundAgentMessage,
  type AppWsOutboundAgentMessageDocRef,
  type AppWsOutboundAgentMessageUploadAffordance,
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
}

export class AppWsAdapter implements ChannelAdapter {
  readonly manifest = MANIFEST
  private readonly registry: AppWsSessionRegistry
  private readonly receiver: IncomingEventReceiver
  private readonly now: () => number
  private readonly generate_message_id: () => string
  private readonly chat_log: AppChatMessageLog | undefined

  constructor(opts: AppWsAdapterOptions) {
    this.registry = opts.registry
    this.receiver = opts.receiver
    this.now = opts.now ?? (() => Date.now())
    this.generate_message_id = opts.generate_message_id ?? (() => crypto.randomUUID())
    this.chat_log = opts.chat_log
  }

  /** Whether a durable message log is wired (enables seq + resume). */
  get hasChatLog(): boolean {
    return this.chat_log !== undefined
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
    this.registry.send(input.channel_topic_id, env)
    return { message_id: canonical_id, seq, was_new }
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

/** Best-effort `app:<user_id>` → `<user_id>`; returns '' on a non-app topic. */
function topicUserId(topic_id: string): string {
  return topic_id.startsWith('app:') ? topic_id.slice('app:'.length) : ''
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
