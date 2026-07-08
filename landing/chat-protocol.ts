/**
 * @neutronai/landing — chat-protocol wire types (L1 refactor extraction).
 *
 * L1 (2026-07) — the inbound/outbound frame types for the `/ws/app/chat`
 * wire protocol, extracted VERBATIM out of `landing/server.ts` into this
 * leaf module. `landing/server.ts` re-exports every symbol below so
 * existing import specifiers stay valid during the transition (per
 * test-policy §2.2 barrel rule); real consumers (gateway/, open/,
 * reminders/) have been flipped to import directly from here, severing
 * the inbound edges those packages previously had onto the `server.ts`
 * edge module (which also owns HTTP route wiring, CSP building, and the
 * Bun.serve bootstrap — none of which belongs on a wire-protocol leaf).
 *
 * Every JSDoc comment below is preserved byte-identical from the
 * original `landing/server.ts` location — it is the only written spec
 * of jti-claim atomicity / identity-unregister / seed-reemit semantics
 * for this protocol surface. Do not reword, reformat, or "improve" it
 * without re-verifying against the call sites it documents.
 */

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
  /**
   * FIX #333 — mark a TRANSIENT system notification (e.g. the cold-start
   * "⏳ Waking up…" ack): rendered LIVE as a quiet centered system pill and
   * NEVER persisted to the durable chat_log, so a project switch/reload can't
   * re-hydrate it as a stray chat bubble. The client already routes
   * `system_notice === true` to the pill channel; the persistence layer
   * (`AppWsAdapter.send`) treats it as ephemeral (live fan-out only, no row).
   */
  system_notice?: boolean
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
  /**
   * P1a (2026-06-26) — the topic this ack belongs to. Stamped so the
   * per-topic client drop-guard attributes the ack to the right topic
   * instead of whatever is focused (notification misrouting fix).
   */
  topic_id?: string
}

/**
 * Tells the client to navigate to a new URL (typically the instance's new
 * subdomain after a slug rename) with a freshly minted start-token. The
 * client replaces `window.location` so the next WebSocket upgrade goes
 * through the validate/start path on the renamed gateway.
 *
 * The `project_slug` field is the NEW slug (post-rename) so the client
 * can correlate. `new_start_token` is the JWT to use for the next
 * chat WebSocket upgrade (`/ws/app/chat?start=...`) — its embedded
 * `project_slug` claim matches the new slug, so the renamed gateway's
 * `validateStartToken` accepts it without dipping into the slug-history
 * shim.
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
  /**
   * P1a (2026-06-26) — the topic this error belongs to. Stamped so the
   * per-topic client drop-guard renders the error in the right topic
   * instead of whatever is focused (notification misrouting fix).
   */
  topic_id?: string
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
