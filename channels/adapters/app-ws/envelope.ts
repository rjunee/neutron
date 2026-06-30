/**
 * @neutronai/channels/app-ws — wire envelopes for the Expo-app WebSocket
 * surface (P5.1 + P5.2).
 *
 * The shape is intentionally a strict superset of the existing landing
 * `ChatOutbound` (`type: 'agent_message'` etc.) so the Expo client and
 * the landing `chat.ts` client can converge on a single renderer in a
 * later P5 sprint without breaking either surface today.
 *
 * Versioning: every envelope carries `v: 1`. Future envelopes that
 * introduce breaking field shapes bump `v` and ship a new union
 * member — the Expo client drops envelopes whose `v` it doesn't
 * understand.
 *
 * P5.2 — every inbound and outbound envelope (except the synthetic
 * `error` envelope) carries an optional `project_id`. The client
 * tags messages with the active project; the gateway stashes the
 * value on the AppWsAdapter session and echoes it back so the client
 * shows the message in the right project transcript. Per-project
 * routing inside the agent loop is a later P5.x concern — for now
 * the gateway just round-trips the value (sprint roadmap § 4 / P5.2
 * out-of-scope note).
 */

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
   * uploads each attachment via the gateway's upload endpoint, then
   * the returned URL rides on this field. Capped at 8 entries / 512
   * chars per URL by `decodeAppWsInbound` so a malformed client can't
   * push huge arrays through the wire.
   */
  attachments?: ReadonlyArray<string>
}

/**
 * Chat-sync foundation (Phase 1) — gap-fill request. A reconnecting (or
 * second) device sends `{ v:1, type:'resume', after_seq:N }` and the surface
 * replays `WHERE topic_id = ? AND seq > N ORDER BY seq` from the durable
 * message log so the client fills the gap it missed while the socket was
 * down. `after_seq:0` (a cold client with an empty local store) replays the
 * whole transcript (bounded by the server's replay page size).
 */
export interface AppWsInboundResume {
  v: 1
  type: 'resume'
  /** Highest server `seq` the client has already applied locally. */
  after_seq: number
}

/**
 * Track B Phase 4 (delivery + read receipts) — a client reports it has READ
 * (viewed) a message. Delivery is server-tracked (recorded for every connected
 * device at fan-out time), so the only receipt a client sends is `read`. The
 * server attributes it to the SOCKET's device id (stashed at upgrade) — the
 * client never self-reports a device id here, so it can't forge another
 * device's receipt. `seq` is the message's server seq when the client knows it
 * (orders/scopes the replay); omitted otherwise.
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
 * reaction on a message. The server attributes it to the SOCKET's device id
 * (stashed at upgrade) — the client never self-reports a device id here, so it
 * can't forge another device's reaction (same anti-forge posture as the read
 * receipt). `seq` is the message's server seq when the client knows it; omitted
 * otherwise.
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
 * Track B Phase 4 (message edit/delete) — a client edits or deletes a message it
 * authored. The server AUTHORIZES it against the message's author (resolved from
 * the message log) — a human socket may mutate `user` messages, the agent may
 * mutate `agent` messages — and the editor is taken from the SOCKET, never the
 * frame. `body` is the new text on an `edit`; absent/ignored on a `delete`.
 * `seq` is the message's server seq when the client knows it; omitted otherwise.
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
 * client. When the unified chat surface is in onboarding mode the agent emits
 * `agent_message` envelopes carrying `options[]` + `prompt_id`; tapping an option
 * sends THIS frame so the server can resolve the structured choice against the
 * engine's persisted `button_prompts` row (NOT a freeform text answer — a
 * button-only phase has `allow_freeform:false`, so the choice MUST carry the
 * `prompt_id` + `choice_value` to advance deterministically). Kept as a SEPARATE
 * decoder (like resume/receipt/reaction/edit) so the user_message path keeps its
 * narrow type. `freeform_text` rides along only when the active prompt allowed a
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
   * connect time. Lets a client that already holds the full transcript skip
   * an unnecessary `resume` round-trip (it only resumes when its local
   * cursor < `last_seen_seq`). Absent when the topic has no persisted
   * messages or the durable log isn't wired.
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
   * cursor to `max(seq)`. Absent when the durable log isn't wired (legacy
   * in-memory-only behaviour).
   */
  seq?: number
  /**
   * Track B Phase 4 — receipt aggregate carried inline on the message. The
   * server records `delivered` for every device connected at fan-out time and
   * stamps the list here (so a receiving device knows it's been delivered);
   * `read_by` is folded on replay so a reconnecting device sees current read
   * state. Both absent when the receipt log isn't wired.
   */
  delivered_by?: ReadonlyArray<string>
  read_by?: ReadonlyArray<string>
}

