/**
 * landing/chat-react — `NeutronChatController`: the framework-agnostic data
 * layer that bridges `@neutron/chat-core`'s `WebChatSession` to the
 * assistant-ui `ExternalStoreRuntime`.
 *
 * Why a controller and not "just a hook": the defining Telegram-grade
 * behaviours (optimistic send, gap-free reconnect, durable transcript) all
 * live in `WebChatSession` / the sync engine — but assistant-ui needs (a) a
 * synchronous, snapshot-able view-model and (b) the EPHEMERAL frames the sync
 * layer deliberately drops: `agent_message_partial` (token streaming) and the
 * implicit "agent is replying" typing state. This controller owns exactly that
 * glue:
 *
 *   - it subscribes to the session's `onChange` (durable transcript changed),
 *     `onStatus` (connection), and `onFrame` (raw stream — added additively to
 *     chat-core for this surface);
 *   - it accumulates streaming partials into a live, not-yet-persisted agent
 *     bubble, which the final `agent_message` (persisted via the Store) then
 *     supersedes — so there is never a duplicate and never a flash;
 *   - it derives `isRunning` (the typing indicator) from "a send is awaiting a
 *     reply OR a stream is in flight";
 *   - it caches a synchronous {@link ChatViewModel} the React layer reads.
 *
 * The session is injected via a factory so the whole controller unit-tests
 * against a fake session + hand-fed frames — i.e. real integration coverage
 * over the chat-core contract without a DOM or a socket.
 */

import { groupReactions } from '@neutron/chat-core'

import type { ProjectTab } from './config.ts'
import { parseWorkBoardItems, type WorkBoardItem } from './work-board-client.ts'
import type {
  ChatMessage,
  ChatMessageOption,
  ChatMessageUploadAffordance,
  ConnStatus,
  PromptKind,
  ReactionAction,
  ReactionChip,
  SendStatus,
} from '@neutron/chat-core'

export type RenderRole = 'user' | 'agent'

/**
 * Track B Phase 4 — the per-message delivery ladder for an outbound (user)
 * message: 🕓 pending → ✓ sent → ✓✓ delivered → ✓✓ read (blue). Mirrors the
 * mobile `DeliveryState`; redefined here so the browser bundle doesn't pull in
 * the RN `app/` package.
 */
export type DeliveryState = 'pending' | 'sent' | 'delivered' | 'read'

/**
 * BUG 3 (live history-import progress) — the in-flight state of a ChatGPT/Claude
 * history import, derived from the server's `import_progress` frame (emitted
 * every ~5s while the job runs). Drives a live spinner + progress line so a long
 * import visibly works instead of stalling at a one-shot "received" banner.
 * Null when no import is in flight. There is NO terminal `import_progress` frame
 * — the engine advances the onboarding phase + sends the analysis `agent_message`
 * on completion — so the controller clears this on a terminal status (defensive)
 * OR when frames go stale (no tick for {@link NeutronChatControllerOptions.importProgressStaleMs}).
 */
export interface ImportProgressVM {
  /** `import_jobs.job_id` — correlates to the upload that started the import. */
  jobId: string
  /** Raw job status: queued | pass1-running | pass2-running | rate_limit_* . */
  status: string
  /** Pass 1 (scan) or Pass 2 (synthesis). */
  pass: 1 | 2
  /** 0..1 completion estimate for the current pass. */
  pct: number
  /** Human-readable line, e.g. "Pass 1: 47/57 batches · ~3 min remaining". */
  body: string
}

export interface RenderMessage {
  /** Stable identity: client_msg_id for user sends, message_id for agent /
   *  streaming bubbles. Drives assistant-ui's message keying. */
  id: string
  /** Track B Phase 4 — the server message id (null until acked / for a
   *  streaming bubble). Reactions are keyed by this, NOT the render `id`
   *  (which is the client_msg_id for user sends). */
  messageId: string | null
  role: RenderRole
  text: string
  status: SendStatus
  /** True for an in-flight streamed agent bubble (no persisted row yet). */
  streaming: boolean
  attachments: readonly string[] | null
  createdAt: number
  /** Delivery ladder for user messages (null for agent / streaming bubbles). */
  delivery: DeliveryState | null
  /** Track B Phase 4 — per-emoji reaction chips for this message (empty when
   *  none). `reactedBySelf` marks chips this client added. */
  reactions: ReactionChip[]
  /** Track B Phase 4 (edit/delete) — true when this message has been edited
   *  (shows an "edited" marker). Always false for a deleted message. */
  edited: boolean
  /** Track B Phase 4 (edit/delete) — true when this message is tombstoned;
   *  the UI renders a "message deleted" placeholder instead of the body. */
  deleted: boolean
  /** P1b (onboarding / quick-reply buttons) — selectable options below an agent
   *  message's body (empty/null when none). */
  options: readonly ChatMessageOption[] | null
  /** P1b — outstanding-prompt id a chosen option is posted back against. */
  promptId: string | null
  /** P1b — whether a free-text reply is allowed alongside the buttons. */
  allowFreeform: boolean | null
  /** P1b — render mode for {@link options} (`buttons` default vs gallery). */
  kind: PromptKind | null
  /** P1b — upload affordance for an onboarding import phase (null when none). */
  uploadAffordance: ChatMessageUploadAffordance | null
  /** P1b — the option `value` this client has tapped (optimistic): the row
   *  collapses/greys once set. Local-only UI state, never persisted. */
  chosenValue: string | null
}

