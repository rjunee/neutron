/**
 * @neutronai/app — Expo-side mirror of `channels/adapters/app-ws/envelope.ts`.
 *
 * The Expo workspace is a separate bun workspace + the channels
 * package is a server-only `@neutronai/channels` workspace (it imports
 * `@neutronai/persistence` which uses `node:sqlite`). Duplicating the
 * envelope shapes here keeps the Expo bundle pure-JS while staying
 * source-of-truth aligned. ANY change here MUST mirror
 * `channels/adapters/app-ws/envelope.ts` — there's a parity test in
 * `app/__tests__/ws-envelope-parity.test.ts` (P5.1).
 *
 * P5.1 — adds two envelope members:
 *   - `AppWsOutboundAgentMessagePartial`: streaming chunks carrying
 *     `body_delta` against a stable `message_id`. A final
 *     `agent_message` envelope finalizes the buffer with metadata
 *     (options / citations / image_urls / doc_refs).
 *   - `AppWsInboundUserMessage.attachments?: string[]`: optional list
 *     of attachment URLs the client uploaded before sending. Capped to
 *     8 entries per message, each ≤ 512 chars.
 *
 * P5.2 — `project_id` rides on every envelope (except `error`) so the
 * client can filter the transcript to the active project.
 */

/** P5.1 — max attachments per user_message envelope. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
/** P5.1 — per-attachment URL byte cap (matches gateway echo). */
export const MAX_ATTACHMENT_URL_LEN = 512;

export interface AppWsInboundUserMessage {
  v: 1;
  type: 'user_message';
  body: string;
  /** Client-generated id used for echo correlation (optional). */
  client_msg_id?: string;
  /** P5.2 — project this message belongs to. Optional for back-compat. */
  project_id?: string;
  /** P5.1 — image attachment URLs uploaded before the send. */
  attachments?: ReadonlyArray<string>;
}

/**
 * Chat-sync foundation — gap-fill request. On every socket (re)open (after
 * `session_ready`) the client sends `{ v:1, type:'resume', after_seq:N }` where
 * `N` is the highest server `seq` it has already applied. The surface replays
 * `WHERE topic_id = ? AND seq > N ORDER BY seq` so a reply emitted during a
 * socket blip is recoverable. `after_seq:0` (cold client) replays the whole
 * transcript (bounded by the server's replay page size). Mirrors
 * `channels/adapters/app-ws/envelope.ts` `AppWsInboundResume`.
 */
export interface AppWsInboundResume {
  v: 1;
  type: 'resume';
  /** Highest server `seq` the client has already applied locally. */
  after_seq: number;
}

export type AppWsInbound = AppWsInboundUserMessage;

export interface AppWsOutboundSessionReady {
  v: 1;
  type: 'session_ready';
  user_id: string;
  project_slug: string;
  topic_id: string;
  ts: number;
  project_id?: string;
  /**
   * Chat-sync foundation — the server's high-water `seq` (`MAX(seq)` for the
   * topic) at connect. Absent when 0 (fresh topic / no durable log). The client
   * resumes only when its local cursor < this; a value STRICTLY LOWER than the
   * client's cursor signals a server reset/reinstall (seq regressed), triggering
   * a stale-store wipe + full re-sync (M1). Mirrors
   * `channels/adapters/app-ws/envelope.ts` `AppWsOutboundSessionReady`.
   */
  last_seen_seq?: number;
}

export interface AppWsOutboundUserMessageEcho {
  v: 1;
  type: 'user_message';
  user_id: string;
  body: string;
  message_id: string;
  ts: number;
  client_msg_id?: string;
  project_id?: string;
  /** P5.1 — echoed attachments so the optimistic bubble can reconcile. */
  attachments?: ReadonlyArray<string>;
  /**
   * Chat-sync foundation — monotonic per-topic sequence assigned on persist.
   * The client advances its resume cursor to `max(seq)`. Absent when the
   * durable log isn't wired (legacy in-memory-only behaviour).
   */
  seq?: number;
}

export interface AppWsOutboundAgentMessageOption {
  label: string;
  body: string;
  value: string;
  image_url?: string;
  decoration?: {
    style?: 'default' | 'destructive' | 'primary';
    icon_custom_emoji_id?: string;
  };
}

export interface AppWsOutboundAgentMessageDocRef {
  /** Human-readable label rendered next to the link. */
  label: string;
  /** Channel-resolved URL (`neutron://docs/...` for project-scoped). */
  url: string;
  /** Owner project_id, or null for vault-legacy references. */
  project_id: string | null;
  /** Path relative to the project's `docs/` root (or vault root). */
  path: string;
}

