/**
 * @neutronai/landing — WebSocket chat client.
 *
 * Bottom-anchored iMessage / Telegram / WhatsApp-Web layout. Sender-grouped
 * runs with avatars on the first agent bubble in a run, asymmetric "tail"
 * corner on the last bubble, run-trailing relative timestamp, "↓ N new"
 * multi-line auto-grow input.
 *
 * The protocol (AgentMessage / UserMessage / ButtonChoiceMessage /
 * RedirectMessage) is unchanged from the Sprint-21 minimal client so the
 * gateway bridge contract stays intact. Only the DOM rendering + autoscroll
 * state machine + composer surface evolved.
 */

import {
  uploadChunked,
  UploadChunkedError,
  type UploadChunkedOptions,
} from './upload-client.ts'
import { mountConnectPanel } from './connect-relay.ts'
import { renderMarkdown } from './markdown.ts'
import {
  decodeJwtSubClaim,
  decodeStartTokenUserId,
} from './start-token-topic-id.ts'

// Re-export so existing `import { decodeJwtSubClaim } from '.../chat.ts'`
// callers (landing tests) stay unchanged after the resolution logic moved
// into the dependency-free `./start-token-topic-id.ts` leaf.
export { decodeJwtSubClaim }

/**
 * Upload Resume Phase 2 — localStorage prefix used to cache active
 * `upload_id`s across page reloads so a mid-upload reload (Sam's 1.18 GB
 * ChatGPT export drop motivated this) can resume from the server's
 * Upload-Offset instead of restarting from byte 0.
 */
const UPLOAD_RESUME_LS_PREFIX = 'neutron.upload_resume.'

export interface ButtonOption {
  label: string
  body: string
  value: string
  /**
   * Sprint 28 Codex r6 P1 — when set, the option's renderable face
   * is a thumbnail at this URL (typically per-instance relative
   * `/profile-pic/candidate/<id>.png` for the portrait gallery). The
   * client renders an <img> instead of (or alongside) the text label
   * when the parent prompt's `kind` is `'image-gallery'`.
   */
  image_url?: string
}

/**
 * Chat-history hydration (2026-05-28 sprint) — wire shape returned
 * by `GET /api/v1/chat/history`. Server pre-computes
 * `resolution_text` (option-body lookup OR freeform text) so the
 * client doesn't need to ship `options_json` or duplicate the
 * lookup logic. The discriminated `resolved` flag lets the
 * renderer narrow exhaustively: a resolved turn always has a
 * non-null `resolution_text` (possibly empty string if the
 * stored row was malformed); an unresolved turn always has
 * `resolution_text: null`.
 *
 * Mirrors `channels/button-store.ts:ChatHistoryTurn`.
 */
export type ChatHistoryTurn = {
  prompt_id: string
  body: string
  created_at: number
} & (
  | { resolved: false; resolution_text: null }
  | { resolved: true; resolution_text: string }
)

/**
 * Local run-context carried across calls to
 * `openOrJoinHistoryRun` so consecutive same-sender historical
 * turns collapse into a single run the same way the live path
 * collapses adjacent live bubbles. Kept LOCAL to a single
 * `prependHistoryBatch` invocation; the live `this.currentRun*`
 * fields are untouched.
 */
interface HistoryRunContext {
  currentRun: HTMLElement | null
  currentRunSender: Sender | null
}

export interface AgentMessage {
  type: 'agent_message'
  body: string
  /**
   * Item 15 (2026-06-19) — the topic this message belongs to (stamped by
   * the live-agent reply path). When present AND it differs from the
   * focused topic, the client routes it to its OWN topic instead of
   * painting it into the focused view (cross-project bleed fix). Absent on
   * onboarding button-prompts → always rendered (back-compat).
   */
  topic_id?: string
  prompt_id?: string
  options?: ButtonOption[]
  allow_freeform?: boolean
  /**
   * Sprint 28 Codex r6 P1 — render hint. `'image-gallery'` tells the
   * client to render the options as a CSS-grid of clickable
   * thumbnails (`image_url` per option) instead of plain buttons.
   * Default (omitted) keeps every existing prompt at parity.
   */
  kind?: 'buttons' | 'image-gallery'
  /**
   * P2 v2 § 6.2 (S4) — upload-affordance envelope. When set, the
   * client renders a file-picker button below the chat input AND
   * enables a page-level drag-and-drop overlay that POSTs the file to
   * `/api/upload/<source>`. Cleared on the next inbound agent message
   * (per § 6.2 — the drag handlers only listen while phase ===
   * import_upload_pending).
   */
  upload_affordance?: { source: 'chatgpt' | 'claude' }
}

/**
 * P1.5 / Sprint 21 — slug-picker redirect envelope. After the user
 * picks their personal subdomain, the gateway emits this BEFORE
 * triggering the systemd restart that kills the current WS so the
 * client can navigate cleanly with a fresh start-token. See
 * gateway/http/chat-bridge.ts:buildSlugPickerEngineHook.
 */
export interface RedirectMessage {
  type: 'redirect'
  new_url: string
  new_start_token: string
  project_slug: string
  reason?: 'slug_renamed'
}

/**
 * 2026-05-22 — structured slug-rename envelope. Server-side mirror:
 * `landing/server.ts:SlugRenamedOutbound`. Emitted on the live WS
 * immediately after `renameUrlSlug` commits so the client can
 * navigate proactively to the personal subdomain WITHOUT waiting for
 * the WS to die + `/recover` fallback to fire (which surfaced a
 * brief "reconnecting..." / "disconnected. refresh to continue."
 * banner pre-2026-05-22).
 *
 * The client handler builds the navigation target as
 * `https://<new_host>/chat?start=<new_token>` and calls
 * `window.location.replace`. The instance gateway's `/chat`
 * handler validates the JWT directly (no `/start` bounce); the
 * `/start?token=` route on the same gateway is for entry-point
 * deep links from the identity service, not for this WS-driven
 * navigation.
 */
export interface SlugRenamedMessage {
  type: 'slug_renamed'
  new_slug: string
  new_host: string
  new_token: string
}

/**
 * Build the slug-rename navigation target. Exported (vs inlined in the
 * `handleSlugRenamed` method) so the local-apex classification can be
 * unit-tested without standing up a full `ChatClient` + jsdom DOM.
 *
 * Codex r1 [P3] (2026-05-22) — strips the port before classifying the
 * host so `<slug>.localhost:3000` (dev with
 * `NEUTRON_BASE_DOMAIN=localhost:3000`) emits `http://`, not `https://`.
 * Pre-fix the branch only matched a bare `localhost:...` prefix and
 * the slug-renamed redirect built `https://prism.localhost:3000/...`
 * in dev — the cert chain rejects, the navigation fails, and the user
 * is stranded mid-rename. Mirrors `signup/deep-link-builder.ts:
 * isLocalApex` so the helper + handler classify the same hosts.
 */
export function buildSlugRenamedTarget(
  new_host: string,
  new_token: string,
  debugOn: boolean,
): string {
  const hostNoPort = new_host.split(':')[0] ?? new_host
  const isLocal =
    hostNoPort === 'localhost' ||
    hostNoPort.endsWith('.localhost') ||
    hostNoPort === '127.0.0.1' ||
    hostNoPort.startsWith('127.') ||
    hostNoPort === '0.0.0.0' ||
    hostNoPort.endsWith('.local') ||
    hostNoPort.endsWith('.test')
  const scheme = isLocal ? 'http' : 'https'
  let target = `${scheme}://${new_host}/chat?start=${encodeURIComponent(new_token)}`
  if (debugOn) target = `${target}&debug=1`
  return target
}

/**
 * Allow-list the scheme of a navigation target before it is handed to a
 * `window.location` sink. The slug-rename / redirect envelopes arrive over the
 * authenticated gateway WebSocket, but a value that flows into `location` is
 * still treated as untrusted: a `javascript:` (or `data:`/`vbscript:`) URL in a
 * location sink is a DOM-XSS execution vector, and an unconstrained host is an
 * open redirect (CodeQL js/xss + js/client-side-unvalidated-url-redirection).
 *
 * Relative inputs resolve against the current document so a same-app path is
 * accepted; everything is normalized through the URL parser and only returned
 * when it resolves to an `http`/`https` URL with a non-empty host. Callers must
 * navigate to the RETURNED value (not the raw input) so the check is on the
 * exact string that reaches the sink. Returns null when the target is unsafe —
 * callers then refuse to navigate rather than trust an arbitrary scheme.
 */
export function safeNavUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const base =
    typeof window !== 'undefined' && window.location
      ? window.location.href
      : undefined
  let url: URL
  try {
    url = base !== undefined ? new URL(raw, base) : new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname.length === 0) return null
  return url.href
}

/**
 * Allow-list an `<img src>` value (image-gallery option thumbnails). Image
 * URLs ride in over the WS too; we accept only `http`/`https` (incl. relative
 * paths like `/profile-pic/candidate/<id>.png`, which resolve to the app
 * origin) and inline `data:image/*` payloads. Any other scheme — notably
 * `javascript:` — yields null so the caller falls back to a text label rather
 * than writing an attacker-influenced scheme to the DOM (CodeQL js/xss).
 */
export function safeImageSrc(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const base =
    typeof window !== 'undefined' && window.location
      ? window.location.href
      : undefined
  let url: URL
  try {
    url = base !== undefined ? new URL(raw, base) : new URL(raw)
  } catch {
    return null
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  if (url.protocol === 'data:' && url.pathname.startsWith('image/')) {
    return url.href
  }
  return null
}

export interface UserMessage {
  type: 'user_message'
  body: string
}

export interface ButtonChoiceMessage {
  type: 'button_choice'
  prompt_id: string
  choice_value: string
  freeform_text?: string
}

/**
 * 2026-05-09 — server-side `{type:'error'}` events. The landing-server
 * WebSocket handler emits these when `bridge.handleInbound` throws (any
 * uncaught engine InterviewError, button-store unknown_prompt, send_failed
 * etc.). Pre-fix the client dropped them silently in the `message` handler
 * → user typed text, server threw, no visible response. Render as a plain
 * agent bubble so the failure surfaces.
 */
export interface ServerErrorMessage {
  type: 'error'
  message: string
}

/**
 * 2026-05-21 (Bug 1, v0.1.75) — `import_progress` envelope. Periodic
 * UI-only update emitted by the per-instance import-running cron tick
 * while the ImportJobRunner is mid-flight. The client renders this as
 * a transient pulsing-dot indicator below the most recent agent
 * bubble, with optional status text.
 *
 * Auto-clears when the next `agent_message` envelope lands (the engine
 * advances out of `import_running` and emits the analysis-presented
 * prompt) OR when an `error` envelope lands OR when the WS closes.
 *
 * The envelope carries NO audit identity — it does NOT count as an
 * agent_message for transcript / delivered_at purposes (preserving the
 * S16 invariants from PR #127).
 *
 * See `docs/plans/P2-onboarding-v2.md` § 3.6 (revised) + § 9.5 for the
 * full spec contract. Mirrored as `ImportProgressOutbound` in
 * `landing/server.ts`.
 */
export interface ImportProgressMessage {
  type: 'import_progress'
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
  pass: 1 | 2
  pct: number
  /**
   * 2026-05-22 — pre-count fix follow-up to PR #264. Replaces the prior
   * `dollars_spent` field, which surfaced a per-token bill that
   * Max-OAuth users (the M2 default + only prod path today) are never
   * charged. The flag disambiguates the two render modes:
   *   true  → "Pass 1: ${done}/${total} batches" (stable denominator)
   *   false → "Pass 1: ${done} batches processed" (count-only)
   */
  chunks_total_known: boolean
  body?: string
}

/**
 * 2026-05-29 in-place topic switch sprint — server ack envelope. The
 * client sends `{type:'topic_switch', new_topic_id:...}` over the WS;
 * the gateway re-binds the sender registry and replies with this
 * envelope on success. The client's `switchTopic` resolver waits for
 * this ack before scrolling to the new topic's first-unread / restored
 * position (defense-in-depth — if the server rejects the switch, we
 * don't want the user staring at empty content scrolled to the
 * wrong place).
 */
export interface TopicSwitchedMessage {
  type: 'topic_switched'
  topic_id: string
}

/**
 * 2026-05-30 Argus r3 P2 #1 follow-up — server-pushed `user_id` envelope.
 * Fires once per WS connection, immediately after the server marks the
 * session live (BOTH the token-auth path and the cookie-only resume
 * path). Lets `switchTopic` derive `web:<user_id>` without re-decoding
 * the `?start=` JWT — cookie-only connections (the most common
 * returning-user entry, per r3) never have a `start_token` on the
 * client, so the prior `decodeJwtSubClaim('')` returned null and a
 * click on the General row in the sidebar silently early-returned (LS
 * already moved but no topic_switch event, no hydrate, user stuck).
 *
 * Fire-and-forget on the wire: no ack, no retransmit. A lost envelope
 * (network race, listener wired late) degrades to the JWT-decode
 * fallback in switchTopic — pre-2026-05-30 behaviour.
 */
export interface SessionReadyMessage {
  type: 'session_ready'
  user_id: string
  /** 2026-06-20 GO-LIVE — set by the server on a RESUMED returning session
   *  (cookie-only resume / spent-jti fallback). Tells the client there is no
   *  fresh-onboarding setup window, so the "Setting things up…" loader clears
   *  immediately rather than waiting on a first agent prompt that a completed
   *  instance never emits. */
  resumed?: boolean
}

/**
 * ISSUES #69 Argus r1 BLOCKER 1 (2026-05-30) — no-render acknowledgement
 * envelope. Mirrors `AgentAckOutbound` on the server. Fired by the
 * gateway when an inbound `button_choice` produced a state mutation
 * (e.g. resolve the seed row) but NO visible reply is owed. The client
 * decrements `pendingAgentReplies` + clears the typing dots so the
 * optimistic bubble from `sendChoice` doesn't persist forever.
 *
 * Currently emitted only by the onboarding-handoff no-match fallback's
 * `[B] Skip for now` path in `handleProjectTopicInbound`. Renders
 * nothing — the user's tap appears as a grayed-out resolved button row,
 * nothing more. See `landing/server.ts:AgentAckOutbound`.
 */
export interface AgentAckMessage {
  type: 'agent_ack'
}

/**
 * ISSUES #115 (2026-06-09) — server-authoritative turn-active brackets.
 * The gateway's chat-bridge wraps every `engine.advance` / `engine.start`
 * with `agent_typing_start` (before) + `agent_typing_end` (after, in a
 * `finally`). These are the DETERMINISTIC source of the typing indicator:
 * the prior client-optimistic model (dots on a visible user send, cleared
 * on the first `agent_message`) was INTERMITTENT — it missed proactively-
 * emitted phase prompts and went dark between messages on multi-message
 * turns. The client ref-counts starts vs ends (`serverTypingActive`), so
 * back-to-back starts coalesce and the dots only clear when every start
 * has its matching end AND no optimistic user-send turn is still pending.
 * Mirrors `landing/server.ts:AgentTypingStartOutbound` / `…EndOutbound`.
 */
export interface AgentTypingStartMessage {
  type: 'agent_typing_start'
}
export interface AgentTypingEndMessage {
  type: 'agent_typing_end'
}

export type InboundEvent =
  | AgentMessage
  | AgentAckMessage
  | AgentTypingStartMessage
  | AgentTypingEndMessage
  | RedirectMessage
  | SlugRenamedMessage
  | ServerErrorMessage
  | ImportProgressMessage
  | TopicSwitchedMessage
  | SessionReadyMessage
/**
 * 2026-05-29 in-place topic switch sprint — outbound `topic_switch`
 * envelope. Sent over the existing WS when the user taps a non-active
 * row in the sidebar topic rail.
 */
export interface TopicSwitchOutbound {
  type: 'topic_switch'
  new_topic_id: string
}
export type OutboundEvent = UserMessage | ButtonChoiceMessage | TopicSwitchOutbound

/**
 * 2026-05-28 sidebar sprint — localStorage key for the user's active
 * topic_id. Restored on page load so a refresh keeps the same topic
 * surface. Cleared by `clearActiveTopic` on explicit "go to General"
 * actions. Exported for test access.
 */
export const ACTIVE_TOPIC_LS_KEY = 'neutron.active_topic_id'

/**
 * 2026-05-28 sidebar sprint — wire shape returned by
 * `GET /api/v1/chat/topics`. Mirrors
 * `gateway/http/chat-topics-surface.ts:ChatTopic`.
 */
export interface ChatTopic {
  topic_id: string
  project_id: string | null
  name: string
  last_body: string | null
  last_created_at: number | null
  unread_count: number
}

export interface ChatClientOptions {
  url: string
  start_token: string
  log: HTMLElement
  status: HTMLElement
  input: HTMLTextAreaElement
  sendBtn: HTMLButtonElement
  /**
   * 2026-05-28 sidebar sprint — optional active topic_id. When set, the
   * client passes `?topic_id=<id>` on both the `GET /api/v1/chat/history`
   * fetches AND the `/ws/chat` upgrade. When omitted, all requests
   * default to General (byte-identical pre-sprint behaviour).
   */
  topic_id?: string
  /**
   * P2 v2 § 6.2 (S4) — upload affordance surface. Optional bag of
   * elements. When all five are supplied AND the latest agent_message
   * carried an `upload_affordance` envelope, the chat client toggles
   * the bar visible + binds page-level drag handlers. When omitted
   * (e.g. embedded chat surfaces that disallow uploads), the upload
   * affordance is silently ignored. `uploadInput` is the hidden
   * `<input type="file">`; clicking `uploadButton` proxies to it.
   * `uploadOverlay` is the full-viewport drop target.
   *
   * The affordance source is always a single substrate (`'chatgpt'` or
   * `'claude'`); the removed "Both" two-upload flow used to surface a
   * second Claude-side button/input pair here (see remove-both-import-option,
   * 2026-06-06).
   */
  uploadBar?: HTMLElement
  uploadButton?: HTMLButtonElement
  uploadInput?: HTMLInputElement
  uploadLabel?: HTMLElement
  uploadOverlay?: HTMLElement
  uploadOverlayText?: HTMLElement
  /**
   * Visual progress bar paired with `uploadLabel`. Updated on every
   * `onProgress` callback from the chunked upload client. Lives in
   * `chat.html` as `<progress id="upload-progress" max="100" value="0" hidden>`;
   * the chat client unhides it on upload start, drives `.value` from
   * each chunk's high-water-mark, and re-hides on success/error.
   */
  uploadProgress?: HTMLProgressElement
  /**
   * ISSUES #48 (2026-05-28) — Cancel + Retry surface. Both optional so
   * embedded chat surfaces without the markup degrade to "click button →
   * upload → succeed or fail" with no mid-flight cancel and no
   * one-click recovery.
   *
   *   - `uploadCancel` — visible while an upload is in flight. Clicking
   *     it aborts the in-flight `uploadChunked` via the per-attempt
   *     `AbortController`. The chunked client rejects with
   *     `UploadChunkedError.opts.phase === 'abort'` and the handler
   *     resets to idle (no error bubble, no retry surface — cancel ≠
   *     error).
   *   - `uploadRetry` — surfaces after a terminal error (413 / network
   *     / etc). Clicking it re-fires `handleUploadFile` with the same
   *     `File` object the user originally picked, so they don't have
   *     to round-trip through the file picker. Suppressed after an
   *     abort: we don't offer to retry what the user explicitly cancelled.
   */
  uploadCancel?: HTMLButtonElement
  uploadRetry?: HTMLButtonElement
  /** Test-only — override `Date.now()` for stable relative-time output. */
  now?: () => number
  /** Test-only — override the upload POST fetch. */
  uploadFetch?: typeof fetch
}

type Sender = 'user' | 'agent'

/**
 * Format a relative-age string in the iMessage / Telegram tradition.
 *
 *  < 60s        → "now"
 *  < 60min      → `${m}m`
 *  < 24h        → `${h}h`
 *  >= 24h       → locale-formatted `HH:MM`
 *
 * Pure function — easy to unit test.
 */
export function formatRelativeTime(now_ms: number, then_ms: number): string {
  const delta = Math.max(0, now_ms - then_ms)
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return 'now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const d = new Date(then_ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * 2026-06-17 (Argus r2) — map the server's per-pass `pct` (0..1 within
 * the current pass) onto a single overall 0..1 scale across both import
 * passes: Pass 1 occupies the first half, Pass 2 the second half. This
 * keeps the visual bar monotonic — it never jumps backwards when the
 * runner advances from Pass 1 (scan) into Pass 2 (synthesis).
 *
 * Pass 1 in streaming-fallback mode emits `pct = 0` (no honest
 * denominator), which collapses to overall 0 and drives the
 * indeterminate bar + "estimating…" state.
 */
export function importOverallPct(pass: 1 | 2, pct: number): number {
  const clamped = Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 1) : 0
  return pass === 2 ? 0.5 + clamped * 0.5 : clamped * 0.5
}

/**
 * 2026-06-17 (Argus r2) — human-friendly time-remaining string tied to
 * the progress bar. Rounds to a calm granularity (nearest 5s under a
 * minute, whole minutes above) so the number doesn't twitch every tick.
 * Returns `null` when there is no honest estimate (non-positive,
 * non-finite, or absurdly large — treat as "still estimating").
 */
export function formatEtaRemaining(remaining_ms: number): string | null {
  if (!Number.isFinite(remaining_ms) || remaining_ms <= 0) return null
  // Guard against early-sample noise producing a wild estimate.
  if (remaining_ms > 30 * 60 * 1000) return null
  const sec = Math.round(remaining_ms / 1000)
  if (sec <= 3) return 'almost done'
  if (sec < 60) {
    const rounded = Math.max(5, Math.round(sec / 5) * 5)
    return `about ${rounded}s left`
  }
  const min = Math.round(sec / 60)
  return min <= 1 ? 'about a minute left' : `about ${min} min left`
}

/** Pixels of slack we treat as "still at the bottom" of #log. */
const AT_BOTTOM_THRESHOLD = 32

/**
 * Returns true when `log.scrollTop` is within `AT_BOTTOM_THRESHOLD` of the
 * bottom of the scroll container. jsdom-friendly: only reads the three
 * scroll properties so tests can fake them.
 */
export function isAtBottom(log: HTMLElement, threshold = AT_BOTTOM_THRESHOLD): boolean {
  const remaining = log.scrollHeight - log.scrollTop - log.clientHeight
  return remaining <= threshold
}

/**
 * Codex T13 r3 P1 (CRITICAL) — scrub start tokens out of arbitrary
 * JSON-ish text BEFORE it enters the WS-trace buffer. The trace gets
 * persisted to `<run-dir>/ws/*-fail.json` on phase failures + tarballed
 * for triage; an unredacted `new_start_token` in a `RedirectMessage`
 * envelope is a still-valid bearer JWT (5-15 min TTL, single-use but
 * usable until first claim).
 *
 * Strategy: regex-replace the value half of any `"<sensitive-key>":"..."`
 * occurrence with `"[REDACTED]"`. Operates on raw JSON text (not
 * parsed objects) because the chat.ts trace stores `event.data`
 * verbatim — running a parse + walk would be more correct but adds
 * complexity for a single failure mode. The regex is intentionally
 * conservative: matches JSON-shaped quoted strings only, so plain
 * prose containing the substring "new_start_token" is untouched.
 *
 * Defense in depth — the harness's `dumpWsTrace()` re-scrubs on read
 * so even if a future caller pushes raw text directly into
 * `window.__neutronWsTrace` the on-disk artifact stays clean.
 *
 * Exported for unit testing.
 */
export function redactSensitiveJson(s: string): string {
  if (typeof s !== 'string' || s.length === 0) return s
  // Keys we know carry tokens / secrets in the wire protocol:
  //   - new_start_token (RedirectMessage)
  //   - start_token (some legacy paths)
  //   - access_token / refresh_token (defensive — not currently in
  //     the inbound envelope, but covers future server-side leaks)
  // Handle both top-level (`"key":"val"`) and nested-encoded
  // (`\"key\":\"val\"`) shapes — the chat-bridge can fan out
  // envelopes-within-envelopes (e.g. an `error.message` field that
  // quotes the original envelope). Mirrors `redactStartTokensInTrace`
  // in scripts/e2e/m2-walkthrough.ts.
  return s.replace(
    /(\\?")(new_start_token|start_token|access_token|refresh_token|old_token)\1\s*:\s*(\\?")(?:(?!\3)[^\\]|\\.)*\3/g,
    '$1$2$1:$3[REDACTED]$3',
  )
}


/** How often we re-render every visible relative timestamp. 30s is fine —
 *  the format only ticks at minute / hour boundaries. */
const TIMESTAMP_REFRESH_INTERVAL_MS = 30_000

/**
 * 2026-05-21 (Bug 3 fix) — when the WS opens we render typing dots
 * optimistically so engine.start has visible liveness while it resolves
 * (LLM router call for phase-spec resolution can take 4+ seconds). If
 * no agent envelope arrives within this window — most likely a terminal
 * phase with nothing to emit, or a misconfigured instance — we force-clear
 * the dots so the user isn't left staring at dangling indicators
 * forever. 15s comfortably covers the worst-case engine.start latency
 * observed in prod while still feeling responsive.
 */
const OPEN_TYPING_TIMEOUT_MS = 15_000

/**
 * 2026-05-28 — WS-reconnect circuit breaker. PR #320's `handleClose`
 * navigates the browser back to `/chat` on every WS drop so the
 * platform proxy (or per-instance auth-gate) can re-issue a fresh
 * start-token. When the WS handler at the destination keeps rejecting
 * (e.g. instance gateway down, synthetic E2E instance with no real backend),
 * the page reloads → chat.ts runs → WS fails → /chat again → infinite
 * loop. The counter below tracks navigation attempts in localStorage;
 * after `WS_RECONNECT_MAX_ATTEMPTS` within `WS_RECONNECT_WINDOW_MS`,
 * the client stops bouncing and renders a static disconnected banner
 * instead. The counter resets on a successful WS open OR when the
 * window expires (so a single transient drop doesn't permanently latch
 * the banner).
 */
export const WS_RECONNECT_LS_KEY = 'neutron.ws_reconnect_attempts'
export const WS_RECONNECT_MAX_ATTEMPTS = 3
export const WS_RECONNECT_WINDOW_MS = 10_000

interface WsReconnectState {
  count: number
  first_ts: number
}

function readWsReconnectState(): WsReconnectState {
  if (typeof localStorage === 'undefined') return { count: 0, first_ts: 0 }
  try {
    const raw = localStorage.getItem(WS_RECONNECT_LS_KEY)
    if (raw === null) return { count: 0, first_ts: 0 }
    const parsed = JSON.parse(raw) as Partial<WsReconnectState>
    if (
      typeof parsed.count !== 'number' ||
      typeof parsed.first_ts !== 'number' ||
      !Number.isFinite(parsed.count) ||
      !Number.isFinite(parsed.first_ts)
    ) {
      return { count: 0, first_ts: 0 }
    }
    return { count: parsed.count, first_ts: parsed.first_ts }
  } catch {
    return { count: 0, first_ts: 0 }
  }
}

function writeWsReconnectState(s: WsReconnectState): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(WS_RECONNECT_LS_KEY, JSON.stringify(s))
  } catch {
    // Quota exceeded / private-mode — ignore. Worst case the circuit
    // breaker degrades to "always navigate" (pre-circuit-breaker
    // behavior), which is no regression.
  }
}