export interface ChatViewModel {
  messages: RenderMessage[]
  /** Typing/streaming indicator — true while awaiting or streaming a reply. */
  isRunning: boolean
  /**
   * BUG 7 — true ONLY while a reply is pending and NOTHING has streamed yet
   * (no live streaming bubble). The typing indicator renders off THIS, not
   * `isRunning`: once a streaming bubble exists it IS the pending affordance,
   * so co-rendering the dots would stack an (often momentarily empty) bubble
   * above the typing dots. Distinct from `isRunning`, which also stays true
   * during streaming so the composer shows Stop.
   */
  awaitingFirstToken: boolean
  status: ConnStatus
  /** Count of sends still queued/unacked (offline tail). */
  pending: number
  projectId: string | null
  /**
   * The owner's project list for the rail. Seeded from the page bootstrap and
   * refreshed LIVE when the server fans a `projects_changed` frame (FIX 1) — so
   * projects created mid-onboarding appear without a reload. Reactive (on the
   * VM) rather than read from the static bootstrap config.
   */
  projects: ProjectTab[]
  /** Track B Phase 4 — delivery state of the most recent user message, for a
   *  Telegram-style status line under the thread. Null when none sent. */
  latestUserDelivery: DeliveryState | null
  /** BUG 3 — live history-import progress (null when no import is in flight). */
  importProgress: ImportProgressVM | null
}

/** The slice of `WebChatSession` the controller depends on (injectable). */
export interface ControllerSession {
  start(): void
  stop(): void
  setActive(active: boolean): void
  status(): ConnStatus
  send(
    body: string,
    opts?: { client_msg_id?: string; project_id?: string; attachments?: readonly string[] },
  ): Promise<void>
  messages(): Promise<ChatMessage[]>
  pendingCount(): Promise<number>
  /** Track B Phase 4 — report read messages (optional so legacy fakes still
   *  satisfy the interface). */
  markRead?(messageIds: readonly string[]): void
  /** Track B Phase 4 — add/remove an emoji reaction (optional so legacy fakes
   *  still satisfy the interface). */
  react?(messageId: string, emoji: string, action: ReactionAction): boolean
  /** Track B Phase 4 (edit/delete) — edit / delete a message the client
   *  authored (optional so legacy fakes still satisfy the interface). */
  editMessage?(messageId: string, body: string): boolean
  deleteMessage?(messageId: string): boolean
  /** P1b (onboarding / quick-reply buttons) — post a tapped option back to the
   *  server (optional so legacy fakes still satisfy the interface). */
  sendButtonChoice?(promptId: string, choiceValue: string, freeformText?: string): boolean
  /** This client's device id, for read-tick self-exclusion (optional). */
  readonly device_id?: string
}

/** Sinks the controller hands to the session factory so it can observe it. */
export interface ControllerSinks {
  onChange: () => void
  onStatus: (status: ConnStatus) => void
  onFrame: (frame: unknown) => void
}

/**
 * The active conversation scope a session is bound to: the durable store key +
 * WS topic (`topicId`) and the project it represents (`projectId`, null =
 * General). The controller hands this to the session factory so each project
 * gets its OWN socket + transcript; switching projects recreates the session
 * with a new scope.
 */
export interface SessionScope {
  topicId: string
  projectId: string | null
}

