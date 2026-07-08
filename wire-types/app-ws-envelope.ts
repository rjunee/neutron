/**
 * @neutronai/wire-types — app-ws WebSocket envelope UNION (L6).
 *
 * The wire envelope TYPES for the Expo-app / web-React WebSocket surface
 * (`/ws/app/chat`, P5.1 + P5.2). Extracted verbatim from
 * `channels/adapters/app-ws/envelope.ts` into this node-free bottom band so
 * BOTH the server (`@neutronai/channels`, which re-exports them + keeps the
 * runtime decode/sanitize value helpers) AND the pure clients (the Expo app,
 * the landing React client) import ONE source instead of the hand mirror
 * that used to live at `app/lib/ws-envelope.ts` (deleted in L6). The G3
 * parity test (`app/__tests__/ws-envelope-parity.test.ts`) now imports these
 * types directly.
 *
 * Only TYPES live here — every value helper (`decodeAppWsInbound`,
 * `sanitizeAttachments`, `AGENT_DEVICE_ID`, the `MAX_*` caps, …) stays in
 * `channels/adapters/app-ws/envelope.ts` because they encode channel-side
 * wire VALIDATION, not the shape. Topic-id derivation moved to
 * `./topic-id.ts` (it was mirrored in `landing/chat-react/config.ts`).
 *
 * Versioning: every envelope carries `v: 1`. Future envelopes that introduce
 * breaking field shapes bump `v` and ship a new union member.
 */

import type { WireAgentMessageOption } from './option.ts'

export interface AppWsInboundUserMessage {
  v: 1
  type: 'user_message'
  body: string
  /** Client-generated id used for echo correlation (optional). */
  client_msg_id?: string
  /** P5.2 — project this message belongs to. Optional for back-compat. */
  project_id?: string
  /**
   * P5.1 — image attachment URLs uploaded before the send. The client
   * uploads each attachment via the gateway's upload endpoint, then the
   * returned URL rides on this field. Capped at 8 entries / 512 chars per
   * URL by `decodeAppWsInbound` so a malformed client can't push huge arrays
   * through the wire.
   */
  attachments?: ReadonlyArray<string>
}

/**
 * Chat-sync foundation (Phase 1) — gap-fill request. A reconnecting (or
 * second) device sends `{ v:1, type:'resume', after_seq:N }` and the surface
 * replays `WHERE topic_id = ? AND seq > N ORDER BY seq` from the durable
 * message log so the client fills the gap it missed while the socket was
 * down. `after_seq:0` replays the whole transcript (bounded by the server's
 * replay page size).
 */
export interface AppWsInboundResume {
  v: 1
  type: 'resume'
  /** Highest server `seq` the client has already applied locally. */
  after_seq: number
}

/**
 * Track B Phase 4 (delivery + read receipts) — a client reports it has READ
 * a message. Delivery is server-tracked, so the only receipt a client sends
 * is `read`. The server attributes it to the SOCKET's device id.
 */
export interface AppWsInboundReceipt {
  v: 1
  type: 'receipt'
  message_id: string
  state: 'read'
  seq?: number
}

/**
 * Track B Phase 4 (message reactions) — a client adds or removes an emoji
 * reaction on a message. The server attributes it to the SOCKET's device id.
 */
export interface AppWsInboundReaction {
  v: 1
  type: 'reaction'
  message_id: string
  emoji: string
  action: 'add' | 'remove'
  seq?: number
}

/**
 * Track B Phase 4 (message edit/delete) — a client edits or deletes a message
 * it authored. The server AUTHORIZES it against the message's author. `body`
 * is the new text on an `edit`; absent/ignored on a `delete`.
 */
export interface AppWsInboundEdit {
  v: 1
  type: 'edit'
  message_id: string
  action: 'edit' | 'delete'
  body?: string
  seq?: number
}

/**
 * Onboarding consolidation (2026-06-26) — a button/quick-reply CHOICE from the
 * client. Kept as a SEPARATE decoder so the user_message path keeps its narrow
 * type. `freeform_text` rides along only when the active prompt allowed a
 * typed answer (`choice_value === '__freeform__'`).
 */
