/**
 * @neutronai/landing — minimal HTTP + WebSocket server (P2 S2).
 *
 * Per docs/plans/P2-onboarding.md § 2.9 Path B: "P2 ships a minimal HTML
 * chat surface (raw chat.html + WebSocket on the gateway port; ~150 LOC
 * of fresh code) so that path B is functional during M2 even if the
 * polished Expo/React UI from P5 isn't done."
 *
 * This module wires the `/chat` GET handler (serving `chat.html` from
 * disk) and the `/ws/chat` WebSocket upgrade (relaying agent ↔ user
 * messages through a caller-supplied `ChatBridge`). Production deploys
 * this as a Bun.serve subprocess on the instance gateway host; the
 * instance subdomain reverse-proxy config forwards `<slug>.<base-domain>/chat`
 * + `/ws/chat` to this process.
 *
 * Codex r1 P1 fix — the prior commit shipped only the static client
 * files, leaving the web sign-up path pointing at a 404. This adds the
 * server-side seam so the route is functional.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 2026-05-28 final-handoff sprint — re-export the canonical MOBILE_APP_URL
// constant so the landing surface (favicon link, OG meta, future deep-link
// route, debug pages) can reference it without duplicating the string. The
// single source of truth lives in `onboarding/interview/final-handoff-config.ts`
// alongside the prompt builders that surface the URL to the user. A grep for
// the URL literal across .ts sources should match only that one definition —
// see `landing/__tests__/mobile-app-url-constant.test.ts` which guards the
// property.
export { MOBILE_APP_URL } from '../onboarding/interview/final-handoff-config.ts'

import { renderMobileInstallHtml } from './mobile-install-config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Sprint 26 r2 (Argus MINOR fix) — build the CSP header for the
 * Telegram onboarding landing page from SHA-256 hashes of every inline
 * `<script>` and `<style>` block in the HTML payload. Hashes let us
 * keep the inline blocks (the page is fully self-contained — useful
 * for static-CDN deploys) while still dropping `'unsafe-inline'` so a
 * future XSS-injected `<script>` is rejected by the browser.
 *
 * Order-insensitive: hash digests are content-addressed; the browser
 * matches against the set of declared hashes regardless of source
 * position. Multiple blocks of the same type are supported.
 */
/**
 * 2026-05-28 sidebar sprint — validate the optional `?topic_id=` query
 * parameter the WS client supplies. Returns `undefined` when the
 * parameter is absent or empty (caller treats as "General"), the
 * validated string when it matches the allowlist, OR the literal
 * `'invalid'` discriminator to signal "send a 400 and skip the upgrade".
 *
 * Allowlist:
 *   - exactly `web:<user_id>` (General)
 *   - `web:<user_id>:<descendant>` where `<descendant>` is `[A-Za-z0-9._-]+`
 *
 * The strict end-of-string-or-`:` boundary mirrors the SQL
 * `topic_id = ? OR topic_id LIKE ? || ':%'` filter in
 * `ButtonStore.listTopicsByUser` — an instance with users `u-1` and
 * `u-10` MUST NOT have `u-1`'s socket accept a topic_id naming
 * `u-10`'s sub-topic.
 */
function validateActiveTopicId(
  raw: string | null,
  user_id: string,
): string | undefined | 'invalid' {
  if (raw === null || raw.length === 0) return undefined
  const generalPrefix = `web:${user_id}`
  if (raw === generalPrefix) return raw
  if (!raw.startsWith(`${generalPrefix}:`)) return 'invalid'
  const descendant = raw.slice(generalPrefix.length + 1)
  if (descendant.length === 0) return 'invalid'
  // Allow `[A-Za-z0-9._-]+` only — matches `sanitizeProjectId` in
  // channels/adapters/app-ws/envelope.ts so a topic the sidebar can
  // produce is round-trippable through the existing project surfaces.
  if (!/^[A-Za-z0-9._-]+$/.test(descendant)) return 'invalid'
  return raw
}

/**
 * 2026-06-05 (click-button, Argus #1 BLOCKER) — resolve the host the WS
 * upgrade request actually arrived on, honouring the `X-Forwarded-Host`
 * the production Caddy chain sets (the upstream Bun socket only knows its
 * loopback bind). Mirrors the identically-named helper in
 * `landing/auth-gate.ts` used by the HTTP 302 self-redirect guard, so the
 * WS-replay path and the 302 path compare against the SAME host value.
 *
 * TRUST ASSUMPTION (Argus r2 minor): `X-Forwarded-Host` is taken on faith.
 * That is safe ONLY because every instance Bun process binds loopback and is
 * never directly internet-reachable — the production Caddy chain is the sole
 * ingress and it OVERWRITES (not appends) `X-Forwarded-Host` with the real
 * SNI host, so a client-supplied header cannot reach here. We still take the
 * first comma-segment defensively. If an instance is ever exposed without the
 * Caddy front (e.g. a future direct-bind dev mode), this header becomes
 * spoofable and host-derivation must move to a server-configured origin.
 */
function resolveRequestHost(req: Request): string {
  const reqUrl = new URL(req.url)
  const xfh = req.headers.get('x-forwarded-host')
  return (xfh ?? reqUrl.host).split(',')[0]!.trim()
}

/**
 * 2026-05-30 Argus r3 P2 #1 follow-up — fire-and-forget emit of the
 * server-trusted `user_id`. Wrapped in a try/catch so a closed-socket
 * throw from the send lambda (see the T10 r3 fix above) NEVER tears
 * down the WS during bring-up; the client falls back to the JWT
 * decode path on the next switchTopic if the envelope is lost.
 */
function emitSessionReady(
  send: (event: ChatOutbound) => void,
  user_id: string,
  resumed = false,
): void {
  try {
    send({ type: 'session_ready', user_id, ...(resumed ? { resumed: true } : {}) })
  } catch (err) {
    console.error('landing/server: emitSessionReady threw (best-effort):', err)
  }
}