/**
 * Clear the WS-reconnect counter. Called from the `open` handler so a
 * successful connection wipes the slate clean. Exported for the test
 * harness + as a documented API for any future ChatClient consumer.
 */
export function clearWsReconnectState(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(WS_RECONNECT_LS_KEY)
  } catch {
    // ignore
  }
}

/**
 * Record an attempt to navigate-back-to-/chat after a WS close. Returns
 * `true` when the caller should GATE the navigation (loop budget
 * exhausted within the rolling window); `false` when navigation may
 * proceed. Always advances state so a subsequent call within the window
 * sees the bumped counter.
 *
 * Window semantics: `first_ts` anchors the start of the current run.
 * When `now_ms - first_ts > WS_RECONNECT_WINDOW_MS`, the run is reset
 * (`count: 1, first_ts: now`) and navigation proceeds. Within the
 * window the counter increments; gating kicks in once it exceeds
 * `WS_RECONNECT_MAX_ATTEMPTS` so attempt #4 is the first one suppressed.
 */
/**
 * Chat-history hydration (2026-05-28 sprint) — composite-cursor
 * stall check for the "Load earlier" advance guard. Returns true
 * when the new page's `(ts, prompt_id)` cursor is NOT strictly
 * older than the previous boundary — i.e. the server failed to
 * advance backward in time AND backward in the (ts-tiebroken)
 * prompt_id ordering.
 *
 * Codex r1 P2 (2026-05-28) — comparing on `ts` alone would
 * discard legitimate ms-collision pages where the next batch
 * shares `created_at` with the boundary but carries strictly
 * lower `prompt_id`s. The backend orders by `(created_at DESC,
 * prompt_id DESC)`, so a valid older page satisfies
 * `(new_ts < prev_ts) OR (new_ts === prev_ts AND new_prompt_id < prev_prompt_id)`.
 * Anything else is stalled.
 *
 * Null cursors are treated as "older than everything" — the
 * empty-result and `oldest_returned_at: null` shapes naturally
 * land in the `body.turns.length === 0` branch before this
 * helper sees them, but we defensively return true if asked.
 */
export function cursorStalled(
  prev: { ts: number; prompt_id: string | null },
  next: { ts: number | null; prompt_id: string | null },
): boolean {
  if (next.ts === null) return true
  if (next.ts < prev.ts) return false
  if (next.ts > prev.ts) return true
  // Equal ts → tiebreak on prompt_id (server orders DESC, so a
  // strictly LOWER prompt_id advances; equal-or-higher stalls).
  if (prev.prompt_id === null) return true
  if (next.prompt_id === null) return false
  return next.prompt_id >= prev.prompt_id
}

export function shouldGateWsReconnect(now_ms: number): boolean {
  const s = readWsReconnectState()
  if (s.count === 0 || now_ms - s.first_ts > WS_RECONNECT_WINDOW_MS) {
    writeWsReconnectState({ count: 1, first_ts: now_ms })
    return false
  }
  const next: WsReconnectState = { count: s.count + 1, first_ts: s.first_ts }
  writeWsReconnectState(next)
  return next.count > WS_RECONNECT_MAX_ATTEMPTS
}

export class ChatClient {
  private ws: WebSocket | null = null
  private readonly opts: ChatClientOptions
  private readonly now: () => number
  /**
   * ISSUES #94 (2026-06-05) — true once the WS has successfully opened at
   * least once on this page. The `?start=` token is a ONE-SHOT credential:
   * the server atomically consumes its jti on first bring-up. Re-presenting
   * a spent token on a reconnect (network blip, tab re-focus, the
   * post-completion General socket) fails the atomic claim → 4001 →
   * "session not started" on every inbound. After the first open we drop
   * the token and let the upgrade authenticate via the 30d session cookie
   * (the server's cookie-only `pending_claim === null` path). The cookie is
   * the durable credential; the start-token is bring-up only.
   */
  private broughtUp = false
  private currentRunSender: Sender | null = null
  private currentRun: HTMLElement | null = null
  /**
   * Item 6 (2026-06-19) — optional hook fired after every successful
   * agent-message paint. The boot shell wires this to the topic rail's
   * `refreshIfNoProjects()` so the sidebar populates LIVE when onboarding
   * creates the projects, without a manual reload. Null when no rail is
   * mounted (embedded surfaces).
   */
  private onAgentMessageHook: (() => void) | null = null
  /**
   * 2026-05-26 — scrolled-up users are not disturbed by new messages
   * (Sam-specced UX). Flips false in `handleScroll` when the user scrolls
   * away from the bottom; new bubbles silently append below the viewport.
   * Reaching the bottom flips it back to true so the next bubble
   * auto-scrolls.
   */
  private stickToBottom = true
  private inFlight = false
  private tsRefreshHandle: ReturnType<typeof setInterval> | null = null
  /**
   * 2026-05-13 — optimistic "agent is typing" dots bubble inserted on
   * user_message / button_choice send and removed on the next
   * agent_message (or on WS close). Purely client-side UX — the server
   * protocol is unchanged, so there is no source-of-truth "typing"
   * event from the engine. The indicator's only job is to acknowledge
   * that the user's input was accepted while engine.advance + the LLM
   * call complete.
   */
  private typingBubble: HTMLElement | null = null
  /**
   * 2026-06-17 (onboarding single-session rework, Step 1) — the centered
   * "Setting things up…" first-load loading indicator. Rendered on first
   * construction (covers the page-load → WS-open → engine.start window, which
   * the server uses to pre-warm the conversational `claude` session behind it),
   * and cleared the instant real content lands: the first agent message, the
   * WS-open typing dots that supersede it, a server error, an import-progress
   * envelope, or hydrated history. Idempotent — `clearSetupIndicator` no-ops
   * once removed. Lives directly in `#log` so the existing scroll / append
   * machinery treats it as a transient first child.
   */
  private setupIndicator: HTMLElement | null = null
  /**
   * 2026-05-21 (Bug 1, v0.1.75) — pulsing-dot indicator rendered below
   * the most recent agent bubble while the import_running phase is
   * underway. Updated on every `import_progress` envelope (5s cadence
   * from the per-instance cron tick); auto-cleared when the next
   * `agent_message` envelope lands, when an `error` envelope lands, or
   * when the WS closes. Mirrors the `typingBubble` field's shape but
   * lives in a separate transient run so the two indicators can
   * theoretically coexist (in practice the typing bubble clears whenever
   * ANY inbound envelope arrives, including `import_progress`).
   */
  private importProgressBubble: HTMLElement | null = null
  /**
   * Phase-label element inside `importProgressBubble` (e.g. "Scanning
   * your conversations"). Stored separately so `renderImportProgress`
   * can update it in place. Deliberately carries NO chunk counts — the
   * raw "N/M batches" readout was the forbidden case (Argus r2): users
   * see a determinate VISUAL bar + ETA, never a chunk number.
   */
  private importProgressBody: HTMLElement | null = null
  /**
   * The determinate visual progress bar (`<progress>`). Driven by the
   * server `pct` envelope, mapped onto an overall 0..100 scale across
   * both passes (pass 1 → 0–50%, pass 2 → 50–100%) so it never appears
   * to run backwards. When `pct` is briefly unknown (Pass 1 streaming-
   * fallback, where the server emits `pct = 0` for lack of an honest
   * denominator) the bar drops its `value` attribute and renders
   * indeterminate.
   */
  private importProgressBar: HTMLProgressElement | null = null
  /**
   * The estimated-time-remaining line tied to the bar. Derived from the
   * observed pct rate over elapsed time within the current pass; shows
   * "estimating…" until we have two samples (or while indeterminate).
   */
  private importProgressEta: HTMLElement | null = null
  /**
   * ETA anchor — the first `(timestamp, overall-pct)` sample of the
   * CURRENT pass. Reset whenever the pass changes (pass 1 and pass 2
   * have independent progress signals) or the bubble is recreated, so
   * the rate estimate stays honest within a pass instead of treating the
   * 0→50% pass boundary as real linear progress.
   */
  private importProgressEtaAnchor: { pass: 1 | 2; ts: number; overall: number } | null = null
  /**
   * 2026-05-13 Codex r2 P2 — counter of outbound turns the user has
   * sent for which the server has not yet replied. Bumped on every
   * `showTypingBubble()` (each `sendInput` / `sendChoice`), decremented
   * on every reply-shaped envelope (`agent_message` /
   * server `error`). The typing bubble stays in the DOM while
   * `pendingAgentReplies > 0`, so a user who fires off two messages
   * back-to-back and gets one reply still sees the dots until the
   * second reply lands. Hard-reset to 0 on WS close (queued turns can
   * no longer be answered on this socket).
   */
  private pendingAgentReplies = 0
  /**
   * ISSUES #115 (2026-06-09) — count of OPEN server turn-brackets:
   * incremented on every `agent_typing_start`, decremented on every
   * `agent_typing_end`. This is the server-authoritative half of the
   * typing-indicator state. The dots stay visible while
   * `serverTypingActive > 0 OR pendingAgentReplies > 0` (see
   * `shouldShowTyping`), so the indicator is GUARANTEED for the whole
   * working window of every turn — including proactively-emitted phase
   * prompts the user never triggered with a visible send, and the gaps
   * between messages on multi-`agent_message` turns. Hard-reset to 0 on
   * WS close alongside `pendingAgentReplies`.
   */
  private serverTypingActive = 0
  /**
   * 2026-05-21 (Bug 3 fix) — defensive handle for the on-open typing-
   * indicator timeout. Cleared on the first inbound envelope so the
   * timeout doesn't accidentally tear down a legitimate user-turn
   * placeholder later in the conversation.
   */
  private openTypingTimeoutHandle: ReturnType<typeof setTimeout> | null = null
  /**
   * ISSUES #115 Argus r1 (2026-06-09) — true while the ON-OPEN optimistic
   * typing bubble is outstanding: we bump `pendingAgentReplies` on WS-open
   * speculatively expecting `engine.start` to deliver a reply. This flag
   * distinguishes that speculative pending from real user-sent-turn
   * pendings (`sendInput` / `sendChoice`).
   *
   * Why it's needed: `handleAgentTypingStart` cancels the on-open
   * defensive timeout the moment the server opens a real turn bracket —
   * which removed the ONLY safety net for the case where `engine.start`
   * opens + closes its bracket (`agent_typing_start` … `agent_typing_end`)
   * but emits NO `agent_message` / `agent_ack` (terminal phase,
   * completed-onboarding reconnect, misconfigured instance). Without
   * reconciliation the speculative `pendingAgentReplies = 1` is never
   * decremented, `agent_typing_end` leaves `shouldShowTyping()` true, and
   * the dots strand forever — the exact stuck-indicator class #115 fixes.
   *
   * `handleAgentTypingEnd` consults this flag: when the server bracket
   * fully closes (`serverTypingActive === 0`) with the on-open optimism
   * still unconsumed, it reconciles the speculative pending so the dots
   * clear. Cleared the instant any real reply lands (`hideTypingBubble`)
   * or the WS dies (`clearTypingBubble`).
   */
  private openOptimisticPending = false

  /**
   * P2 v2 § 6.2 (S4) — the source advertised by the most recent
   * agent_message's `upload_affordance` envelope, or null when no
   * upload is currently expected. Drives the file-picker button +
   * drag-drop overlay surfaces; updated on every agent_message render.
   */
  private uploadAffordanceSource: 'chatgpt' | 'claude' | null = null
  /** Page-level drag listeners installed once, gated by uploadAffordanceSource. */
  private uploadDragInstalled = false
  /** Stack-depth counter for nested dragenter/dragleave so the overlay
   *  doesn't flicker as the cursor crosses bubble boundaries. */
  private uploadDragDepth = 0
  /** True while a POST /api/upload/<source> is in flight — keeps the
   *  button disabled + suppresses re-drops. */
  private uploadInFlight = false

  /**
   * ISSUES #48 (2026-05-28) — controller that wires the Cancel button
   * to `uploadChunked`'s `AbortSignal`. Non-null only while an upload is
   * in flight; reset to `null` in the `finally` block so the NEXT
   * upload starts with a fresh controller. Critical — sharing a single
   * controller across attempts would poison every subsequent upload
   * after the first cancel.
   */
  private uploadAbortController: AbortController | null = null

  /**
   * ISSUES #48 (2026-05-28) — last `{file, source}` the user picked,
   * cached at the top of `handleUploadFile` so the Retry button can
   * re-fire the same upload after a terminal error (413, transport
   * failure) without forcing them back through the file picker.
   *
   * Cleared when:
   *   - the upload succeeds (no retry needed)
   *   - the user explicitly cancels (no retry offered)
   *   - the affordance flips on a new agent envelope (stale attempt)
   */
  private lastUploadAttempt: { file: File; source: 'chatgpt' | 'claude' } | null = null

  /**
   * Chat-history hydration (2026-05-28 sprint) — set of every
   * `prompt_id` that has rendered into `#log`, whether via the live
   * WS `agent_message` envelope or via the
   * `GET /api/v1/chat/history` fetch. The dedup check is the FIRST
   * statement of BOTH render paths so order of arrival between the
   * live WS active-prompt re-emit and the history-fetch response
   * never produces a duplicate bubble.
   *
   * Lifetime: page lifetime. WS reconnects do NOT clear the Set —
   * the engine's reconnect-time re-emit (which carries the same
   * `prompt_id`) is intentionally silenced because the prompt is
   * already on screen. New prompts that arrive after reconnect
   * carry fresh `prompt_id`s and render normally.
   *
   * `AgentMessage.prompt_id` is OPTIONAL — terminal turns without
   * a button keyboard ship without one and are NEVER dedup'd
   * (they also never appear in the history payload, which only
   * surfaces `button_prompts` rows).
   */
  private renderedPromptIds = new Set<string>()
  /**
   * 2026-06-05 (click-button slug-rename) — true once the
   * "Open your agent →" CTA card has been rendered by `handleSlugRenamed`.
   * The server emits the `slug_renamed` envelope on the live socket AND
   * persists a pending-redirect; a reconnect-replay could deliver a second
   * envelope, so this guards against rendering a duplicate CTA card.
   */
  private slugReadyCtaRendered = false
  /**
   * True once `hydrateInitialHistory` has resolved (success OR
   * non-OK status). Guards against re-firing on WS reconnect:
   * the engine's active-prompt re-emit + the cached Set are
   * sufficient to surface the active turn on reconnect, so a
   * second history fetch would be wasted work AND would re-run
   * the scroll-anchor math, briefly yanking the user's viewport.
   */
  private historyHydrated = false
  /** True while a fetch is in flight; guards against re-entry. */
  private historyHydrating = false
  /**
   * 2026-05-29 in-place topic switch sprint — per-topic scroll
   * positions cached on switch-away. Key: topic_id; value: scrollTop
   * at the moment the user left the topic. Restored on switch-back
   * so a user reading project A, jumping to General, then jumping
   * back to A lands at the SAME scroll position (Telegram behaviour).
   *
   * Topics the user has NEVER opened are absent from this map; the
   * first-mount path picks "scroll to first unread OR bottom"
   * instead of restoring (see `applyFirstMountScroll`).
   */
  private topicScrollOffsets = new Map<string, number>()
  /**
   * Topics whose first-mount paint has already happened in THIS
   * page lifetime. Distinguishes "first ever load of this topic"
   * (no entry in `topicScrollOffsets`, find first-unread, render
   * the "New" divider) from "switch-back" (entry in
   * `topicScrollOffsets`, restore scroll). Critical because the
   * "New" divider only renders on FIRST mount — re-rendering it on
   * every switch-back would visually scream at the user.
   */
  private topicFirstMountDone = new Set<string>()
  /**
   * Resolver for the in-flight `switchTopic(...)` call's
   * `topic_switched` ack. Non-null only between the WS send and the
   * inbound ack envelope; cleared in `handleTopicSwitched` on
   * success OR via a 3 s timeout fallback in `switchTopic` so a
   * server that never acks doesn't strand the UI. Mirrors the
   * `inFlight` discipline used by the composer's send button.
   */
  private pendingTopicSwitchResolver: ((id: string) => void) | null = null
  /**
   * 2026-05-30 Argus r3 P2 #2 fix — the topic_id the most-recent
   * `switchTopic` call sent to the server, stashed alongside
   * `pendingTopicSwitchResolver` so `handleTopicSwitched` can ignore
   * stale acks from superseded switches. Without this check a rapid
   * double-click (A → B → A) could resolve the wrong destination's
   * resolver — the FIFO ack ordering means B's ack lands first and
   * fires A's resolver with B's topic_id, causing the client to
   * hydrate the wrong topic into the just-cleared log.
   *
   * The brief's `pendingTopicSwitchRequest = { topic_id, resolver }`
   * compound shape is decomposed here into two sibling fields so the
   * existing timeout / null-guard pattern stays byte-identical (the
   * timeout reads the resolver; we just add an extra mismatch guard
   * in handleTopicSwitched).
   */
  private pendingTopicSwitchDestination: string | null = null
  /**
   * 2026-05-30 Argus r3 P2 #1 fix — server-pushed `user_id` from the
   * `session_ready` envelope, captured ONCE on first delivery. Used by
   * `switchTopic` to derive the General topic_id (`web:<user_id>`)
   * without falling back to a JWT decode on cookie-only sessions where
   * `start_token` is empty. Falls back to `decodeJwtSubClaim(start_token)`
   * when null (envelope not yet received OR pre-r3 server that doesn't
   * emit it).
   */
  private serverPushedUserId: string | null = null
  /**
   * Handle for the `topic_switched` ack timeout fallback. Cleared
   * on ack OR on next `switchTopic` so a stale timeout can't trip a
   * later switch.
   */
  private pendingTopicSwitchTimeoutHandle: ReturnType<typeof setTimeout> | null = null
  /**
   * Unread count for the next topic to switch INTO. Populated by
   * `switchTopic` from the caller's hint (the TopicRail row's
   * `unread_count`) and read by `applyFirstMountScroll` to decide
   * whether to look for the first-unread bubble. Reset to 0 after
   * the scroll is applied. Optional: when omitted the helper
   * defaults to "no known unread" (scrolls to bottom on first mount).
   */
  private pendingTopicSwitchUnreadCount = 0
  /**
   * 2026-05-29 in-place topic switch sprint — "↓ N new" pill, anchored
   * bottom-right of the scroll viewport. Surfaces ONLY when a live
   * `agent_message` envelope arrives AND the user is scrolled UP from
   * the bottom (`stickToBottom === false`). Clicking the pill scrolls
   * the user back to the bottom; the pill auto-hides on bottom. Sourced
   * from `chat.html`'s `#new-pill` element (existing CSS class
   * `.new-pill`). Optional — when the element is missing the chat
   * surface degrades to the pre-sprint silent-append behaviour.
   */
  private newPill: HTMLButtonElement | null = null
  /**
   * Count of unread live agent_message envelopes that arrived while
   * the user was scrolled up. Surfaced in the new-pill label
   * ("↓ 3 new"). Reset to 0 when the user reaches the bottom OR
   * taps the pill.
   */
  private scrolledUpUnreadCount = 0
  /** True while a "Load earlier" fetch is in flight; cosmetic
   *  `button.disabled` is for UX, this flag is the truth. */
  private loadingOlder = false
  /** `created_at` of the oldest historical turn currently rendered.
   *  Used as the `before` cursor on the next "Load earlier" fetch.
   *  Null until at least one batch has landed. */
  private historyOldestTs: number | null = null
  /** Composite-cursor companion — the `prompt_id` of the oldest
   *  historical turn currently rendered. Threaded through to the
   *  next fetch so multiple prompts sharing the same `created_at`
   *  ms don't get silently skipped on the page boundary. */
  private historyOldestPromptId: string | null = null
  /** The "Load earlier messages" button — first child of `#log`
   *  while `has_more=true`. Lazy-constructed on first render so
   *  the empty-history case (new owner, no `button_prompts`
   *  rows) never instantiates it. */
  private loadEarlierButton: HTMLButtonElement | null = null
  /** True while `prependHistoryBatch` is mid-flight (between the
   *  scroll-anchor capture and the scroll-anchor restore). Read
   *  by `handleScroll` + `commitNewBubble` to suppress
   *  `stickToBottom` flip / auto-scroll during the prepend so a
   *  scroll event fired by the `scrollTop` write can't mid-strip
   *  the viewport. */
  private prepending = false
  /** True once `dispose()` runs. Promise resolutions in
   *  `hydrateInitialHistory` / `loadOlderBatch` check this flag
   *  (and `abortController.signal.aborted`) before any DOM write
   *  so a torn-down ChatClient can't leak a ghost render. */
  private disposed = false
  /** Owns every in-flight `fetch()` issued by the chat-history
   *  surface. Aborted on WS close, page unload, and `dispose()`.
   *  Re-minted on each successful WS open so reconnect-driven
   *  hydration paths are clean. */
  private abortController = new AbortController()