/**
 * M2 chat-upload UX — surfaced when the engine is in
 * `ai_substrate_offered` / `import_upload_pending` and expects a ChatGPT
 * / Claude export ZIP. Mirrors `channels/adapters/app-ws/envelope.ts`.
 */
export interface AppWsOutboundAgentMessageUploadAffordance {
  source: 'chatgpt' | 'claude';
}

export interface AppWsOutboundAgentMessage {
  v: 1;
  type: 'agent_message';
  body: string;
  message_id: string;
  ts: number;
  prompt_id?: string;
  options?: ReadonlyArray<AppWsOutboundAgentMessageOption>;
  allow_freeform?: boolean;
  kind?: 'buttons' | 'image-gallery';
  citations?: ReadonlyArray<{ title: string; url: string }>;
  image_urls?: ReadonlyArray<string>;
  /** P7.3 — structured doc references with deep-link URLs. */
  doc_refs?: ReadonlyArray<AppWsOutboundAgentMessageDocRef>;
  project_id?: string;
  /**
   * ISSUE #18 — top-level deep-link the client should navigate to after
   * rendering the message. The Expo client's `<ChatDeepLinkNavigator>`
   * consumes this once per message_id via `router.push(deep_link)`. Cores
   * emit at the top level so a single client-side consumer handles every
   * Core's deep-link uniformly.
   */
  deep_link?: string;
  /** M2 chat-upload UX — drives phase-aware hint + drag-drop affordance. */
  upload_affordance?: AppWsOutboundAgentMessageUploadAffordance;
  /**
   * Chat-sync foundation — monotonic per-topic sequence assigned on persist.
   * Resume-cursor key, same semantics as the user echo's `seq`. Absent when
   * the durable log isn't wired.
   */
  seq?: number;
}

/**
 * P5.1 — streaming chunk for an in-flight agent message.
 *
 * Successive partials for the same `message_id` append to a growing
 * buffer in the client; the final canonical `agent_message` replaces
 * the buffer with the full body + attaches metadata. The server-side
 * substrate dispatcher does NOT emit these envelopes today — the
 * client primitive lands inert at P5.1 and a later P5.x sprint wires
 * the server emit when the agent loop opts in to chunked output.
 */
export interface AppWsOutboundAgentMessagePartial {
  v: 1;
  type: 'agent_message_partial';
  /** Stable id; the final `agent_message` carries the same value. */
  message_id: string;
  /** Text chunk appended to the buffer. */
  body_delta: string;
  /** Server-emit timestamp of this chunk. */
  ts: number;
  /** P5.2 parity — project this stream belongs to. */
  project_id?: string;
}

export interface AppWsOutboundError {
  v: 1;
  type: 'error';
  code: string;
  message: string;
}

/**
 * Chat transport — server-authoritative typing indicator. Emitted on the
 * app-ws path the moment the gateway begins working a live-agent turn
 * (`state:'start'`) and again when the turn settles (`state:'end'`, on BOTH
 * success and failure). EPHEMERAL: NOT persisted, carries no `seq`, never
 * replayed on `resume`. The client clears typing on the next `agent_message`
 * regardless, so a dropped `end` frame can't wedge the indicator. Mirrors
 * `channels/adapters/app-ws/envelope.ts` `AppWsOutboundAgentTyping`.
 */
export interface AppWsOutboundAgentTyping {
  v: 1;
  type: 'agent_typing';
  /** `start` when the agent begins a turn; `end` when it settles. */
  state: 'start' | 'end';
  ts: number;
  /** P5.2 parity — project the in-flight turn belongs to. */
  project_id?: string;
}

/**
 * Result of a matched slash command (`/note`, `/remind`, `/cal`, `/skills`, …).
 * The app-ws surface answers a chat-command-filter match with exactly ONE of
 * these frames and SKIPS the agent dispatch — so NO `agent_message` follows.
 * The client must render `text` (else the command output is lost). Mirrors
 * `gateway/http/app-ws-surface.ts` `postCommandResult`.
 */
export interface AppWsOutboundChatCommandResult {
  v: 1;
  type: 'chat_command_result';
  channel_topic_id: string;
  text: string;
  ts: number;
  data?: unknown;
  deep_link?: string;
  error?: { code?: string; message?: string };
  client_msg_id?: string;
}

export type AppWsOutbound =
  | AppWsOutboundSessionReady
  | AppWsOutboundUserMessageEcho
  | AppWsOutboundAgentMessage
  | AppWsOutboundAgentMessagePartial
  | AppWsOutboundAgentTyping
  | AppWsOutboundError
  | AppWsOutboundChatCommandResult;