export interface NeutronChatControllerOptions {
  /** Build a session bound to `scope` (its topic + project). Called once at
   *  construction and again on every project switch (a fresh per-project
   *  socket). */
  createSession: (sinks: ControllerSinks, scope: SessionScope) => ControllerSession
  /** Map an active project (null = General) to its durable store key + WS topic
   *  (`app:<user>` for General, `app:<user>:<project>` for a project). Optional:
   *  when omitted, a deterministic per-project fallback is used (sufficient for
   *  tests that inject their own fake session; production wires the real one in
   *  `main.tsx`). */
  topicForProject?: (projectId: string | null) => string
  projectId?: string | null
  /** Initial project list from the page bootstrap (FIX 1 — kept reactive). */
  projects?: ProjectTab[]
  /**
   * BUG 3 — how long (ms) a live import-progress indicator persists after the
   * LAST `import_progress` frame before it auto-clears. Frames arrive every ~5s
   * while the job runs (including during rate-limit pauses), so a gap this long
   * means `import_running` ended (the analysis message has/will land). Defaults
   * to 12000 (≈2 missed ticks). Injectable so tests don't wait on a real timer.
   */
  importProgressStaleMs?: number
}

interface StreamEntry {
  text: string
  createdAt: number
}

export class NeutronChatController {
  /** The live session — REPLACED on every project switch (not readonly). */
  private session: ControllerSession
  /** Factory + topic mapper retained so a project switch can stand up a fresh
   *  per-project session bound to the new scope. */
  private readonly createSessionFn: (sinks: ControllerSinks, scope: SessionScope) => ControllerSession
  private readonly topicForProject: (projectId: string | null) => string
  /** The observer sinks, built ONCE and reused across session recreations. */
  private readonly sinks: ControllerSinks
  /** Lifecycle latches so a project switch revives the new session in the same
   *  started/active state as the one it replaced. */
  private started = false
  private activeState = true
  private msgs: ChatMessage[] = []
  /** message_id → accumulated streaming text (not yet persisted). */
  private readonly streaming = new Map<string, StreamEntry>()
  /**
   * Ephemeral agent-style notices the sync layer never persists: slash-command
   * results (`chat_command_result`) and surfaced `error` frames. The app-ws
   * surface answers a matched chat command with exactly ONE
   * `chat_command_result` frame and SKIPS the agent dispatch — so no
   * `agent_message` ever follows. Without rendering it the typing indicator
   * spins forever (the awaiting bracket is never cleared) AND the command's
   * output is silently lost. These live only for the controller's lifetime;
   * the server doesn't persist them to the transcript either, so they vanish
   * on reload — matching the server's own non-persistence.
   */
  private readonly notices: RenderMessage[] = []
  private connStatus: ConnStatus = 'idle'
  private awaitingReply = false
  private pending = 0
  private projectId: string | null
  /** FIX 1 — reactive project list (seeded from bootstrap, updated on frame). */
  private projects: ProjectTab[]
  private readonly listeners = new Set<(vm: ChatViewModel) => void>()
  /**
   * Work Board live-frame subscribers (the `WorkBoardTab`). Kept SEPARATE from
   * the `vm` listeners so a `work_board_changed` frame re-renders only the board
   * tab, never the whole chat view — mirrors the `projects_changed` apply but
   * out-of-band of the chat ViewModel (the board isn't chat state).
   */
  private readonly workBoardListeners = new Set<
    (items: WorkBoardItem[], projectId: string | undefined) => void
  >()
  /** Last board snapshot seen on a frame, replayed to a late subscriber. */
  private lastWorkBoard: WorkBoardItem[] | null = null
  /** The project the cached snapshot belongs to (the frame's `project_id`), so a
   *  late subscriber for a DIFFERENT project isn't replayed the wrong board. */
  private lastWorkBoardProjectId: string | undefined = undefined
  private vm: ChatViewModel
  private seq = 0
  /** P1b — render id → the option `value` the user tapped (optimistic collapse). */
  private readonly chosen = new Map<string, string>()
  /** This client's device id (for read-tick self-exclusion). */
  private readonly deviceId: string
  /** BUG 3 — live import progress (null when no import is in flight). */
  private importProgress: ImportProgressVM | null = null
  /** BUG 3 — staleness timer that clears {@link importProgress} when frames stop. */
  private importProgressTimer: ReturnType<typeof setTimeout> | null = null
  private readonly importProgressStaleMs: number