function buildOnboardingTelegramCsp(html: string): string {
  const scriptHashes = collectInlineHashes(html, 'script')
  const styleHashes = collectInlineHashes(html, 'style')
  const scriptDirective = ["'self'", ...scriptHashes].join(' ')
  const styleDirective = ["'self'", ...styleHashes].join(' ')
  return [
    "default-src 'self'",
    `script-src ${scriptDirective}`,
    `style-src ${styleDirective}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

function collectInlineHashes(html: string, tag: 'script' | 'style'): string[] {
  // The static landing HTML uses bare `<script>` / `<style>` opens (no
  // attributes). We deliberately do NOT match tags with attributes —
  // any future tag with `src=` / `href=` is fetched by URL and
  // covered by `'self'`, not the inline-hash whitelist. Inline blocks
  // with attributes (e.g. `<script type="module">`) would need a
  // schema bump here; flag at PR review time.
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
  const out: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    const body = match[1] ?? ''
    const digest = createHash('sha256').update(body, 'utf8').digest('base64')
    out.push(`'sha256-${digest}'`)
  }
  return out
}

export type ChatInbound =
  | { type: 'user_message'; body: string }
  | { type: 'button_choice'; prompt_id: string; choice_value: string; freeform_text?: string }
  /**
   * 2026-05-29 in-place topic switch sprint. Sent by the client when
   * the user taps a non-active row in the sidebar topic rail. The
   * gateway re-binds the per-session sender to `new_topic_id` so
   * subsequent engine emits route to the new topic on the SAME WS
   * (no socket reconnect, no page reload). The bridge replies with a
   * `topic_switched` ack on success OR an `error` envelope on
   * validation failure (cross-user topic_id, malformed shape, etc.).
   */
  | { type: 'topic_switch'; new_topic_id: string }

/**
 * P1.5 / Sprint 21 — `ChatOutbound` is a discriminated union covering both
 * the original `agent_message` envelope (P2 S2) and the new `redirect`
 * envelope used by the slug-picker integration. The redirect tells the
 * client to navigate to the new instance subdomain with a fresh start
 * token before the instance gateway restart kills the WebSocket.
 *
 * The two members were a single `agent_message`-only interface up to
 * Sprint 20; the union is backward-compatible because every existing
 * call site sets `type: 'agent_message'` explicitly.
 *
 * LLM-driven prompts sprint (2026-05-09) — added `agent_typing_start` /
 * `agent_typing_end` so the gateway can signal when the LLM resolver is
 * mid-rephrase. The web client will render a typing indicator in a
 * follow-up chat-UI sprint; this sprint just emits the wire signals
 * around the LLM call. The union is backward-compatible — clients that
 * don't know these types can ignore them safely (new optional members
 * on a typed union, every existing render path branches on `type`).
 */
export type ChatOutbound =
  | AgentMessageOutbound
  | AgentAckOutbound
  | RedirectOutbound
  | SlugRenamedOutbound
  | AgentTypingStartOutbound
  | AgentTypingEndOutbound
  | ErrorOutbound
  | ImportProgressOutbound
  | TopicSwitchedOutbound
  | SessionReadyOutbound

export interface AgentMessageOutbound {
  type: 'agent_message'
  body: string
  /**
   * Item 15 (2026-06-19, owner live-dogfood) — the topic this message
   * belongs to. Stamped by the live-agent turn runner (which sends a
   * project/General reply over the user's single socket). A slow reply
   * can arrive AFTER the user has switched to another project; with no
   * topic_id the client rendered it into whatever was focused
   * (cross-project bleed). The web client uses this to route the message
   * to its OWN topic: it only paints a message whose topic_id matches the
   * focused topic, so a reply for topic A never appears while topic B is
   * open (it hydrates from history when the user switches to A). Optional
   * + back-compat: onboarding button-prompts omit it and always render.
   */
  topic_id?: string
  prompt_id?: string
  options?: ReadonlyArray<{
    label: string
    body: string
    value: string
    /**
     * Sprint 28 Codex r4 P1 — per-option image URL (typically
     * `/profile-pic/candidate/<id>.png` for the portrait gallery).
     * The web client renders this as a thumbnail when present.
     */
    image_url?: string
  }>
  allow_freeform?: boolean
  /**
   * Sprint 28 Codex r4 P1 — render hint. `'image-gallery'` tells the
   * web client to render the options as a CSS-grid of clickable
   * thumbnails (`image_url` per option). Default `'buttons'` keeps
   * every existing prompt at parity.
   */
  kind?: 'buttons' | 'image-gallery'
  /**
   * P2 v2 § 6.2 (S4) — upload affordance hint for the web client. When
   * present, the client renders a file-picker button and enables a
   * page-level drag-and-drop overlay that POSTs to
   * `/api/upload/<source>`. Telegram path ignores this — Telegram has
   * its own native document-attach affordance + the per-instance bot
   * inbound handler covers § 6.3.
   */
  upload_affordance?: { source: 'chatgpt' | 'claude' }
}

/**
 * ISSUES #69 Argus r1 BLOCKER 1 (2026-05-30) — no-render acknowledgement
 * envelope. The landing client bumps `pendingAgentReplies` on every
 * outbound `button_choice` (via `sendChoice` → `showTypingBubble`) and
 * only clears the optimistic typing dots when a reply-shaped envelope
 * lands. Project topics have no per-project agent loop yet, so the
 * gateway's silent-skip branch in `handleProjectTopicInbound` would
 * otherwise leave the dots stuck on screen forever.
 *
 * Wire shape is intentionally minimal: `type` is the only field. The
 * client's handler maps `agent_ack` to `hideTypingBubble()` — no body,
 * no bubble, no run mutation. Idempotent on the client; a stray ack
 * with no outstanding turn is a no-op (`pendingAgentReplies` clamps
 * at 0 in `hideTypingBubble`).
 *
 * NOT a replacement for `agent_message` — anything the user should SEE
 * uses `agent_message`. This envelope exists ONLY for "the server has
 * decided to say nothing in response to your tap, but the client should
 * stop waiting" flows. Currently the only such flow is the no-match
 * fallback's `[B] Skip for now`.
 */
export interface AgentAckOutbound {
  type: 'agent_ack'
}

/**
 * Tells the client to navigate to a new URL (typically the instance's new
 * subdomain after a slug rename) with a freshly minted start-token. The
 * client replaces `window.location` so the next WebSocket upgrade goes
 * through the validate/start path on the renamed gateway.
 *
 * The `project_slug` field is the NEW slug (post-rename) so the client
 * can correlate. `new_start_token` is the JWT to use for the next
 * `/ws/chat?start=...` upgrade — its embedded `project_slug` claim
 * matches the new slug, so the renamed gateway's `validateStartToken`
 * accepts it without dipping into the slug-history shim.
 */
export interface RedirectOutbound {
  type: 'redirect'
  new_url: string
  new_start_token: string
  project_slug: string
  reason?: 'slug_renamed'
}

/**
 * 2026-05-22 — structured slug-rename envelope. Emitted by the slug-
 * picker hook on the LIVE WS immediately after `renameUrlSlug`
 * commits, so the client navigates to the renamed subdomain without
 * waiting for the WS to die + the `/recover` fallback to fire.
 *
 * Per Sam (2026-05-22): "The recover navigation should be automatic
 * and invisible to the user" — the prior flow surfaced a brief
 * "reconnecting..." / "disconnected. refresh to continue." status
 * banner whenever the WS dropped post-rename. The structured envelope
 * lets the client navigate proactively (sub-second blank flash, no
 * error banner, no user action).
 *
 * Wire shape:
 *   - `new_slug` — the post-rename `url_slug` (e.g. `prism`). Surfaced
 *     for telemetry / debug-trace correlation; the client builds the
 *     final URL from `new_host` + `new_token`.
 *   - `new_host` — the personal subdomain hostname (e.g.
 *     `prism.example.test`). Excludes scheme + path so the client
 *     can pick `https://` for prod and `http://` for local dev.
 *   - `new_token` — freshly-minted start_token JWT bound to `new_slug`,
 *     15-min TTL (`signup/start-token.ts:issueStartToken`). The
 *     renamed gateway's `validateStartToken` accepts it directly
 *     (the JWT's `project_slug` claim matches the gateway's renamed
 *     slug-history shim collapse target).
 *
 * The `redirect` envelope (above) is the LEGACY shape used by the
 * pending-redirect store on reconnect; this envelope is the new
 * proactive emit path. Both coexist — the client handler for
 * `slug_renamed` calls `window.location.replace` immediately,
 * `redirect` retains its existing handler.
 */
export interface SlugRenamedOutbound {
  type: 'slug_renamed'
  new_slug: string
  new_host: string
  new_token: string
}

/**
 * LLM-driven prompts sprint (2026-05-09) — emitted BEFORE the resolver's
 * Anthropic call so the client can render a typing indicator while the
 * agent's reply is being generated (~600-1500ms typical for Haiku 4.5).
 *
 * Wire shape is intentionally minimal: `type` is the only field. The
 * matching `agent_typing_end` always follows, on both success AND
 * failure paths (the resolver guards via finally). Multiple
 * `agent_typing_start` events back-to-back are a no-op for the FE — it
 * shows the indicator while at least one start is unmatched by an end.
 */
export interface AgentTypingStartOutbound {
  type: 'agent_typing_start'
}

/**
 * LLM-driven prompts sprint (2026-05-09) — emitted AFTER the resolver's
 * LLM call returns (or throws / times out). Always paired with a prior
 * `agent_typing_start` from the same resolver invocation.
 */
export interface AgentTypingEndOutbound {
  type: 'agent_typing_end'
}

/**
 * Server → client error envelope. Mirrors `ServerErrorMessage` in
 * `landing/chat.ts` (the FE-side declaration). The web client renders
 * the `message` as a plain agent bubble so the failure surfaces — see
 * the `chat.ts` notes for why the FE no longer drops these silently.
 *
 * Currently emitted by:
 *   - landing/server.ts WS handler when `bridge.handleInbound` throws.
 *   - gateway/http/chat-bridge.ts slug-picker hook when an inner
 *     gateway-restart returns `restart_status:'failed'` (rename
 *     committed at the registry/Caddy/identity layers but the
 *     per-instance unit didn't pick up the new slug).
 */
export interface ErrorOutbound {
  type: 'error'
  message: string
}

/**
 * 2026-05-21 — `import_progress` envelope (Bug 1, v0.1.75).
 *
 * Periodic UI-only update emitted by the per-instance `import-running` cron
 * tick while the ImportJobRunner is mid-flight (status =
 * `pass1-running` / `pass2-running` / `queued`). The web client renders
 * this as a transient pulsing-dot indicator below the most recent agent
 * bubble with optional status text — auto-cleared when the next
 * `agent_message` envelope arrives (which lands when the runner
 * terminates and the engine advances to `import_analysis_presented`).
 *
 * CRITICAL: import_progress is a pure UI ping. It does NOT touch
 * `button_prompts.delivered_at`, `transcript.jsonl`, or any audit state
 * (preserving S16 invariants). Servers MUST NOT wait for an
 * acknowledgment — the envelope is fire-and-forget.
 *
 * Telegram channel: silent drop today (no `telegramSender` wired). The
 * `import_progress` UX is web-only until a follow-up sprint wires
 * Telegram-side rendering.
 *
 * See `docs/plans/P2-onboarding-v2.md` § 3.6 (revised) + § 9.5 for the
 * full spec contract.
 */
/**
 * 2026-05-29 in-place topic switch sprint — server ack for an inbound
 * `topic_switch` event. The client uses this to confirm the gateway
 * re-bound the sender successfully before scrolling to the new topic's
 * last-unread position. A rejected switch produces an `error` envelope
 * instead (mirroring the existing `bridge.handleInbound` error path).
 */
export interface TopicSwitchedOutbound {
  type: 'topic_switched'
  topic_id: string
}

/**
 * 2026-05-30 Argus r3 P2 #1 follow-up — fires once per WS connection,
 * directly after `session_started = true` on BOTH the token-auth and
 * cookie-only paths. Lets the client derive its own General topic_id
 * (`web:<user_id>`) WITHOUT re-decoding the `?start=` JWT — cookie-only
 * connections never have a start_token on the client, so the prior
 * `decodeJwtSubClaim('')` returned null and `switchTopic` to General
 * silently early-returned (LS already moved, but no topic_switch event
 * sent and no hydrate fired — user stuck on the old project topic
 * until manual reload).
 *
 * The envelope is fire-and-forget: no ack required, no retransmit. If
 * the client misses it (network hiccup, listener wired late) `switchTopic`
 * falls back to the JWT decode path — degrading gracefully to the
 * pre-2026-05-30 behaviour rather than failing closed.
 */
export interface SessionReadyOutbound {
  type: 'session_ready'
  user_id: string
  /**
   * 2026-06-20 GO-LIVE (owner live-dogfood) — true when this socket is a
   * RESUMED returning session (cookie-only resume or the spent-jti cookie
   * fallback), NOT a fresh `?start=` onboarding bring-up. A resumed session
   * has no "Setting things up…" setup window — the workspace already exists
   * — so the client clears the first-load loader immediately instead of
   * waiting on a fresh-onboarding first agent prompt that never comes on a
   * completed instance (the loader-stuck-forever bug).
   */
  resumed?: boolean
}

export interface ImportProgressOutbound {
  type: 'import_progress'
  /** ImportJob.job_id from `import_jobs` row — handy for client-side
   *  correlation with downstream events. */
  job_id: string
  /** Mirrors `import_jobs.status` exactly. */
  status:
    | 'queued'
    | 'pass1-running'
    | 'pass2-running'
    | 'rate_limit_cooling_off'
    | 'rate_limit_paused'
    | 'completed'
    | 'failed'
    | 'cancelled'
  /** Which pass the runner is currently in. `queued` → 1; `pass1-running`
   *  → 1; `pass2-running` → 2; terminal states → 2 (the engine emits a
   *  terminal `agent_message` immediately after, so clients rarely see
   *  these — they're included for completeness so the union is total). */
  pass: 1 | 2
  /** 0.0..1.0 fractional progress through the current pass. For Pass 1
   *  this is `pass1_chunks_done / max(pass1_chunks_total, 1)` when the
   *  runner pre-counted (chunks_total_known === true). When the runner
   *  is in streaming-fallback mode (chunks_total_known === false) the
   *  engine emits `pct = 0` because there is no honest denominator to
   *  render against. For Pass 2 this is an elapsed-time heuristic
   *  clamped to [0, 0.95] so the indicator never claims to be done
   *  before the runner actually completes (Pass 2 is single-shot Opus
   *  with no granular signal). */
  pct: number
  /**
   * 2026-05-22 — pre-count fix follow-up to PR #264.
   *
   * `true`  → runner pre-counted; client renders
   *           `Pass 1: ${done}/${total} batches` against a stable
   *           denominator.
   * `false` → runner is streaming (pre-count threw); client renders
   *           `Pass 1: ${done} batches processed` (count-only).
   *
   * Replaces the pre-fix `dollars_spent` field, which surfaced a
   * per-token bill that Max-OAuth users (the M2 default + only prod
   * path) are never charged.
   */
  chunks_total_known: boolean
  /** Optional human-readable status string. Clients prefer this over
   *  reconstructing one from `pass + pct + chunks_total_known` when
   *  present. Example (known total): `"Pass 1: 47/57 batches"`.
   *  Example (unknown total): `"Pass 1: 47 batches processed"`. */
  body?: string
}

/**
 * The bridge boundary the landing server delegates to. Production wires
 * this through `signup/start-token.ts:consumeStartToken` (to validate
 * the inbound `?start=<token>` query param) + the onboarding engine
 * (`InterviewEngine.advance(...)`).
 *
 * Codex r5 P2: split `authenticate` into `validateStartToken` (no jti
 * claim) + `startSession` (atomic claim + first emit) so a failed
 * upgrade doesn't burn the start-token. Codex r5 P1: `startSession` is
 * the hook that emits the agent's opening prompt to the freshly opened
 * socket so the user does not stare at a blank screen.
 */
export interface PendingChatClaim {
  project_slug: string
  user_id: string
  jti: string
  expires_at_ms: number
  /**
   * 2026-05-28 sidebar sprint — optional `?topic_id=` query parameter the
   * WS client supplied (e.g. `web:<user_id>` for General OR
   * `web:<user_id>:<project_id>` for a per-project topic). Validated by
   * the upgrade handler against the claim's user_id so a crafted value
   * can't route to another user. When omitted, the bridge defaults to
   * the General topic (`webTopicId(user_id)`).
   */
  active_topic_id?: string
}

export interface ChatBridge {
  /**
   * Validate the `?start=<token>` query param WITHOUT consuming the jti.
   * Production wires through a JWT verify + audience + expiry check;
   * the actual atomic claim happens later in `startSession`.
   */
  validateStartToken(input: { start_token: string }): Promise<PendingChatClaim | null>
  /**
   * Atomically claim the validated start-token's jti AND fire the
   * agent's opening prompt to the freshly opened socket. Called by the
   * server once on `open`, after the WebSocket upgrade has succeeded.
   * Returns false on a claim race (the jti was consumed elsewhere
   * between validate and start) so the server closes the WS.
   */
  startSession(input: {
    claim: PendingChatClaim
    send: (event: ChatOutbound) => void
    /**
     * 2026-05-28 sidebar sprint — the active topic_id this socket is
     * bound to. Defaults to `webTopicId(claim.user_id)` when omitted
     * (legacy callers + cookie-only upgrades on the General topic).
     * The bridge uses this to register the outbound sender at the right
     * topic key so engine emits land on the correct sender.
     */
    active_topic_id?: string
    /**
     * 2026-06-05 (click-button, Argus #1 BLOCKER) — the host this WS is
     * connected to (resolved from `X-Forwarded-Host`, else the request
     * URL host). Threaded into the pending-redirect `takeAndClaim` so the
     * WS-replay path can apply the SAME destination-host self-redirect
     * guard the HTTP 302 path already has: a reconnect that lands ON the
     * slug-rename destination host must NOT re-emit the redirect to
     * itself (nor burn the start-token), and must instead fall through to
     * a normal engine.start. Omitted by callers that can't resolve the
     * request host; the guard then never fires.
     */
    current_host?: string
    /**
     * #306 (2026-06-19) — the auto-detected browser timezone from the
     * `?tz=` WS-upgrade query param (IANA, e.g. "America/Los_Angeles").
     * The bridge forwards it to `engine.start` so onboarding stamps it
     * onto `phase_state.timezone` and never has to ask. Optional: absent
     * on cookie-only resumes, Telegram clients, and older browsers; the
     * engine re-validates the shape before persisting.
     */
    browser_timezone?: string
  }): Promise<boolean>
  /**
   * Called once per inbound chat event from the WebSocket. The bridge is
   * expected to drive the engine and call `send(...)` with any agent
   * outbound that follows.
   */
  handleInbound(input: {
    project_slug: string
    user_id: string
    event: ChatInbound
    send: (event: ChatOutbound) => void
    /**
     * 2026-05-28 sidebar sprint — the active topic_id this socket is
     * bound to (same semantics as on `startSession`). Defaults to the
     * General topic when omitted.
     */
    active_topic_id?: string
    /**
     * 2026-05-29 in-place topic switch sprint — optional callback the
     * server passes so the bridge's `topic_switch` handler can mutate
     * the per-socket `SocketState.active_topic_id` in place. Without
     * this, the bridge re-binds the sender registry but the NEXT
     * inbound message would still arrive with the OLD `active_topic_id`
     * (because the server reads it from `data.active_topic_id` on
     * every message). The server's lambda assigns `data.active_topic_id
     * = new_topic_id` so the contract stays "ws.data is the source of
     * truth; the bridge never holds its own copy across calls."
     *
     * Optional for back-compat — when omitted the bridge falls back to
     * re-binding only the registry; the new topic still receives
     * engine emits via the sender re-register, but subsequent inbound
     * messages on the same socket still report the OLD active_topic_id
     * (which is what the pre-sprint behaviour was).
     */
    updateActiveTopicId?: (new_id: string) => void
    /**
     * 2026-05-29 ISSUES #70 — race-safety read-callback paired with
     * `updateActiveTopicId`. The bridge's `topic_switch` handler awaits
     * `reEmitActiveSeedPromptIfAny` (two DB round-trips: list +
     * get-prompt) BEFORE acking the switch. If a SECOND `topic_switch`
     * lands on the same socket during that await, the first re-emit's
     * `send(...)` would otherwise paint a stale seed into the just-
     * cleared `#log` of the second destination topic. With this hook
     * wired, the helper re-reads `ws.data.active_topic_id` right before
     * emitting and drops the emit (logs `event=seed_reemit_superseded`)
     * when the active topic has moved on. Mirrors the client-side
     * `pendingTopicSwitchDestination` ack guard introduced in
     * PR #338 r4.
     *
     * Optional for back-compat — when omitted the helper emits
     * unconditionally (the pre-sprint behaviour). Production wires
     * `() => ws.data.active_topic_id` so the live value is read at the
     * moment of emit, never a stale snapshot captured at handler entry.
     */
    getActiveTopicId?: () => string | undefined
  }): Promise<void>
  /**
   * Optional — called once on WebSocket `close`. Production bridges use
   * this hook to unregister per-session sender entries from
   * registries (Codex Sprint 18 r1 P2 fix — without close-side
   * cleanup, a long-lived per-instance gateway accrues stale
   * topic_id → send entries and engine emits would still find a
   * sender even after the client is gone). Safe to omit; the server
   * tolerates the absence.
   *
   * Argus Sprint 18 r1 BLOCKING — `send` is the same per-socket lambda
   * the server passed into `startSession` (captured once in
   * SocketState so reference equality holds). Identity-aware
   * registries compare-and-delete by this ref so an old socket's
   * close-fire after a reconnect cannot delete the new socket's
   * sender.
   */
  closeSession?(input: {
    project_slug: string
    user_id: string
    send: (event: ChatOutbound) => void
    /**
     * 2026-05-28 sidebar sprint — the active topic_id this socket was
     * bound to. The bridge uses this to identity-aware unregister the
     * sender from the right topic key.
     */
    active_topic_id?: string
  }): Promise<void> | void
  /**
   * 2026-05-29 r2 BLOCKER fix (Codex catch) — called once on cookie-only
   * WS open (no `?start=` token, `pending_claim === null`). Mirrors the
   * `startSession` post-claim hook for the cookie-resume path:
   * registers the per-socket sender at the active topic AND re-emits
   * the active unresolved seed prompt for project topics so a page
   * refresh on `web:<user_id>:<proj>` doesn't render blank.
   *
   * No jti to claim, no engine bootstrap to run (the cookie-only path
   * is by definition "warm" — the engine already started on a prior
   * start-token redemption). Best-effort: a failure here MUST NOT
   * close the socket. The server still marks `session_started = true`
   * so subsequent inbound messages walk `handleInbound` normally.
   *
   * Optional for back-compat. When omitted, the cookie-only path runs
   * pre-r2 behaviour: no sender register, no seed re-emit (project
   * topics render blank on refresh — the bug this hook fixes).
   */
  resumeCookieSession?(input: {
    project_slug: string
    user_id: string
    send: (event: ChatOutbound) => void
    active_topic_id?: string
  }): Promise<void> | void
}

export interface LandingServerOptions {
  /** Directory containing `chat.html` + compiled `chat.js`. */
  static_dir?: string
  /**
   * C2 (OSS split) — directory containing the workspace-invite assets
   * (`invite.html` + `invite.ts`). The invite flow is Managed-tier
   * machinery; its assets relocated out of the Open `landing/` package,
   * so the Managed boot wrapper points this at their new home. Defaults
   * to `static_dir` (back-compat: a dir that carries all assets
   * together). When the files are absent the invite routes self-disable
   * (existsSync-guarded), which is the Open self-host default.
   */
  invite_assets_dir?: string
  /** Bridge that drives onboarding from inbound user events. */
  bridge: ChatBridge
  /** Port to listen on; production wires to the per-instance gateway port. */
  port?: number
  /** Optional hostname; defaults to '0.0.0.0' for ipv4 binding. */
  hostname?: string
  /**
   * Codex r9 P1 fix: the landing CTAs link to `/api/v1/sign-up?via=tg|web`.
   * The identity service owns OAuth start; this option lets the landing
   * server 302-redirect those CTAs to the identity URL so the public
   * deploy is functional out of the box. When unset, /api/v1/sign-up
   * returns 503 with a clear "identity_oauth_url not configured"
   * message so ops can spot the missing config quickly.
   *
   * The function receives the original `via` query param (`tg` or
   * `web`) and returns the absolute identity OAuth start URL with
   * `?via=...` appended. Production wires this to e.g.
   * `https://<auth-host>/oauth/google/start`.
   */
  resolveSignupRedirect?: (input: { via: 'tg' | 'web' }) => string
  /**
   * P2 S5 — POST /onboarding/invite-accept handler.
   *
   * Codex r2 P1 fix: `landing/invite.ts` posts the user's accept tap
   * to `/onboarding/invite-accept`. Without this hook the landing
   * server 404s the POST and the invite page is functionally broken.
   *
   * When set, the landing server routes POST /onboarding/invite-accept
   * to this handler. The handler is responsible for parsing
   * `{ invite_token: string }` from the body, threading the
   * authenticated session (accepter_user_id + accepter_email +
   * accepter_user_instance_slug) from the gateway's session cookie,
   * and returning a JSON `InviteAcceptResponseShape` body.
   *
   * When unset the route returns 503 with a clear
   * "invite_accept_handler not configured" message so ops can spot
   * the gap (mirrors `resolveSignupRedirect`'s pattern).
   */
  inviteAcceptHandler?: (req: Request) => Promise<Response>
  /**
   * Anthropic Max one-liner installer — handler for the four
   * install-token routes (`/install-token`, `/install/<id>.sh`,
   * `/api/v1/install-token-callback`, `/api/v1/install-token-status`).
   *
   * The dispatcher returns a `Response` if the request matched one
   * of those routes, or `null` if not. We delegate at the top of
   * `fetch()` so the install-token surface 200s before the static
   * `/chat` / `/onboarding/telegram` / wildcard 404 fallback runs.
   *
   * When unset, the install-token surface is unmounted entirely —
   * the boot script wires it only when the identity-service URL +
   * shared secret are both configured.
   */
  installTokenHandler?: (req: Request) => Promise<Response | null>
  /**
   * S17 (2026-05-17) — `GET /recover` handler. Mounted on the per-
   * instance gateway so a same-origin /recover fetch from chat.ts after
   * a post-slug-rename WS disconnect lands on a handler that can mint
   * a fresh start-token bound to the CURRENT slug.
   *
   * Without this, the per-instance gateway returns 404 and the chat
   * client surfaces "disconnected. refresh to continue." instead of
   * silently reconnecting via the 302 → /chat?start=<fresh> flow
   * implemented by `signup/recover-handler.ts:handleRecover`.
   *
   * The per-instance gateway's prod composer (`gateway/index.ts`) wires
   * a closure that calls `handleRecover(req, …)` against the platform
   * instances registry + identity DB. Optional — gateways that don't
   * configure identity-service access leave this unset and the route
   * 404s through the default chain (parity with the platform proxy's
   * 503-when-unwired behaviour: the chat client falls back to a
   * manual-refresh hint either way).
   */
  recoverHandler?: (req: Request) => Promise<Response>
  /**
   * 2026-05-27 persistent-session-cookie sprint (Part B) — resolve the
   * cookie-authenticated user's identity for a `/ws/chat` upgrade that
   * arrives with only a session cookie (no `?start=` token). Returns
   * the cookie's `project_slug` + the owner's `user_id` when the cookie
   * is valid for THIS gateway's instance; returns `null` when the cookie
   * is missing, malformed, expired, signed with the wrong secret, OR
   * binds a different instance slug.
   *
   * The optional `set_cookie` is a pre-formatted `Set-Cookie` header
   * value (e.g. `__neutron_chat_session=…; HttpOnly; Secure;
   * SameSite=Lax; Path=/; Max-Age=2592000`) emitted on the 101
   * upgrade response so cookie-only WS upgrades roll the session-
   * cookie expiry forward in lockstep with HTTP-side sliding refresh
   * from `landing/auth-gate.ts`.
   *
   * Production wires this against the platform instances registry +
   * `signSessionCookie` / `readSessionCookie` from
   * `landing/session-cookie.ts` (same shape as `mintStartToken`
   * on `auth_gate`). Optional — when unset, cookie-only WS upgrades
   * 400 the same way a missing-start-token request does, preserving
   * back-compat for dev / smoke deploys that don't wire identity.
   *
   * Precedence: `?start=<jwt>` ALWAYS wins. The cookie hook is only
   * consulted when no start-token query param is present, so a
   * mixed-auth request (cookie + token) walks the existing token path
   * untouched.
   */
  cookieToUserClaim?: (req: Request) => Promise<{
    project_slug: string
    user_id: string
    set_cookie?: string
  } | null>
  /**
   * ISSUES #318 (2026-06-21) — Open self-host Claude-auth gate (defense in
   * depth for the installer gate). When provided AND `isUnauthenticated()`
   * returns true, a `GET /chat` serves the "Authenticate Claude to continue"
   * page instead of the chat shell — so a box booted with NO Claude substrate
   * credential (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` both unset)
   * never presents an interactive-looking chat that silently produces nothing.
   *
   * `isUnauthenticated` is evaluated per request (a closure over the live
   * environment) so a restart that finally has the token clears the gate
   * without rebuilding the server. Managed leaves this UNSET — its substrate is
   * per-user Max OAuth / BYO key resolved elsewhere, not from this process's
   * env — so the gate is inert there and `GET /chat` serves the shell as before.
   */
  chatAuthGate?: {
    isUnauthenticated: () => boolean
  }
}

interface SocketState {
  project_slug: string
  user_id: string
  /**
   * 2026-05-28 sidebar sprint — the `?topic_id=` query param value (or
   * undefined when the client didn't supply one). Threaded into the
   * bridge's start/inbound/close lifecycle so engine emits land on the
   * sender registered for the right topic. Validated against the
   * authenticated `user_id` at upgrade time so a crafted value cannot
   * route to another user.
   */
  active_topic_id?: string
  /**
   * Pending claim threaded from validate → upgrade → open so we can
   * atomically consume the jti once the socket is actually live.
   *
   * 2026-05-27 persistent-session-cookie sprint (Part B) — nullable to
   * support cookie-only WS upgrades. When `null` the WS was authed via
   * a valid session cookie (no `?start=` token present), so there is no
   * jti to claim and no welcome envelope to fire on `open`. The open
   * handler still captures the per-socket `send` lambda + flips
   * `session_started` true so subsequent inbound messages walk
   * `bridge.handleInbound` normally; `bridge.startSession` is skipped
   * entirely.
   */
  pending_claim: PendingChatClaim | null
  /** Set after `startSession` confirms the claim. Inbound messages
   *  before this is true are dropped (the open handler closes on
   *  failure, but the WS could deliver a message before `open` fires). */
  session_started: boolean
  /**
   * 2026-06-05 (click-button, Argus #1 BLOCKER) — the host the upgrade
   * request arrived on (resolved from `X-Forwarded-Host`, else the
   * request URL host). Captured at upgrade time because Bun's WS handler
   * has no access to the original request. Threaded into
   * `bridge.startSession` so the pending-redirect WS-replay path can skip
   * a destination-host self-redirect. Optional — absent on legacy
   * upgrades that predate this field.
   */
  current_host?: string
  /**
   * #306 (2026-06-19) — the auto-detected browser timezone from the `?tz=`
   * query param on the first (token) upgrade. Captured here because Bun's
   * WS `open` handler has no access to the original request URL. Threaded
   * into `bridge.startSession` so onboarding stamps it onto
   * `phase_state.timezone`. Only set on the `?start=` token path (the
   * client sends `?tz=` once, on the first connect); cookie-only resumes
   * leave it undefined and the engine keeps the value stamped on connect 1.
   */
  browser_timezone?: string
  /**
   * ISSUES #94 (2026-06-05) — cookie-resolved identity captured at upgrade
   * time as a FALLBACK for the token path. When a `?start=` token rides the
   * upgrade but its jti is already consumed (a reconnect / reload
   * re-presenting a spent one-shot token — the post-completion General
   * socket), `bridge.startSession` returns false. Pre-fix the open handler
   * closed the socket (4001) and `session_started` stayed false, so the
   * user — though authenticated by a valid 30d session cookie — was
   * stranded with "session not started" on every inbound. When this is set
   * (a session cookie valid for the SAME `user_id`/`project_slug` as the
   * token), the open handler resumes via the cookie-only path instead of
   * closing. Only populated when `cookieToUserClaim` is wired AND the
   * cookie is present + same-`user_id` (the single-instance cookie resolver
   * already guarantees same-instance); a cross-identity or absent cookie
   * leaves this undefined so a genuine jti race with no session closes
   * cleanly (no silent cross-auth). The resume itself uses `data.project_slug`
   * /`data.user_id` (the token claim) — identical to the happy `startSession`
   * path — so the stored fields are the cookie identity for observability.
   */
  cookie_fallback_claim?: { project_slug: string; user_id: string }
  /**
   * Per-socket send lambda — captured ONCE in `open` and reused for
   * the lifetime of the socket so the bridge can use reference
   * equality to identify which socket owns a registry entry. Argus
   * Sprint 18 r1 BLOCKING — without this stable ref, a fresh lambda
   * created on each call would defeat the registry's
   * identity-aware unregister. Optional because `close` may fire
   * before `open` (e.g. peer hangs up mid-upgrade).
   */
  send?: (event: ChatOutbound) => void
}

/**
 * Returned by `createLandingServer`: the `{ fetch, websocket }` pair the
 * caller plugs into Bun.serve (or composes into a per-instance gateway). A
 * named export so the realmode-composer factory can declare its return
 * type without `ReturnType<typeof createLandingServer>` magic (TS
 * reviewer Sprint 19 P3 recommendation).
 */
export interface LandingServer {
  fetch: (req: Request, server: import('bun').Server<SocketState>) => Response | Promise<Response>
  websocket: import('bun').WebSocketHandler<SocketState>
}

/**
 * ISSUES #318 — the Open Claude-auth gate page served at `GET /chat` when the
 * box has no working Claude substrate credential. Self-contained: a single
 * inline `<style>`, NO inline script and NO external assets, so it renders
 * under any CSP and never itself depends on the unauthenticated substrate. The
 * copy mirrors the installer's `claude setup-token` guidance so the web surface
 * and the CLI agree on the one step left.
 */
export function renderChatAuthGateHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Authenticate Claude — Neutron</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 24px;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #e6e6f0; background: #0e0e16;
  }
  .card {
    max-width: 560px; width: 100%; background: #16161f;
    border: 1px solid #2a2a3a; border-radius: 14px; padding: 32px;
  }
  h1 { margin: 0 0 6px; font-size: 20px; color: #fff; }
  p.lead { margin: 0 0 20px; color: #a6a6c0; }
  ol { margin: 0 0 12px; padding-left: 20px; }
  li { margin: 0 0 14px; }
  code {
    display: block; margin-top: 6px; padding: 10px 12px; border-radius: 8px;
    background: #0a0a12; border: 1px solid #2a2a3a; color: #7cf;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
    word-break: break-all; white-space: pre-wrap;
  }
  .alt { color: #a6a6c0; font-size: 13px; margin: 0 0 18px; }
  .foot { color: #6f6f88; font-size: 13px; border-top: 1px solid #2a2a3a; padding-top: 16px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
         background: #f0a020; margin-right: 8px; vertical-align: middle; }
</style>
</head>
<body>
  <main class="card">
    <h1><span class="dot"></span>Authenticate Claude to continue</h1>
    <p class="lead">This Neutron box has no Claude credential yet, so chat can't run.
       Connect Claude, then restart Neutron.</p>
    <ol>
      <li>Run this where Neutron is installed — it opens a browser and prints a token:
        <code>claude setup-token</code>
      </li>
      <li>Add the printed token to your <code>.env</code>:
        <code>CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat…</code>
      </li>
      <li>Restart Neutron, then reload this page.</li>
    </ol>
    <p class="alt">Prefer API billing? Set <code>ANTHROPIC_API_KEY=sk-ant-…</code> in
       <code>.env</code> instead, then restart.</p>
    <p class="foot">Neutron spawns the <code>claude</code> CLI as its LLM substrate —
       it never calls api.anthropic.com directly. One of the two credentials above
       is required before the first chat.</p>
  </main>
</body>
</html>`
}

/**
 * Bun.serve handler that surfaces `/chat` (HTTP) + `/ws/chat`
 * (WebSocket). Uses Bun's native upgrade pattern so a single port
 * accepts both. Caller is responsible for SIGTERM handling + graceful
 * shutdown — the returned `stop()` closes the server.
 */
export function createLandingServer(options: LandingServerOptions): LandingServer {
  const static_dir = options.static_dir ?? HERE
  // P0b (2026-06-26) — React/assistant-ui is the ONLY web chat client. The
  // vanilla `chat.html`/`chat.ts` surface and the `NEUTRON_WEB_CHAT_CLIENT`
  // flag were DELETED (Ryan-locked: no feature flags, no dual code paths), so a
  // fresh single-owner Open install always serves the tabbed React shell
  // (ProjectShell → ChatApp with the Documents/Tasks tabs) at `/chat`.
  //
  // `chat-react.html` is the shell (loads `/chat-react.js`); the JS is either a
  // pre-built `chat-react.js` next to it or lazily bundled from
  // `chat-react/main.tsx` on first request (minified — it carries React +
  // assistant-ui). The shell is REQUIRED: a single-owner Open install always
  // ships it, so its absence is a packaging error (throw at boot), NOT a
  // silent fall-back to a now-nonexistent vanilla client.
  const chat_react_html_path = join(static_dir, 'chat-react.html')
  if (!existsSync(chat_react_html_path)) {
    throw new Error(`landing static_dir missing chat-react.html: ${chat_react_html_path}`)
  }
  const chat_react_html = readFileSync(chat_react_html_path)
  const chat_react_js_prebuilt_path = join(static_dir, 'chat-react.js')
  let chat_react_js_cache: string | null = existsSync(chat_react_js_prebuilt_path)
    ? readFileSync(chat_react_js_prebuilt_path, 'utf8')
    : null
  const chat_react_entry_path = join(static_dir, 'chat-react', 'main.tsx')
  // P2 S5 — invite landing short-circuit. Optional: callers that haven't
  // wired the invite handler yet skip the route entirely so the existing
  // /chat surface stays untouched. C2 (OSS split): the invite assets are
  // Managed-tier and live outside this package — resolved via
  // `invite_assets_dir`, defaulting to `static_dir` for back-compat.
  const invite_assets_dir = options.invite_assets_dir ?? static_dir
  const invite_html_path = join(invite_assets_dir, 'invite.html')
  const invite_html: Buffer | null = existsSync(invite_html_path) ? readFileSync(invite_html_path) : null
  // Sprint 26 — Telegram onboarding landing page. The identity service
  // 302s telegram-signup users here after OAuth completes; the page
  // renders an "Open Telegram to continue" deeplink button targeting
  // the per-instance bot. Ships as a static file so the platform-landing
  // process can serve it without any additional wiring; absent file
  // means the route 404s through the default fallback (dev / pre-Sprint-26
  // deploys with no bot pool configured).
  const onboarding_telegram_path = join(static_dir, 'onboarding-telegram.html')
  const onboarding_telegram_html: Buffer | null = existsSync(onboarding_telegram_path)
    ? readFileSync(onboarding_telegram_path)
    : null
  // Sprint 26 r2 (Argus MINOR fix) — drop `'unsafe-inline'` from the
  // landing's CSP by precomputing SHA-256 hashes of the page's inline
  // <script> and <style> blocks at load time. Hashes are stable across
  // process restarts (HTML is a versioned static file) and the CSP
  // header is built once and cached.
  const onboarding_telegram_csp: string | null =
    onboarding_telegram_html !== null
      ? buildOnboardingTelegramCsp(onboarding_telegram_html.toString('utf8'))
      : null
  const invite_js_prebuilt_path = join(invite_assets_dir, 'invite.js')
  let invite_js_cache: string | null = existsSync(invite_js_prebuilt_path)
    ? readFileSync(invite_js_prebuilt_path, 'utf8')
    : null
  const invite_ts_path = join(invite_assets_dir, 'invite.ts')
  // ISSUES #208 — `/mobile` install page. The wow handoff's "Get the
  // mobile app" button points at `MOBILE_APP_URL` (the `/mobile` path on
  // the apex domain); the apex is served by the signup-landing process
  // which delegates here, so loading the page in THIS shared route table
  // makes the existing URL resolve on BOTH surfaces (apex + per-instance
  // subdomains) with no Caddy change — and retroactively fixes the dead
  // links in already-delivered handoff messages. Store links are rendered server-side at construction from
  // `mobile-install-config.ts` (empty constants → greyed coming-soon;
  // filled → live anchors). Absent file falls through to the default
  // 404 like the other optional static pages.
  const mobile_html_path = join(static_dir, 'mobile.html')
  const mobile_html: Buffer | null = existsSync(mobile_html_path)
    ? Buffer.from(renderMobileInstallHtml(readFileSync(mobile_html_path, 'utf8')), 'utf8')
    : null
  // ISSUES #208 — PWA/brand assets on the per-instance surface. The
  // signup-landing boot script serves these from its own allowlist
  // (landing/boot.ts), but the per-instance gateway previously served
  // NOTHING for them, so chat.html could not link a manifest or icons —
  // Add-to-Home-Screen on `<slug>.<base>/chat` produced an icon-less
  // screenshot shortcut. Same literal-match allowlist shape as boot.ts
  // (no path traversal). Missing files fall through to the default 404.
  const brand_assets = new Map<string, { body: Buffer; type: string }>()
  for (const [route, file, type] of [
    ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
    ['/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png'],
    ['/site.webmanifest', 'site.webmanifest', 'application/manifest+json'],
  ] as const) {
    const p = join(static_dir, file)
    if (existsSync(p)) brand_assets.set(route, { body: readFileSync(p), type })
  }
  const bridge = options.bridge
  async function resolveChatReactJs(): Promise<string | null> {
    if (chat_react_js_cache !== null) return chat_react_js_cache
    if (!existsSync(chat_react_entry_path)) return null
    try {
      const result = await Bun.build({
        entrypoints: [chat_react_entry_path],
        target: 'browser',
        format: 'esm',
        // Minified: the bundle carries React + ReactDOM + assistant-ui +
        // chat-core (~0.6 MB minified). Cached after the first build.
        minify: true,
        sourcemap: 'none',
      })
      if (!result.success || result.outputs.length === 0) return null
      const out = result.outputs[0]
      if (out === undefined) return null
      chat_react_js_cache = await out.text()
      return chat_react_js_cache
    } catch {
      return null
    }
  }
  async function resolveInviteJs(): Promise<string | null> {
    if (invite_js_cache !== null) return invite_js_cache
    if (!existsSync(invite_ts_path)) return null
    try {
      const result = await Bun.build({
        entrypoints: [invite_ts_path],
        target: 'browser',
        format: 'esm',
        minify: false,
        sourcemap: 'none',
      })
      if (!result.success || result.outputs.length === 0) return null
      const out = result.outputs[0]
      if (out === undefined) return null
      invite_js_cache = await out.text()
      return invite_js_cache
    } catch {
      return null
    }
  }
  return {
    async fetch(req, server): Promise<Response> {
      const url = new URL(req.url)
      // Anthropic Max one-liner installer surface (install-token).
      // The handler returns null on miss so the rest of this fetch
      // chain runs unaffected; matched routes return their Response.
      if (options.installTokenHandler !== undefined) {
        const installTokenRes = await options.installTokenHandler(req)
        if (installTokenRes !== null) return installTokenRes
      }
      // S17 (2026-05-17) — /recover dispatch. Mounted ahead of /chat so
      // a same-origin /recover fetch from chat.ts (post-slug-rename WS
      // disconnect on the per-instance subdomain) reaches the handler
      // before any of the catch-all branches. See
      // `signup/recover-handler.ts:handleRecover` for the contract.
      if (
        url.pathname === '/recover' &&
        req.method === 'GET' &&
        options.recoverHandler !== undefined
      ) {
        return options.recoverHandler(req)
      }
      // 2026-05-22 — `/start?token=` (or `?start=` legacy) lands on the
      // per-instance gateway when a returning user signed in via the
      // identity service: `identity/main.ts:onReturningWebSignin` builds
      // a per-instance deep link once the owner has picked a real URL
      // slug (`url_slug !== internal_handle`) so the user lands on
      // `<slug>.<apex>` from the first hop instead of the shared
      // `chat.<apex>` host. The token IS the auth gate (validated by
      // `/chat`'s `validateStartToken` immediately downstream); this
      // handler is a thin URL rewrite that keeps the deep-link shape
      // symmetric with `landing/onboarding-chat-proxy.ts:457-482`.
      //
      // Debug + import-source params pass through so the destination
      // `/chat?start=...` page's chat.html bootstrap can re-enable
      // debug mode + import affordances (URL-only propagation per
      // Codex T13 r13 P3).
      if (url.pathname === '/start' && req.method === 'GET') {
        const token = url.searchParams.get('token') ?? url.searchParams.get('start') ?? ''
        if (token.length === 0) {
          return new Response('missing start token', { status: 400 })
        }
        const dest = new URL('/chat', `${url.protocol}//${url.host}`)
        dest.searchParams.set('start', token)
        for (const key of ['debug', 'import']) {
          const v = url.searchParams.get(key)
          if (v !== null) dest.searchParams.set(key, v)
        }
        return new Response(null, {
          status: 302,
          headers: { location: `${dest.pathname}${dest.search}` },
        })
      }
      if (url.pathname === '/chat' && req.method === 'GET') {
        // ISSUES #318 — app-level Claude-auth gate. A box with no working
        // substrate credential would render an interactive-looking chat that
        // silently produces nothing; show a clear "authenticate Claude" page
        // instead. Evaluated per request so a restart-with-token clears it.
        if (options.chatAuthGate?.isUnauthenticated() === true) {
          return new Response(renderChatAuthGateHtml(), {
            // 503: the chat surface is intentionally unavailable until a
            // credential is present (not a 200 "here's your chat" lie, not a
            // 404 "no such page"). Browsers render the HTML body regardless.
            status: 503,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
            },
          })
        }
        // P0b — React is the only client. Always serve the tabbed React shell
        // (no flag, no `?client=` branch, no vanilla fallback). The shell is
        // loaded + asserted at construction, so this is unconditional.
        return new Response(new Uint8Array(chat_react_html), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      // Serve the lazily-bundled React client. Returns 404 only on a packaging
      // error (the `chat-react/main.tsx` entry missing) — the shell that
      // references `/chat-react.js` is required at boot, so in a real install
      // this always resolves.
      if (url.pathname === '/chat-react.js' && req.method === 'GET') {
        const js = await resolveChatReactJs()
        if (js === null) return new Response('chat-react.js unavailable', { status: 404 })
        return new Response(js, {
          headers: { 'content-type': 'application/javascript; charset=utf-8' },
        })
      }
      // ISSUES #208 — mobile install/landing page (see construction note).
      if (mobile_html !== null && url.pathname === '/mobile' && req.method === 'GET') {
        return new Response(new Uint8Array(mobile_html), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      // ISSUES #208 — PWA/brand assets (manifest + icons) so the
      // per-instance chat surface is installable. Mirrors boot.ts headers.
      if (req.method === 'GET') {
        const asset = brand_assets.get(url.pathname)
        if (asset !== undefined) {
          return new Response(new Uint8Array(asset.body), {
            headers: {
              'content-type': asset.type,
              'cache-control': 'public, max-age=86400',
            },
          })
        }
      }
      if (url.pathname === '/api/v1/sign-up' && req.method === 'GET') {
        // Codex r9 P1: redirect the landing CTA to the identity OAuth
        // start URL. Without `resolveSignupRedirect` configured, ops
        // sees a clear 503 instead of a silent 404.
        if (options.resolveSignupRedirect === undefined) {
          return new Response(
            'identity_oauth_url not configured. Set resolveSignupRedirect on LandingServerOptions.',
            { status: 503 },
          )
        }
        // Argus follow-up: accept long-form `via=telegram` (the canonical
        // shape that `identity/service.ts:readSignupVia` already accepts)
        // alongside the short `via=tg`. Direct deeplinks or future deploys
        // using `?via=telegram` would otherwise silently fall through to
        // the web flow, sending Telegram users to the wrong surface.
        const via_raw = url.searchParams.get('via') ?? ''
        const via: 'tg' | 'web' =
          via_raw === 'tg' || via_raw === 'telegram' ? 'tg' : 'web'
        const target = options.resolveSignupRedirect({ via })
        return new Response(null, {
          status: 302,
          headers: { location: target },
        })
      }
      if (
        invite_html !== null &&
        (url.pathname === '/invite' || url.pathname === '/') &&
        req.method === 'GET' &&
        url.searchParams.has('invite')
      ) {
        return new Response(new Uint8Array(invite_html), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      // Sprint 26 — Telegram landing: a friendly HTML page with an
      // "Open Telegram" deeplink button. Identity 302s
      // here with the bot, signin_event_id, and slug params. The page
      // reads those params client-side to build the t.me deeplink.
      if (
        onboarding_telegram_html !== null &&
        url.pathname === '/onboarding/telegram' &&
        req.method === 'GET'
      ) {
        return new Response(new Uint8Array(onboarding_telegram_html), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            // Defense-in-depth: the page uses one inline <script> +
            // one inline <style> block to build the deeplink from
            // query params. Sprint 26 r2 (Argus MINOR fix) replaces
            // `'unsafe-inline'` with SHA-256 hashes of the actual
            // block bodies so an XSS-injected <script> would be
            // rejected by the browser even if the query whitelist
            // were bypassed.
            'content-security-policy':
              onboarding_telegram_csp ??
              "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
          },
        })
      }
      if (url.pathname === '/invite.js' && req.method === 'GET') {
        const js = await resolveInviteJs()
        if (js === null) return new Response('invite.js unavailable', { status: 404 })
        return new Response(js, {
          headers: { 'content-type': 'application/javascript; charset=utf-8' },
        })
      }
      if (url.pathname === '/onboarding/invite-accept' && req.method === 'POST') {
        if (options.inviteAcceptHandler === undefined) {
          return new Response(
            JSON.stringify({
              status: 'error',
              reason: 'invite_accept_handler not configured. Set inviteAcceptHandler on LandingServerOptions.',
            }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          )
        }
        return options.inviteAcceptHandler(req)
      }
      if (url.pathname === '/ws/chat') {
        // 2026-05-27 persistent-session-cookie sprint (Part B) — the
        // upgrade handler accepts EITHER a valid `?start=<jwt>` (status
        // quo precedence — token wins when present) OR a valid session
        // cookie for THIS gateway's instance. Cookie-only upgrades emit a
        // refreshed `Set-Cookie` on the 101 response so the session-
        // cookie expiry rolls forward in lockstep with the HTTP-side
        // sliding refresh in `landing/auth-gate.ts`.
        //
        // Pre-sprint (token-only) behaviour is preserved exactly when
        // `cookieToUserClaim` is unwired: any request without a
        // `?start=` query param falls straight through to the 400 below.
        const start_token = url.searchParams.get('start') ?? ''
        // 2026-05-28 sidebar sprint — optional active-topic param.
        // Validated against the resolved user_id below (after claim
        // resolution) so a crafted topic_id can't pre-bind a sender
        // before instance auth runs.
        const active_topic_id_raw = url.searchParams.get('topic_id')
        // #306 (2026-06-19) — the auto-detected browser timezone. Captured
        // at upgrade time (Bun's WS `open` can't read the request URL) and
        // threaded into startSession → engine.start. Light bound here (the
        // engine re-validates the IANA shape); trimmed empty → undefined.
        const browser_timezone_raw = (url.searchParams.get('tz') ?? '').trim()
        const browser_timezone =
          browser_timezone_raw.length > 0 && browser_timezone_raw.length <= 64
            ? browser_timezone_raw
            : undefined
        if (start_token.length > 0) {
          // Codex r5 P2: validate-only here (NO jti claim). The atomic
          // consume happens after upgrade succeeds in the open handler so
          // a failed upgrade does not burn the token.
          const claim = await bridge.validateStartToken({ start_token })
          if (claim === null) {
            return new Response('invalid start token', { status: 401 })
          }
          const active_topic_id = validateActiveTopicId(active_topic_id_raw, claim.user_id)
          if (active_topic_id === 'invalid') {
            return new Response('invalid topic_id', { status: 400 })
          }
          // ISSUES #94 — also resolve the session cookie (when wired) as a
          // FALLBACK for the open handler. The `?start=` token still wins
          // (token precedence is preserved: pending_claim is set from it
          // and the jti is claimed in `open`), but a reconnect / reload
          // re-presenting a spent one-shot token would otherwise fail the
          // atomic claim and strand the authenticated user. Only a cookie
          // for the SAME identity is a valid recovery net — a cross-identity
          // cookie is ignored so there is no silent cross-auth. This is the
          // ONLY place the cookie can be read (Bun's WS `open` has no req).
          let cookie_fallback_claim: { project_slug: string; user_id: string } | undefined
          if (options.cookieToUserClaim !== undefined) {
            // Best-effort: resolving the fallback cookie MUST NOT break the
            // token auth path. Token always wins; a cookie-hook failure
            // simply leaves the recovery net unset.
            try {
              const cookieClaim = await options.cookieToUserClaim(req)
              // Same-identity is the `user_id` match. The cookie resolver is
              // single-instance (it returns null for any cookie that binds a
              // DIFFERENT instance — see `cookieToUserClaim` docs), so a
              // non-null claim is already guaranteed to be for THIS gateway's
              // instance. Do NOT also require `project_slug` equality: during a
              // no-restart slug rename the token's `claim.project_slug`
              // collapses to the gateway's frozen downstream slug while the
              // cookie resolver reports the CURRENT slug, so a strict-equality
              // gate would drop the fallback for the renamed-host reconnect —
              // exactly the consumed-token recovery this fix exists to provide
              // (Codex r1 P1).
              if (cookieClaim !== null && cookieClaim.user_id === claim.user_id) {
                cookie_fallback_claim = {
                  project_slug: cookieClaim.project_slug,
                  user_id: cookieClaim.user_id,
                }
              }
            } catch (err) {
              console.error('chat cookieToUserClaim (token-fallback resolve) threw:', err)
            }
          }
          const data: SocketState = {
            project_slug: claim.project_slug,
            user_id: claim.user_id,
            pending_claim: { ...claim, ...(active_topic_id !== undefined ? { active_topic_id } : {}) },
            session_started: false,
            current_host: resolveRequestHost(req),
            ...(active_topic_id !== undefined ? { active_topic_id } : {}),
            ...(browser_timezone !== undefined ? { browser_timezone } : {}),
            ...(cookie_fallback_claim !== undefined ? { cookie_fallback_claim } : {}),
          }
          const upgraded = server.upgrade(req, { data })
          if (!upgraded) {
            return new Response('upgrade failed', { status: 426 })
          }
          // server.upgrade returns true on success; the WS lifecycle takes over.
          return new Response(null, { status: 101 })
        }
        // Cookie-only branch — only walked when `?start=` is missing AND
        // the boot wired `cookieToUserClaim`. Returning null from the
        // hook (cookie missing / malformed / expired / cross-instance)
        // collapses to the same 400 a tokenless pre-sprint upgrade
        // produced, so existing token-only callers (mobile WS clients,
        // older browsers without the cookie) keep getting their
        // familiar "missing start token" body.
        if (options.cookieToUserClaim !== undefined) {
          const cookieClaim = await options.cookieToUserClaim(req)
          if (cookieClaim !== null) {
            const active_topic_id = validateActiveTopicId(active_topic_id_raw, cookieClaim.user_id)
            if (active_topic_id === 'invalid') {
              return new Response('invalid topic_id', { status: 400 })
            }
            const data: SocketState = {
              project_slug: cookieClaim.project_slug,
              user_id: cookieClaim.user_id,
              // No jti to claim for cookie-only auth; the `open` handler
              // skips `bridge.startSession` entirely when `pending_claim`
              // is null (returning user resumes mid-session — there is
              // no welcome envelope to fire).
              pending_claim: null,
              session_started: false,
              ...(active_topic_id !== undefined ? { active_topic_id } : {}),
            }
            // Defence-in-depth: pass the refreshed `Set-Cookie` BOTH on
            // the upgrade-arg `headers` (newer Bun) AND on the 101
            // response shell (older Bun) so browser cookie-jar rollover
            // happens regardless of which path Bun's WS upgrade
            // ultimately honours. The HTML-side gate at
            // `landing/auth-gate.ts` rolls the cookie on every gated
            // HTTP hit; this is the WS-side parity so a long-lived chat
            // session past the original cookie's 30d window keeps the
            // cookie alive without an intervening HTTP round-trip.
            const upgradeOpts: Parameters<typeof server.upgrade>[1] = { data }
            if (cookieClaim.set_cookie !== undefined) {
              upgradeOpts.headers = { 'set-cookie': cookieClaim.set_cookie }
            }
            const upgraded = server.upgrade(req, upgradeOpts)
            if (!upgraded) {
              return new Response('upgrade failed', { status: 426 })
            }
            const responseHeaders: Record<string, string> = {}
            if (cookieClaim.set_cookie !== undefined) {
              responseHeaders['set-cookie'] = cookieClaim.set_cookie
            }
            return new Response(null, { status: 101, headers: responseHeaders })
          }
          // Cookie hook returned null — fall through to the missing-
          // start-token 400 below (cookie absence is indistinguishable
          // from token absence on the wire; the operator's logs already
          // surface the underlying signin-needed signal via the gate).
        }
        return new Response('missing start token', { status: 400 })
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      async message(ws, message): Promise<void> {
        const data = ws.data
        if (data === undefined) return
        // Codex r5 P1: drop inbound messages before the session has been
        // started. Otherwise a fast client could send before the open
        // handler's startSession runs, slipping past the atomic jti claim.
        if (!data.session_started) {
          ws.send(JSON.stringify({ type: 'error', message: 'session not started' }))
          return
        }
        let event: ChatInbound
        try {
          event = JSON.parse(typeof message === 'string' ? message : message.toString()) as ChatInbound
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'malformed event' }))
          return
        }
        // Argus Sprint 18 r1 BLOCKING — reuse the per-socket send lambda
        // captured in `open` so the bridge sees a stable reference for
        // the lifetime of this socket. handleInbound re-registers on
        // every inbound; if we passed a fresh lambda each call the
        // registry would churn and identity-aware unregister could not
        // tell sockets apart.
        const send = data.send
        if (send === undefined) {
          // open() never ran (extremely unlikely — message before open).
          // Bail rather than synthesize a fresh send lambda that would
          // break identity tracking.
          ws.send(JSON.stringify({ type: 'error', message: 'session not started' }))
          return
        }
        try {
          await bridge.handleInbound({
            project_slug: data.project_slug,
            user_id: data.user_id,
            event,
            send,
            ...(data.active_topic_id !== undefined ? { active_topic_id: data.active_topic_id } : {}),
            // 2026-05-29 in-place topic switch sprint — let the bridge
            // mutate `ws.data.active_topic_id` so a `topic_switch` event
            // updates the per-socket binding atomically with the
            // sender re-register. The next inbound message on this
            // socket then reads the NEW topic_id; without this hop the
            // bridge would re-bind the registry but the server's next
            // dispatch would still pass the OLD topic_id back in.
            updateActiveTopicId: (new_id: string): void => {
              data.active_topic_id = new_id
            },
            // 2026-05-29 ISSUES #70 — race-safety read-callback paired
            // with `updateActiveTopicId`. The bridge's `topic_switch`
            // handler awaits the seed re-emit DB round-trip BEFORE
            // acking; if a second `topic_switch` lands during that
            // await, the helper re-reads ws.data.active_topic_id via
            // this lambda and drops the stale seed before painting it
            // into the new destination's just-cleared #log.
            getActiveTopicId: (): string | undefined => data.active_topic_id,
          })
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'bridge error'
          ws.send(JSON.stringify({ type: 'error', message: reason }))
        }
      },
      async open(ws): Promise<void> {
        const data = ws.data
        if (data === undefined) return
        // Capture the per-socket send lambda ONCE so every bridge call
        // (startSession / handleInbound / closeSession) sees the same
        // reference. Identity-aware registries (Argus Sprint 18 r1
        // BLOCKING) compare-and-delete by this ref.
        //
        // T10 (2026-05-14) — surface a closed-socket send as a throw.
        // Bun's `ws.send` returns 0 (NOT -1, NOT a throw) when the
        // underlying WS is no longer OPEN; pre-T10 this silently
        // dropped the engine's welcome envelope while reporting success
        // to the engine. With the throw, the InMemoryWebChatSenderRegistry's
        // catch (chat-bridge.ts) downgrades the routed-send result to
        // `was_new=false`, the engine leaves `delivered_at=null`, and
        // the user's reconnect re-emits the prompt. Without this
        // discriminator the engine treats the closed-socket send the
        // same as a successful delivery — the exact silent-drop the
        // T10 brief calls out.
        //
        // T10 r3 (Argus #1 BLOCKING) — distinguish `0` (closed) from
        // `-1` (backpressure: queued, will flush on drain). The pre-r3
        // `wrote <= 0` lumped backpressure into closed-socket and would
        // tear the session down with 4001 mid-onboarding the moment a
        // slow client got behind on a larger envelope. `=== 0` is the
        // only real closed-socket signal per Bun's ServerWebSocket
        // contract.
        const send = (outbound: ChatOutbound): void => {
          const wrote = ws.send(JSON.stringify(outbound))
          if (typeof wrote === 'number' && wrote === 0) {
            throw new Error(
              `landing/server: ws.send returned ${wrote} (socket closed)`,
            )
          }
        }
        data.send = send
        // 2026-05-27 persistent-session-cookie sprint (Part B) — when
        // `pending_claim` is null the WS was authed via a valid session
        // cookie (no `?start=` token); there is no jti to atomically
        // claim and no agent welcome envelope to fire. Skip
        // `bridge.startSession` entirely, mark the session live so
        // subsequent inbound messages walk `handleInbound` normally.
        // The cookie-only path mirrors a "warm" reconnect — the user is
        // resuming mid-session and the engine's existing state is
        // surfaced by the next user inbound, not by a server emit.
        //
        // 2026-05-29 r2 BLOCKER fix (Codex catch) — call
        // `bridge.resumeCookieSession` (if defined) BEFORE marking the
        // session live. The cookie-only path is the MOST COMMON entry
        // for a returning user (refresh on a project topic, persisted
        // localStorage pointer to `web:<u>:<proj>`); without this hook
        // the project-seed re-emit only fires on fresh start-token or
        // in-place `topic_switch`, leaving the project topic blank on
        // refresh (the history hydration's unresolved-skip drops the
        // active seed row at chat.ts:1195). The bridge registers the
        // sender at the active topic AND re-emits the active
        // unresolved seed prompt; failure is swallowed (logged) so it
        // CANNOT block session bring-up.
        if (data.pending_claim === null) {
          if (bridge.resumeCookieSession !== undefined) {
            try {
              const out = bridge.resumeCookieSession({
                project_slug: data.project_slug,
                user_id: data.user_id,
                send,
                ...(data.active_topic_id !== undefined ? { active_topic_id: data.active_topic_id } : {}),
              })
              if (out !== undefined && typeof (out as Promise<void>).then === 'function') {
                await (out as Promise<void>).catch((err: unknown) => {
                  console.error('chat bridge resumeCookieSession threw:', err)
                })
              }
            } catch (err) {
              console.error('chat bridge resumeCookieSession threw:', err)
            }
          }
          data.session_started = true
          // 2026-05-30 Argus r3 P2 #1 fix — push the authed user_id so the
          // cookie-only client can derive its General topic_id without
          // re-decoding a `?start=` JWT that doesn't exist on this path.
          // 2026-06-20 GO-LIVE — `resumed: true`: a cookie-only resume has no
          // fresh-onboarding setup window, so the client clears its loader.
          emitSessionReady(send, data.user_id, true)
          return
        }
        // Codex r5 P1 + P2: claim the jti AND fire the agent's opening
        // prompt now that the upgrade has actually succeeded. If the
        // claim races (someone else consumed the jti) the bridge returns
        // false and we close the socket cleanly.
        let started = false
        // ISSUES #94 Codex r1 P1 — distinguish a clean `false` return (the
        // atomic jti claim failed: a spent one-shot token on reconnect — the
        // bug this fix targets) from a THROW (engine bootstrap failed with the
        // token UNSPENT). Only the clean-false case is eligible for the
        // cookie-fallback resume; a throw must preserve the existing retry
        // contract and close so the client reconnects + retries startSession
        // (otherwise we'd mark a session live whose opening prompt never
        // emitted).
        let startSessionThrew = false
        try {
          started = await bridge.startSession({
            claim: data.pending_claim,
            send,
            ...(data.active_topic_id !== undefined ? { active_topic_id: data.active_topic_id } : {}),
            ...(data.current_host !== undefined ? { current_host: data.current_host } : {}),
            ...(data.browser_timezone !== undefined ? { browser_timezone: data.browser_timezone } : {}),
          })
        } catch (err) {
          startSessionThrew = true
          const reason = err instanceof Error ? err.message : 'bridge error'
          ws.send(JSON.stringify({ type: 'error', message: reason }))
        }
        if (!started) {
          // ISSUES #94 (2026-06-05) — the jti claim failed. The usual cause
          // in prod is NOT a genuine race but a reconnect / reload
          // re-presenting a spent one-shot `?start=` token (the
          // post-completion General socket). If a session cookie for the
          // SAME identity rode the upgrade, the user is still authenticated:
          // resume via the cookie-only path (re-register the sender, re-emit
          // the active seed) and mark the session live instead of closing
          // with 4001 and stranding them with "session not started" on
          // every inbound. Mirrors the `pending_claim === null` block above.
          //
          // Codex r1 P1 — gate on `!startSessionThrew`: a throw means
          // bootstrap failed with the token unspent, so we must NOT mark the
          // session live off the cookie (that would skip the failed opening
          // prompt). Only a clean `false` (spent-jti claim race) recovers here.
          const fallback = data.cookie_fallback_claim
          if (!startSessionThrew && fallback !== undefined) {
            // Identity already constrained to match the token at upgrade
            // time; pivot to a cookie-only socket so close()/inbound treat
            // it like any other warm resume.
            data.pending_claim = null
            if (bridge.resumeCookieSession !== undefined) {
              try {
                const out = bridge.resumeCookieSession({
                  project_slug: data.project_slug,
                  user_id: data.user_id,
                  send,
                  ...(data.active_topic_id !== undefined ? { active_topic_id: data.active_topic_id } : {}),
                })
                if (out !== undefined && typeof (out as Promise<void>).then === 'function') {
                  await (out as Promise<void>).catch((err: unknown) => {
                    console.error('chat bridge resumeCookieSession threw:', err)
                  })
                }
              } catch (err) {
                console.error('chat bridge resumeCookieSession threw:', err)
              }
            }
            data.session_started = true
            // 2026-06-20 GO-LIVE — spent-jti cookie fallback is also a resumed
            // returning session; clear the client loader (no setup window).
            emitSessionReady(send, data.user_id, true)
            return
          }
          ws.close(4001, 'session start failed')
          return
        }
        data.session_started = true
        // 2026-05-30 Argus r3 P2 #1 fix — push the authed user_id so the
        // client uses a server-trusted value (matches the cookie-only
        // path; keeps the JWT-decode fallback in `chat.ts:switchTopic`
        // strictly belt-and-braces).
        emitSessionReady(send, data.user_id)
      },
      close(ws): void {
        // Codex Sprint 18 r1 P2: notify the bridge so it can unregister
        // per-session sender entries (in-memory registries leak across
        // long-lived instance processes otherwise). The hook is optional;
        // platform-landing's no-auth bridge omits it cleanly.
        const data = ws.data
        if (data === undefined) return
        // Only fire closeSession if the WS got past the open handler's
        // session_started guard — sockets that closed before
        // bridge.startSession completed never registered a sender.
        if (!data.session_started) return
        if (bridge.closeSession === undefined) return
        // Argus Sprint 18 r1 BLOCKING — pass the same `send` lambda the
        // bridge saw at startSession so identity-aware unregister works.
        // If `open` never ran (defensive path) `data.send` is undefined
        // and we skip closeSession entirely; the registry has no
        // entry to clean up anyway.
        const send = data.send
        if (send === undefined) return
        try {
          const out = bridge.closeSession({
            project_slug: data.project_slug,
            user_id: data.user_id,
            send,
            ...(data.active_topic_id !== undefined ? { active_topic_id: data.active_topic_id } : {}),
          })
          if (out !== undefined && typeof (out as Promise<void>).then === 'function') {
            void (out as Promise<void>).catch((err: unknown) => {
              console.error('chat bridge closeSession threw:', err)
            })
          }
        } catch (err) {
          console.error('chat bridge closeSession threw:', err)
        }
      },
    },
  }
}