export interface AppWsOutboundAgentMessageOption {
  label: string
  body: string
  value: string
  image_url?: string
  decoration?: {
    style?: 'default' | 'destructive' | 'primary'
    icon_custom_emoji_id?: string
  }
}

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
 * M2 chat-upload UX — drives the Expo client's upload affordances during
 * onboarding phases that expect a ChatGPT / Claude export ZIP. Mirrors the
 * landing `ChatOutbound.upload_affordance` so a single `phase-prompts`
 * metadata field renders the same drag-drop / file-picker hint across both
 * web chat surfaces. Absent on every other agent_message; the client treats
 * absence as "clear the affordance" so the hint disappears when the engine
 * advances past the import phases.
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
   * P7.3 — structured doc references resolved against the app channel.
   * Each entry has a deep-link URL the Expo client can pass to
   * `Linking.openURL(...)` to land in the in-app doc reader at the
   * referenced location. Inline `[label](docs:/...)` markers in
   * `body` are pre-rewritten to the same `neutron://docs/...` URL
   * shape; this field is for the agent's structured-citation slot
   * (the docs-side mirror of `citations`).
   */
  doc_refs?: ReadonlyArray<AppWsOutboundAgentMessageDocRef>
  /** P5.2 — project this agent message belongs to. */
  project_id?: string
  /**
   * ISSUE #18 — top-level deep-link the client should consider navigating
   * to after rendering the message. The Expo client's
   * `<ChatDeepLinkNavigator>` consumes this once per message_id via
   * `router.push(deep_link)`. Cores emit at the top level of the envelope
   * (NOT nested under a Core-private metadata field) so one client-side
   * consumer handles every Core's deep-link uniformly.
   */
  deep_link?: string
  /**
   * M2 chat-upload UX — when set, the Expo client shows a phase-aware hint
   * above the composer + accepts ZIP drag-drop / paste / picker for the
   * advertised source(s). Absence on subsequent agent_messages clears the
   * affordance so the hint disappears as the engine leaves the import
   * phases.
   */
  upload_affordance?: AppWsOutboundAgentMessageUploadAffordance
  /**
   * Chat-sync foundation — monotonic per-topic sequence assigned on persist.
   * Ordering + resume-cursor key, same semantics as the user echo's `seq`.
   * Absent when the durable log isn't wired.
   */
  seq?: number
  /**
   * Track B Phase 4 — receipt aggregate carried inline (same semantics as the
   * user echo). `delivered_by` = devices connected at fan-out; `read_by` folded
   * on replay. The client's UI doesn't show ticks on agent messages, but the
   * read state still drives cross-device unread reconciliation.
   */
  delivered_by?: ReadonlyArray<string>
  read_by?: ReadonlyArray<string>
}