  constructor(opts: NeutronChatControllerOptions) {
    this.projectId = opts.projectId ?? null
    this.projects = opts.projects ?? []
    this.importProgressStaleMs = opts.importProgressStaleMs ?? 12_000
    this.createSessionFn = opts.createSession
    this.topicForProject =
      opts.topicForProject ??
      ((projectId) =>
        projectId !== null && projectId.length > 0 ? `app:${projectId}` : 'app')
    this.sinks = {
      onChange: () => {
        void this.handleChange()
      },
      onStatus: (status) => this.handleStatus(status),
      onFrame: (frame) => this.handleFrame(frame),
    }
    this.session = this.createSessionFn(this.sinks, {
      projectId: this.projectId,
      topicId: this.topicForProject(this.projectId),
    })
    this.deviceId = this.session.device_id ?? ''
    this.vm = this.computeVm()
  }

  start(): void {
    this.started = true
    this.session.start()
    // Cold-open hydration: a durable Store (OPFS) may already hold the
    // transcript + queued offline sends from a previous session. Read it
    // immediately so a returning user sees their chat (and pending badge)
    // instantly on mount — NOT only after the next inbound frame / send. The
    // live `session_ready` resume still fills any gap once the socket opens.
    void this.handleChange()
  }

  stop(): void {
    this.started = false
    if (this.importProgressTimer !== null) {
      clearTimeout(this.importProgressTimer)
      this.importProgressTimer = null
    }
    this.session.stop()
  }

  setActive(active: boolean): void {
    this.activeState = active
    this.session.setActive(active)
  }

  getViewModel(): ChatViewModel {
    return this.vm
  }

  /**
   * Switch the active project. With per-project chat each project owns its OWN
   * app-ws topic + durable transcript, so a switch RE-SCOPES the session: the
   * current socket is torn down and a fresh one is bound to the new project's
   * topic (General = the user-scoped topic), then the new topic's history
   * hydrates from the shared store. The previous conversation's ephemeral state
   * (streaming bubble, typing bracket, command/error notices, import progress,
   * optimistic button choices) is reset so it can't bleed across. A no-op when
   * the project is unchanged.
   */
  setProject(projectId: string | null): void {
    if (projectId === this.projectId) return
    // Tear down the outgoing per-project socket.
    this.session.stop()
    this.projectId = projectId
    // Reset per-CONVERSATION state — the new topic hydrates its own transcript.
    this.streaming.clear()
    this.notices.length = 0
    this.chosen.clear()
    this.awaitingReply = false
    this.msgs = []
    this.pending = 0
    this.lastWorkBoard = null
    this.lastWorkBoardProjectId = undefined
    if (this.importProgressTimer !== null) {
      clearTimeout(this.importProgressTimer)
      this.importProgressTimer = null
    }
    this.importProgress = null
    // Stand up the session bound to the new scope, mirroring the current
    // started/active lifecycle so the new socket opens iff the controller is
    // running.
    this.session = this.createSessionFn(this.sinks, {
      projectId,
      topicId: this.topicForProject(projectId),
    })
    if (this.started) {
      this.session.start()
      this.session.setActive(this.activeState)
    }
    // Publish the empty/scoped VM immediately (instant switch feel), then
    // hydrate the new topic's durable transcript.
    this.publish()
    void this.handleChange()
  }

