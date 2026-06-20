/**
 * @neutronai/channels — channel-agnostic type abstraction.
 *
 * The single-registration ABC
 * shape is the architectural improvement over OpenClaw and Hermes — adding a
 * platform requires implementing `ChannelAdapter` (one file) plus a single
 * `registerChannelAdapter(adapter)` call at boot. The 9 surfaces (factory,
 * auth-map, system-prompt-hint, toolset, send-message-tool, …) all derive
 * by reflection from the manifest the adapter exports.
 */

export type ChannelKind = 'telegram' | 'app_socket' | 'webhook' | 'cli'

/**
 * Channel-bound topic identifier. The `(channel_kind, channel_topic_id)`
 * pair is the routing key in `topics` (migration 0004); the `topic_id`
 * is Neutron's internal UUID for the topic row.
 */
export interface Topic {
  topic_id: string
  channel_kind: ChannelKind
  channel_topic_id: string
  project_id: string | null
  privacy_mode: 'regular' | 'private'
}

/** A user's identity on a channel. Resolved by the adapter from the raw event. */
export interface ChannelUser {
  /** The channel's native id (e.g. telegram from.id). */
  channel_user_id: string
  /** Display name for prompt prefixing in group projects. */
  display_name: string
}

/**
 * Uniform multi-author attribution envelope (connect-spec §4). A shared project
 * means many humans talk to ONE Claude in one memory, so every event records
 * WHO. The owner is author #0 (`{ id: 'owner', display: <owner label> }`); each
 * collaborator is a distinct stable id + display name derived from their
 * `connected_members` row (`id = local_slug`, `display = display_name`).
 *
 * ONE field, uniform everywhere — no owner-vs-collaborator code fork. Stamped
 * ONCE server-side at the message-routing ingress (§4.2), persisted on the
 * message row (§4.4), and read by the transcript / scribe / Core-activity
 * layers (§4.3). NEVER trusted from a token claim or request body.
 */
export interface Author {
  /** Stable, uniform across owner + every collaborator. */
  id: string
  /** Human label rendered in the transcript + roster. */
  display: string
}

/**
 * Inbound event normalised across all channels. The adapter does the
 * channel-specific decoding (telegram update → IncomingEvent etc.).
 *
 * `body.text` is the only required content shape at P1; richer attachment
 * shapes (images, voice) layer in via `body.attachments` (P1 leaves this
 * as a loose `unknown[]` slot for adapters to use; the substrate-side
 * tooling parses).
 */
export interface IncomingEvent {
  channel_kind: ChannelKind
  channel_topic_id: string
  user: ChannelUser
  body: {
    text: string
    attachments?: unknown[]
  }
  /** Channel-native event id for idempotency / debug. */
  event_id: string
  /** Wall-clock ms when the channel produced the event. */
  received_at: number
  /**
   * Uniform author attribution (connect-spec §4). Stamped once, server-side, at
   * ingress: collaborator turns carry `{ id: local_slug, display: display_name }`
   * (the resolved member); owner-native channel turns carry author #0
   * (`{ id: 'owner', display: 'owner' }`, defaulted by `ChannelRouter.receive`
   * when an adapter doesn't set it). Always present once the router has seen the
   * event, so every downstream consumer can read WHO spoke without a fork.
   */
  author?: Author
  /**
   * Foreign-origin instance slug when this event arrived via the cross-instance
   * API (workspace → member fan-out). Absent for channel-native events
   * (Telegram update, app-socket message, CLI input — all of which originate
   * inside the receiving instance). Downstream persistence MUST treat this
   * field as load-bearing for privacy quarantine: when present and ≠ the
   * receiving instance, the message is foreign-origin content and the
   * persistence layer gates writes via `quarantineForeignContent`. The
   * field is preserved end-to-end through the router — the router itself
   * does not rewrite or strip it.
   */
  origin_instance_slug?: string
  /**
   * Adapter-specific metadata pass-through. Channels that capture
   * structured context at decode time (e.g. the app-ws adapter
   * stashing the inbound `project_id` from the wire envelope) ride
   * here so downstream consumers (topic handlers, the agent loop)
   * can read it without the core router knowing the adapter's
   * encoding. Mirror of `OutgoingMessage.adapter_options`. Per P5.2
   * (sprint roadmap § 4) — initial consumer is `project_id` from the
   * app-ws inbound; later channels may layer more keys.
   */
  adapter_metadata?: Record<string, unknown>
}

/**
 * Outbound message sent from gateway → channel. Routed via `Topic`.
 * Channels MAY split or compose this further (UTF-16-aware truncation in
 * the Telegram adapter, single-line for CLI, etc.).
 */
export interface OutgoingMessage {
  topic: Topic
  text: string
  /**
   * Optional inline-keyboard primitive (Telegram) / list of choices for
   * an interactive prompt. Adapters that don't support interactive
   * keyboards (CLI) render as numbered options in the body text.
   */
  inline_choices?: InlineChoice[]
  /**
   * Adapter-specific options pass-through. Exotic features that do not
   * generalize (Telegram parse_mode, voice attachments, etc.) ride here
   * keyed by adapter name.
   */
  adapter_options?: Record<string, unknown>
}

export interface InlineChoice {
  /** Human-readable label rendered on the button. */
  label: string
  /** Opaque token returned to the gateway when the user clicks. */
  callback_data: string
}

/**
 * The per-adapter manifest. The router uses this to dispatch incoming
 * events to the correct adapter instance and to surface introspection.
 */
export interface ChannelAdapterManifest {
  kind: ChannelKind
  /** Human-readable name surfaced in observability. */
  display_name: string
  /** Whether this adapter supports inline keyboards. */
  supports_inline_choices: boolean
  /** Whether this adapter supports unprompted send (push). */
  supports_unprompted_send: boolean
}

/**
 * Concrete channel adapter — one per `ChannelKind` per gateway process.
 * Implementations: TelegramAdapter (P1 S4), AppSocketAdapter (P5 stub),
 * WebhookAdapter (P1 S4 — generic incoming-webhook), CliAdapter (dev).
 */
export interface ChannelAdapter {
  manifest: ChannelAdapterManifest
  /** Send an outbound message. Returns the channel-native message id. */
  send(message: OutgoingMessage): Promise<string>
  /** Acknowledge an inline-choice callback (e.g. Telegram answerCallbackQuery). */
  acknowledgeChoice?(channel_topic_id: string, callback_id: string): Promise<void>
  /** Optional — start the long-running ingress loop (webhook server, long-poll, etc.). */
  start?(): Promise<void>
  /** Optional — graceful shutdown of the ingress loop. */
  stop?(): Promise<void>
}

/**
 * Receiver — every adapter posts decoded events here. The router subscribes
 * one of these per gateway process and routes events into topic-lifecycle.
 */
export interface IncomingEventReceiver {
  receive(event: IncomingEvent): Promise<void>
}