export interface AppWsInboundButtonChoice {
  v: 1
  type: 'button_choice'
  prompt_id: string
  choice_value: string
  freeform_text?: string
}

export type AppWsInbound = AppWsInboundUserMessage

export interface AppWsOutboundSessionReady {
  v: 1
  type: 'session_ready'
  user_id: string
  project_slug: string
  topic_id: string
  ts: number
  /** P5.2 — project_id carried on the upgrade query string. */
  project_id?: string
  /**
   * Chat-sync foundation — the highest persisted `seq` for this topic at
   * connect time. Absent when the topic has no persisted messages or the
   * durable log isn't wired.
   */
  last_seen_seq?: number
}

export interface AppWsOutboundUserMessageEcho {
  v: 1
  type: 'user_message'
  user_id: string
  body: string
  message_id: string
  ts: number
  /** Echoed back when the inbound carried one. Lets the client correlate. */
  client_msg_id?: string
  /** P5.2 — echoed so the client can show the message in the right project. */
  project_id?: string
  /** P5.1 — echoed attachments so the optimistic bubble can reconcile. */
  attachments?: ReadonlyArray<string>
  /**
   * Chat-sync foundation — monotonic per-topic sequence assigned on persist.
   * The client orders by `seq` (never by clock) and advances its resume
   * cursor to `max(seq)`. Absent when the durable log isn't wired.
   */
  seq?: number
  /**
   * Track B Phase 4 — receipt aggregate carried inline on the message.
   * `delivered_by` = devices connected at fan-out; `read_by` folded on replay.
   */
  delivered_by?: ReadonlyArray<string>
  read_by?: ReadonlyArray<string>
}

/**
 * THE canonical wire option — one selectable option attached to an agent
 * message. Aliases {@link WireAgentMessageOption} (L6 unification); this name
 * is retained for the existing app-ws consumers. See `./option.ts` for the
 * five-shape unification rationale.
 */
export type AppWsOutboundAgentMessageOption = WireAgentMessageOption

export interface AppWsOutboundAgentMessageDocRef {
  /** Human-readable label rendered next to the link in the client. */
  label: string
  /** Channel-resolved URL — `neutron://docs/...` for project-scoped. */
  url: string
  /** Owner project_id, or null for vault-legacy references. */
  project_id: string | null
  /** Path relative to the project's `docs/` root (or vault root). */
  path: string
}

/**
 * M2 chat-upload UX — drives the client's upload affordances during
 * onboarding phases that expect a ChatGPT / Claude export ZIP.
 */
export interface AppWsOutboundAgentMessageUploadAffordance {
  source: 'chatgpt' | 'claude'
}

export interface AppWsOutboundAgentMessage {
  v: 1
  type: 'agent_message'
  body: string
  message_id: string
  ts: number
  prompt_id?: string
  options?: ReadonlyArray<AppWsOutboundAgentMessageOption>
  allow_freeform?: boolean
  kind?: 'buttons' | 'image-gallery'
  /** Optional inline citations: array of `{ title, url }` pairs. */
  citations?: ReadonlyArray<{ title: string; url: string }>
  /** Optional image URLs the client should render below the body. */
  image_urls?: ReadonlyArray<string>
  /**
   * P7.3 — structured doc references resolved against the app channel. Each
   * entry has a deep-link URL the client can open to land in the in-app doc
   * reader at the referenced location.
   */
  doc_refs?: ReadonlyArray<AppWsOutboundAgentMessageDocRef>
  /** P5.2 — project this agent message belongs to. */
  project_id?: string
  /**
   * ISSUE #18 — top-level deep-link the client should consider navigating to
   * after rendering the message.
   */
  deep_link?: string
  /**
   * M2 chat-upload UX — when set, the client shows a phase-aware hint above
   * the composer + accepts ZIP drag-drop / paste / picker for the advertised
   * source(s). Absence clears the affordance.
   */
  upload_affordance?: AppWsOutboundAgentMessageUploadAffordance
  /**
   * Chat-sync foundation — monotonic per-topic sequence assigned on persist.
   * Absent when the durable log isn't wired.
   */
  seq?: number
  /**
   * Track B Phase 4 — receipt aggregate carried inline (same semantics as the
   * user echo).
   */
  delivered_by?: ReadonlyArray<string>
  read_by?: ReadonlyArray<string>
  /**
   * FIX #333 — a TRANSIENT system notification (the cold-start "⏳ Waking up…"
   * ack): rendered as a quiet centered system pill, NEVER persisted to the
   * durable chat_log (no `seq`). Absent for a normal agent reply.
   */
  system_notice?: boolean
}