/**
 * P5.1 — streaming chunk for an in-flight agent message.
 *
 * Successive partials for the same `message_id` append to a growing
 * buffer client-side; the final canonical `AppWsOutboundAgentMessage`
 * replaces the buffer with the full body + attaches metadata. The
 * server-side substrate dispatcher does NOT emit these envelopes today
 * (P5.1 ships the client primitive only); a later P5.x sprint wires
 * the chunked-emit path when the agent loop opts in.
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
 * Chat transport — server-authoritative typing indicator (Ryan-directed
 * "we have a typing indicator for this purpose"). Emitted on the app-ws path
 * the moment the gateway begins working a live-agent turn (`state:'start'`)
 * and again when the turn settles (`state:'end'`, on BOTH success and
 * failure). Unlike a client-side optimistic guess, this is driven by the
 * server actually picking up + finishing the turn, so warm turns (every turn
 * after the cold first one) get a real "agent is replying…" affordance for
 * their whole 5–240s duration.
 *
 * EPHEMERAL by design: typing frames are NOT persisted to the chat log and
 * carry no `seq` — they're fanned directly to the topic's live devices and
 * never replayed on `resume` (a stale "typing…" must never survive a
 * reconnect). The client clears typing on the next `agent_message` regardless,
 * so a dropped `end` frame can't wedge the indicator. Back-to-back `start`
 * frames are idempotent for the client (it just stays in the typing state).
 *
 * Mirrors the legacy `web:` path's `agent_typing_start` / `agent_typing_end`
 * `ChatOutbound` frames (`landing/server.ts`) collapsed into one envelope with
 * a `state` discriminator so the Expo wire union stays compact.
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
 * Single-owner Open — a live project-list refresh.
 *
 * THE BUG (P2 follow-up to #84): the served `/chat` HTML injects the owner's
 * project list ONCE at page-load (`open/composer.ts` projectsBootstrapScript).
 * A brand-new owner bootstraps with `__neutron_projects=[]`; when onboarding
 * then CREATES projects in the SAME session there was no signal to refresh, so
 * the Documents/Tasks/Admin tabs only appeared after a manual reload. The
 * server fans this frame out over the app-ws topic the moment the project set
 * changes; the client refreshes its rail + (when transitioning General→a first
 * project) auto-selects it so the per-project tabs render live, no reload.
 *
 * Carries the full canonical list (not a delta) so the client apply is
 * idempotent + order-independent — the same shape the page bootstrap injects.
 */
export interface AppWsOutboundProjectsChanged {
  v: 1
  type: 'projects_changed'
  /** Fresh canonical project list (id + label), mirroring the boot bootstrap. */
  projects: ReadonlyArray<{ id: string; label: string }>
  /**
   * The project the client should make active when it currently has none — the
   * first project, mirroring the page bootstrap's `active_project_id`. Null when
   * the list is empty. The client only auto-selects on a 0→N transition so it
   * never hijacks a user who deliberately navigated to General.
   */
  active_project_id: string | null
  ts: number
}

/**
 * Track B Phase 4 — a receipt-state update for one already-delivered message.
 * Fanned out to EVERY device on the topic whenever a device reads a message
 * (or the agent reads an inbound user message). Carries the FULL current
 * aggregate (not a delta) so the client merge is idempotent + order-independent
 * — the same union semantics as the inline `delivered_by`/`read_by` on the
 * message envelope. Also replayed (per message with receipts) after a resume.
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
 * Track B Phase 4 (message reactions) — the FULL current reaction aggregate for
 * one message. Fanned out to EVERY device on the topic whenever a device
 * adds/removes a reaction, and replayed (per message with reactions) after a
 * resume. Unlike the receipt aggregate (a monotonic union the client
 * accumulates), the client REPLACES its reaction set with whichever
 * `reaction_update` carries the highest `rev` — that's what lets a removal
 * actually clear a reaction.
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
 * Track B Phase 4 (message edit/delete) — the current edit state of one message.
 * Fanned out to EVERY device on the topic whenever the author edits/deletes a
 * message, and replayed (per edited/deleted message) after a resume. The client
 * REPLACES its body with whichever `edit_update` carries the highest `rev`
 * (last-writer-wins, chat-core `pickEditState`); a `deleted` update tombstones
 * the bubble and clears the body.
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
 * `WorkBoardItem` (the envelope module stays dependency-free); the composer's
 * push helper maps the store rows onto this shape.
 */