  subscribe(fn: (vm: ChatViewModel) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /**
   * Subscribe to live Work Board snapshots (`work_board_changed` frames). The
   * callback fires with the full board (active+next first, then completed) AND
   * the frame's `project_id` (or `undefined` when the frame omits it) on every
   * committed board mutation — agent tool OR human HTTP write, both ride the same
   * server push. The subscriber MUST drop a snapshot whose project_id doesn't
   * match the tab it's mounted for (the app-ws topic is per-user, so a sibling
   * project's board can arrive on this socket). If a snapshot has already
   * arrived, the new subscriber is replayed it synchronously (with its
   * project_id) so a tab mounted AFTER the frame doesn't miss it. Returns an
   * unsubscribe fn. Full-snapshot + idempotent, so the tab can replace its list
   * outright (no delta merge).
   */
  onWorkBoardChanged(
    fn: (items: WorkBoardItem[], projectId: string | undefined) => void,
  ): () => void {
    this.workBoardListeners.add(fn)
    if (this.lastWorkBoard !== null) fn(this.lastWorkBoard, this.lastWorkBoardProjectId)
    return () => {
      this.workBoardListeners.delete(fn)
    }
  }

  /**
   * Optimistically send a user message. Sets the typing indicator immediately
   * (so the UI feels instant), tags it with the active project, and lets the
   * session own the durable enqueue + flush. The optimistic bubble renders via
   * the session's `onChange`.
   */
  async send(body: string, attachments?: readonly string[]): Promise<void> {
    this.awaitingReply = true
    this.publish()
    const opts: { project_id?: string; attachments?: readonly string[] } = {}
    if (this.projectId !== null && this.projectId.length > 0) opts.project_id = this.projectId
    if (attachments !== undefined && attachments.length > 0) opts.attachments = attachments
    await this.session.send(body, opts)
  }

  private handleStatus(status: ConnStatus): void {
    this.connStatus = status
    this.publish()
  }

  private handleFrame(frame: unknown): void {
    if (typeof frame !== 'object' || frame === null) return
    const f = frame as Record<string, unknown>
    const type = f['type']
    if (type === 'agent_message_partial') {
      const messageId = f['message_id']
      const delta = f['body_delta']
      if (typeof messageId !== 'string' || messageId.length === 0) return
      if (typeof delta !== 'string') return
      const existing = this.streaming.get(messageId)
      if (existing === undefined) {
        // BUG 7 — some turns open the stream with a leading ZERO-LENGTH delta.
        // Materializing a streaming bubble for it renders an EMPTY agent bubble
        // above the typing indicator. Ignore the empty opener: keep the
        // "awaiting" bracket (so the typing dots stay) until a real token lands,
        // and only then create the bubble.
        if (delta.length === 0) return
        // A real token has begun — clear the "awaiting" bracket.
        this.awaitingReply = false
        this.streaming.set(messageId, { text: delta, createdAt: this.nextSeq() })
      } else {
        this.awaitingReply = false
        existing.text += delta
      }
      this.publish()
      return
    }
    if (type === 'agent_message') {
      // The final message persists via the Store (a following onChange); clear
      // the awaiting bracket now so the indicator doesn't linger if no stream
      // ever arrived. The streaming buffer is pruned once the persisted row
      // shows up (see handleChange).
      this.awaitingReply = false
      this.publish()
      return
    }
    if (type === 'agent_typing') {
      // Server-authoritative typing indicator (ephemeral, never persisted). The
      // gateway fans `start` the moment it picks up a live-agent turn and `end`
      // when the turn settles (on success AND failure) — so a warm turn shows
      // the dots for its whole 5–240s duration instead of only the optimistic
      // on-send guess. We drive the SAME `awaiting` bracket the optimistic path
      // sets, so the existing `car-typing` indicator (keyed off
      // awaitingFirstToken) lights up; the optimistic-on-send set stays as a
      // fallback for a missed `start`. A stray frame tagged for a DIFFERENT
      // project than the active one must not flip this surface's indicator.
      if (this.isForeignProject(f['project_id'])) return
      const state = f['state']
      if (state === 'start') {
        // Idempotent — back-to-back starts just keep the bracket on.
        this.awaitingReply = true
        this.publish()
      } else if (state === 'end') {
        // Clear the bracket. A live streaming bubble (if one is in flight)
        // already supersedes the dots via awaitingFirstToken, so this is a
        // no-op there; the next `agent_message` clears it regardless, so a
        // dropped `end` can never wedge the indicator.
        this.awaitingReply = false
        this.publish()
      }
      return
    }
    if (type === 'error') {
      // Clear the awaiting bracket AND surface the failure as a visible notice.
      // Previously the spinner cleared but nothing was shown, leaving the user's
      // message a silent dead-end. The common LLM-failure path ships a friendly
      // `agent_message` (not an `error` frame), so this only renders the genuine
      // surface errors (button_choice_failed, dispatch_failed, malformed_envelope,
      // resume_failed) — matching the Expo native client, which already appends a
      // system bubble for `error` frames.
      this.awaitingReply = false
      const msg = typeof f['message'] === 'string' ? (f['message'] as string) : ''
      const code = typeof f['code'] === 'string' ? (f['code'] as string) : ''
      const body =
        msg.length > 0
          ? msg
          : code.length > 0
            ? `Something went wrong (${code}).`
            : 'Something went wrong.'
      this.pushNotice(body)
      return
    }
    if (type === 'chat_command_result') {
      // A matched slash command (/note, /remind, /cal, /skills, …): the server
      // answers with exactly ONE result frame and does NOT dispatch the agent,
      // so no `agent_message` will follow. Clear the awaiting bracket (else the
      // typing dots spin forever) and render the result text as an agent-style
      // bubble (else the command's output is silently lost). `text` is set for
      // both success and error responses; fall back to the error message only
      // when text is empty.
      this.awaitingReply = false
      const text = typeof f['text'] === 'string' ? (f['text'] as string) : ''
      const err = f['error']
      const errMsg =
        typeof err === 'object' && err !== null && typeof (err as Record<string, unknown>)['message'] === 'string'
          ? ((err as Record<string, unknown>)['message'] as string)
          : ''
      const body = text.length > 0 ? text : errMsg.length > 0 ? errMsg : 'Command completed.'
      this.pushNotice(body)
      return
    }
    if (type === 'import_progress') {
      // BUG 3 — live history-import progress. The engine emits this every ~5s
      // while the import job runs; render a live spinner + progress line off it.
      // Terminal statuses normally DON'T arrive here (the engine advances the
      // phase + sends the analysis agent_message instead), but clear defensively
      // if one does. Otherwise refresh the progress + (re)arm the staleness timer.
      const status = typeof f['status'] === 'string' ? (f['status'] as string) : ''
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        this.clearImportProgress()
        return
      }
      const jobId = typeof f['job_id'] === 'string' ? (f['job_id'] as string) : ''
      const pass: 1 | 2 = f['pass'] === 2 ? 2 : 1
      const rawPct = f['pct']
      const pct =
        typeof rawPct === 'number' && Number.isFinite(rawPct) ? Math.min(1, Math.max(0, rawPct)) : 0
      const body = typeof f['body'] === 'string' ? (f['body'] as string) : ''
      this.importProgress = { jobId, status, pass, pct, body }
      this.armImportProgressStaleTimer()
      this.publish()
      return
    }
    // FIX 1 — a live project-list refresh (projects created/changed mid-session,
    // e.g. during onboarding). Replace the RAIL's list only — projects appear in
    // the persistent left rail the moment onboarding mints them. With per-project
    // chat we deliberately do NOT auto-switch the chat into the new project on
    // this 0→N transition: the onboarding conversation runs on the General topic,
    // and re-scoping the socket mid-onboarding would yank the user into an empty
    // project chat and drop the still-arriving onboarding messages. The user
    // enters a project by tapping it in the rail (an explicit `setProject`).
    // Work Board live snapshot — the server fans the FULL board after every
    // committed mutation (agent tool or human HTTP write). Parse + cache it and
    // fan it to the board-tab subscribers ONLY (out-of-band of the chat vm).
    if (type === 'work_board_changed') {
      const items = parseWorkBoardItems(f['items'])
      const framePid =
        typeof f['project_id'] === 'string' && (f['project_id'] as string).length > 0
          ? (f['project_id'] as string)
          : undefined
      this.lastWorkBoard = items
      this.lastWorkBoardProjectId = framePid
      for (const fn of this.workBoardListeners) {
        try {
          fn(items, framePid)
        } catch {
          /* a throwing tab callback must not wedge the frame loop */
        }
      }
      return
    }
    if (type === 'projects_changed') {
      const raw = Array.isArray(f['projects']) ? (f['projects'] as unknown[]) : []
      const projects: ProjectTab[] = []
      for (const p of raw) {
        if (typeof p !== 'object' || p === null) continue
        const rec = p as Record<string, unknown>
        const id = rec['id']
        const label = rec['label']
        if (typeof id === 'string' && id.length > 0 && typeof label === 'string') {
          projects.push({ id, label })
        }
      }
      // Refresh the rail list; the active conversation is NOT changed here (see
      // the note above — per-project chat enters a project only via an explicit
      // `setProject`, which re-scopes the socket).
      this.projects = projects
      this.publish()
    }
  }