  /**
   * S11 — cached `topic_id` for the `X-Neutron-Topic-Id` upload header.
   * Derived from the `sub` claim of the JWT in `opts.start_token` and
   * shaped to match the engine's web-topic contract (`webTopicId(...)`
   * in gateway/http/chat-bridge.ts:175).
   *
   * `undefined` = not yet computed; `null` = computed but the token
   * couldn't be parsed (lazy fallback so the upload still goes through
   * — the gateway logs a one-shot deprecation). Cached so repeated
   * uploads in one session don't re-parse the JWT.
   */
  private uploadTopicIdCache: string | null | undefined = undefined

  constructor(opts: ChatClientOptions) {
    this.opts = opts
    this.now = opts.now ?? (() => Date.now())
    this.opts.sendBtn.addEventListener('click', () => this.sendInput())
    this.opts.input.addEventListener('keydown', (event) => this.handleInputKey(event))
    this.opts.input.addEventListener('input', () => this.autoGrow())
    this.opts.log.addEventListener('scroll', () => this.handleScroll())
    // 2026-05-29 in-place topic switch sprint — wire the "↓ N new"
    // pill. The button lives in `chat.html` (#new-pill); on a
    // scrolled-up live envelope the chat client labels + reveals it,
    // on click the user jumps to the bottom and the pill auto-hides.
    // Telegram pattern. Optional — when the element is missing
    // (embedded surfaces with a custom chat shell), the pill is
    // silently disabled.
    if (typeof document !== 'undefined') {
      const newPill = document.getElementById('new-pill')
      if (newPill !== null && newPill instanceof HTMLButtonElement) {
        this.newPill = newPill
        newPill.addEventListener('click', () => this.handleNewPillClick())
      }
    }
    this.wireUploadAffordance()
    this.autoGrow()
    // 2026-06-17 onboarding single-session rework (Step 1) — render the
    // centered "Setting things up…" loading indicator on first load, ONLY when
    // `#log` is empty (a fresh onboarding visit). It covers the page-load →
    // WS-open → engine.start window — the same window the server uses to
    // pre-warm the conversational session — and is cleared the instant the
    // first real content renders (see `clearSetupIndicator`). When the log
    // already has content (server-rendered prior turns / a returning session),
    // there's nothing to "set up", so skip it.
    if (this.opts.log.childElementCount === 0) {
      this.showSetupIndicator()
    }
    // Suppress smooth scrolling on the very first paint so the page
    // doesn't visibly scroll-from-zero into place.
    this.opts.log.style.scrollBehavior = 'auto'
    this.scrollToBottom('auto')
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        this.opts.log.style.scrollBehavior = 'smooth'
      })
    } else {
      this.opts.log.style.scrollBehavior = 'smooth'
    }
    // Periodic refresh so "now" → "1m" → "2m" → … ticks without needing a
    // new message to arrive. Each .ts element carries its source timestamp
    // in `data-ts`; we just re-format against the current clock.
    if (typeof setInterval === 'function') {
      this.tsRefreshHandle = setInterval(
        () => this.refreshAllTimestamps(),
        TIMESTAMP_REFRESH_INTERVAL_MS,
      )
    }
  }

  /**
   * Stop the timestamp-refresh interval. Currently only used by tests
   * (the page lifetime is the WebSocket lifetime in production).
   *
   * 2026-05-28 chat-history hydration — also abort any in-flight
   * history fetches and mark the client disposed so Promise
   * resolutions short-circuit before touching the (about-to-be-
   * detached) DOM. Idempotent.
   */
  dispose(): void {
    if (this.tsRefreshHandle !== null) {
      clearInterval(this.tsRefreshHandle)
      this.tsRefreshHandle = null
    }
    this.clearOpenTypingTimeout()
    this.disposed = true
    this.abortController.abort()
  }

  /**
   * Chat-history hydration (2026-05-28 sprint) — fetch the most
   * recent batch of historical turns from
   * `GET /api/v1/chat/history` and render them ABOVE the live
   * tail. Fires from the WS `onopen` handler (parallel to
   * `engine.start`). Idempotent: re-firing on a subsequent
   * WS reconnect no-ops because `historyHydrated` is sticky for
   * the page lifetime (and the deduped Set survives reconnect,
   * so the active prompt's reconnect-time re-emit silences
   * itself).
   *
   * Errors (network, 401, 500) log to console and return silently
   * — the live WS path continues uninterrupted; the user sees the
   * currently-active phase prompt rendered via the engine's
   * existing re-emit path. Non-200 responses are also non-fatal
   * (the chat surface degrades to live-WS-only).
   */
  private async hydrateInitialHistory(): Promise<void> {
    if (this.historyHydrated || this.historyHydrating) return
    this.historyHydrating = true
    try {
      const signal = this.abortController.signal
      // 2026-05-28 sidebar sprint — thread the active topic_id through
      // when set so the history reflects the selected sidebar topic.
      const params = new URLSearchParams()
      params.set('limit', '20')
      if (typeof this.opts.topic_id === 'string' && this.opts.topic_id.length > 0) {
        params.set('topic_id', this.opts.topic_id)
      }
      const res = await fetch(`/api/v1/chat/history?${params.toString()}`, {
        credentials: 'include',
        signal,
      })
      if (this.disposed || signal.aborted) return
      if (!res.ok) {
        console.warn(
          `[chat] event=history-hydrate-failed status=${res.status} — falling back to live-WS-only`,
        )
        return
      }
      const body = (await res.json()) as {
        ok?: boolean
        turns?: ChatHistoryTurn[]
        has_more?: boolean
        oldest_returned_at?: number | null
        oldest_returned_prompt_id?: string | null
      }
      if (this.disposed || signal.aborted) return
      if (body.ok !== true || !Array.isArray(body.turns)) {
        console.warn(`[chat] event=history-hydrate-malformed-body — ignoring`)
        return
      }
      this.prependHistoryBatch(
        body.turns,
        body.has_more === true,
        body.oldest_returned_at ?? null,
        body.oldest_returned_prompt_id ?? null,
        true,
      )
      this.historyHydrated = true
    } catch (err) {
      // AbortError from a cleanly-disposed client is expected.
      // NetworkError is also silenced — it fires from environments
      // where the chat surface is exercised without a real backend
      // (jsdom / happy-dom test bootstraps, dev sandboxes). Real
      // backend failures surface as a non-OK HTTP response above
      // and are already logged. Other unexpected throws still
      // warn so a regression surfaces.
      if (err instanceof Error) {
        if (err.name === 'AbortError' || err.name === 'NetworkError') return
      }
      console.warn(`[chat] event=history-hydrate-threw`, err)
    } finally {
      this.historyHydrating = false
    }
  }

  /**
   * Fetch the next older batch when the user clicks "Load earlier".
   * Strict `loadingOlder` flag gate (cosmetic `disabled` is for UX
   * only — keyboard / screen-reader double-fire could bypass the
   * disabled attribute). The fetch's `signal` ties back to
   * `abortController` so a WS close mid-flight cleans up.
   *
   * Advance guard: if the server returns the same
   * `oldest_returned_at` (or no rows at all when we believed
   * `has_more=true`), the cursor isn't advancing — hide the
   * button + log so the user isn't trapped clicking forever.
   */
  private async loadOlderBatch(): Promise<void> {
    if (this.loadingOlder) return
    if (!this.historyHydrated) return
    if (this.historyOldestTs === null) return
    const button = this.loadEarlierButton
    if (button === null) return
    this.loadingOlder = true
    const originalLabel = button.textContent ?? 'Load earlier messages'
    button.disabled = true
    button.textContent = 'Loading…'
    const prevOldest = this.historyOldestTs
    const prevOldestPromptId = this.historyOldestPromptId
    try {
      const signal = this.abortController.signal
      const params = new URLSearchParams()
      params.set('before', String(prevOldest))
      if (prevOldestPromptId !== null) {
        params.set('before_prompt_id', prevOldestPromptId)
      }
      params.set('limit', '20')
      // 2026-05-28 sidebar sprint — thread the active topic_id when set.
      if (typeof this.opts.topic_id === 'string' && this.opts.topic_id.length > 0) {
        params.set('topic_id', this.opts.topic_id)
      }
      const res = await fetch(`/api/v1/chat/history?${params.toString()}`, {
        credentials: 'include',
        signal,
      })
      if (this.disposed || signal.aborted) return
      if (!res.ok) {
        console.warn(
          `[chat] event=history-load-earlier-failed status=${res.status}`,
        )
        return
      }
      const body = (await res.json()) as {
        ok?: boolean
        turns?: ChatHistoryTurn[]
        has_more?: boolean
        oldest_returned_at?: number | null
        oldest_returned_prompt_id?: string | null
      }
      if (this.disposed || signal.aborted) return
      if (body.ok !== true || !Array.isArray(body.turns)) {
        console.warn(`[chat] event=history-load-earlier-malformed-body`)
        return
      }
      const newOldest = body.oldest_returned_at ?? null
      const newOldestPromptId = body.oldest_returned_prompt_id ?? null
      // Advance guard — the server should always either return at
      // least one new row (which advances the cursor backward in
      // time) OR send `has_more: false`. If neither happens, hide
      // the button so the user isn't stuck looping.
      //
      // Codex r1 P2 (2026-05-28) — compare the COMPOSITE cursor
      // `(created_at, prompt_id)`, not just `created_at`. The
      // backend paginates by `(created_at, prompt_id)` to handle
      // ms-collisions, so a valid next page CAN share
      // `oldest_returned_at` with the previous boundary as long as
      // the prompt_id is strictly lower. Comparing on `created_at`
      // alone would discard those legitimate older rows and
      // prematurely hide the Load-earlier button on a burst-emit
      // topic.
      if (
        body.turns.length === 0 ||
        cursorStalled(
          { ts: prevOldest, prompt_id: prevOldestPromptId },
          { ts: newOldest, prompt_id: newOldestPromptId },
        )
      ) {
        console.warn(
          `[chat] event=history-cursor-stalled prev=(${prevOldest},${String(prevOldestPromptId)}) new=(${String(newOldest)},${String(newOldestPromptId)}) — hiding load-earlier button`,
        )
        this.removeLoadEarlierButton()
        return
      }
      this.prependHistoryBatch(
        body.turns,
        body.has_more === true,
        newOldest,
        body.oldest_returned_prompt_id ?? null,
        false,
      )
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'AbortError' || err.name === 'NetworkError') return
      }
      console.warn(`[chat] event=history-load-earlier-threw`, err)
    } finally {
      this.loadingOlder = false
      // Restore the button (it may have been removed in the cursor-
      // stalled branch above, in which case this is a no-op).
      if (this.loadEarlierButton !== null) {
        this.loadEarlierButton.disabled = false
        this.loadEarlierButton.textContent = originalLabel
      }
    }
  }

  /**
   * Insert a batch of historical turns at the TOP of `#log` and
   * restore the scroll viewport to the same visible content
   * (height-delta anchor). Uses a `DocumentFragment` for the
   * batch so the browser performs a single reflow regardless of
   * batch size.
   *
   * The historical runs are built with a LOCAL run-context that
   * does NOT touch `this.currentRun` / `this.currentRunSender`
   * (those track the live-stream tail). Prepended user-side
   * bubbles render `turn.resolution_text` directly — no
   * interactive button affordances on historical rows.
   */
  private prependHistoryBatch(
    turns: ChatHistoryTurn[],
    hasMore: boolean,
    oldestTs: number | null,
    oldestPromptId: string | null,
    isNewestBatch: boolean,
  ): void {
    if (this.disposed || this.abortController.signal.aborted) return
    // 2026-06-17 — hydrated history is real content. Clear the first-load
    // "Setting things up…" indicator when there are turns to render. An EMPTY
    // batch (fresh owner, no prior turns) leaves the indicator up so it keeps
    // covering the window until the first live agent message lands.
    if (turns.length > 0) this.clearSetupIndicator()
    const log = this.opts.log
    // Capture scroll anchor BEFORE any DOM mutation so the
    // height-delta restore math works on the as-was state.
    const heightBefore = log.scrollHeight
    const topBefore = log.scrollTop
    this.prepending = true
    try {
      const fragment = document.createDocumentFragment()
      const ctx: HistoryRunContext = { currentRun: null, currentRunSender: null }
      // BUG #310 (2026-06-19) — the topic's single most-recent unresolved
      // row is the "active prompt" the server re-emits live with clickable
      // buttons (`reEmitActiveSeedPromptIfAny`, limit=1). Only the newest
      // batch (initial hydration) can contain it; older "Load earlier"
      // pages never do. Turns arrive DESC, so `turns[0]` is the newest.
      // Flag it so `renderHistoricalTurn` leaves it for the live re-emit
      // instead of painting a buttonless inert copy.
      const newest = turns[0]
      const activePromptId =
        isNewestBatch && newest !== undefined && !newest.resolved
          ? newest.prompt_id
          : null
      // Server delivers DESC by (created_at, prompt_id); reverse to
      // chronological order so the run-collapse logic stitches
      // same-sender adjacent turns the way the live path would.
      const chronological = turns.slice().reverse()
      for (const turn of chronological) {
        this.renderHistoricalTurn(turn, ctx, fragment, activePromptId)
      }
      // Insert the new content at the TOP of #log, then re-anchor
      // the "Load earlier" button (if any) so it remains the
      // visible first child. The pin-to-bottom invariant
      // (`#log > :first-child { margin-top: auto }`) applies to
      // whatever ends up first — when content overflows the
      // viewport (the common case once any history is loaded)
      // the auto-margin collapses to 0, which is the desired
      // visual.
      log.insertBefore(fragment, log.firstChild)
      this.historyOldestTs = oldestTs
      this.historyOldestPromptId = oldestPromptId
      if (hasMore && oldestTs !== null) {
        this.showLoadEarlierButton()
      } else {
        this.removeLoadEarlierButton()
      }
      // Restore scroll: keep the user's previous visible content
      // pinned to the same on-screen position. The height delta
      // accounts for whatever the prepend added.
      const heightAfter = log.scrollHeight
      log.scrollTop = topBefore + (heightAfter - heightBefore)
    } finally {
      // ALWAYS release the gate, even if a DOM call threw — keeping
      // it set would brick the live scroll handler.
      this.prepending = false
    }
  }

  /**
   * Render a single historical turn into `fragment` (NOT
   * `this.opts.log`). The local `ctx` collapses consecutive
   * same-sender turns the way the live path collapses adjacent
   * agent / user bubbles within a run, WITHOUT touching
   * `this.currentRun` / `this.currentRunSender` (which belong to
   * the live tail).
   *
   * Resolved turns render TWO bubbles: the agent's prompt body,
   * then a user-side bubble with `turn.resolution_text`. Unresolved
   * turns (the active phase prompt that the server pre-emits via
   * `button_prompts` even before the engine re-emits it on WS-open)
   * render only the agent-side bubble — the dedup Set silences
   * the live re-emit when it arrives.
   */
  private renderHistoricalTurn(
    turn: ChatHistoryTurn,
    ctx: HistoryRunContext,
    fragment: DocumentFragment,
    activePromptId: string | null,
  ): void {
    // BUG #310 fix (2026-06-19, owner live-dogfood) — render UNRESOLVED
    // historical rows as inert agent bubbles. Previously this method did
    // `if (!turn.resolved) return`, dropping every unresolved row and
    // relying on the server's live re-emit to repaint the conversation.
    // But the re-emit (`reEmitActiveSeedPromptIfAny`) ships only the
    // SINGLE most-recent unresolved row, so any earlier unresolved turn
    // (a prior agent reply the user never answered, a persisted project
    // stub) vanished on a topic switch — a project whose only row was its
    // unresolved opening seed showed exactly one message. Rendering them
    // inert (no button keyboard — the row carries no answer to click) lets
    // the full backlog hydrate.
    //
    // The ONE row we still skip is the topic's single most-recent
    // unresolved row (`activePromptId`, set only on the newest batch).
    // That is the "active prompt" the server re-emits live WITH its
    // clickable button keyboard. Painting it inert here would let the
    // dedup below silence the live re-emit, leaving the user a prompt body
    // with no way to answer it. We skip it WITHOUT adding it to
    // `renderedPromptIds`, so the authoritative clickable re-emit still
    // paints and owns the dedup slot.
    if (!turn.resolved && turn.prompt_id === activePromptId) return
    // Dedup before any DOM construction so the history-arrives-second
    // case is symmetric with the live-arrives-second case.
    if (this.renderedPromptIds.has(turn.prompt_id)) return
    this.renderedPromptIds.add(turn.prompt_id)
    // Connect engagement mode (2026-06-26) — a `tag_gated` quiet message
    // persists as an inert USER turn with an EMPTY `body` (the text lives in
    // `resolution_text`). Skip the agent bubble for an empty body so it paints
    // as a user-only bubble; every pre-existing turn has a non-empty agent body
    // so this guard is a no-op for them.
    if (turn.body.length > 0) {
      const agentRun = this.openOrJoinHistoryRun('agent', ctx, fragment)
      this.appendBubble(agentRun, 'agent', turn.body)
      this.refreshHistoryTail(agentRun, turn.created_at)
    }
    if (turn.resolved && turn.resolution_text.length > 0) {
      const userRun = this.openOrJoinHistoryRun('user', ctx, fragment)
      this.appendBubble(userRun, 'user', turn.resolution_text)
      this.refreshHistoryTail(userRun, turn.created_at)
    }
  }

  /**
   * Mirror of `openOrJoinRun` that (a) operates on a local
   * `HistoryRunContext` instead of mutating `this.currentRun*`,
   * and (b) appends new runs to a `DocumentFragment` so the
   * caller can stitch the entire batch in a single reflow.
   */
  private openOrJoinHistoryRun(
    sender: Sender,
    ctx: HistoryRunContext,
    target: DocumentFragment,
  ): HTMLElement {
    if (ctx.currentRunSender === sender && ctx.currentRun !== null) {
      return ctx.currentRun
    }
    const run = document.createElement('div')
    run.className = `run run-${sender}`
    run.dataset['sender'] = sender
    if (sender === 'agent') {
      const avatar = document.createElement('div')
      avatar.className = 'avatar'
      avatar.textContent = 'N'
      run.appendChild(avatar)
    }
    target.appendChild(run)
    ctx.currentRun = run
    ctx.currentRunSender = sender
    return run
  }

  /**
   * Place a `.ts` timestamp at the end of a historical run.
   * Anchors on the prompt's `created_at` so the relative label
   * matches when the turn happened (not when the page loaded).
   * The periodic `refreshAllTimestamps` tick re-formats every
   * `.ts[data-ts]` on its own cadence, so "5h ago" → "6h ago"
   * naturally without per-turn bookkeeping.
   */
  private refreshHistoryTail(run: HTMLElement, anchor_ts_ms: number): void {
    const existing = run.querySelector(':scope > .ts')
    if (existing !== null) existing.remove()
    const ts = document.createElement('div')
    ts.className = 'ts'
    ts.dataset['ts'] = String(anchor_ts_ms)
    ts.textContent = formatRelativeTime(this.now(), anchor_ts_ms)
    run.appendChild(ts)
  }

  /**
   * Lazy-construct (or hoist back to the top of `#log`) the
   * "Load earlier messages" button. Single node reused across
   * batches so the click listener stays bound — replacing the
   * node every batch would leak listeners. Click is gated on
   * `loadingOlder` AND `historyHydrated` inside `loadOlderBatch`.
   */
  private showLoadEarlierButton(): void {
    if (this.loadEarlierButton === null) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'load-earlier'
      button.textContent = 'Load earlier messages'
      button.addEventListener('click', () => {
        void this.loadOlderBatch()
      })
      this.loadEarlierButton = button
    }
    const log = this.opts.log
    if (this.loadEarlierButton.parentElement !== log) {
      log.insertBefore(this.loadEarlierButton, log.firstChild)
    } else if (log.firstChild !== this.loadEarlierButton) {
      // The button exists in #log but a fresh prepend put older
      // runs above it — hoist it back to the top.
      log.insertBefore(this.loadEarlierButton, log.firstChild)
    }
  }

  /**
   * Drop the "Load earlier" button when the server signals
   * `has_more=false` (or stalls). Idempotent.
   */
  private removeLoadEarlierButton(): void {
    if (this.loadEarlierButton === null) return
    if (this.loadEarlierButton.parentElement !== null) {
      this.loadEarlierButton.parentElement.removeChild(this.loadEarlierButton)
    }
  }

  /**
   * 2026-05-21 (Bug 3 fix) — drop the on-open typing-indicator
   * timeout handle. Idempotent. Called on first envelope, on WS close,
   * and on dispose so a stale timeout can't tear down a future
   * user-turn placeholder.
   */
  private clearOpenTypingTimeout(): void {
    if (this.openTypingTimeoutHandle === null) return
    if (typeof clearTimeout === 'function') {
      clearTimeout(this.openTypingTimeoutHandle)
    }
    this.openTypingTimeoutHandle = null
  }

  /**
   * Item 6 (2026-06-19) — register a callback fired after every successful
   * agent-message paint. The boot shell wires this to the topic rail's
   * live-refresh so the sidebar populates the moment onboarding creates
   * projects (no manual reload). Idempotent setter; last write wins.
   */
  setOnAgentMessageHook(fn: () => void): void {
    this.onAgentMessageHook = fn
  }

  connect(): void {
    // 2026-05-28 chat-history hydration — refresh the AbortController
    // on every connect attempt so a previously-aborted controller
    // (from a prior WS close) doesn't immediately cancel the new
    // hydration fetch. The very first `connect()` after construction
    // re-uses the controller minted in the field initializer (still
    // northwind).
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController()
    }
    // 2026-05-28 sidebar sprint — append `&topic_id=<id>` when the
    // active topic is non-General so the WS upgrade registers the
    // outbound sender at the right key. The gateway-side validator at
    // `landing/server.ts:validateActiveTopicId` rejects malformed
    // values with 400 (closes the upgrade) so a bad value never
    // silently mis-routes.
    const wsParams = new URLSearchParams()
    // ISSUES #94 — present the one-shot `?start=` token ONLY on the first
    // bring-up. Once the WS has opened, its jti is consumed; a reconnect
    // re-presenting it would fail the server's atomic claim and strand the
    // user with "session not started". Subsequent connects authenticate via
    // the session cookie (the server's cookie-only upgrade path).
    if (this.opts.start_token.length > 0 && !this.broughtUp) {
      wsParams.set('start', this.opts.start_token)
    }
    if (typeof this.opts.topic_id === 'string' && this.opts.topic_id.length > 0) {
      wsParams.set('topic_id', this.opts.topic_id)
    }
    // Item 5 (2026-06-19) — auto-detect the browser timezone and present it
    // on the FIRST bring-up so onboarding can thread it into state and the
    // agent NEVER has to ask (the interview prompt is instructed to treat
    // it as already known). Best-effort: `Intl` is universal in supported
    // browsers, but any failure just omits the param (the agent then falls
    // back to its prior behaviour). Sent only with the start token (first
    // connect) — a reconnect re-derives it server-side from stored state.
    if (this.opts.start_token.length > 0 && !this.broughtUp) {
      const tz = detectBrowserTimezone()
      if (tz !== null) wsParams.set('tz', tz)
    }
    const queryString = wsParams.toString()
    const url = queryString.length > 0 ? `${this.opts.url}?${queryString}` : this.opts.url
    const ws = new WebSocket(url)
    this.ws = ws
    this.setStatus('connecting', 'connecting')
    // T13 — `?debug=1`-gated WS trace hook for the e2e harness. The
    // chat.html bootstrap inline script (executed BEFORE this module
    // loads) sets `window.__neutron_debug = true` when the page URL
    // had `?debug=1`. When the flag is on we push every WS open /
    // close / message / error into `window.__neutronWsTrace` so the
    // harness can dump it on a phase failure. Dead-code-eliminable in
    // the sense that production never sets the flag and the listener
    // registrations cost nothing on the happy path. Bound capped to
    // the last 200 entries to keep the in-page buffer small.
    const win =
      typeof window !== 'undefined'
        ? (window as unknown as {
            __neutron_debug?: boolean
            __neutronWsTrace?: Array<{ t: number; kind: string; [k: string]: unknown }>
          })
        : undefined
    const debug = win?.__neutron_debug === true
    if (debug && win !== undefined) {
      if (!Array.isArray(win.__neutronWsTrace)) win.__neutronWsTrace = []
      const trace = win.__neutronWsTrace
      const push = (entry: { kind: string; [k: string]: unknown }): void => {
        trace.push({ t: Date.now(), ...entry })
        if (trace.length > 200) trace.splice(0, trace.length - 200)
      }
      push({ kind: 'init', url_host: typeof location !== 'undefined' ? location.host : '' })
      ws.addEventListener('open', () => push({ kind: 'open' }))
      ws.addEventListener('close', (ev) =>
        push({
          kind: 'close',
          code: (ev as CloseEvent).code,
          reason: ((ev as CloseEvent).reason || '').slice(0, 120),
        }),
      )
      ws.addEventListener('message', (event) => {
        const raw = typeof event.data === 'string' ? event.data : ''
        // Codex T13 r3 P1 (CRITICAL) — RedirectMessage envelopes
        // carry a live `new_start_token` JWT (5-15 min TTL,
        // single-use but valid until first claim). Without
        // redaction the harness would persist still-valid bearer
        // tokens into `<run-dir>/ws/*-fail.json`, which gets
        // tarballed + shared on Telegram for triage. Run every
        // outbound trace entry through a defensive scrubber that
        // replaces the token value with a placeholder before it
        // even enters the in-page buffer (defense in depth — the
        // harness's dumpWsTrace also re-scrubs on read).
        push({ kind: 'message', body: redactSensitiveJson(raw).slice(0, 500) })
      })
      ws.addEventListener('error', () => push({ kind: 'error' }))
    }
    ws.addEventListener('open', () => {
      // 2026-05-28 — circuit-breaker reset. A successful WS open means
      // whatever caused the prior close cleared, so wipe the
      // navigation-attempt counter. Without this a session that
      // recovers after 2 transient drops would keep "count=2" cached
      // forever, and a single drop next week would gate immediately.
      clearWsReconnectState()
      this.setStatus('connected', 'connected')
      // 2026-05-28 chat-history hydration — fire the initial history
      // fetch in parallel with `engine.start`. The fetch is
      // fire-and-forget (the typing bubble below covers UX while
      // both the engine + the history land). Deduplication via
      // `renderedPromptIds` keeps the live active-prompt re-emit
      // and the fetched-active-prompt row from double-rendering
      // regardless of arrival order. Idempotent on WS reconnect
      // (the `historyHydrated` flag short-circuits the second call).
      void this.hydrateInitialHistory()
      // 2026-05-21 (Bug 3 fix) — render the optimistic "agent is typing"
      // dots immediately on WS-open so the user sees liveness while
      // engine.start completes (the LLM router call for phase-spec
      // resolution can take 4+ seconds before the first agent envelope
      // arrives). Without this, the user stares at a blank chat with
      // no feedback. The first agent_message that lands fires
      // `renderAgent` → `hideTypingBubble`, decrementing the
      // pendingAgentReplies counter we just bumped, so the dots vanish
      // at the right moment.
      //
      // Edge case — engine.start has nothing to emit (e.g. terminal
      // phase, no active prompt + no static spec for the phase). The
      // dots would dangle. Defensive timeout below clears them after
      // OPEN_TYPING_TIMEOUT_MS so a misconfigured / completed flow
      // doesn't render forever-dots.
      this.showTypingBubble()
      // ISSUES #115 Argus r1 — tag this pending as the ON-OPEN optimistic
      // one so `handleAgentTypingEnd` can reconcile it if engine.start's
      // turn bracket closes without ever delivering a reply (terminal
      // phase / completed-onboarding reconnect / misconfig). The bracket's
      // `agent_typing_start` cancels the defensive timeout below, so this
      // flag is what keeps the no-reply case from stranding the dots.
      this.openOptimisticPending = true
      const handle = (typeof setTimeout === 'function')
        ? setTimeout(() => {
            // Only force-clear the OPEN-time bubble; user-sent turns
            // (sendInput/sendChoice) bump pendingAgentReplies and have
            // their own real reply landing. We use clearTypingBubble
            // to remove the bubble AND zero pendingAgentReplies, but
            // only when the counter is still exactly 1 (i.e. no user
            // turn has happened since open). If the user already
            // typed something, leave it alone — the user-turn dots
            // will hide on their own reply.
            if (this.pendingAgentReplies === 1 && this.typingBubble !== null) {
              this.clearTypingBubble()
              console.warn(
                '[chat] event=open-typing-timeout — no agent envelope arrived within '
                + `${OPEN_TYPING_TIMEOUT_MS}ms; clearing dangling dots`,
              )
            }
          }, OPEN_TYPING_TIMEOUT_MS)
        : null
      if (handle !== null) {
        this.openTypingTimeoutHandle = handle
      }
    })
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data) as InboundEvent
        if (msg.type === 'agent_message') this.renderAgent(msg)
        else if (msg.type === 'agent_ack') this.handleAgentAck()
        else if (msg.type === 'agent_typing_start') this.handleAgentTypingStart()
        else if (msg.type === 'agent_typing_end') this.handleAgentTypingEnd()
        else if (msg.type === 'redirect') this.handleRedirect(msg)
        else if (msg.type === 'slug_renamed') this.handleSlugRenamed(msg)
        else if (msg.type === 'error') this.renderServerError(msg)
        else if (msg.type === 'import_progress') this.renderImportProgress(msg)
        else if (msg.type === 'topic_switched') this.handleTopicSwitched(msg)
        else if (msg.type === 'session_ready') this.handleSessionReady(msg)
      } catch (err) {
        // 2026-06-18 (Bug 2) — surface instead of silently swallowing. This was
        // the blank-screen amplifier: a JSON.parse failure on a malformed frame
        // is benign, but a throw out of a render handler (renderAgent etc.) used
        // to vanish here with the typing dots already cleared. renderAgent now
        // self-defends with its own try/catch + fallback paint; this log is the
        // backstop for anything else (and for genuinely malformed frames).
        if (typeof console !== 'undefined') {
          console.warn('[chat] ws message handler threw', err)
        }
      }
    })
    ws.addEventListener('close', () => {
      void this.handleClose()
    })
    ws.addEventListener('error', () => {
      this.setStatus('error', 'error')
    })
  }

  /**
   * Reconnect after the WS closes mid-flow.
   *
   * 2026-05-27 persistent-session-cookie sprint — the chat client no
   * longer self-recovers via `/recover`. The instance gateway's
   * auth-gate (`landing/auth-gate.ts`) now owns the
   * cookie-valid-or-OAuth-bounce decision: a bare `GET /chat` either
   * serves the chat HTML (valid `neutron_session` cookie) or 302s to
   * identity signin with `return_url` preserved. We simply navigate
   * back to `/chat` and let the gate route the user.
   *
   * Prior behavior (deleted): read `window.__neutron_start_token`
   * stashed by chat.html, POST to `/recover?old_token=…`, parse the
   * 302 Location, fall back to "disconnected. refresh to continue."
   * on any failure. That path is fully obsolete now that the session
   * cookie carries identity across socket drops and tab reloads.
   */
  private async handleClose(): Promise<void> {
    // 2026-05-28 chat-history hydration — abort any in-flight
    // `/api/v1/chat/history` fetch so its Promise resolution can't
    // try to write into a torn-down DOM after the reconnect
    // navigation. The `connect()` path re-mints a fresh controller
    // on the next open. AbortError is swallowed inside the
    // hydration / loadOlder paths.
    this.abortController.abort()
    // 2026-05-21 (Bug 3 fix) — close cancels the on-open timeout the
    // same way an arriving envelope would; otherwise it could fire
    // mid-reconnect after the new socket re-armed it.
    this.clearOpenTypingTimeout()
    // 2026-05-13 — the WS is gone; whatever the optimistic typing
    // bubble was placeholding for can no longer arrive on this socket.
    // Force-clear the dots AND zero the pending-replies counter
    // (queued turns are effectively dropped). Codex r2 P2.
    this.clearTypingBubble()
    // 2026-05-21 (Bug 1, v0.1.75) — clear the import-progress bubble
    // too. The next session's first cron tick will re-emit a fresh
    // progress envelope onto the new socket if import_running is still
    // active.
    this.hideImportProgressBubble()
    // 2026-06-05 (Argus r2 P1 / Codex / julik-frontend-races, all independent)
    // — once the slug-rename CTA ("Open your agent →") is on screen, a WS
    // close is EXPECTED: the rename's `addOwnerRoute()` / Caddy flip tears
    // down the live socket. Auto-reloading to `/chat` here would get 302'd
    // (by THIS PR's unconditional pending-redirect persist) to the NEW host
    // BEFORE the user clicks — and the step-2.5 reorder makes that new
    // route/TLS even less likely to be ready at that instant. That is the
    // exact redirect-at-a-cold-host race this whole PR exists to eliminate,
    // and it would turn the button into decoration on the happy path. So we
    // leave the CTA in place and wait for the user's explicit click; the
    // pending-redirect 302 stays purely as the manual-reload recovery net.
    if (this.slugReadyCtaRendered) {
      this.setStatus('connected', 'ready — tap "Open your agent →"')
      return
    }
    this.setStatus('connecting', 'reconnecting...')
    if (typeof window !== 'undefined') {
      // 2026-05-28 — circuit breaker. If the destination `/chat`
      // keeps rejecting (instance gateway down, synthetic E2E instance
      // with no real backend, network blip during a slug-rename) the
      // pre-fix shape was an infinite navigate-loop. Cap at
      // WS_RECONNECT_MAX_ATTEMPTS within WS_RECONNECT_WINDOW_MS;
      // beyond that, render a static disconnected banner and stop
      // navigating until the user reloads. The counter resets on a
      // successful WS open (see the `open` handler in `connect()`).
      const gated = shouldGateWsReconnect(this.now())
      if (gated) {
        this.setStatus(
          'disconnected',
          'Connection lost. Refresh or sign in again.',
        )
        return
      }
      this.setStatus('connecting', 'redirecting to sign in…')
      try {
        window.location.replace('/chat')
        return
      } catch {
        // Defensive fallback for jsdom / sandboxed iframes — fall
        // through to the manual-refresh hint.
      }
    }
    this.setStatus('disconnected', 'disconnected. refresh to continue.')
  }

  /**
   * 2026-05-29 in-place topic switch sprint — switch the chat surface
   * to a different topic on the SAME WebSocket. Replaces the prior
   * `window.location.href = '/chat?topic_id=...'` reload path used by
   * `TopicRail.handleSelect`.
   *
   * Flow:
   *   1. Record the OUTGOING topic's scrollTop into
   *      `topicScrollOffsets` so a switch-back lands at the same
   *      position (Telegram behaviour).
   *   2. Cancel any in-flight `/api/v1/chat/history` fetch (the abort
   *      controller's signal propagates into the hydrator's Promise
   *      and short-circuits before any DOM write).
   *   3. Mint a fresh abort controller so the next hydrate has a clean
   *      signal.
   *   4. Clear `#log` content (keep the topic rail + composer intact;
   *      they live OUTSIDE `#log` in `chat.html`'s structure).
   *   5. Reset per-topic render state (renderedPromptIds, history
   *      cursor) so the new topic hydrates from scratch.
   *   6. Send the `topic_switch` event over the WS.
   *   7. Wait for the server's `topic_switched` ack (3 s timeout
   *      fallback so a misbehaving server doesn't strand the UI).
   *   8. Fetch the new topic's history.
   *   9. Apply first-mount scroll (last-unread / restored offset /
   *      bottom) based on `topicScrollOffsets` + `unread_count_hint`.
   *
   * The `unread_count_hint` is sourced from the sidebar TopicRail's
   * row (the `/api/v1/chat/topics` response already carries
   * `unread_count`), and lets `applyFirstMountScroll` pick the right
   * scroll target without an extra round-trip.
   *
   * Returns a Promise that resolves once the new topic's history is
   * rendered AND scrolled into position. The TopicRail can `await`
   * the call to drive a "switching..." status if it wants, but the
   * default UX is to fire-and-forget.
   */
  async switchTopic(
    new_topic_id: string | null,
    opts: { unread_count_hint?: number } = {},
  ): Promise<void> {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
      // No live socket -- fall back to a hard reload so the next
      // page-load picks up the new topic via the localStorage path.
      // This branch is the legacy behaviour, preserved as a graceful
      // degradation for disconnect-mid-switch.
      writeActiveTopicId(new_topic_id)
      if (typeof window !== 'undefined') {
        try {
          window.location.assign(`${window.location.pathname}${window.location.search}`)
        } catch {
          // jsdom / sandbox -- ignore.
        }
      }
      return
    }
    // The user's persisted "current topic" pointer drives the next
    // page load AND any uploads that happen on this socket. Mirror the
    // sidebar's local-state semantics: General is null, project is
    // the topic_id string.
    // 2026-05-30 Argus r3 P2 #1 fix — prefer the server-pushed user_id
    // from the `session_ready` envelope over the JWT decode. Cookie-only
    // upgrades have no `start_token` on the client (`?start=` is absent
    // from the URL), so `decodeJwtSubClaim('')` returned null and the
    // General-row click silently early-returned. The JWT path remains
    // as a belt-and-braces fallback for the rare case where the
    // `session_ready` envelope hasn't landed yet (or a pre-r3 server
    // doesn't emit it).
    const sub = this.serverPushedUserId ?? decodeStartTokenUserId(this.opts.start_token)
    const general = sub !== null ? `web:${sub}` : null
    const resolved = new_topic_id === null || (general !== null && new_topic_id === general)
      ? general
      : new_topic_id
    if (resolved === null) {
      // No way to derive General -- nothing to do (degraded auth).
      console.warn('[chat] switchTopic event=skip reason=no_user_id')
      return
    }
    const outgoing_topic_id =
      typeof this.opts.topic_id === 'string' && this.opts.topic_id.length > 0
        ? this.opts.topic_id
        : general
    if (outgoing_topic_id === resolved) {
      // Same-topic no-op. Don't disrupt scroll / hydration state.
      return
    }
    // 1) Cache the outgoing topic's scroll position so switch-back
    //    lands at the same spot. Capture BEFORE any DOM mutation.
    if (outgoing_topic_id !== null) {
      this.topicScrollOffsets.set(outgoing_topic_id, this.opts.log.scrollTop)
    }
    // 2) Abort any in-flight history fetch from the outgoing topic.
    //    AbortError is swallowed inside the hydrator.
    this.abortController.abort()
    // 3) Fresh controller for the incoming topic's hydrate.
    this.abortController = new AbortController()
    // 4) Clear `#log`. Suppress smooth scroll for the duration of the
    //    swap so the user never sees an animated zero -> bottom jump.
    const log = this.opts.log
    const prevScrollBehavior = log.style.scrollBehavior
    log.style.scrollBehavior = 'auto'
    log.replaceChildren()
    // `replaceChildren()` detached the first-load indicator's node; drop the
    // dangling field reference so it stays consistent (it never re-shows on a
    // topic switch — only first construction shows it).
    this.setupIndicator = null
    // 5) Reset per-topic render state. The renderedPromptIds Set has
    //    page-lifetime durability for the *current* topic; switching
    //    topics MUST clear it so the new topic's history can render
    //    its own active prompt (otherwise the dedup Set would silence
    //    the WS active-prompt re-emit on the new topic too).
    this.renderedPromptIds.clear()
    this.historyHydrated = false
    this.historyHydrating = false
    this.loadingOlder = false
    this.historyOldestTs = null
    this.historyOldestPromptId = null
    this.loadEarlierButton = null
    this.currentRun = null
    this.currentRunSender = null
    this.stickToBottom = true
    this.clearTypingBubble()
    // 2026-06-20 GO-LIVE #4 — tear down the on-open dangling-dots timeout too.
    // It is armed ONCE on WS-open (the engine.start optimistic dots) and never
    // re-armed. If it fires AFTER a switch — while a fresh turn on the NEWLY
    // selected topic is showing its own dots (pendingAgentReplies===1,
    // typingBubble!==null) — its force-clear would kill that live indicator
    // ("switch kills the typing indicator"). The original on-open dots are
    // already gone (clearTypingBubble above), so dropping the handle here is
    // strictly correct. dispose() clears it too; this mirrors that for switch.
    this.clearOpenTypingTimeout()
    this.hideImportProgressBubble()
    this.hideNewPill()
    // 6) Persist the new pointer + update the client-side handle so
    //    the next history fetch / WS reconnect picks the right topic.
    const newTopicForLs = general !== null && resolved === general ? null : resolved
    writeActiveTopicId(newTopicForLs)
    if (newTopicForLs === null) {
      delete (this.opts as { topic_id?: string }).topic_id
    } else {
      this.opts.topic_id = resolved
    }
    this.pendingTopicSwitchUnreadCount =
      typeof opts.unread_count_hint === 'number' && opts.unread_count_hint > 0
        ? opts.unread_count_hint
        : 0
    // 7) Send the WS event + wait for the server's ack (3 s timeout).
    try {
      await new Promise<string>((resolve) => {
        this.pendingTopicSwitchResolver = resolve
        // 2026-05-30 Argus r3 P2 #2 — stash the requested destination so
        // handleTopicSwitched can ignore acks for a SUPERSEDED switch.
        // Rapid double-click (A → B → A): without this guard B's ack
        // would fire A's resolver and the client could hydrate the
        // wrong topic into the just-cleared log.
        this.pendingTopicSwitchDestination = resolved
        if (this.pendingTopicSwitchTimeoutHandle !== null) {
          clearTimeout(this.pendingTopicSwitchTimeoutHandle)
        }
        this.pendingTopicSwitchTimeoutHandle = setTimeout(() => {
          if (this.pendingTopicSwitchResolver !== null) {
            console.warn(
              `[chat] switchTopic event=ack_timeout to=${resolved} -- continuing with hydrate anyway`,
            )
            const r = this.pendingTopicSwitchResolver
            this.pendingTopicSwitchResolver = null
            this.pendingTopicSwitchDestination = null
            this.pendingTopicSwitchTimeoutHandle = null
            r(resolved)
          }
        }, 3000)
        this.send({ type: 'topic_switch', new_topic_id: resolved })
      })
    } finally {
      // Restore scrollBehavior at the END of the switch (after
      // applyFirstMountScroll completes synchronously below) so any
      // POST-switch live envelopes use the smooth scroll.
    }
    // 8) Hydrate the new topic's history.
    await this.hydrateInitialHistory()
    // 9) Apply scroll target (Telegram behaviour: restored offset,
    //    first unread, or bottom -- in that order of preference).
    this.applyFirstMountScroll(resolved)
    // Restore smooth scroll for subsequent live envelopes.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        log.style.scrollBehavior = prevScrollBehavior.length > 0 ? prevScrollBehavior : 'smooth'
      })
    } else {
      log.style.scrollBehavior = prevScrollBehavior.length > 0 ? prevScrollBehavior : 'smooth'
    }
  }

  /**
   * 2026-05-29 in-place topic switch sprint — resolve the inbound
   * `topic_switched` ack from the gateway. The `switchTopic`
   * Promise's resolver was stashed pre-send; we fire it here so
   * the hydrate step proceeds. A late ack (after the 3 s timeout
   * already fired) is a silent no-op.
   *
   * 2026-05-30 Argus r3 P2 #2 fix — also drop acks whose `topic_id`
   * does NOT match the most-recently-requested destination. Rapid
   * double-click (A → B → A): without this guard B's ack would
   * arrive first (FIFO over the WS), fire A's resolver with the
   * wrong topic_id, and the post-await hydrate could render the
   * wrong topic into the just-cleared log. The stale ack is logged
   * and dropped; the in-flight switch's timeout remains armed so a
   * genuinely missing destination ack still falls through to the
   * 3 s timeout path.
   */
  private handleTopicSwitched(msg: TopicSwitchedMessage): void {
    const resolver = this.pendingTopicSwitchResolver
    if (resolver === null) return
    if (
      this.pendingTopicSwitchDestination !== null &&
      msg.topic_id !== this.pendingTopicSwitchDestination
    ) {
      console.warn(
        `[chat] handleTopicSwitched event=stale_ack ack_topic=${msg.topic_id} expected=${this.pendingTopicSwitchDestination} -- dropping superseded ack`,
      )
      return
    }
    if (this.pendingTopicSwitchTimeoutHandle !== null) {
      clearTimeout(this.pendingTopicSwitchTimeoutHandle)
      this.pendingTopicSwitchTimeoutHandle = null
    }
    this.pendingTopicSwitchResolver = null
    this.pendingTopicSwitchDestination = null
    resolver(msg.topic_id)
  }

  /**
   * 2026-05-30 Argus r3 P2 #1 fix — capture the server-pushed `user_id`
   * so `switchTopic` can derive `web:<user_id>` for the General topic
   * even on cookie-only sessions (no `?start=` JWT to decode). Fired
   * once per WS connection on `session_ready`; subsequent envelopes
   * are accepted as last-write-wins (defensive — the server should
   * only emit once but we don't fail closed if it doesn't).
   */
  private handleSessionReady(msg: SessionReadyMessage): void {
    if (typeof msg.user_id !== 'string' || msg.user_id.length === 0) return
    this.serverPushedUserId = msg.user_id
    // ISSUES #94 (Codex r2 P1) — `session_ready` is the server's proof that
    // the session is genuinely LIVE: it fires only AFTER `session_started =
    // true` on every success path (token jti claimed, cookie-only resume, or
    // the consumed-token cookie fallback). The raw WS `open` event is NOT
    // proof — `bridge.startSession` can still fail AFTER the upgrade with the
    // jti UNSPENT (a transient `engine.start` throw), in which case the
    // server closes the socket SPECIFICALLY so the client retries with the
    // still-valid `?start=` token. Flipping `broughtUp` here (not on `open`)
    // means a reconnect drops the token ONLY once it has actually been
    // consumed; an unconsumed-token close leaves `broughtUp` false so the
    // retry re-presents the token, preserving the bring-up retry contract.
    this.broughtUp = true
    // 2026-06-20 GO-LIVE P0 (owner live-dogfood) — clear the first-load
    // "Setting things up…" loader on a RESUMED returning session. The loader
    // exists to cover a FRESH onboarding's page-load → WS-open → first-prompt
    // window and was only ever cleared by the first rendered content
    // (`renderAgent` / a non-empty history batch). But a completed instance
    // that has nothing pending emits NO first agent prompt on reload, and the
    // General topic's history can be empty, so the loader hung FOREVER until a
    // topic switch tore it down. A `resumed` session_ready is the server's
    // deterministic proof this is a returning user with no setup window — so
    // we clear immediately. `clearSetupIndicator` is idempotent, so a later
    // history batch / agent_message is a harmless no-op. Fresh onboarding
    // arrives on the `?start=` path WITHOUT `resumed`, so its loader still
    // covers the bring-up window until the first prompt renders.
    if (msg.resumed === true) {
      this.clearSetupIndicator()
    }
  }

  /**
   * 2026-05-29 in-place topic switch sprint — apply the right scroll
   * target on first paint of a topic. Three branches:
   *
   *   1. Switch-back to a previously-opened topic ->
   *      `topicScrollOffsets` has an entry -> restore it.
   *   2. First mount of a topic with unread prompts (per the sidebar
   *      hint) -> insert a "-- New --" divider above the first
   *      unresolved bubble and scroll to it.
   *   3. First mount with no unread -> scroll to bottom synchronously
   *      (no animation). The CSS `margin-top: auto` on `#log >
   *      :first-child` already handles the pin-to-bottom case when
   *      content is shorter than the viewport; this branch covers the
   *      content-overflowing-viewport case.
   *
   * All branches set the scroll position via direct `scrollTop`
   * assignment (NOT `scrollTo({behavior:'smooth'})`) so the user
   * never sees an animated jump from top to bottom -- the Telegram
   * UX standard Sam asked for.
   */
  private applyFirstMountScroll(topic_id: string): void {
    const log = this.opts.log
    const restored = this.topicScrollOffsets.get(topic_id)
    if (restored !== undefined && this.topicFirstMountDone.has(topic_id)) {
      // Switch-back path. Restore the previously cached offset
      // synchronously; no animation.
      log.scrollTop = restored
      this.stickToBottom = isAtBottom(log)
      this.scrolledUpUnreadCount = 0
      this.hideNewPill()
      return
    }
    this.topicFirstMountDone.add(topic_id)
    const unreadHint = this.pendingTopicSwitchUnreadCount
    this.pendingTopicSwitchUnreadCount = 0
    if (unreadHint > 0) {
      // Insert the "-- New --" divider above the first unresolved
      // bubble we can find. The history hydration path renders
      // resolved bubbles ONLY (per the existing chat-history-surface
      // contract -- unresolved active prompts arrive via the WS
      // active-prompt re-emit on the new socket-bind). For the
      // current sprint we approximate "first unread" by anchoring
      // the divider above the LAST `unreadHint` agent bubbles --
      // the most recent agent-side runs.
      const insertedDivider = this.insertNewMessagesDivider(unreadHint)
      if (insertedDivider !== null) {
        // Scroll synchronously to the divider so the user lands
        // ABOVE the first new message (per Telegram). Use direct
        // scrollTop -- no smooth.
        const target = Math.max(0, insertedDivider.offsetTop - 24)
        log.scrollTop = target
        this.stickToBottom = isAtBottom(log)
        this.scrolledUpUnreadCount = 0
        this.hideNewPill()
        return
      }
      // No divider could be inserted (no agent bubbles in the
      // hydrated history -- fresh topic). Fall through to "scroll
      // to bottom".
    }
    log.scrollTop = log.scrollHeight - log.clientHeight
    this.stickToBottom = true
    this.scrolledUpUnreadCount = 0
    this.hideNewPill()
  }

  /**
   * Insert the "-- New --" divider before the first agent run in the
   * trailing `unreadCount` runs of `#log`. Returns the inserted
   * divider HTMLElement on success, or null when no insertion point
   * was found (empty log / no agent runs).
   *
   * Idempotent: removes any prior divider first so a re-fire on
   * switch-back doesn't stack dividers. The divider style is
   * sourced from `chat.html`'s `.new-divider` CSS class (added by
   * this sprint).
   *
   * Exported via the class surface for unit testing.
   */
  private insertNewMessagesDivider(unreadCount: number): HTMLElement | null {
    const log = this.opts.log
    // Tear down any prior divider.
    const prior = log.querySelector('.new-divider')
    if (prior !== null) prior.remove()
    const agentRuns = log.querySelectorAll<HTMLElement>('.run-agent')
    if (agentRuns.length === 0) return null
    // Anchor above the (unreadCount)th-from-last agent run. When
    // there are fewer agent runs than unreadCount, the divider lands
    // above the first one.
    const anchorIndex = Math.max(0, agentRuns.length - unreadCount)
    const anchor = agentRuns[anchorIndex] ?? null
    if (anchor === null) return null
    const divider = document.createElement('div')
    divider.className = 'new-divider'
    divider.setAttribute('role', 'separator')
    divider.setAttribute('aria-label', 'New messages')
    const label = document.createElement('span')
    label.className = 'new-divider-label'
    label.textContent = 'New'
    divider.appendChild(label)
    log.insertBefore(divider, anchor)
    return divider
  }

  /**
   * 2026-05-29 in-place topic switch sprint — show the "↓ N new"
   * pill when a live envelope arrives while the user is scrolled
   * up. Idempotent: re-firing while the pill is already visible
   * just refreshes the count.
   */
  private showNewPill(): void {
    const pill = this.newPill
    if (pill === null) return
    if (this.scrolledUpUnreadCount === 0) {
      pill.hidden = true
      return
    }
    pill.hidden = false
    pill.textContent =
      this.scrolledUpUnreadCount === 1
        ? '↓ 1 new'
        : `↓ ${this.scrolledUpUnreadCount} new`
  }

  private hideNewPill(): void {
    const pill = this.newPill
    if (pill === null) return
    pill.hidden = true
    this.scrolledUpUnreadCount = 0
  }

  private handleNewPillClick(): void {
    this.scrollToBottom('smooth')
    this.hideNewPill()
  }

  /**
   * P1.5 / Sprint 21 — handle the slug-picker redirect envelope. Kept
   * intentionally simple: navigate via `location.replace` so the
   * back-button history doesn't fight the renamed subdomain. The
   * gateway emits this BEFORE the systemd restart that kills the
   * underlying WebSocket so we get a clean handoff.
   */
  private handleRedirect(msg: RedirectMessage): void {
    if (typeof window === 'undefined') return
    let target = `${msg.new_url}${msg.new_url.includes('?') ? '&' : '?'}start=${encodeURIComponent(msg.new_start_token)}`
    // Codex T13 P2 #2 — propagate the debug flag across the redirect
    // so the WS-trace hook stays on the renamed-subdomain page.
    // URL-only propagation (no sessionStorage stash — that mechanism
    // leaked across origins; see Codex T13 r13 P3). Append only when
    // debug is on so production users never see it.
    const win =
      typeof window !== 'undefined'
        ? (window as unknown as { __neutron_debug?: boolean })
        : undefined
    if (win?.__neutron_debug === true) {
      target = `${target}&debug=1`
    }
    // Scheme/host allow-list before the location sink — refuse a
    // javascript:/data: target (DOM-XSS) or an unparseable redirect.
    const safe = safeNavUrl(target)
    if (safe === null) {
      this.setStatus('error', 'redirect blocked: unsafe target')
      return
    }
    this.setStatus('connecting', `redirecting to ${msg.project_slug}.…`)
    try {
      window.location.replace(safe)
    } catch {
      // Defensive fallback for environments where replace throws (test
      // jsdom, sandboxed iframe). location.assign + hard set still
      // produce a navigation in real browsers.
      window.location.href = safe
    }
  }

  /**
   * 2026-06-05 — structured slug-rename envelope handler, CLICK-BUTTON
   * model (Sam's call after another real signup failed):
   *
   *   "show a big button on the screen saying click here to login to your
   *    new agent, and then on that click take them to the new URL."
   *
   * The prior implementation called `window.location.replace` immediately
   * (auto-redirect). That kept losing a race: the slug rename's Caddy route
   * work tears down the live WS, so the envelope frequently arrived on a
   * dead socket (or the navigation hit a not-yet-ready host). A user CLICK
   * is a deterministic cross-host navigation — the human delay (seconds)
   * covers the new host's route + TLS readiness — so we render an explicit
   * CTA card with a big "Open your agent →" button instead of navigating.
   *
   * The button's click builds the SAME target the auto-redirect used
   * (`https://<new_host>/chat?start=<new_token>`, http:// for local dev)
   * and navigates. The user ALWAYS sees a clickable button, never a spinner
   * — we also clear any pending typing/import indicators here since the
   * slug-pick reply the user was waiting on has now arrived.
   *
   * Idempotent: if both the live envelope AND a reconnect-replay fire,
   * `slugReadyCtaRendered` guards against a duplicate card.
   *
   * See docs/plans/slug-rename-click-button-2026-06-05.md.
   */
  private handleSlugRenamed(msg: SlugRenamedMessage): void {
    if (typeof window === 'undefined') return
    if (this.slugReadyCtaRendered) return
    this.slugReadyCtaRendered = true
    const debugOn =
      (window as unknown as { __neutron_debug?: boolean }).__neutron_debug === true
    const target = buildSlugRenamedTarget(msg.new_host, msg.new_token, debugOn)
    // The slug-pick reply the user was waiting on has arrived — clear the
    // first-load loading indicator + optimistic typing dots / import-progress
    // bubble so the CTA renders on a clean slate (mirrors `renderAgent`'s
    // prologue).
    this.clearSetupIndicator()
    this.clearOpenTypingTimeout()
    this.hideTypingBubble()
    this.hideImportProgressBubble()
    const ts = this.now()
    const run = this.openOrJoinRun('agent', ts)
    this.appendBubble(run, 'agent', `🎉 Your agent is ready at ${msg.new_host}`)
    // One full-width CTA button. Reuses the `.buttons cols-1` grid styling
    // so it matches the rest of the chat affordances. The click navigates
    // cross-host (NOT a `button_choice` over the WS) — this is the
    // guaranteed handoff path.
    const grid = document.createElement('div')
    grid.className = 'buttons cols-1 slug-ready-cta'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'slug-ready-open'
    btn.textContent = 'Open your agent →'
    btn.addEventListener('click', () => {
      this.consumeButtons(grid, btn)
      // Scheme/host allow-list before the location sink (see safeNavUrl).
      const safe = safeNavUrl(target)
      if (safe === null) {
        this.setStatus('error', 'open blocked: unsafe target')
        return
      }
      this.setStatus('connecting', `opening ${msg.new_slug}.…`)
      try {
        window.location.assign(safe)
      } catch {
        window.location.href = safe
      }
    })
    grid.appendChild(btn)
    const existingTs = run.querySelector(':scope > .ts')
    if (existingTs !== null) run.insertBefore(grid, existingTs)
    else run.appendChild(grid)
    this.refreshTail(run)
    this.commitNewBubble(btn)
  }

  private setStatus(state: string, label: string): void {
    this.opts.status.textContent = label
    this.opts.status.dataset['state'] = state
  }

  /**
   * 2026-05-09 — render a server-side `{type:'error'}` envelope as a
   * visible agent bubble. Pre-fix the client silently dropped these,
   * which produced the user-typed-slug-then-silence symptom: when the
   * engine threw mid-rename (button-store unknown_prompt, send_failed,
   * any uncaught InterviewError) the landing-server forwarded a typed
   * error to the WS but the client ignored it. Surfacing it inline lets
   * the user know their input was received and what failed instead of
   * leaving them staring at their own bubble.
   */
  private renderServerError(msg: ServerErrorMessage): void {
    // 2026-06-17 — an error is the first content to land; clear the first-load
    // "Setting things up…" indicator so the failure surfaces in its place.
    this.clearSetupIndicator()
    // 2026-05-21 (Bug 3 fix) — server error counts as the first
    // envelope arriving; cancel the on-open typing timeout.
    this.clearOpenTypingTimeout()
    // 2026-05-13 — an error envelope is the server's response too:
    // clear the optimistic typing dots so the failure surfaces in
    // place of the placeholder.
    this.hideTypingBubble()
    // 2026-05-21 (Bug 1, v0.1.75) — also clear the import-progress
    // bubble. An error envelope during import_running means the runner
    // hit a fatal status; the agent message that follows describes the
    // failure and the user re-routes via the keyboard.
    this.hideImportProgressBubble()
    const ts = this.now()
    const run = this.openOrJoinRun('agent', ts)
    const text = msg.message.length > 0 ? msg.message : 'something went wrong, please try again'
    const bubble = this.appendBubble(run, 'agent', text)
    this.refreshTail(run)
    this.commitNewBubble(bubble)
    // Codex r3 P2 — if more turns are queued, re-emit the dots BELOW
    // this error so the placeholder anchors to the still-outstanding
    // turn instead of getting orphaned above the error.
    this.renderTypingBubbleNowIfPending()
  }

  /**
   * Render an agent message into the stream. Joins the in-progress
   * agent run if the previous bubble was also from the agent;
   * otherwise opens a new run with an avatar.
   */
  private renderAgent(msg: AgentMessage): void {
    // Item 15 (2026-06-19, owner live-dogfood) — cross-project bleed guard.
    // FIRST statement, before any current-topic state is touched. The
    // live-agent reply path stamps `msg.topic_id`. A slow (cold) reply can
    // arrive AFTER the user has switched to another topic over the SAME
    // socket; without this guard the client painted it into whatever was
    // focused. When the message carries a topic_id that differs from the
    // focused topic, it belongs to ANOTHER topic — it is already persisted
    // server-side and will hydrate when the user switches there, so we drop
    // the live paint here rather than bleed it into the wrong transcript.
    //
    // Conservative by construction (onboarding-safe): we ONLY suppress when
    // BOTH the message AND the focused view carry a concrete topic_id and
    // they differ. Onboarding button-prompts omit topic_id (always render),
    // and the initial General load has an undefined focused topic (always
    // render) — so the working onboarding flow is never affected.
    const focusedTopic = this.opts.topic_id
    if (
      typeof msg.topic_id === 'string' &&
      msg.topic_id.length > 0 &&
      typeof focusedTopic === 'string' &&
      focusedTopic.length > 0 &&
      msg.topic_id !== focusedTopic
    ) {
      if (typeof console !== 'undefined') {
        console.debug('[chat] agent_message routed away (other topic)', {
          msg_topic: msg.topic_id,
          focused: focusedTopic,
        })
      }
      return
    }
    // 2026-05-28 chat-history hydration — FIRST statement: dedup
    // against `renderedPromptIds`. The hydration fetch may resolve
    // BEFORE the engine's active-prompt re-emit lands on WS-open
    // (or after — order is unstable). Either path: whichever lands
    // first wins; the second silently no-ops without disturbing
    // scroll, typing-bubble state, or run-context state.
    //
    // `prompt_id` is optional on AgentMessage (terminal turns ship
    // without one); those messages bypass the dedup entirely
    // (they're not in `button_prompts` and never appear in
    // history either, so there's nothing to collide with).
    const pid = msg.prompt_id
    // 2026-06-18 (first-load client-render fix, Bug 2) — diagnostics so a
    // field-reported BLANK first message can be traced from the browser console
    // without a local repro: log every inbound agent_message + whether the
    // dedup Set silenced it.
    const deduped = pid !== undefined && this.renderedPromptIds.has(pid)
    if (typeof console !== 'undefined') {
      console.debug('[chat] agent_message recv', { prompt_id: pid, deduped })
    }
    if (deduped) return
    // 2026-05-21 (Bug 3 fix) — the on-open typing timeout is now moot
    // (a real envelope arrived). Drop the handle so it can't fire late
    // and tear down a future user-turn placeholder.
    this.clearOpenTypingTimeout()
    // 2026-05-13 — the arriving agent message IS the response the
    // optimistic typing bubble was placeholding for. Remove it before
    // opening/joining the next run so we don't leave dots dangling
    // above the real reply.
    this.hideTypingBubble()
    // 2026-05-21 (Bug 1, v0.1.75) — clear the import-progress bubble
    // too. The arriving agent_message is what the user has been waiting
    // for (the import_running phase advanced); the progress indicator's
    // job is done.
    this.hideImportProgressBubble()
    // 2026-06-18 (Bug 2) — wrap the WHOLE paint. Pre-fix, a throw anywhere in
    // here (markdown render, button grid, a DOM op) propagated to the WS
    // message handler's try/catch and was SWALLOWED — leaving the typing dots
    // already cleared above and NOTHING painted: the blank-screen bug. We now
    // catch, surface the error, and paint a plain-text fallback so the screen
    // is never left blank. The setup loader is cleared and the prompt_id is
    // recorded ONLY after a successful paint (below), so a mid-render throw can
    // neither flash an empty screen (Bug 1) nor poison the dedup Set (Bug 2).
    try {
      const ts = this.now()
      const run = this.openOrJoinRun('agent', ts)
      const bubble = this.appendBubble(run, 'agent', msg.body)

    // Bug 2 (2026-05-09 chat-ux fix, refined Argus r1): on free-text-allowed
    // prompts where the only options are escape ramps ("Skip" / "Pause"),
    // the buttons add noise — the user types the answer in the composer.
    // But many freeform prompts also expose REAL named branches the engine
    // routes by `choice_value` (signup → use-telegram-name; import_offered
    // → show-curated; archetype_picked → keep-display-name;
    // work_pattern_captured → 4 named patterns; Sean-Ellis survey →
    // very_disappointed / somewhat_disappointed / not_disappointed).
    // Engine maps freeform replies to `__freeform__`, NOT to those named
    // values, so suppressing the buttons would make those branches
    // unreachable. Only suppress when EVERY option is a known
    // escape-ramp value. `image-gallery` (tap-to-pick portraits) is
    // also exempt.
    const ESCAPE_RAMP_VALUES = new Set([
      '__skip__',
      '__pause__',
      'skip',
      'pause',
      'skip-onboarding',
      'pause-onboarding',
    ])
    // import-screen-deadend sprint (2026-06-06) — Fix 2: do NOT suppress on
    // UPLOAD-affordance prompts. The suppression rationale above ("the user
    // types the answer in the composer") does not apply when the user's
    // action is upload-a-file / skip, not typing a freeform answer. On
    // `import_upload_pending` the body promises a "Skip the import" button
    // and the engine emits a single `skip` escape-ramp option — suppressing
    // it made the copy lie (the phantom-Skip bug Sam hit). When an
    // `upload_affordance` envelope is present, render the escape-ramp button.
    const suppressForFreeform =
      msg.allow_freeform === true &&
      msg.kind !== 'image-gallery' &&
      msg.upload_affordance === undefined &&
      msg.options !== undefined &&
      msg.options.length > 0 &&
      msg.options.every((opt) => ESCAPE_RAMP_VALUES.has(opt.value))
    if (
      msg.options !== undefined &&
      msg.options.length > 0 &&
      msg.prompt_id !== undefined &&
      !suppressForFreeform
    ) {
      const grid = document.createElement('div')
      // Sprint 28 Codex r6 P1 — `image-gallery` prompts render as a
      // CSS-grid of tappable thumbnails. Options without an
      // `image_url` (the trailing Skip / Regenerate control row) fall
      // back to plain text buttons inside the same grid so the
      // gallery + control rows stay visually grouped.
      const isGallery = msg.kind === 'image-gallery'
      // 2026-05-28 — text-length-aware grid columns (Telegram model).
      // Short labels (≤ 12 chars) fit 3 across; medium labels (≤ 24)
      // fit 2; longer labels collapse to 1 so the affordance stays
      // legible on narrow viewports. The longest label drives the
      // decision — uniform widths keep the row visually balanced.
      // Image galleries keep their existing auto-fit grid (the CSS
      // owns column sizing for thumbnails).
      const colsClass = ((): string => {
        if (isGallery) return ''
        const maxLen = msg.options.reduce(
          (acc, opt) => Math.max(acc, (opt.body ?? '').length),
          0,
        )
        if (maxLen > 24) return 'cols-1'
        if (maxLen > 12) return 'cols-2'
        return 'cols-3'
      })()
      grid.className = isGallery
        ? 'buttons image-gallery'
        : colsClass.length > 0
          ? `buttons ${colsClass}`
          : 'buttons'
      const promptId = msg.prompt_id
      for (const opt of msg.options) {
        const btn = document.createElement('button')
        btn.type = 'button'
        // Allow-list the thumbnail scheme; an unsafe (e.g. javascript:) src
        // falls through to the plain-text label below (CodeQL js/xss).
        const safeThumb =
          isGallery && typeof opt.image_url === 'string'
            ? safeImageSrc(opt.image_url)
            : null
        if (safeThumb !== null) {
          btn.className = 'thumb'
          const img = document.createElement('img')
          img.src = safeThumb
          img.alt = opt.body
          img.loading = 'lazy'
          btn.appendChild(img)
          const caption = document.createElement('span')
          caption.className = 'thumb-caption'
          // 2026-05-09 chat-UX: the visual button block IS the affordance.
          // Drop the "A — " / "B — " letter-prefix legend (Telegram still
          // renders the legend in its body text via render-button-prompt.ts;
          // web /chat doesn't need it).
          caption.textContent = opt.body
          btn.appendChild(caption)
        } else {
          btn.textContent = opt.body
        }
        btn.addEventListener('click', () => {
          this.consumeButtons(grid, btn)
          this.sendChoice(promptId, opt.value)
        })
        grid.appendChild(btn)
      }
      // Insert button grid before the timestamp so the timestamp stays
      // last in the run.
      const existingTs = run.querySelector(':scope > .ts')
      if (existingTs !== null) run.insertBefore(grid, existingTs)
      else run.appendChild(grid)
    }

      this.refreshTail(run)
      this.commitNewBubble(bubble)
      // Bug 1 — the first real agent message has now painted into #log. The
      // "Setting things up…" loader's job is done; clear it AFTER the bubble is
      // committed so the welcome never flashes onto an empty screen and the
      // loader owns the screen right up until the message lands.
      this.clearSetupIndicator()
      // Bug 2 — record the prompt_id ONLY after a successful paint so a throw
      // mid-render can't poison the dedup Set and silently eat a later re-emit
      // of the SAME message (the dedup-drops-first-message blank path).
      if (pid !== undefined) this.renderedPromptIds.add(pid)
      // P2 v2 § 6.2 (S4) — refresh the upload affordance after every agent
      // message render. The envelope's presence (or absence) on the
      // newly-arrived message is authoritative; an agent reply that does
      // NOT carry `upload_affordance` clears the surfaces (e.g. import
      // job started → no more uploads expected).
      this.refreshUploadAffordance(msg.upload_affordance ?? null)
      // Item 6 (2026-06-19, owner live-dogfood) — onboarding finalizes the
      // N projects server-side AFTER the rail's one-shot mount hydrate, so
      // the sidebar stayed empty until a manual page reload. Nudge the
      // topic-rail to re-fetch `/api/v1/chat/topics` on each agent message
      // WHILE it has no project rows yet; the refresher self-guards so this
      // is a no-op (no fetch) once the projects appear. This makes the
      // sidebar populate LIVE the moment onboarding creates the projects.
      this.onAgentMessageHook?.()
      if (typeof console !== 'undefined') {
        console.debug('[chat] agent_message painted', { prompt_id: pid })
      }
    } catch (err) {
      // Bug 2 — a throw in markdown/button-grid/DOM used to be swallowed by the
      // WS handler, leaving the typing dots cleared and the screen blank.
      // Surface it and paint a plain-text fallback so SOMETHING always lands.
      if (typeof console !== 'undefined') {
        console.error('[chat] renderAgent threw — painting plain-text fallback', err, {
          prompt_id: pid,
        })
      }
      this.paintAgentFallback(msg.body, pid)
    }
    // Codex r3 P2 — if more turns are queued, re-emit the dots BELOW
    // the just-rendered reply via the same-sender collapse rule so
    // the placeholder anchors to "what we're still waiting for".
    this.renderTypingBubbleNowIfPending()
  }

  /**
   * 2026-06-18 (Bug 2) — last-resort fallback when `renderAgent`'s normal paint
   * throws (e.g. a markdown edge case, an undefined body, a DOM failure). Paints
   * the message body as PLAIN TEXT (bypassing the markdown renderer, the most
   * likely throw source) in a fresh agent run, clears the first-load loader, and
   * records the prompt_id so a re-emit doesn't double-paint. Itself wrapped so a
   * second failure can't escape — the worst case is a logged double-failure, not
   * a thrown exception that strands the UI.
   */
  private paintAgentFallback(body: string, pid: string | undefined): void {
    try {
      const run = this.openOrJoinRun('agent', this.now())
      const bubble = document.createElement('div')
      bubble.className = 'bubble bubble-agent'
      bubble.textContent = typeof body === 'string' ? body : String(body ?? '')
      run.querySelectorAll(':scope > .bubble.tail').forEach((b) => b.classList.remove('tail'))
      bubble.classList.add('tail')
      const existingTs = run.querySelector(':scope > .ts')
      if (existingTs !== null) run.insertBefore(bubble, existingTs)
      else run.appendChild(bubble)
      this.refreshTail(run)
      this.commitNewBubble(bubble)
      this.clearSetupIndicator()
      if (pid !== undefined) this.renderedPromptIds.add(pid)
    } catch (err2) {
      if (typeof console !== 'undefined') {
        console.error('[chat] paintAgentFallback also threw', err2)
      }
    }
  }

  /**
   * ISSUES #69 Argus r1 BLOCKER 1 (2026-05-30) — handle a no-render
   * `agent_ack` envelope. The server fires this when an inbound
   * `button_choice` was processed (e.g. seed row resolved) but no
   * visible reply is owed. We decrement `pendingAgentReplies` + clear
   * the optimistic typing dots, then re-emit fresh dots if the user
   * has additional outstanding turns (mirrors the post-`agent_message`
   * tail of `renderAgent`).
   *
   * Mirrors `landing/server.ts:AgentAckOutbound`. Idempotent: a stray
   * ack with `pendingAgentReplies === 0` is a no-op — `hideTypingBubble`
   * clamps at 0, `removeTypingBubbleNow` is null-safe.
   */
  private handleAgentAck(): void {
    // Mirror the relevant teardown from `renderAgent`'s prologue: the
    // on-open typing timeout is moot (a real envelope arrived) and the
    // import-progress bubble (if any) should clear, just like a real
    // agent_message would clear it. Skip the dedup-by-prompt-id /
    // `openOrJoinRun` / `appendBubble` / refresh paths — those are
    // bubble-rendering concerns and an ack renders nothing.
    this.clearOpenTypingTimeout()
    this.hideTypingBubble()
    this.hideImportProgressBubble()
    this.renderTypingBubbleNowIfPending()
  }

  /**
   * ISSUES #115 — true while the typing dots should be on screen: either
   * the server has an open turn-bracket (`serverTypingActive`) OR an
   * optimistic user-send turn is still awaiting its reply
   * (`pendingAgentReplies`). The single predicate keeps the two systems
   * (server-authoritative + on-send-optimistic) from fighting over the
   * bubble — the dots clear only when BOTH are quiescent.
   */
  private shouldShowTyping(): boolean {
    return this.serverTypingActive > 0 || this.pendingAgentReplies > 0
  }

  /**
   * ISSUES #115 — handle the server's `agent_typing_start`. Bumps the
   * server bracket counter and ensures the dots are visible. The
   * gateway emits this at turn-start (before `engine.advance` /
   * `engine.start`), so unlike the optimistic on-send path it fires for
   * EVERY turn — including phase prompts the engine emits without a
   * preceding user send. A real envelope arriving also moots the on-open
   * timeout. If a bubble is already showing (optimistic on-send dots, or
   * the prior message of a multi-message turn) we just keep it pinned to
   * the bottom rather than churning the DOM.
   */
  private handleAgentTypingStart(): void {
    this.serverTypingActive += 1
    this.clearOpenTypingTimeout()
    if (this.typingBubble !== null) {
      const run = this.typingBubble.parentElement
      if (run !== null && run.parentElement === this.opts.log) {
        this.opts.log.appendChild(run)
      }
      if (this.stickToBottom) this.scrollToBottom('smooth')
      return
    }
    this.renderTypingBubbleNow()
  }

  /**
   * ISSUES #115 — handle the server's `agent_typing_end`. Decrements the
   * bracket counter (clamped at 0 so a stray end can't go negative) and
   * tears the dots down ONLY when nothing else still wants them visible
   * (`shouldShowTyping`). This is what finally clears the indicator on a
   * multi-`agent_message` turn: each `agent_message` re-arms the dots
   * below it while `serverTypingActive > 0`, and the trailing
   * `agent_typing_end` removes them once the turn is fully done.
   */
  private handleAgentTypingEnd(): void {
    if (this.serverTypingActive > 0) {
      this.serverTypingActive -= 1
    }
    // ISSUES #115 Argus r1 (2026-06-09) — reconcile the ON-OPEN optimistic
    // pending. If the server's turn bracket has now fully closed
    // (`serverTypingActive` back to 0) and the on-open optimism was never
    // consumed by a real reply (`hideTypingBubble` would have flipped the
    // flag), then `engine.start` produced NO agent_message/agent_ack
    // (terminal phase, completed-onboarding reconnect, misconfigured
    // instance). The speculative `pendingAgentReplies` we bumped on WS-open
    // would otherwise keep `shouldShowTyping()` true and strand the dots
    // forever — the on-open defensive timeout was already cancelled by
    // `handleAgentTypingStart`. Drop the speculative pending so the
    // indicator can clear. Scoped strictly to the on-open optimism: a real
    // user-sent turn's pending is owed a reply and is cleared by that
    // reply, never by a bracket close.
    if (this.openOptimisticPending && this.serverTypingActive === 0) {
      this.openOptimisticPending = false
      if (this.pendingAgentReplies > 0) {
        this.pendingAgentReplies -= 1
      }
    }
    if (!this.shouldShowTyping()) {
      this.removeTypingBubbleNow()
    }
  }

  /**
   * Note an outbound turn that the user just sent. Bumps the pending-
   * replies counter and renders the typing dots if they're not already
   * showing. Called from `sendInput` / `sendChoice` immediately after
   * the outbound WS frame has been queued.
   *
   * Codex r6 P2 — if a typing bubble already exists (the user just
   * sent a second turn before the first reply arrived), move the
   * transient typing run to the very bottom of the log so the
   * placeholder sits BELOW the newer outbound message instead of
   * being stranded above it.
   */
  /**
   * 2026-06-17 onboarding single-session rework (Step 1) — render the centered
   * "Setting things up…" first-load loading indicator into `#log`. Idempotent:
   * a second call while one is already showing no-ops. Pure DOM creation, no
   * counter mutation.
   */
  private showSetupIndicator(): void {
    if (this.setupIndicator !== null) return
    if (typeof document === 'undefined') return
    const wrap = document.createElement('div')
    wrap.className = 'setup-indicator'
    wrap.dataset['transient'] = 'setup'
    const inner = document.createElement('div')
    inner.className = 'setup-indicator-inner'
    const spinner = document.createElement('div')
    spinner.className = 'setup-spinner'
    const label = document.createElement('div')
    label.className = 'setup-label'
    label.textContent = 'Setting things up…'
    inner.appendChild(spinner)
    inner.appendChild(label)
    wrap.appendChild(inner)
    this.opts.log.appendChild(wrap)
    this.setupIndicator = wrap
  }

  /**
   * 2026-06-17 onboarding single-session rework (Step 1) — remove the first-load
   * loading indicator. Called the instant real content lands (first agent
   * message, WS-open typing dots, server error, import progress, hydrated
   * history). Idempotent — no-ops once the indicator is gone.
   */
  private clearSetupIndicator(): void {
    if (this.setupIndicator === null) return
    this.setupIndicator.remove()
    this.setupIndicator = null
  }

  private showTypingBubble(): void {
    this.pendingAgentReplies += 1
    if (this.typingBubble !== null) {
      const run = this.typingBubble.parentElement
      if (run !== null && run.parentElement === this.opts.log) {
        // appendChild moves an existing element to the end of the
        // parent's child list — it doesn't clone.
        this.opts.log.appendChild(run)
      }
      if (this.stickToBottom) this.scrollToBottom('smooth')
      return
    }
    this.renderTypingBubbleNow()
  }

  /**
   * Note an inbound reply envelope (agent_message / server error).
   * Decrements the pending-replies counter and physically removes the
   * typing bubble so the caller can render the real reply on a clean
   * slate. After rendering the real reply the caller MUST call
   * `renderTypingBubbleNowIfPending()` so a still-outstanding turn
   * gets fresh dots BELOW the just-rendered reply (Codex r3 P2 — the
   * previous "keep the bubble where it is" path put the real reply
   * UNDER the typing dots in `send, send, reply` flows).
   */
  private hideTypingBubble(): void {
    // ISSUES #115 Argus r1 — a real reply envelope arrived, which fulfils
    // the on-open optimistic pending (if it was still outstanding). Clear
    // the flag so `handleAgentTypingEnd` won't later double-count and
    // over-decrement `pendingAgentReplies`.
    this.openOptimisticPending = false
    if (this.pendingAgentReplies > 0) {
      this.pendingAgentReplies -= 1
    }
    this.removeTypingBubbleNow()
  }

  /**
   * Force-clear the typing bubble and zero the pending-replies counter
   * regardless of how many turns were outstanding. Called from
   * `handleClose` — once the WS is dead, no reply can arrive on it, so
   * the queued turns are effectively dropped.
   */
  private clearTypingBubble(): void {
    this.pendingAgentReplies = 0
    // ISSUES #115 Argus r1 — the WS is gone; no reply can fulfil the
    // on-open optimism, so drop the flag alongside the counters.
    this.openOptimisticPending = false
    // ISSUES #115 — also drop any open server turn-brackets. The WS is
    // gone; no `agent_typing_end` can arrive on it, so leaving
    // `serverTypingActive > 0` would strand the dots (and keep
    // `shouldShowTyping` true) on the next render.
    this.serverTypingActive = 0
    this.removeTypingBubbleNow()
  }

  /**
   * Detach the typing-bubble DOM node and its TRANSIENT parent run.
   * Idempotent. Because the typing bubble always lives in a fresh
   * `data-transient="typing"` run that it doesn't share with any real
   * agent bubble (Codex r6 — see `renderTypingBubbleNow` below), the
   * teardown is unconditional: the run goes when the dots go. No
   * tail-handoff bookkeeping is required because the typing bubble
   * never strips `.tail` from any real bubble in the first place.
   */
  private removeTypingBubbleNow(): void {
    if (this.typingBubble === null) return
    const bubble = this.typingBubble
    const parent = bubble.parentElement
    bubble.remove()
    this.typingBubble = null
    if (parent === null) return
    if (parent.dataset['transient'] === 'typing') {
      // Defensive: if `currentRun` ever pointed at this transient run
      // (shouldn't, since renderTypingBubbleNow doesn't update the
      // tracker), clear it so openOrJoinRun doesn't try to reuse a
      // detached node.
      if (this.currentRun === parent) {
        this.currentRun = null
        this.currentRunSender = null
      }
      parent.remove()
    }
  }

  /**
   * Render the three-dot agent-typing bubble in a fresh standalone
   * agent run appended to the end of the log. Pure DOM creation — no
   * counter mutation, no update to `currentRun` / `currentRunSender`.
   *
   * Codex r6 P3 — the typing bubble is treated as a TRANSIENT overlay,
   * NOT a participant in the same-sender run-collapse system. Earlier
   * cuts went through `openOrJoinRun('agent')` which flipped
   * `currentRunSender` to `'agent'`, breaking user-run collapsing for
   * the very next `sendInput` (two rapid user sends each landed in
   * their own user run with separate timestamps). Always rendering
   * the typing run as a separate `data-transient="typing"` node keeps
   * the run-collapse invariant intact while still giving the dots
   * their own avatar bubble.
   *
   * Codex r4 P2 — only scrolls to bottom when the viewport is already
   * stuck there. The `sendInput` / `sendChoice` paths force-scroll
   * via `scrollToBottom('smooth')` BEFORE this runs (which flips
   * `stickToBottom = true`), so the user-just-sent case still snaps
   * the viewport to the dots. Post-reply re-emits from a
   * scrolled-up viewport stay quiet.
   */
  private renderTypingBubbleNow(): void {
    // 2026-06-18 (Bug 1) — while the first-load "Setting things up…" loader is
    // up it is the SOLE liveness signal and owns the screen until the first
    // agent message paints (which clears it). Suppress the typing dots so they
    // never render OVER the loader (the on-open optimistic dots + the server's
    // `agent_typing_start` both route here during the engine.start window).
    // The callers still bump their counters (pendingAgentReplies /
    // serverTypingActive), so the ISSUES #115 reconciliation bookkeeping stays
    // correct — only the VISIBLE dots are withheld. Once the welcome paints and
    // clears the loader, `renderTypingBubbleNowIfPending` re-emits the dots for
    // any still-in-flight multi-message turn.
    if (this.setupIndicator !== null) return
    const run = document.createElement('div')
    run.className = 'run run-agent'
    run.dataset['sender'] = 'agent'
    run.dataset['transient'] = 'typing'
    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    avatar.textContent = 'N'
    run.appendChild(avatar)
    const bubble = document.createElement('div')
    bubble.className = 'bubble bubble-agent typing tail'
    for (let i = 0; i < 3; i += 1) {
      const dot = document.createElement('span')
      dot.className = 'dot'
      bubble.appendChild(dot)
    }
    run.appendChild(bubble)
    this.opts.log.appendChild(run)
    this.typingBubble = bubble
    if (this.stickToBottom) {
      this.scrollToBottom('smooth')
    }
  }

  /**
   * Codex r3 P2 — after a real reply renders, re-emit the typing dots
   * if more turns are still queued. The dots land in the same run as
   * the just-rendered reply (via the same-sender collapse rule) BELOW
   * it, anchoring the placeholder to "what we're still waiting for"
   * rather than the message that already landed.
   */
  private renderTypingBubbleNowIfPending(): void {
    // ISSUES #115 — re-arm when EITHER an optimistic user-send turn is
    // still pending OR the server's turn-bracket is still open. The
    // latter is what keeps the dots alive between messages on a
    // multi-`agent_message` turn: `renderAgent` removes the bubble to
    // render its reply, then calls this to re-emit the dots below the
    // fresh message while `serverTypingActive > 0`.
    if (this.shouldShowTyping() && this.typingBubble === null) {
      this.renderTypingBubbleNow()
    }
  }

  /**
   * 2026-05-21 (Bug 1, v0.1.75) — handle an inbound `import_progress`
   * envelope. The first envelope on a fresh import_running phase
   * creates the bubble; subsequent envelopes update the body text in
   * place. The bubble auto-clears when the next `agent_message`
   * envelope lands (the engine advanced out of import_running).
   *
   * Terminal envelopes (`status === 'completed' | 'failed' |
   * 'cancelled'`) are no-ops — the engine emits a matching
   * `agent_message` immediately after the terminal status lands, and
   * the agent_message render path clears the bubble. We tolerate
   * receiving a terminal-status progress envelope as a safety net but
   * don't render anything for it.
   *
   * v0.1.78 (2026-05-22) — `rate_limit_cooling_off` /
   * `rate_limit_paused` are NOT terminal: the bubble keeps animating
   * with the server-supplied body so the user sees we're still working
   * on the backoff.
   */
  private renderImportProgress(msg: ImportProgressMessage): void {
    // 2026-06-18 (Bug 1) — do NOT clear the first-load loader here. The loader
    // is cleared ONLY when the first agent MESSAGE renders (renderAgent) or on a
    // server error (renderServerError). In practice import-progress envelopes
    // only arrive long after the welcome has painted (post-upload), so the
    // loader is already gone; this just guarantees progress can never steal the
    // screen from the loader before the first message lands.
    if (
      msg.status === 'completed' ||
      msg.status === 'failed' ||
      msg.status === 'cancelled'
    ) {
      this.hideImportProgressBubble()
      return
    }
    // 2026-06-17 (Argus r2) — the visible phase label is derived ONLY
    // from `pass`/`status`. We deliberately IGNORE `msg.body` here: the
    // server body carries a raw chunk count ("Pass 1: 47/57 batches"),
    // and surfacing chunk numbers to the user was the forbidden case.
    // The user sees a clean phase label + a determinate bar + an ETA.
    const rate_limited =
      msg.status === 'rate_limit_cooling_off' || msg.status === 'rate_limit_paused'
    const label = rate_limited
      ? 'Paused briefly — picking your import back up'
      : msg.pass === 2
        ? 'Synthesizing your personality'
        : 'Scanning your conversations'

    const overall = importOverallPct(msg.pass, msg.pct)
    // Determinate only when we have an honest fraction. Pass 1 streaming-
    // fallback (pct = 0) and the very first sample render indeterminate.
    const determinate = overall > 0

    // Reset the ETA anchor on a fresh bubble or a pass transition so the
    // rate estimate is computed within a single pass (the 0→50% pass
    // boundary is not real linear progress).
    const now = this.now()
    if (
      this.importProgressEtaAnchor === null ||
      this.importProgressEtaAnchor.pass !== msg.pass
    ) {
      this.importProgressEtaAnchor = { pass: msg.pass, ts: now, overall }
    }
    let eta: string | null = null
    if (rate_limited) {
      // Honest: while paused on a rate limit the clock is meaningless.
      eta = 'estimating…'
    } else if (determinate) {
      const anchor = this.importProgressEtaAnchor
      const elapsed = now - anchor.ts
      const delta = overall - anchor.overall
      if (elapsed > 0 && delta > 0) {
        const rate = delta / elapsed // overall-fraction per ms
        eta = formatEtaRemaining((1 - overall) / rate)
      }
    }

    if (this.importProgressBubble === null) {
      this.renderImportProgressBubbleNow(label, overall, determinate, eta)
      return
    }
    if (this.importProgressBody !== null) this.importProgressBody.textContent = label
    this.updateImportProgressBar(overall, determinate)
    if (this.importProgressEta !== null) {
      this.importProgressEta.textContent = eta ?? 'estimating…'
    }
  }

  /**
   * 2026-06-17 (Argus r2) — push the overall fraction onto the visual
   * `<progress>` bar. Determinate sets `value` (0..100); indeterminate
   * strips it so the browser renders its native indeterminate animation.
   */
  private updateImportProgressBar(overall: number, determinate: boolean): void {
    const bar = this.importProgressBar
    if (bar === null) return
    if (determinate) {
      bar.value = Math.round(Math.min(Math.max(overall, 0), 1) * 100)
      bar.dataset['determinate'] = 'true'
    } else {
      bar.removeAttribute('value')
      bar.dataset['determinate'] = 'false'
    }
  }

  /**
   * 2026-05-21 (Bug 1, v0.1.75) — create the import-progress bubble in
   * a fresh transient agent run appended to the end of the log. Mirrors
   * `renderTypingBubbleNow` shape but with a leading status line above
   * the three dots so the user sees both progress text + pulsing
   * animation.
   *
   * The bubble lives in its own `data-transient="import-progress"` run
   * so it doesn't interfere with the typingBubble run or the run-
   * collapse system (Codex r6 P3 — see `renderTypingBubbleNow` for the
   * design rationale).
   */
  private renderImportProgressBubbleNow(
    label: string,
    overall: number,
    determinate: boolean,
    eta: string | null,
  ): void {
    const run = document.createElement('div')
    run.className = 'run run-agent'
    run.dataset['sender'] = 'agent'
    run.dataset['transient'] = 'import-progress'
    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    avatar.textContent = 'N'
    run.appendChild(avatar)
    const bubble = document.createElement('div')
    bubble.className = 'bubble bubble-agent import-progress tail'

    const body = document.createElement('span')
    body.className = 'import-progress-body'
    body.textContent = label
    bubble.appendChild(body)

    // The determinate visual progress bar — the primary readout.
    const bar = document.createElement('progress')
    bar.className = 'import-progress-bar'
    bar.max = 100
    bubble.appendChild(bar)

    const etaEl = document.createElement('span')
    etaEl.className = 'import-progress-eta'
    etaEl.textContent = eta ?? 'estimating…'
    bubble.appendChild(etaEl)

    run.appendChild(bubble)
    this.opts.log.appendChild(run)
    this.importProgressBubble = bubble
    this.importProgressBody = body
    this.importProgressBar = bar
    this.importProgressEta = etaEl
    this.updateImportProgressBar(overall, determinate)
    if (this.stickToBottom) {
      this.scrollToBottom('smooth')
    }
  }

  /**
   * 2026-05-21 (Bug 1, v0.1.75) — detach the import-progress bubble +
   * its transient run. Idempotent.
   */
  private hideImportProgressBubble(): void {
    if (this.importProgressBubble === null) return
    const bubble = this.importProgressBubble
    const parent = bubble.parentElement
    bubble.remove()
    this.importProgressBubble = null
    this.importProgressBody = null
    this.importProgressBar = null
    this.importProgressEta = null
    this.importProgressEtaAnchor = null
    if (parent === null) return
    if (parent.dataset['transient'] === 'import-progress') {
      if (this.currentRun === parent) {
        this.currentRun = null
        this.currentRunSender = null
      }
      parent.remove()
    }
  }

  /**
   * Mark a button-prompt grid as consumed: disable every button, mark
   * the picked one, freeze the run so future renders don't overwrite
   * the visual state. The grey-out is what "consumed" means visually.
   *
   * Also closes the current agent run. A button click is a logical
   * user turn — the next agent_message should land in a fresh run
   * BELOW the consumed buttons, not stack inside the same run as
   * if it were a continuation of the prompt.
   */
  private consumeButtons(grid: HTMLElement, picked: HTMLButtonElement): void {
    grid.classList.add('consumed')
    grid.querySelectorAll('button').forEach((b) => {
      ;(b as HTMLButtonElement).disabled = true
    })
    picked.classList.add('picked')
    this.currentRunSender = null
    this.currentRun = null
  }

  private sendInput(): void {
    const body = this.opts.input.value
    const trimmed = body.trim()
    if (trimmed.length === 0 || this.ws === null || this.ws.readyState !== WebSocket.OPEN) return
    if (this.inFlight) return
    this.inFlight = true
    this.opts.sendBtn.disabled = true
    try {
      this.opts.input.value = ''
      this.autoGrow()
      const ts = this.now()
      const run = this.openOrJoinRun('user', ts)
      const bubble = this.appendBubble(run, 'user', body)
      this.refreshTail(run)
      // A local send is an explicit "I'm at the bottom now" gesture — even
      // if the user had scrolled up to read history, the act of sending
      // their own message should reveal it. Force-scroll past the
      // commitNewBubble stickToBottom check.
      this.commitLocalSend(bubble)
      this.send({ type: 'user_message', body })
      // 2026-05-13 — optimistic typing dots so the 2-3s engine.advance +
      // LLM gap looks like the agent is responding, not a frozen page.
      // The next agent_message (or WS close) removes the bubble.
      this.showTypingBubble()
    } finally {
      // Flicker-guard: re-enable on next tick so the disabled state is
      // visible to the user. Keeps double-Enter from double-submitting.
      setTimeout(() => {
        this.inFlight = false
        this.opts.sendBtn.disabled = false
      }, 50)
    }
  }

  private sendChoice(prompt_id: string, choice_value: string): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return
    this.send({ type: 'button_choice', prompt_id, choice_value })
    // 2026-05-13 Codex r1 P2 — button-choice replies hit the same
    // 2-3s engine.advance + LLM gap as typed messages. consumeButtons
    // has already nulled currentRun/currentRunSender, so openOrJoinRun
    // inside showTypingBubble() opens a fresh agent run below the
    // grayed-out prompt — the user gets the same optimistic "thinking"
    // feedback for tapped options as for typed text.
    //
    // Codex r5 P2 — tapping a button is an explicit "I want to see
    // the response" gesture (same semantic as sendInput's
    // commitLocalSend force-scroll). Snap to bottom BEFORE the dots
    // render so a user who'd scrolled up to read history still sees
    // the optimistic acknowledgement — without this, the
    // `stickToBottom`-gated scroll in `renderTypingBubbleNow` would
    // leave the dots silently appended off-screen.
    this.scrollToBottom('smooth')
    this.showTypingBubble()
  }

  private send(event: OutboundEvent): void {
    if (this.ws === null) return
    this.ws.send(JSON.stringify(event))
  }

  /**
   * Open a new run if `sender` differs from the in-progress run; otherwise
   * return the in-progress run. Run elements live as direct children of
   * `#log`, with the structure:
   *   <div class="run run-{sender}">
   *     <div class="avatar">N</div>     // agent only
   *     <div class="bubble"...>...</div>
   *     <div class="bubble tail">...</div>
   *     <div class="ts">2m</div>
   *   </div>
   */
  private openOrJoinRun(sender: Sender, _ts_ms: number): HTMLElement {
    if (this.currentRunSender === sender && this.currentRun !== null) {
      return this.currentRun
    }
    const run = document.createElement('div')
    run.className = `run run-${sender}`
    run.dataset['sender'] = sender
    if (sender === 'agent') {
      const avatar = document.createElement('div')
      avatar.className = 'avatar'
      avatar.textContent = 'N'
      run.appendChild(avatar)
    }
    this.opts.log.appendChild(run)
    this.currentRun = run
    this.currentRunSender = sender
    return run
  }

  private appendBubble(run: HTMLElement, sender: Sender, body: string): HTMLElement {
    const bubble = document.createElement('div')
    bubble.className = `bubble bubble-${sender}`
    // ISSUES #116 — agent bubbles render a tight, XSS-safe markdown
    // subset (bold/italic/code/lists) so the agent's `**bold**` output
    // shows formatted instead of raw markers (Sam's live-signup
    // screenshot). User bubbles stay plain text: a user typing `**` should
    // see their own literal characters, and there's no reason to format
    // their input. `renderMarkdown` escapes BEFORE formatting, so the
    // `innerHTML` assignment is injection-safe (see landing/markdown.ts).
    if (sender === 'agent') {
      bubble.classList.add('md')
      bubble.innerHTML = renderMarkdown(body)
    } else {
      bubble.textContent = body
    }
    // The previous bubble in this run loses its tail; the new one
    // becomes the run's only tail.
    run.querySelectorAll(':scope > .bubble.tail').forEach((b) => b.classList.remove('tail'))
    bubble.classList.add('tail')
    // Insert before the timestamp (if any) so timestamps stay last.
    const existingTs = run.querySelector(':scope > .ts')
    if (existingTs !== null) {
      run.insertBefore(bubble, existingTs)
    } else {
      run.appendChild(bubble)
    }
    return bubble
  }

  /**
   * Re-anchor the run-trailing timestamp to the moment of the latest
   * bubble. The DOM only carries one `.ts` per run; we tear down the
   * existing one and append a fresh one anchored to `now`, then a
   * periodic `refreshAllTimestamps` tick re-formats the visible label
   * over time so "now" → "1m" → "2m" → … without needing a new bubble.
   */
  private refreshTail(run: HTMLElement): void {
    const now_ms = this.now()
    const existing = run.querySelector(':scope > .ts')
    if (existing !== null) existing.remove()
    const ts = document.createElement('div')
    ts.className = 'ts'
    ts.dataset['ts'] = String(now_ms)
    ts.textContent = formatRelativeTime(now_ms, now_ms)
    run.appendChild(ts)
  }

  /**
   * Walk every visible `.ts` element and re-format its label against the
   * current clock. Each `.ts` carries its anchor moment in `data-ts`.
   */
  private refreshAllTimestamps(): void {
    const now_ms = this.now()
    const elements = this.opts.log.querySelectorAll<HTMLElement>('.ts')
    elements.forEach((el) => {
      const raw = el.dataset['ts']
      if (raw === undefined) return
      const then_ms = Number.parseInt(raw, 10)
      if (Number.isNaN(then_ms)) return
      el.textContent = formatRelativeTime(now_ms, then_ms)
    })
  }

  private commitNewBubble(_bubble: HTMLElement): void {
    // Auto-scroll only when the user is anchored at the bottom; when
    // they've scrolled up to read, leave the viewport alone — the new
    // bubble silently appends below their reading position and becomes
    // visible the moment they scroll back to the bottom.
    if (this.stickToBottom) {
      this.scrollToBottom('smooth')
      return
    }
    // 2026-05-29 in-place topic switch sprint — scrolled-up users
    // get the "↓ N new" pill (Telegram pattern). Counter increments
    // on every live agent envelope while scrolled up; clicking the
    // pill scrolls + zeros the counter.
    this.scrolledUpUnreadCount += 1
    this.showNewPill()
  }

  /**
   * Local-send variant of commitNewBubble. Always reveals the
   * just-rendered bubble, regardless of whether the user had scrolled
   * up — the act of sending is an explicit "snap to bottom" gesture.
   */
  private commitLocalSend(_bubble: HTMLElement): void {
    this.scrollToBottom('smooth')
  }

  private scrollToBottom(behavior: ScrollBehavior): void {
    const log = this.opts.log
    const top = log.scrollHeight
    // Prefer the explicit ScrollToOptions API so `behavior: 'smooth'`
    // is honored without depending on the CSS `scroll-behavior`
    // property. Fall back to a property write for environments
    // (jsdom, older harness builds) that don't implement scrollTo.
    if (typeof log.scrollTo === 'function') {
      try {
        log.scrollTo({ top, behavior })
      } catch {
        log.scrollTop = top
      }
    } else {
      log.scrollTop = top
    }
    this.stickToBottom = true
  }

  private handleScroll(): void {
    // 2026-05-28 chat-history hydration — suppress
    // `stickToBottom` recomputation while a "Load earlier" prepend
    // is mid-flight. Without this gate, the synchronous scroll
    // event fired by the height-delta `scrollTop` write would flip
    // `stickToBottom = false` mid-restore (because the prepend
    // momentarily puts the user above the bottom). Once the
    // restore lands, the user is *still* scrolled up reading
    // history, which is correctly captured on the next REAL scroll
    // event — so we just have to skip the bookkeeping for the
    // synthetic write.
    if (this.prepending) return
    // Load-bearing: toggling `stickToBottom` here is what makes
    // "scroll-up to read history without being yanked back" work, AND
    // it's what flips us back to auto-scroll once the user reaches the
    // bottom again (so the next bubble lands in view without a pill
    // click).
    this.stickToBottom = isAtBottom(this.opts.log)
    // 2026-05-29 in-place topic switch sprint — bottoming out clears
    // the "↓ N new" pill (the user has caught up to the live tail).
    if (this.stickToBottom) {
      this.hideNewPill()
    }
  }

  private handleInputKey(event: KeyboardEvent): void {
    // IME composition: never short-circuit a multi-keystroke compose.
    if (event.isComposing) return
    if (event.key !== 'Enter') return
    if (event.shiftKey) return // Shift-Enter inserts a newline (default behavior)
    event.preventDefault()
    this.sendInput()
  }

  /**
   * Auto-grow the textarea up to ~6 lines. The CSS max-height clamps the
   * visual height; this is just to keep `scrollHeight` from inflating
   * indefinitely between renders.
   */
  private autoGrow(): void {
    const ta = this.opts.input
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }

  /**
   * P2 v2 § 6.2 (S4) — bind the file-picker button + drag/drop overlay
   * to the upload flow. The handlers stay installed for the lifetime of
   * the page; visibility is gated by `uploadAffordanceSource` so the
   * affordance is invisible / inert outside `import_upload_pending`.
   */
  private wireUploadAffordance(): void {
    const {
      uploadBar,
      uploadButton,
      uploadInput,
      uploadOverlay,
    } = this.opts
    if (
      uploadBar === undefined ||
      uploadButton === undefined ||
      uploadInput === undefined ||
      uploadOverlay === undefined
    ) {
      return
    }
    const wireButtonInputPair = (
      button: HTMLButtonElement,
      input: HTMLInputElement,
      source: 'chatgpt' | 'claude',
    ): void => {
      button.addEventListener('click', () => {
        if (this.uploadInFlight) return
        input.click()
      })
      input.addEventListener('change', () => {
        const file = input.files?.[0] ?? null
        if (file === null) return
        // ISSUES #48 review follow-up — guard re-entry on the change
        // handler too, not just the click. The button's click handler
        // bails if `uploadInFlight`, but a programmatic
        // `input.dispatchEvent(new Event('change'))` (or a synthetic
        // `input.files` set) would otherwise overwrite the per-attempt
        // `uploadAbortController`, orphaning the in-flight fetch (Cancel
        // would only abort the new attempt). Cheap defense-in-depth.
        if (this.uploadInFlight) return
        void this.handleUploadFile(file, source)
        // Reset so the same file can be re-picked after an error.
        input.value = ''
      })
    }
    wireButtonInputPair(uploadButton, uploadInput, 'chatgpt')
    // ISSUES #48 — Cancel + Retry wiring (regression fix after Phase 2
    // chunked-upload rebase dropped the Phase 1 wiring). Both buttons
    // are optional: when omitted the affordance bar still works
    // (succeed-or-fail) but mid-flight cancel + one-click retry are
    // silently disabled. handleUploadFile owns the visibility lifecycle.
    const cancelBtn = this.opts.uploadCancel
    if (cancelBtn !== undefined) {
      cancelBtn.addEventListener('click', () => {
        // Bail if we're not in-flight (defensive against duplicate clicks
        // or a click after the finally already cleared the controller).
        if (this.uploadAbortController === null) return
        // ISSUES #48 review follow-up — give the user immediate visual
        // feedback. The chunked client's transport-failure retry loop in
        // `upload-client.ts:patchChunkWithRetry` catches the AbortError
        // thrown by the in-flight PATCH and waits `initialDelayMs` (1s
        // default) BEFORE the next iteration calls `throwIfAborted` and
        // surfaces `phase: 'abort'`. During that 1s window, without this
        // synchronous label flip, the UI still says "Uploading X 47%…"
        // with a visible progress bar and the user has no idea their
        // click registered. Flip the label + disable the button now so
        // the click feels instant; the finally block tears the cancel
        // button down once the rejection propagates.
        const label = this.opts.uploadLabel
        if (label !== undefined) label.textContent = 'Cancelling…'
        cancelBtn.disabled = true
        // Aborts the in-flight `uploadChunked` via the per-attempt
        // controller stored on the instance. The chunked client rejects
        // with `UploadChunkedError.opts.phase === 'abort'`, and
        // handleUploadFile's catch branch routes that to the cancel
        // reset (no error bubble, no retry surface).
        this.uploadAbortController.abort()
      })
    }
    const retryBtn = this.opts.uploadRetry
    if (retryBtn !== undefined) {
      retryBtn.addEventListener('click', () => {
        if (this.uploadInFlight) return
        const last = this.lastUploadAttempt
        if (last === null) return
        // Re-fire with the SAME File the user originally picked.
        // handleUploadFile rebuilds its `uploadChunked` opts per call
        // so this is safe — a fresh controller, a fresh chunk loop.
        void this.handleUploadFile(last.file, last.source)
      })
    }
    if (this.uploadDragInstalled) return
    this.uploadDragInstalled = true
    const onDragEnter = (event: DragEvent): void => {
      if (this.uploadAffordanceSource === null) return
      if (!isDataTransferFile(event.dataTransfer)) return
      event.preventDefault()
      this.uploadDragDepth += 1
      this.setUploadOverlayVisible(true)
    }
    const onDragOver = (event: DragEvent): void => {
      if (this.uploadAffordanceSource === null) return
      if (!isDataTransferFile(event.dataTransfer)) return
      event.preventDefault()
    }
    const onDragLeave = (event: DragEvent): void => {
      if (this.uploadAffordanceSource === null) return
      event.preventDefault()
      this.uploadDragDepth = Math.max(0, this.uploadDragDepth - 1)
      if (this.uploadDragDepth === 0) this.setUploadOverlayVisible(false)
    }
    const onDrop = (event: DragEvent): void => {
      this.uploadDragDepth = 0
      this.setUploadOverlayVisible(false)
      if (this.uploadAffordanceSource === null) return
      if (!isDataTransferFile(event.dataTransfer)) return
      event.preventDefault()
      const file = event.dataTransfer?.files?.[0] ?? null
      if (file === null) return
      // The affordance is always a single source — route the dropped file
      // to it directly (guarded non-null above).
      void this.handleUploadFile(file, this.uploadAffordanceSource)
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
  }

  /**
   * P2 v2 § 6.2 (S4) — sync the affordance bar + drag overlay to the
   * latest envelope. Called from `renderAgent`.
   */
  private refreshUploadAffordance(
    affordance: { source: 'chatgpt' | 'claude' } | null,
  ): void {
    this.uploadAffordanceSource = affordance?.source ?? null
    const bar = this.opts.uploadBar
    const label = this.opts.uploadLabel
    const button = this.opts.uploadButton
    const overlayText = this.opts.uploadOverlayText
    if (bar === undefined) return
    // ISSUES #48 — any affordance flip (next agent envelope, success
    // path clearing the bar) drops the retry surface AND the cached
    // attempt so a stale Retry can't fire against a brand-new flow.
    // Cancel + progress are owned by the in-flight handler's lifecycle
    // and intentionally NOT touched here (a mid-upload affordance
    // refresh shouldn't yank the cancel button out from under the user).
    const retryBtn = this.opts.uploadRetry
    if (retryBtn !== undefined) retryBtn.hidden = true
    this.lastUploadAttempt = null
    if (this.uploadAffordanceSource === null) {
      bar.hidden = true
      bar.classList.remove('error')
      this.setUploadOverlayVisible(false)
      this.uploadDragDepth = 0
      return
    }
    bar.hidden = false
    bar.classList.remove('error')
    const src = this.uploadAffordanceSource
    const sourceLabel = src === 'claude' ? 'Claude export' : 'ChatGPT export'
    if (label !== undefined) label.textContent = `Upload your ${sourceLabel} ZIP`
    if (button !== undefined) button.textContent = `Upload ${sourceLabel}`
    if (overlayText !== undefined) {
      overlayText.textContent = `Drop your ${sourceLabel} here`
    }
  }

  /**
   * P2 v2 § 6.2 (S4) — common path for file-picker AND drag-drop. POSTs
   * the bytes to `/api/upload/<source>`, renders a synthetic user
   * bubble so the user sees their action acknowledged, and surfaces
   * errors inline. Server-side, the upload handler bridges into
   * `engine.notifyImportUpload(...)` which fires the next agent_message
   * over the WS — clearing the upload affordance on the next render.
   */
  private async handleUploadFile(
    file: File,
    routeOverride?: 'chatgpt' | 'claude',
  ): Promise<void> {
    if (this.uploadInFlight) return
    if (this.uploadAffordanceSource === null) return
    // Caller passed an explicit route (the file-picker button + the
    // drag-drop handler both do) — honour it. Otherwise collapse the
    // affordance source: 'claude' → claude, anything else → chatgpt.
    const source: 'chatgpt' | 'claude' =
      routeOverride !== undefined
        ? routeOverride
        : this.uploadAffordanceSource === 'claude'
          ? 'claude'
          : 'chatgpt'
    this.uploadInFlight = true
    // ISSUES #48 — cache this attempt so the Retry button can re-fire
    // it after a terminal error without a file-picker round trip. Set
    // BEFORE any await so a synchronous-throwing failure still has a
    // cached attempt to retry against. Cleared on success / cancel /
    // affordance flip.
    this.lastUploadAttempt = { file, source }
    const bar = this.opts.uploadBar
    const button = this.opts.uploadButton
    const label = this.opts.uploadLabel
    const progress = this.opts.uploadProgress
    const cancelBtn = this.opts.uploadCancel
    const retryBtn = this.opts.uploadRetry
    if (button !== undefined) button.disabled = true
    if (bar !== undefined) bar.classList.remove('error')
    if (label !== undefined) label.textContent = `Uploading ${file.name}…`
    if (progress !== undefined) {
      progress.value = 0
      progress.removeAttribute('hidden')
    }
    // ISSUES #48 — Cancel shows while in-flight; Retry hides on every
    // fresh attempt so a stale red Retry button doesn't linger across
    // a Cancel→Retry→Cancel sequence.
    if (cancelBtn !== undefined) cancelBtn.hidden = false
    if (retryBtn !== undefined) retryBtn.hidden = true
    // ISSUES #48 — per-attempt AbortController. Stored on the instance
    // so the Cancel button listener can fire `.abort()` from outside
    // this method. Cleared in `finally` so the NEXT upload mints a
    // fresh controller (a shared controller would poison subsequent
    // uploads after the first cancel).
    const controller = new AbortController()
    this.uploadAbortController = controller
    // Optimistic user-message bubble so the action shows up in the
    // transcript even before the server acks.
    const ts = this.now()
    const run = this.openOrJoinRun('user', ts)
    const bubble = this.appendBubble(run, 'user', `Uploaded ${file.name}`)
    this.refreshTail(run)
    this.commitNewBubble(bubble)
    try {
      // Upload Resume Phase 2 — chunked resumable upload protocol.
      // Replaces the prior single-shot multipart POST so multi-GB
      // exports (Sam's 1.18 GB ChatGPT) survive a mid-upload network
      // drop and resume from the server's last acked byte. The legacy
      // `POST /api/upload/<source>` is still wired on the server for
      // any client that doesn't drive the chunked protocol (e.g. the
      // in-app RN client today).
      // Bind to globalThis. A bare `fetch` reference loses its `this` =
      // Window binding when called as a free function inside uploadChunked
      // (`args.fetchImpl(url, init)`), and Chrome/Edge throw
      // `Failed to execute 'fetch' on 'Window': Illegal invocation`. The
      // sibling bind in `landing/upload-client.ts:142` only catches the
      // "no fetchImpl passed" branch — this is the explicit-pass branch.
      const fetchImpl = this.opts.uploadFetch ?? fetch.bind(globalThis)
      // S11 — derive X-Neutron-Topic-Id from the start_token's `sub`
      // claim so the gateway's `engine.notifyImportUpload` routes the
      // post-upload button emit back through THIS socket. Pre-S11 the
      // gateway hardcoded `topic_id='chat'` with no registered sender;
      // engine emit silently dropped and the engine got stuck.
      const topicId = this.resolveUploadTopicId()
      const headers: Record<string, string> = {}
      if (topicId !== null) headers['X-Neutron-Topic-Id'] = topicId

      const resumeKey = `${UPLOAD_RESUME_LS_PREFIX}${source}:${file.name}:${file.size}`
      const resumeUploadId = readLocalStorageSafe(resumeKey)
      const initialPctText = label?.textContent
      const opts: UploadChunkedOptions = {
        url: `/api/upload/${source}`,
        file,
        fetchImpl,
        headers,
        // ISSUES #48 — feed the per-attempt AbortController's signal
        // into the chunked client so a Cancel-button click
        // (controller.abort()) propagates through `throwIfAborted`
        // into a rejection with `phase === 'abort'`.
        signal: controller.signal,
        onProgress: (loaded, total) => {
          // Surface progress via the upload label + visual progress bar
          // so the user sees the upload advancing even on slow
          // connections. The bar is driven by the per-chunk server-acked
          // high-water-mark from the chunked client, so it only ever
          // advances on confirmed bytes (no client-side optimistic creep).
          const pct = total > 0 ? Math.floor((loaded / total) * 100) : 0
          if (label !== undefined) {
            label.textContent = `Uploading ${file.name} ${pct}%…`
          }
          if (progress !== undefined) {
            progress.value = pct
          }
        },
      }
      if (resumeUploadId !== null) opts.resumeUploadId = resumeUploadId
      let result
      try {
        result = await uploadChunked(opts)
        // Persist the upload_id ONLY after we have it — survives an
        // immediate page reload between /start and the first PATCH.
        writeLocalStorageSafe(resumeKey, result.upload_id)
      } catch (err) {
        if (err instanceof UploadChunkedError) {
          // On any non-resumable failure clear the cached id so a retry
          // doesn't try to resume an expired session.
          if (
            err.opts.status === 0 ||
            err.opts.status === 404 ||
            err.opts.status === 410 ||
            err.opts.status >= 400
          ) {
            removeLocalStorageSafe(resumeKey)
          }
          throw err
        }
        // Restore the label text the caller set up if uploadChunked
        // threw before any progress callback fired.
        if (label !== undefined && typeof initialPctText === 'string') {
          label.textContent = initialPctText
        }
        throw err
      }
      // Success — clear the cached resume id and let the WS deliver
      // the next agent_message (the engine's import_running status).
      // The render path clears the upload affordance off the next
      // envelope automatically.
      removeLocalStorageSafe(resumeKey)
      // ISSUES #48 — invalidate the cached attempt so a Retry click
      // after a happy path doesn't re-fire a stale File (the user
      // would expect Retry to apply to the most recent failure, not
      // a completed upload).
      this.lastUploadAttempt = null
      void result
    } catch (err) {
      // ISSUES #48 — cancel vs terminal-error branch. The chunked
      // client surfaces a deliberate user cancel as
      // `UploadChunkedError` with `opts.phase === 'abort'` (see
      // `throwIfAborted` in `landing/upload-client.ts:558`). Treat
      // those as a clean idle reset:
      //   - friendly "cancelled" label, NOT the red error label
      //   - NO error agent bubble (cancel ≠ failure)
      //   - retry stays hidden (we don't offer to retry what the
      //     user explicitly cancelled — they can re-pick if they
      //     change their mind)
      //   - cached attempt cleared (no stale Retry target)
      const aborted =
        controller.signal.aborted ||
        (err instanceof UploadChunkedError && err.opts.phase === 'abort')
      if (aborted) {
        if (label !== undefined) {
          label.textContent = 'Upload cancelled. Pick another file to try again.'
        }
        // ISSUES #48 review r1 — rewrite the optimistic user bubble
        // appended above so the transcript reads truthfully. Without
        // this the bubble still says "Uploaded {name}" while the
        // upload-bar label says "Upload cancelled. Pick another
        // file…" — directly contradictory. We preserve the same DOM
        // node (rather than detach + re-append) so the user's mental
        // model that they DID initiate an upload survives — just one
        // that didn't complete.
        bubble.textContent = `Cancelled upload of ${file.name}`
        if (bar !== undefined) bar.classList.remove('error')
        if (retryBtn !== undefined) retryBtn.hidden = true
        this.lastUploadAttempt = null
      } else {
        const message = err instanceof Error ? err.message : 'upload failed'
        if (bar !== undefined) bar.classList.add('error')
        if (label !== undefined) label.textContent = `Upload failed: ${message}. Try again.`
        // ISSUES #48 — surface the Retry button on terminal errors so
        // the user can re-fire the same File with one click
        // (lastUploadAttempt still holds it).
        if (retryBtn !== undefined) retryBtn.hidden = false
        // Surface as a server-error-style agent bubble so the user sees
        // the failure inline.
        const errRun = this.openOrJoinRun('agent', this.now())
        const errBubble = this.appendBubble(
          errRun,
          'agent',
          `Couldn't upload that file: ${message}`,
        )
        this.refreshTail(errRun)
        this.commitNewBubble(errBubble)
      }
    } finally {
      this.uploadInFlight = false
      // ISSUES #48 — clear the per-attempt controller so the NEXT
      // upload mints a fresh one. Sharing controllers across attempts
      // would mean a cancel on attempt N permanently poisons attempt
      // N+1 (signal.aborted stays true forever).
      this.uploadAbortController = null
      if (button !== undefined) button.disabled = false
      // ISSUES #48 — Cancel always hides at end of attempt, win or
      // lose. Retry visibility is managed in the try/catch branches
      // above (visible only on terminal error). Re-enable the button
      // alongside hiding it so the NEXT upload mints a fresh attempt
      // with a clickable Cancel from the start (the cancel listener
      // sets `disabled = true` for immediate-feedback UX).
      if (cancelBtn !== undefined) {
        cancelBtn.hidden = true
        cancelBtn.disabled = false
      }
      if (progress !== undefined) {
        progress.setAttribute('hidden', '')
        progress.value = 0
      }
    }
  }

  /**
   * S11 — lazily compute the `topic_id` to send in the
   * `X-Neutron-Topic-Id` upload header so the upload handler's post-upload
   * `engine.notifyImportUpload` routes the follow-up emit back through THIS
   * socket. Returns `web:<user_id>` to match `webTopicId(...)` in
   * gateway/http/web-topic-id.ts.
   *
   * Identity resolution, in order of trust:
   *   1. `serverPushedUserId` — the `session_ready` envelope's `user_id`,
   *      the server's own proof of identity. Present for BOTH Open and
   *      Managed sessions regardless of token shape, and the only signal a
   *      cookie-only resume (no `?start=` token on the client) has.
   *   2. `decodeStartTokenUserId(opts.start_token)` — decode the identity
   *      from the start-token for the rare pre-`session_ready` upload.
   *      Handles BOTH shapes: the Open single-owner HMAC start-token
   *      (2-segment, `user_id` in the payload) AND the Managed JWT
   *      (3-segment, `sub` claim). The prior code only understood the JWT
   *      `sub` shape, so in real Open usage it returned null → no header →
   *      the gateway fell back to topic 'chat' → the import never
   *      correlated to the session → onboarding stuck at
   *      import_upload_pending.
   *
   * Returns null only when neither signal is available; the upload still
   * goes through but the post-upload engine emit may drop. A null result
   * is NOT cached so a later call (after `session_ready` lands) can still
   * resolve; a successful resolution is cached to avoid re-parsing on
   * back-to-back uploads.
   */
  private resolveUploadTopicId(): string | null {
    if (typeof this.uploadTopicIdCache === 'string') return this.uploadTopicIdCache
    const token = this.opts.start_token
    const userId =
      this.serverPushedUserId ??
      (typeof token === 'string' ? decodeStartTokenUserId(token) : null)
    if (userId === null) {
      this.uploadTopicIdCache = null
      return null
    }
    this.uploadTopicIdCache = `web:${userId}`
    return this.uploadTopicIdCache
  }

  private setUploadOverlayVisible(visible: boolean): void {
    const overlay = this.opts.uploadOverlay
    if (overlay === undefined) return
    overlay.hidden = !visible
    if (visible) overlay.dataset['active'] = 'true'
    else delete overlay.dataset['active']
  }
}