export interface AppWsWorkBoardItem {
  id: string
  title: string
  status: 'upcoming' | 'in_progress' | 'done'
  sort_order: number
  design_doc_ref: string | null
  inline_active: boolean
  linked_run_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

/**
 * Work Board (Phase 1a) — the FULL current board snapshot for one project,
 * fanned out to every device on the owner's topic after a committed board
 * mutation (agent tool OR HTTP write — both ride the one shared store's
 * `onChange`). Full snapshot (not a delta) so the client apply is idempotent
 * + order-independent, mirroring `projects_changed`.
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
 *
 * Fanned to the owner's app-ws topic every ~5s by the import-running cron
 * (`onboarding/interview/import-running-cron.ts` → `engine-import-routing.ts`)
 * while a ChatGPT/Claude history import processes, so a long import (minutes,
 * for hundreds of conversations) visibly works instead of stalling on a one-shot
 * "received" banner. Collapses the legacy `web:` path's `import_progress`
 * `ChatOutbound` frame (`landing/server.ts`) onto the consolidated app-ws wire.
 *
 * EPHEMERAL + UI-only: NOT persisted, carries no `seq`, never replayed on
 * `resume` — mirrors `agent_typing` / `work_board_changed`. Terminal statuses
 * normally arrive via the phase advance + analysis `agent_message`, not here;
 * the client clears its spinner defensively if a terminal frame does land.
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
  | AppWsOutboundAgentTyping
  | AppWsOutboundImportProgress
  | AppWsOutboundError

/**
 * Decode an inbound envelope. Returns `null` on a wrong-shape envelope
 * (wrong `v`, wrong `type`, body-not-a-string, oversize body, or "no
 * payload at all" — see {@link payloadIsEmpty}) so the caller can drop
 * the frame without crashing the socket.
 *
 * P5.1 — `body` may now be the empty string when `attachments` is
 * non-empty. The composer enables Send on `draft.trim().length > 0 ||
 * attachments.length > 0` (InputComposer.tsx) — before this change the
 * gateway hard-rejected the attachments-only case, dropping the send
 * silently. Closes Argus r1 BLOCKING #2.
 */
export function decodeAppWsInbound(raw: unknown): AppWsInbound | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'user_message') return null
  const body = e['body']
  if (typeof body !== 'string') return null
  if (body.length > MAX_USER_MESSAGE_LEN) return null
  const cleaned_attachments = sanitizeAttachments(e['attachments'])
  // P5.1 — require at least one of body or attachments. The composer
  // gates Send on (body.trim().length > 0 || attachments.length > 0)
  // so allowing both empty here would re-enable the original "missing
  // body" 1006 the bubble-failed regression rode in on.
  if (payloadIsEmpty(body, cleaned_attachments)) return null
  const out: AppWsInboundUserMessage = { v: 1, type: 'user_message', body }
  const client_msg_id = e['client_msg_id']
  if (typeof client_msg_id === 'string' && client_msg_id.length > 0 && client_msg_id.length <= 128) {
    out.client_msg_id = client_msg_id
  }
  const cleaned_project_id = sanitizeProjectId(e['project_id'])
  if (cleaned_project_id !== null) {
    out.project_id = cleaned_project_id
  }
  if (cleaned_attachments !== null) {
    out.attachments = cleaned_attachments
  }
  return out
}

/**
 * Chat-sync foundation — decode a `{ v:1, type:'resume', after_seq:N }`
 * gap-fill control frame. Kept SEPARATE from {@link decodeAppWsInbound} (the
 * message decoder) so message-path consumers keep their narrow
 * `AppWsInboundUserMessage` type. Returns `null` for anything that isn't a
 * well-formed resume; `after_seq` is clamped to a non-negative integer so a
 * malformed cursor can't drive a negative / fractional replay query.
 */
export function decodeAppWsResume(raw: unknown): AppWsInboundResume | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'resume') return null
  const raw_after = e['after_seq']
  if (typeof raw_after !== 'number' || !Number.isFinite(raw_after)) return null
  return { v: 1, type: 'resume', after_seq: Math.max(0, Math.trunc(raw_after)) }
}