  private async handleChange(): Promise<void> {
    const [msgs, pending] = await Promise.all([this.session.messages(), this.session.pendingCount()])
    this.msgs = msgs
    this.pending = pending
    // Drop any streaming buffer whose final message has now persisted, so the
    // durable row (with its seq + metadata) supersedes the live bubble.
    if (this.streaming.size > 0) {
      const persistedIds = new Set<string>()
      for (const m of msgs) if (m.message_id !== null) persistedIds.add(m.message_id)
      for (const id of [...this.streaming.keys()]) {
        if (persistedIds.has(id)) this.streaming.delete(id)
      }
    }
    this.markVisibleAgentRead(msgs)
    this.publish()
  }

  /**
   * Track B Phase 4 — report agent messages as read. The web chat is a single
   * scrolling thread the user is looking at, so a persisted agent message is
   * "read"; the session de-dups so this only sends one receipt per message.
   * Reporting ONLY agent messages (never the user's own sends) means a receipt
   * can't light the sender's own read tick.
   */
  private markVisibleAgentRead(msgs: ChatMessage[]): void {
    if (this.session.markRead === undefined) return
    const ids: string[] = []
    for (const m of msgs) {
      if (m.role === 'agent' && m.message_id !== null) ids.push(m.message_id)
    }
    if (ids.length > 0) this.session.markRead(ids)
  }