/**
 * Upload Resume Phase 2 — small localStorage helpers used by
 * {@link Chat.handleUploadFile} to cache `upload_id`s across page
 * reloads so a mid-upload reload resumes from the server's
 * `Upload-Offset` instead of restarting from byte 0. Each helper is
 * safe to call in non-browser test environments (returns null / no-ops
 * when `localStorage` is unavailable).
 */
function readLocalStorageSafe(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const v = localStorage.getItem(key)
    if (typeof v !== 'string' || v.length === 0) return null
    return v
  } catch {
    return null
  }
}

function writeLocalStorageSafe(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  } catch {
    // SecurityError / QuotaExceeded — best-effort cache; the next
    // upload will just have to /start from scratch.
  }
}

function removeLocalStorageSafe(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(key)
  } catch {
    // swallow
  }
}

/**
 * Helper — does the `DataTransfer` carry an actual file? Browsers fire
 * `dragenter` for plain selection drags + dragged DOM nodes; we only
 * want the overlay when a file is in flight.
 */
function isDataTransferFile(dt: DataTransfer | null | undefined): boolean {
  if (dt === undefined || dt === null) return false
  const types = dt.types
  if (types === undefined || types === null) return false
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === 'Files') return true
  }
  return false
}

/**
 * 2026-05-28 sidebar sprint — read the persisted active topic_id from
 * localStorage. Returns null when storage is unavailable OR when the
 * stored value is empty/General. Validation happens server-side at
 * the WS upgrade + history fetch; this helper is purely about
 * remembering "which sidebar row did the user last click on".
 */