/**
 * Track B Phase 4 — decode a `{ v:1, type:'receipt', message_id, state:'read' }`
 * read-receipt control frame. SEPARATE from the message + resume decoders so
 * each path keeps its narrow type. Returns `null` for anything malformed. Only
 * `read` is accepted from clients (delivery is server-tracked). The device id
 * is intentionally NOT read from the frame — the surface attributes the receipt
 * to the socket's own device id, so a client can't forge another device's ack.
 */
export function decodeAppWsReceipt(raw: unknown): AppWsInboundReceipt | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'receipt') return null
  if (e['state'] !== 'read') return null
  const message_id = e['message_id']
  if (typeof message_id !== 'string' || message_id.length === 0 || message_id.length > 256) {
    return null
  }
  const out: AppWsInboundReceipt = { v: 1, type: 'receipt', message_id, state: 'read' }
  const raw_seq = e['seq']
  if (typeof raw_seq === 'number' && Number.isFinite(raw_seq)) {
    out.seq = Math.max(0, Math.trunc(raw_seq))
  }
  return out
}

/**
 * Track B Phase 4 — decode a
 * `{ v:1, type:'reaction', message_id, emoji, action:'add'|'remove' }` frame.
 * SEPARATE from the message / resume / receipt decoders so each path keeps its
 * narrow type. Returns `null` for anything malformed. The device id is
 * intentionally NOT read from the frame — the surface attributes the reaction
 * to the socket's own device id, so a client can't forge another device's
 * reaction. The emoji is validated by {@link sanitizeReactionEmoji}.
 */
export function decodeAppWsReaction(raw: unknown): AppWsInboundReaction | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'reaction') return null
  if (e['action'] !== 'add' && e['action'] !== 'remove') return null
  const message_id = e['message_id']
  if (typeof message_id !== 'string' || message_id.length === 0 || message_id.length > 256) {
    return null
  }
  const emoji = sanitizeReactionEmoji(e['emoji'])
  if (emoji === null) return null
  const out: AppWsInboundReaction = { v: 1, type: 'reaction', message_id, emoji, action: e['action'] }
  const raw_seq = e['seq']
  if (typeof raw_seq === 'number' && Number.isFinite(raw_seq)) {
    out.seq = Math.max(0, Math.trunc(raw_seq))
  }
  return out
}

/** Track B Phase 4 — max bytes for a reaction emoji. Generous enough for any
 *  single grapheme cluster (flags, skin-tone + ZWJ sequences) while bounding a
 *  malformed client from shipping arbitrary text as a "reaction". */
export const MAX_REACTION_EMOJI_LEN = 64

/**
 * Validate a reaction emoji from an untrusted source. Returns the cleaned value
 * or `null` (absent / malformed). Accepts a non-empty string up to
 * {@link MAX_REACTION_EMOJI_LEN} chars with NO ASCII control chars or
 * whitespace — i.e. a single emoji/grapheme, not a sentence. Deliberately does
 * NOT enforce a fixed allowlist: the client picks the palette, and a future
 * emoji shouldn't require a server change.
 */
export function sanitizeReactionEmoji(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0 || raw.length > MAX_REACTION_EMOJI_LEN) return null
  // Reject control chars (C0/C1) and any whitespace — a reaction is one glyph,
  // never multi-token text. Char-code scan avoids fiddly char-class ranges.
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x20 || (code >= 0x7f && code <= 0xa0)) return null
    if (/\s/u.test(ch)) return null
  }
  return raw
}

/**
 * Track B Phase 4 (edit/delete) — decode a
 * `{ v:1, type:'edit', message_id, action:'edit'|'delete', body? }` frame.
 * SEPARATE from the message / resume / receipt / reaction decoders so each path
 * keeps its narrow type. Returns `null` for anything malformed. The editor
 * device id is intentionally NOT read from the frame — the surface attributes
 * the mutation to the socket's own device id and authorizes it against the
 * message's author, so a client can't forge an edit as another party. An `edit`
 * REQUIRES a non-empty body bounded by {@link MAX_USER_MESSAGE_LEN}; a `delete`
 * ignores any body.
 */