  /** Report messages the user has viewed (Track B Phase 4). Exposed for a UI
   *  that wants finer-grained viewport reporting than the auto-read above. */
  markRead(messageIds: readonly string[]): void {
    this.session.markRead?.(messageIds)
  }

  /**
   * Track B Phase 4 — toggle an emoji reaction on a message. `add` / `remove`
   * is sent to the server, which fans the authoritative `reaction_update` back
   * (applied via the session's `onChange`). A no-op when the session predates
   * reactions (legacy fake) or the message id is empty.
   */
  react(messageId: string, emoji: string, action: ReactionAction): void {
    if (messageId.length === 0 || emoji.length === 0) return
    this.session.react?.(messageId, emoji, action)
  }

  /**
   * Track B Phase 4 (edit/delete) — edit a message's body. The server
   * authorizes it against the message's author and fans the authoritative
   * `edit_update` back (applied via `onChange`). A no-op when the session
   * predates edits (legacy fake), the id is empty, or the body is blank.
   */
  editMessage(messageId: string, body: string): void {
    if (messageId.length === 0 || body.trim().length === 0) return
    this.session.editMessage?.(messageId, body.trim())
  }

  /**
   * Track B Phase 4 (edit/delete) — delete (tombstone) a message. The server
   * authorizes + fans an `edit_update` with `deleted:true` back. A no-op when
   * the session predates edits or the id is empty.
   */
  deleteMessage(messageId: string): void {
    if (messageId.length === 0) return
    this.session.deleteMessage?.(messageId)
  }

  /**
   * P1b (onboarding / quick-reply buttons) — handle a tapped option. Posts the
   * choice back to the server via {@link ControllerSession.sendButtonChoice}
   * (when a prompt id is present — the wire frame needs it to route), then
   * records the chosen `value` locally keyed by the render id so the option row
   * collapses/greys optimistically on the next render. Mirrors the Expo app's
   * `record_choice` reducer action. A no-op for an empty value.
   */
  onChoose(messageId: string, promptId: string | null, value: string): void {
    if (messageId.length === 0 || value.length === 0) return
    if (promptId !== null && promptId.length > 0) {
      this.session.sendButtonChoice?.(promptId, value)
    }
    this.chosen.set(messageId, value)
    this.publish()
  }

  /**
   * Append an ephemeral agent-style notice (slash-command result / surfaced
   * error) and republish. Ordered with live streams via the shared `seq`
   * counter so a notice and a streamed reply interleave by arrival.
   */
  private pushNotice(text: string): void {
    const seq = this.nextSeq()
    this.notices.push({
      id: `notice:${seq}`,
      messageId: null,
      role: 'agent',
      text,
      status: 'sent',
      streaming: false,
      attachments: null,
      createdAt: seq,
      delivery: null,
      reactions: [],
      edited: false,
      deleted: false,
      options: null,
      promptId: null,
      allowFreeform: null,
      kind: null,
      uploadAffordance: null,
      chosenValue: null,
    })
    this.publish()
  }

  /** BUG 3 — (re)arm the timer that clears stale import progress once frames
   *  stop arriving (job ended / socket gap). */
  private armImportProgressStaleTimer(): void {
    if (this.importProgressTimer !== null) clearTimeout(this.importProgressTimer)
    this.importProgressTimer = setTimeout(() => {
      this.importProgressTimer = null
      if (this.importProgress !== null) {
        this.importProgress = null
        this.publish()
      }
    }, this.importProgressStaleMs)
  }

  /** BUG 3 — clear live import progress + cancel its staleness timer. */
  private clearImportProgress(): void {
    if (this.importProgressTimer !== null) {
      clearTimeout(this.importProgressTimer)
      this.importProgressTimer = null
    }
    if (this.importProgress !== null) {
      this.importProgress = null
      this.publish()
    }
  }

  private publish(): void {
    this.vm = this.computeVm()
    for (const fn of this.listeners) fn(this.vm)
  }