export function readActiveTopicId(): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(ACTIVE_TOPIC_LS_KEY)
    if (typeof raw !== 'string' || raw.length === 0) return null
    return raw
  } catch {
    return null
  }
}

/**
 * Item 5 (2026-06-19) — auto-detect the browser's IANA timezone
 * (`Intl.DateTimeFormat().resolvedOptions().timeZone`, e.g.
 * "America/Los_Angeles") so onboarding never has to ask. Returns null when
 * `Intl` is unavailable or yields an empty/oversize value. Bounded to a
 * sane length so a hostile/garbage value can't bloat the WS upgrade URL;
 * the server re-validates the `?tz=` param shape before using it.
 */
export function detectBrowserTimezone(): string | null {
  try {
    if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
      return null
    }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof tz !== 'string') return null
    const trimmed = tz.trim()
    if (trimmed.length === 0 || trimmed.length > 64) return null
    return trimmed
  } catch {
    return null
  }
}

/**
 * Persist the active topic_id to localStorage. `null` clears the
 * entry so subsequent reloads default to General.
 */
export function writeActiveTopicId(topic_id: string | null): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (topic_id === null || topic_id.length === 0) {
      localStorage.removeItem(ACTIVE_TOPIC_LS_KEY)
    } else {
      localStorage.setItem(ACTIVE_TOPIC_LS_KEY, topic_id)
    }
  } catch {
    // Quota / sandboxed — sidebar still works, just doesn't persist.
  }
}