export function decodeAppWsEdit(raw: unknown): AppWsInboundEdit | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'edit') return null
  if (e['action'] !== 'edit' && e['action'] !== 'delete') return null
  const message_id = e['message_id']
  if (typeof message_id !== 'string' || message_id.length === 0 || message_id.length > 256) {
    return null
  }
  const action = e['action']
  const out: AppWsInboundEdit = { v: 1, type: 'edit', message_id, action }
  if (action === 'edit') {
    const body = e['body']
    if (typeof body !== 'string') return null
    if (body.length === 0 || body.length > MAX_USER_MESSAGE_LEN) return null
    out.body = body
  }
  const raw_seq = e['seq']
  if (typeof raw_seq === 'number' && Number.isFinite(raw_seq)) {
    out.seq = Math.max(0, Math.trunc(raw_seq))
  }
  return out
}

/**
 * Onboarding consolidation (2026-06-26) — decode a
 * `{ v:1, type:'button_choice', prompt_id, choice_value, freeform_text? }` frame.
 * SEPARATE from the message / resume / receipt / reaction / edit decoders so each
 * path keeps its narrow type. Returns `null` for anything malformed. Lengths are
 * bounded so a malformed client can't push huge strings through the engine's
 * choice-resolution path; `freeform_text` reuses the user-message cap.
 */
export function decodeAppWsButtonChoice(raw: unknown): AppWsInboundButtonChoice | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'button_choice') return null
  const prompt_id = e['prompt_id']
  if (typeof prompt_id !== 'string' || prompt_id.length === 0 || prompt_id.length > 256) {
    return null
  }
  const choice_value = e['choice_value']
  if (typeof choice_value !== 'string' || choice_value.length === 0 || choice_value.length > 512) {
    return null
  }
  const out: AppWsInboundButtonChoice = { v: 1, type: 'button_choice', prompt_id, choice_value }
  const freeform_text = e['freeform_text']
  if (typeof freeform_text === 'string' && freeform_text.length > 0) {
    if (freeform_text.length > MAX_USER_MESSAGE_LEN) return null
    out.freeform_text = freeform_text
  }
  return out
}

/**
 * P5.1 — predicate shared by the WS decoder and the HTTP `/api/app/chat/send`
 * handler so the empty-payload check has identical semantics on both
 * transports. A send is "empty" when the body has no non-whitespace content AND
 * no valid attachments rode along. Either one being non-empty is
 * sufficient to forward to the agent loop.
 *
 * TRIM PARITY (M1 E2E Round 2, 2026-06-29): the gate used raw `body.length`, so
 * a whitespace-only body ("   " / "\n") read as non-empty and was forwarded — but
 * the agent worker then trims it to '' and silently returns (no reply, no error),
 * leaving the user's whitespace bubble a dead-end. The official client gates Send
 * on `draft.trim()`, but the HTTP `/api/app/chat/send` endpoint and any malformed
 * / third-party client could hit it. Trim here so both transports reject exactly
 * the shape the worker rejects, keeping decode ⇄ worker parity.
 */
export function payloadIsEmpty(
  body: string,
  attachments: ReadonlyArray<string> | null | undefined,
): boolean {
  if (body.trim().length > 0) return false
  if (attachments !== null && attachments !== undefined && attachments.length > 0) {
    return false
  }
  return true
}

/** Conservative cap. Matches the landing chat's practical client behaviour. */
export const MAX_USER_MESSAGE_LEN = 16_384

/** P5.1 — max attachments per user_message envelope. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8
/** P5.1 — per-attachment URL byte cap (matches the gateway echo). */
export const MAX_ATTACHMENT_URL_LEN = 512

/**
 * P5.1 — sanitize `attachments` from an untrusted source. Returns the
 * cleaned array (always frozen) or `null` to mean "absent / malformed".
 * Rejects on: non-array, > MAX_ATTACHMENTS_PER_MESSAGE entries,
 * non-string entries, entries > MAX_ATTACHMENT_URL_LEN chars, or
 * entries that don't start with `https?://` or `/`. The "starts with
 * /" form is reserved for gateway-relative URLs returned by the
 * upload endpoint (`/api/app/upload/<id>`).
 */