  private computeVm(): ChatViewModel {
    const rendered: RenderMessage[] = this.msgs.map((m) => {
      const id = m.client_msg_id.length > 0 ? m.client_msg_id : (m.message_id ?? `seq:${m.seq ?? 0}`)
      return {
        id,
        messageId: m.message_id,
        role: m.role,
        text: m.body,
        status: m.status,
        streaming: false,
        attachments: m.attachments,
        createdAt: m.created_at,
        delivery: deliveryFor(m, this.deviceId),
        reactions: groupReactions(m.reactions, this.deviceId),
        edited: m.deleted !== true && m.edited_at !== null && m.edited_at !== undefined,
        deleted: m.deleted === true,
        // P1b (onboarding / quick-reply buttons) — surface the agent-message
        // option metadata + this client's optimistic choice onto the VM.
        options: m.options ?? null,
        promptId: m.prompt_id ?? null,
        allowFreeform: m.allow_freeform ?? null,
        kind: m.kind ?? null,
        uploadAffordance: m.upload_affordance ?? null,
        chosenValue: this.chosen.get(id) ?? null,
      }
    })
    // Append live streaming bubbles whose final message hasn't persisted yet.
    const persistedIds = new Set<string>()
    for (const m of this.msgs) if (m.message_id !== null) persistedIds.add(m.message_id)
    const liveStreams: RenderMessage[] = []
    for (const [messageId, entry] of this.streaming) {
      if (persistedIds.has(messageId)) continue
      // BUG 7 — never render an empty streaming bubble (defensive: handleFrame
      // already drops the leading empty-delta opener). An empty bubble would
      // stack above the typing indicator.
      if (entry.text.length === 0) continue
      liveStreams.push({
        id: `stream:${messageId}`,
        messageId,
        role: 'agent',
        text: entry.text,
        status: 'sent',
        streaming: true,
        attachments: null,
        createdAt: entry.createdAt,
        delivery: null,
        reactions: [],
        edited: false,
        deleted: false,
        options: null,
        promptId: null,
        allowFreeform: null,
        kind: null,
        uploadAffordance: null,
        chosenValue: null,
      })
    }
    // Tail = live streaming bubbles + ephemeral notices (command results /
    // errors), ordered together by arrival (`seq`) so a streamed reply and a
    // notice interleave correctly. Both sort AFTER the durable transcript.
    const tail = [...liveStreams, ...this.notices].sort((a, b) => a.createdAt - b.createdAt)
    const messages = [...rendered, ...tail]
    // Latest user message's delivery — for a Telegram-style status line.
    let latestUserDelivery: DeliveryState | null = null
    for (let i = rendered.length - 1; i >= 0; i--) {
      const r = rendered[i]
      if (r !== undefined && r.role === 'user') {
        latestUserDelivery = r.delivery
        break
      }
    }
    return {
      messages,
      isRunning: this.awaitingReply || liveStreams.length > 0,
      awaitingFirstToken: this.awaitingReply && liveStreams.length === 0,
      status: this.connStatus,
      pending: this.pending,
      projectId: this.projectId,
      projects: this.projects,
      latestUserDelivery,
      importProgress: this.importProgress,
    }
  }

  /** Monotonic local ordering key for streaming bubbles (no wall clock). */
  private nextSeq(): number {
    this.seq += 1
    return this.seq
  }

  /**
   * True when a frame is tagged for a DIFFERENT project than the active one.
   * Only fires when BOTH the frame and this surface carry an explicit project —
   * an unscoped frame (no `project_id`) or the General view (null active
   * project) always applies, matching the message frames, which don't scope at
   * all. Used to keep a stray `agent_typing` from flipping the wrong project's
   * indicator.
   */
  private isForeignProject(rawProjectId: unknown): boolean {
    if (typeof rawProjectId !== 'string' || rawProjectId.length === 0) return false
    if (this.projectId === null || this.projectId.length === 0) return false
    return rawProjectId !== this.projectId
  }
}

/**
 * Track B Phase 4 — derive an outbound message's delivery ladder from its send
 * status + read aggregate. Mirrors the mobile `deliveryState`: queued→pending,
 * sent→sent, acked→delivered, and acked→read once any device OTHER than this
 * one (incl. the synthetic `agent` reader) appears in `read_by`.
 */
export function deliveryFor(m: ChatMessage, selfDeviceId: string): DeliveryState | null {
  if (m.role !== 'user') return null
  if (m.status === 'queued') return 'pending'
  if (m.status === 'sent') return 'sent'
  const readBy = m.read_by
  if (readBy !== null && readBy !== undefined) {
    for (const id of readBy) {
      if (id.length > 0 && id !== selfDeviceId) return 'read'
    }
  }
  return 'delivered'
}