/**
 * Compute the avatar character for a topic row (single uppercase
 * letter, falls back to ★ on empty names). Used as the fallback glyph
 * when `topicGlyph` doesn't find a known-pattern emoji.
 */
export function topicAvatarChar(name: string): string {
  const first = name.trim().charAt(0)
  if (first.length === 0) return '★'
  return first.toUpperCase()
}

/**
 * Curated emoji glyph map for common project name patterns. Order
 * doesn't matter — patterns are mutually exclusive in practice. Add
 * entries here when a new project name lands; unknown names fall
 * through to `topicAvatarChar` (first-letter).
 */
const KNOWN_GLYPHS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\btabs?\b/i, '🗂'],
  [/\btopline\b/i, '🗂'],
  [/\bnorthwind\b/i, '🧪'],
  [/\bn8n\b/i, '⚙️'],
  [/\bhome\s*assistant\b/i, '🏠'],
  [/\bla\s*property\b/i, '🏡'],
  [/\bhelperbot\b/i, '🤖'],
  [/\bacme\b/i, '💜'],
  [/\bbook\b/i, '📚'],
  [/\bnova\b/i, '⚡'],
  [/\brelationship\b/i, '❤️'],
  [/\bbiohack(?:ing)?\b/i, '🧬'],
  [/\btax\b/i, '💎'],
]