/**
 * P5.1 — streaming chunk for an in-flight agent message. Successive partials
 * for the same `message_id` append to a growing buffer client-side; the final
 * canonical `AppWsOutboundAgentMessage` replaces the buffer with the full
 * body + metadata.
 */
export interface AppWsOutboundAgentMessagePartial {
  v: 1
  type: 'agent_message_partial'
  /** Stable id across the stream — the final `agent_message` carries the same id. */
  message_id: string
  /** Text appended to the client buffer. */
  body_delta: string
  /** Server-emit time of this chunk. */
  ts: number
  /** P5.2 parity — project this stream belongs to. */
  project_id?: string
}

export interface AppWsOutboundError {
  v: 1
  type: 'error'
  code: string
  message: string
}

/**
 * Chat transport — server-authoritative typing indicator. Emitted the moment
 * the gateway begins working a live-agent turn (`state:'start'`) and again
 * when the turn settles (`state:'end'`, on BOTH success and failure).
 * EPHEMERAL: NOT persisted, carries no `seq`, never replayed on `resume`.
 */
export interface AppWsOutboundAgentTyping {
  v: 1
  type: 'agent_typing'
  /** `start` when the agent begins a turn; `end` when it settles. */
  state: 'start' | 'end'
  ts: number
  /** P5.2 parity — project the in-flight turn belongs to. */
  project_id?: string
}

/**
 * Single-owner Open — a live project-list refresh. Carries the full canonical
 * list (not a delta) so the client apply is idempotent + order-independent.
 */
export interface AppWsOutboundProjectsChanged {
  v: 1
  type: 'projects_changed'
  /**
   * Fresh canonical project list, mirroring the boot bootstrap. Each entry
   * carries the rail-redesign fields alongside id + label.
   */
  projects: ReadonlyArray<{
    id: string
    label: string
    emoji: string
    unread: number
    last_activity_at: string
    activity: 'idle' | 'working' | 'attention'
    preview: string | null
    preview_from: 'user' | 'agent' | null
    live_runs: number
  }>
  /**
   * The project the client should make active when it currently has none.
   * Null when the list is empty.
   */
  active_project_id: string | null
  ts: number
}

/**
 * Track B Phase 4 — a receipt-state update for one already-delivered message.
 * Carries the FULL current aggregate (not a delta).
 */
export interface AppWsOutboundReceiptUpdate {
  v: 1
  type: 'receipt_update'
  message_id: string
  /** The message's server seq (lets a client scope/ignore stale updates). */
  seq?: number
  delivered_by: ReadonlyArray<string>
  read_by: ReadonlyArray<string>
  ts: number
  /** P5.2 parity — project the underlying message belongs to. */
  project_id?: string
}

/**
 * Track B Phase 4 (message reactions) — the FULL current reaction aggregate
 * for one message. The client REPLACES its reaction set with whichever
 * `reaction_update` carries the highest `rev`.
 */
export interface AppWsOutboundReactionUpdate {
  v: 1
  type: 'reaction_update'
  message_id: string
  /** The message's server seq (lets a client scope/ignore stale updates). */
  seq?: number
  /** Monotonic per-message reaction revision (last-writer-wins key). */
  rev: number
  /** The active `(emoji, device_id)` reactions on the message. */
  reactions: ReadonlyArray<{ emoji: string; device_id: string }>
  ts: number
  /** P5.2 parity — project the underlying message belongs to. */
  project_id?: string
}

/**
 * Track B Phase 4 (message edit/delete) — the current edit state of one
 * message. The client REPLACES its body with whichever `edit_update` carries
 * the highest `rev`; a `deleted` update tombstones the bubble.
 */