export function sanitizeAttachments(raw: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(raw)) return null
  if (raw.length === 0) return null
  if (raw.length > MAX_ATTACHMENTS_PER_MESSAGE) return null
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') return null
    if (entry.length === 0 || entry.length > MAX_ATTACHMENT_URL_LEN) return null
    if (!/^(https?:\/\/|\/)/.test(entry)) return null
    out.push(entry)
  }
  return Object.freeze(out)
}

/**
 * P5.2 — bound the project_id field so a malformed client (or attacker)
 * can't push huge strings through the gateway's per-message state.
 * Project ids in the gateway are instance-scoped uuids (or short slugs);
 * 128 chars is generous.
 */
export const MAX_PROJECT_ID_LEN = 128

/**
 * Validate a project_id from an untrusted source (query string or
 * HTTP body). Returns the cleaned value or `null` to mean "absent or
 * malformed". Callers treat both the same — the surface stashes
 * `undefined` on the session, so subsequent echoes omit project_id.
 */
export function sanitizeProjectId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0 || raw.length > MAX_PROJECT_ID_LEN) return null
  // Allow letters, digits, underscores, hyphens, and dots so slug and
  // uuid forms both pass. Reject control chars, quotes, slashes, etc.
  if (!/^[A-Za-z0-9_.-]+$/.test(raw)) return null
  return raw
}

/**
 * Validate a client `platform` flag from the WS upgrade query string
 * or HTTP send body. Used by the surface to route per-session
 * doc-link rendering ('web' → https://app.example.test/projects/
 * <id>/docs?path=..., 'native' → neutron://docs/...). Argus BLOCKING #2.
 */
export function sanitizePlatform(raw: unknown): 'web' | 'native' | null {
  if (raw === 'web' || raw === 'native') return raw
  return null
}

/** Track B Phase 4 — bound the device_id reported on the WS upgrade query
 *  string. Client-minted (a uuid or short opaque token); 128 chars is ample. */
export const MAX_DEVICE_ID_LEN = 128

/**
 * Validate a device_id from the untrusted upgrade query string. Returns the
 * cleaned value or `null` (absent / malformed → the surface mints a synthetic
 * per-connection id so receipt attribution still works, it just isn't stable
 * across reconnects for that client). Same charset as project ids.
 */
export function sanitizeDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0 || raw.length > MAX_DEVICE_ID_LEN) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(raw)) return null
  return raw
}

/** Track B Phase 4 — synthetic device id the gateway attributes to the agent
 *  loop when it reads (picks up) an inbound user message. Lets a single-device
 *  sender see the read tick the moment the agent acts, with no second device.
 *  Mirrors `@neutron/chat-core`'s `AGENT_DEVICE_ID`; the wire value is the bare
 *  string `agent`. */
export const AGENT_DEVICE_ID = 'agent'

/** Synthetic `channel_topic_id` for an Expo session. */
export function appWsTopicId(user_id: string): string {
  return `app:${user_id}`
}

/**
 * Per-project `channel_topic_id` for a web session — `app:<user_id>:<project_id>`.
 * The web React client opens ONE socket per active project (reconnecting on a
 * project switch) so persistence + seq + resume + fan-out all scope to this
 * per-project topic string; General stays on the user-scoped {@link appWsTopicId}.
 * User-scoped (NOT a bare `wow-shell-<id>`) so two users opening the same project
 * never share a transcript — mirrors the proven `landing/server.ts`
 * `web:<user>:<project>` model. Mobile keeps the single `app:<user>` socket +
 * `project_id`-field switch model (it does NOT use this), so per-project binding
 * is gated on `platform === 'web'` at the surface.
 */
export function appWsProjectTopicId(user_id: string, project_id: string): string {
  return `app:${user_id}:${project_id}`
}

/** Parse `app:<user_id>` back to `user_id`. Returns `null` on mismatch. */
export function parseAppWsTopicId(topic_id: string): string | null {
  if (!topic_id.startsWith('app:')) return null
  const user_id = topic_id.slice('app:'.length)
  return user_id.length > 0 ? user_id : null
}