/**
 * Pick the avatar glyph for a topic name. Emoji when the name matches
 * a curated pattern; otherwise the first uppercase letter via
 * `topicAvatarChar`.
 */
export function topicGlyph(name: string): string {
  for (const [pattern, glyph] of KNOWN_GLYPHS) {
    if (pattern.test(name)) return glyph
  }
  return topicAvatarChar(name)
}

/**
 * Curated palette of distinct hues that read on the dark rail surface
 * (mid-saturation, mid-lightness). 10 colours — enough to feel varied
 * across a typical project list (~7 projects) without two adjacent
 * rows colliding on common project_id distributions. Pinned by
 * __tests__/sidebar-rail.test.ts (deterministic colour test).
 */
const TOPIC_COLOR_PALETTE: ReadonlyArray<string> = [
  '#3aa1ff', // blue
  '#42c98f', // green
  '#b96bff', // purple
  '#ff8a3a', // orange
  '#ff6b9d', // pink
  '#36c5d4', // teal
  '#ff5a5f', // red
  '#f0b400', // amber
  '#5a76ff', // indigo
  '#d44bff', // magenta
]

/** djb2 string hash — deterministic, fast, good enough for palette modulo. */
function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i)
  }
  // Force unsigned 32-bit so the modulo below stays non-negative.
  return h >>> 0
}