export interface AppWsOutboundEditUpdate {
  v: 1
  type: 'edit_update'
  message_id: string
  /** The message's server seq (lets a client scope/ignore stale updates). */
  seq?: number
  /** Monotonic per-message edit revision (last-writer-wins key). */
  rev: number
  /** The message's current body after the edit (`''` for a delete tombstone). */
  body: string
  /** True once the message has been tombstoned (deleted). */
  deleted: boolean
  /** unix-ms time of the edit/delete (drives the "edited" marker). */
  edited_at: number
  ts: number
  /** P5.2 parity — project the underlying message belongs to. */
  project_id?: string
}

/**
 * One Work Board row, in wire shape. Decoupled from `work-board/store.ts`'s
 * `WorkBoardItem` (this envelope module stays dependency-free); the composer's
 * push helper maps the store rows onto this shape.
 */
export interface AppWsWorkBoardItem {
  id: string
  title: string
  status: 'upcoming' | 'in_progress' | 'done' | 'failed'
  sort_order: number
  design_doc_ref: string | null
  inline_active: boolean
  linked_run_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  /**
   * Item 1 (M1 trident-UX hardening) — the bound trident run's LIVE progress,
   * present ONLY on an item whose `linked_run_id` names a live run.
   */
  run_progress?: AppWsRunProgress
}

/** Item 1 — the wire shape of a bound run's live progress (see `RunProgress`). */
export interface AppWsRunProgress {
  run_id: string
  phase_label: 'planning' | 'building' | 'reviewing' | 'merged' | 'failed' | 'cancelled'
  round: number
  started_at: string
  last_advanced_at: string
  elapsed_ms: number
  stalled: boolean
  stalled_ms: number | null
  pr: number | null
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | null
  failure_reason: string | null
}

/**
 * Work Board (Phase 1a) — the FULL current board snapshot for one project.
 * Full snapshot (not a delta) so the client apply is idempotent.
 */
export interface AppWsOutboundWorkBoardChanged {
  v: 1
  type: 'work_board_changed'
  /** The board, active+next first (board order) then completed (reverse-chron). */
  items: ReadonlyArray<AppWsWorkBoardItem>
  /** Server-derived project the board belongs to (P5.2 parity). */
  project_id?: string
  ts: number
}

/**
 * Onboarding history-import — live progress for the in-flight import job.
 * EPHEMERAL + UI-only: NOT persisted, carries no `seq`, never replayed.
 */
export interface AppWsOutboundImportProgress {
  v: 1
  type: 'import_progress'
  /** The import job this update belongs to. */
  job_id: string
  status:
    | 'queued'
    | 'pass1-running'
    | 'pass2-running'
    | 'rate_limit_cooling_off'
    | 'rate_limit_paused'
    | 'completed'
    | 'failed'
    | 'cancelled'
  /** 1 = triage pass (counting conversations), 2 = synthesis pass. */
  pass: 1 | 2
  /** 0..1 fractional progress within the current pass. */
  pct: number
  /**
   * Whether the chunk denominator is stable (render "N of M") vs still
   * streaming (count-only). Mirrors `ImportJob.chunks_total_known` end-to-end.
   */
  chunks_total_known: boolean
  /** Human-readable progress line, e.g. "reading conversation N of M…". */
  body?: string
  ts: number
}

/**
 * Fired ONCE at the onboarding→completed transition. A pure signal frame — it
 * carries no payload beyond its type. The web client reacts to it to run the
 * Managed post-onboarding claim redirect.
 */
export interface AppWsOutboundOnboardingCompleted {
  v: 1
  type: 'onboarding_completed'
  ts: number
}

export type AppWsOutbound =
  | AppWsOutboundSessionReady
  | AppWsOutboundUserMessageEcho
  | AppWsOutboundAgentMessage
  | AppWsOutboundAgentMessagePartial
  | AppWsOutboundReceiptUpdate
  | AppWsOutboundReactionUpdate
  | AppWsOutboundEditUpdate
  | AppWsOutboundProjectsChanged
  | AppWsOutboundWorkBoardChanged
  | AppWsOutboundOnboardingCompleted
  | AppWsOutboundAgentTyping
  | AppWsOutboundImportProgress
  | AppWsOutboundError