/**
 * Map a project_id (or any stable seed) to a palette hue. Empty seed
 * returns the neutral avatar background — used for the General row so
 * it visually reads as "the default tray" rather than "another
 * project".
 */
export function topicAvatarColor(seed: string): string {
  if (seed.length === 0) return '#2b3037'
  return TOPIC_COLOR_PALETTE[djb2(seed) % TOPIC_COLOR_PALETTE.length]!
}

/**
 * 2026-05-29 sidebar sprint — Telegram-topics-strip topic rail. Always
 * visible vertical column of avatar-over-label rows (~76px wide). No
 * hamburger toggle, no slide-in drawer. Fetches
 * `/api/v1/chat/topics`, renders rows, binds click → switch.
 *
 * Switching topics (updated 2026-05-29 in-place sprint): when the user
 * clicks a row AND a `chatClient` is wired, we call
 * `chatClient.switchTopic(...)` over the existing WS — no page reload,
 * no socket reconnect. The chat surface clears `#log`, re-binds the
 * sender, hydrates the new topic's history, and scrolls to the
 * first-unread / restored offset (Telegram pattern).
 *
 * When `chatClient` is unset (test harness without a live client) the
 * row falls back to the legacy persist-and-reload path so the
 * pre-sprint behaviour survives.
 *
 * Visual state (Argus / Sam 2026-05-29 callout): the active-row marker
 * (`aria-current="page"` + accent stripe) is re-applied IN-PLACE via
 * `applyActiveRow` instead of relying on a full re-render. Without
 * this, the previously-active row would keep its accent stripe until
 * the next `render(...)` invalidated it -- visually broken on a
 * sub-second WS switch.
 */
export interface TopicRailMountOptions {
  rail: HTMLElement
  list: HTMLElement
  activeTopicId: string | null
  /**
   * 2026-05-29 in-place topic switch sprint — live ChatClient handle.
   * When wired (production path from `bootChatFromQueryString`), row
   * clicks call `chatClient.switchTopic(...)` to swap topics over the
   * existing WS. When omitted (tests, embedded surfaces without a
   * ChatClient), the click falls back to the legacy
   * persist-localStorage + page-reload behaviour.
   */
  chatClient?: ChatClient
  /** Test-only — override the fetch + reload primitives. */
  fetchImpl?: typeof fetch
  reload?: (target: string) => void
}

export class TopicRail {
  private readonly opts: TopicRailMountOptions
  private readonly fetchImpl: typeof fetch
  private readonly reload: (target: string) => void
  private activeTopicId: string | null
  /**
   * Topic rows the last render painted, keyed by `topic_id`. Used by
   * `applyActiveRow` to flip the active marker in-place without a
   * full re-render of the strip.
   */
  private readonly rowsByTopicId = new Map<string, HTMLButtonElement>()
  /**
   * Item 6 (2026-06-19) — true once a render has painted at least one
   * PROJECT row (project_id !== null). Gates `refreshIfNoProjects()` so
   * the live-refresh nudge stops fetching once onboarding's projects land.
   */
  private hasProjectRows = false
  /** Item 6 — guard against overlapping in-flight refresh fetches. */
  private refreshing = false

  constructor(opts: TopicRailMountOptions) {
    this.opts = opts
    this.activeTopicId = opts.activeTopicId
    this.fetchImpl =
      opts.fetchImpl ??
      (typeof fetch === 'function' ? fetch.bind(globalThis) : (((): never => {
        throw new Error('TopicRail requires a fetch implementation')
      })()))
    this.reload =
      opts.reload ??
      ((target: string): void => {
        if (typeof window !== 'undefined') {
          window.location.assign(target)
        }
      })
  }

  /**
   * Fetch the topic list + render rows. Resolves after the first
   * paint; failures log + leave the fallback row visible.
   */
  async hydrate(): Promise<void> {
    let topics: ChatTopic[] | null = null
    try {
      const res = await this.fetchImpl('/api/v1/chat/topics', { credentials: 'include' })
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean; topics?: ChatTopic[] }
        if (body.ok === true && Array.isArray(body.topics)) {
          topics = body.topics
        } else {
          console.warn(`[chat] event=topic-rail-malformed-body`)
        }
      } else if (res.status === 404) {
        // Endpoint unmounted — fine, fallback row stays.
        return
      } else {
        console.warn(`[chat] event=topic-rail-fetch-failed status=${res.status}`)
      }
    } catch (err) {
      console.warn(`[chat] event=topic-rail-fetch-threw`, err)
    }
    if (topics === null) return
    this.render(topics)
  }

  /**
   * Item 6 (2026-06-19, owner live-dogfood) — live-refresh nudge. Re-fetch
   * the topic list ONLY while no project row has been painted yet. Wired
   * to the ChatClient's post-agent-message hook so the sidebar populates
   * the moment onboarding finalizes the projects, without a manual reload.
   * Self-guarding: once a project row lands (`hasProjectRows`), this
   * no-ops, so steady-state agent turns cost zero extra fetches. The
   * `refreshing` latch coalesces overlapping nudges.
   */
  async refreshIfNoProjects(): Promise<void> {
    if (this.hasProjectRows || this.refreshing) return
    this.refreshing = true
    try {
      await this.hydrate()
    } finally {
      this.refreshing = false
    }
  }

  /**
   * Render the rows. The active topic gets `aria-current="page"`;
   * `data-topic-id="<id>"` lets click handlers + tests find rows by
   * topic. The General row (project_id === null) renders with a `#`
   * glyph on the neutral surface so it visually reads as the default
   * tray; per-project rows use a curated glyph + deterministic colour
   * keyed on project_id.
   */
  render(topics: ChatTopic[]): void {
    const list = this.opts.list
    list.innerHTML = ''
    this.rowsByTopicId.clear()
    // Item 6 — latch once we've painted any project row so the live-refresh
    // nudge can stop. General-only (project_id === null) does NOT latch.
    if (topics.some((t) => t.project_id !== null)) this.hasProjectRows = true
    if (topics.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'rail-empty'
      empty.textContent = 'No conversations yet.'
      list.appendChild(empty)
      return
    }
    const active = this.activeTopicId
    for (const topic of topics) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'topic-row'
      row.dataset['topicId'] = topic.topic_id
      if (topic.project_id !== null) row.dataset['projectId'] = topic.project_id
      if (topic.project_id === null) row.dataset['topic'] = 'general'
      const isActive =
        (active === null && topic.project_id === null) ||
        active === topic.topic_id
      if (isActive) row.setAttribute('aria-current', 'page')

      const avatar = document.createElement('span')
      avatar.className = 'topic-avatar'
      if (topic.project_id === null) {
        // General — neutral surface, `#` glyph. The neutral background
        // matches the default --agent-avatar-bg from the stylesheet so
        // the row reads as "the home tray" rather than "another
        // coloured project".
        avatar.textContent = '#'
      } else {
        avatar.textContent = topicGlyph(topic.name)
        avatar.style.backgroundColor = topicAvatarColor(topic.project_id)
      }

      const badge = document.createElement('span')
      badge.className = 'topic-badge'
      badge.dataset['unreadCount'] = String(topic.unread_count)
      if (topic.unread_count > 0) {
        badge.textContent = String(topic.unread_count)
      } else {
        badge.hidden = true
      }
      // The badge is an absolute-positioned overlay on the avatar
      // (Telegram pattern). Keeping it as a child of `.topic-avatar`
      // means it inherits the row's hover / active states without an
      // extra positioning context.
      avatar.appendChild(badge)
      row.appendChild(avatar)

      const label = document.createElement('span')
      label.className = 'topic-label'
      label.textContent = topic.name
      row.appendChild(label)

      row.addEventListener('click', () => this.handleSelect(topic))
      list.appendChild(row)
      this.rowsByTopicId.set(topic.topic_id, row)
    }
  }

  /**
   * 2026-05-29 in-place topic switch sprint — flip the
   * `aria-current="page"` marker (and the per-row accent stripe via
   * CSS) without a full re-render of the topic list. Called by
   * `handleSelect` immediately on click so the user gets instant
   * visual feedback for their tap, even before the WS switch
   * completes.
   */
  private applyActiveRow(topic_id: string | null): void {
    this.activeTopicId = topic_id
    for (const [id, row] of this.rowsByTopicId.entries()) {
      const isGeneral = row.dataset['topic'] === 'general'
      const isActive =
        (topic_id === null && isGeneral) ||
        topic_id === id
      if (isActive) row.setAttribute('aria-current', 'page')
      else row.removeAttribute('aria-current')
    }
  }

  private handleSelect(topic: ChatTopic): void {
    // 2026-05-29 in-place topic switch sprint — flip the active marker
    // BEFORE the network round-trip so the tap feels instant.
    const next = topic.project_id === null ? null : topic.topic_id
    this.applyActiveRow(next)
    // Persist the new pointer so a fresh page-load (or a reconnect
    // that falls back to the legacy navigate path) restores the
    // current topic. The chat client also writes this from inside
    // `switchTopic`; we set it here too so the legacy fallback
    // branch below picks up the new value.
    if (topic.project_id === null) {
      writeActiveTopicId(null)
    } else {
      writeActiveTopicId(topic.topic_id)
    }
    // Optimistically zero the unread badge -- the gateway flips the
    // server-side count to 0 on the next history fetch (resolved
    // bubbles surface as resolution_text, unresolved prompts surface
    // their content via the WS re-emit which `renderedPromptIds`
    // dedups). Without this the badge stays visible until the next
    // sidebar hydrate, which looks broken.
    const badge = this.rowsByTopicId.get(topic.topic_id)?.querySelector('.topic-badge') as HTMLElement | null
    if (badge !== null) {
      badge.hidden = true
      badge.dataset['unreadCount'] = '0'
    }
    if (this.opts.chatClient !== undefined) {
      // In-place switch: no reload, no socket reconnect. The hint
      // lets `switchTopic` pick "scroll to last unread" without an
      // extra round-trip to /api/v1/chat/topics for the per-topic
      // unread_count.
      void this.opts.chatClient.switchTopic(
        topic.project_id === null ? null : topic.topic_id,
        { unread_count_hint: topic.unread_count },
      )
      return
    }
    // Legacy fallback (test harness, embedded surfaces with no live
    // ChatClient): reload via the same /chat URL so the page boots
    // fresh with the newly-stored topic_id.
    const target =
      typeof window !== 'undefined' && typeof window.location !== 'undefined'
        ? `${window.location.pathname}${window.location.search}`
        : '/chat'
    this.reload(target)
  }
}

export function bootChatFromQueryString(): void {
  if (typeof window === 'undefined') return
  // Codex r3 P3: derive ws/wss from the page protocol so localhost + dev
  // deploys (over plain http://) don't get refused for trying to open a
  // TLS WebSocket.
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${scheme}://${window.location.host}/ws/chat`
  // Codex r4 P1: prefer the in-memory stash that chat.html populates
  // before history.replaceState scrubs the token from the URL. The
  // location-based fallback covers callers that load this script
  // outside the standard chat.html shell.
  const stashed = (window as unknown as { __neutron_start_token?: string }).__neutron_start_token
  let start_token = typeof stashed === 'string' && stashed.length > 0 ? stashed : ''
  if (start_token.length === 0) {
    const params = new URLSearchParams(window.location.search)
    start_token = params.get('start') ?? ''
  }
  const log = document.getElementById('log') as HTMLElement | null
  const status = document.getElementById('status') as HTMLElement | null
  const input = document.getElementById('input') as HTMLTextAreaElement | null
  const sendBtn = document.getElementById('send') as HTMLButtonElement | null
  // P2 v2 § 6.2 (S4) — upload affordance DOM. All five are optional;
  // when any is missing the ChatClient silently drops the upload UI
  // (back-compat for embedded surfaces that lack the upload markup).
  const uploadBar = document.getElementById('upload-bar') as HTMLElement | null
  const uploadButton = document.getElementById('upload-button') as HTMLButtonElement | null
  const uploadInput = document.getElementById('upload-input') as HTMLInputElement | null
  const uploadLabel = document.getElementById('upload-label') as HTMLElement | null
  const uploadOverlay = document.getElementById('upload-overlay') as HTMLElement | null
  const uploadOverlayText = document.getElementById('upload-overlay-text') as HTMLElement | null
  const uploadProgress = document.getElementById('upload-progress') as HTMLProgressElement | null
  const uploadCancel = document.getElementById('upload-cancel') as HTMLButtonElement | null
  const uploadRetry = document.getElementById('upload-retry') as HTMLButtonElement | null
  if (log === null || status === null || input === null || sendBtn === null) return
  // 2026-05-28 sidebar sprint — restore the active topic_id from
  // localStorage so a refresh keeps the same topic surface. The
  // value is validated server-side at the WS upgrade + history
  // fetch, so a corrupt localStorage entry just 400s the upgrade
  // (chat surface degrades to the General default on next reload).
  const active_topic_id = readActiveTopicId()
  const opts: ChatClientOptions = { url, start_token, log, status, input, sendBtn }
  if (active_topic_id !== null && active_topic_id.length > 0) {
    opts.topic_id = active_topic_id
  }
  // exactOptionalPropertyTypes: only set the property when we have a real
  // element. Passing `undefined` explicitly is rejected.
  if (uploadBar !== null) opts.uploadBar = uploadBar
  if (uploadButton !== null) opts.uploadButton = uploadButton
  if (uploadInput !== null) opts.uploadInput = uploadInput
  if (uploadLabel !== null) opts.uploadLabel = uploadLabel
  if (uploadOverlay !== null) opts.uploadOverlay = uploadOverlay
  if (uploadOverlayText !== null) opts.uploadOverlayText = uploadOverlayText
  if (uploadProgress !== null) opts.uploadProgress = uploadProgress
  if (uploadCancel !== null) opts.uploadCancel = uploadCancel
  if (uploadRetry !== null) opts.uploadRetry = uploadRetry
  const client = new ChatClient(opts)
  client.connect()
  // 2026-05-29 sidebar sprint — mount the topic rail. Always-visible
  // narrow vertical strip (~76px), no drawer wiring. Hydrates from
  // `/api/v1/chat/topics`; clicking a row triggers a page reload with
  // the new topic_id persisted to localStorage. Failures are non-fatal
  // (the static fallback row in chat.html keeps the user on General).
  const rail = document.getElementById('topic-rail') as HTMLElement | null
  const railList = document.getElementById('rail-list') as HTMLElement | null
  if (rail !== null && railList !== null) {
    const topicRail = new TopicRail({
      rail,
      list: railList,
      activeTopicId: active_topic_id,
      // 2026-05-29 in-place topic switch sprint — thread the live
      // ChatClient so row clicks switch topics on the existing WS
      // instead of triggering a page reload.
      chatClient: client,
    })
    void topicRail.hydrate()
    // Item 6 (2026-06-19) — live-refresh the sidebar when onboarding
    // finalizes projects: each agent message nudges the rail to re-fetch,
    // self-guarded to stop once project rows appear (see
    // `refreshIfNoProjects`).
    client.setOnAgentMessageHook(() => {
      void topicRail.refreshIfNoProjects()
    })
  }

  // M2.5 — "Connect" relay affordance. Open self-hosters
  // connect their instance so the shared projects they're invited to surface
  // across devices. Mounts a header trigger + inline disclosure panel and
  // hydrates from /api/app/connect/auth/status. On a Managed instance
  // the status route 404s and the affordance hides itself.
  const header = document.querySelector('header') as HTMLElement | null
  if (header !== null) {
    mountConnectPanel({ header })
  }
}

// Codex r2 P1 fix: chat.html loads this file as `<script type="module" src="/chat.js">`,
// so the browser evaluates the module and stops. The bootstrap MUST self-invoke for
// the page to be functional. Guard with `typeof window` so server-side imports
// (the landing/__tests__/server.test.ts smoke test) don't crash.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => bootChatFromQueryString())
  } else {
    bootChatFromQueryString()
  }
}
