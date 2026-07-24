// persistent-repl-substrate.ts → types.ts
// Public option/notice/reply contracts + internal turn/resume shapes + the
// rate-limit banner notice dispatcher (D2 split).

import type { DeadTurnNotice } from './api5xx-dead-turn-watcher.ts'
import type { SettingsPermissions } from './build-settings.ts'
import { EventChannel } from './event-channel.ts'
import { buildDetectorContext } from './output-scan.ts'
import type { SpawnAssertionConfig } from './post-spawn-assertion.ts'
import type { PtyHost } from './pty-host.ts'
import { RATE_LIMIT_BANNER_BOTTOM_N, type RateLimitBannerSeverity, matchRateLimitBanner, severityForBannerDetectorId } from './rate-limit-banner.ts'
import { AUTH_FAILURE_BOTTOM_N, matchAuthFailure } from './auth-failure-signature.ts'
import type { CaptureSessionConfig } from './session-capture.ts'
import type { SizeSeverity } from './session-size-watchdog.ts'
import type { ReplSession } from './repl-session.ts'

/** A rate-limit / overload banner that crossed the rising edge (master-table row
 *  #10). Surfaced through the injected {@link PersistentReplSubstrateOptions.onRateLimitBanner}
 *  seam (the gateway wires real chat delivery — the substrate is a runtime-layer
 *  module and MUST NOT import the gateway). NOTIFY-ONLY: there is no keystroke and
 *  no auto-retry. */
export interface RateLimitBannerNotice {
  /** Stable discriminator (mirrors {@link DeadTurnNotice.reason}). */
  reason: 'rate_limit_banner'
  /** The owning REPL session. */
  sessionId: string
  /** `temporary` (Anthropic-side transient 429/529/overload/502 — CC retries) or
   *  `usage-cap` (subscription window cap — no auto-recovery). */
  severity: RateLimitBannerSeverity
  /** The verbatim banner line that matched (trimmed) — surfaced so the user can
   *  cross-check which limit is in effect. */
  matched: string
}

/** Surface a rate-limit / overload banner notice on the rising edge (row #10).
 *  Notify-only — mirrors {@link surfaceSizeAlert}'s three surfaces: (a) the active
 *  turn's channel if one is in flight (inline visibility), (b) an operator stderr
 *  log (always), and (c) the injected `onRateLimitBanner` hook so a gateway can
 *  wire a richer chat-surface delivery. The scanner already stamped the
 *  per-`threadId::severity` edge-latch BEFORE this runs, so it is fire-once per
 *  rising edge and a hook failure can NOT un-latch or re-fire (invariant §1/§4). */
export function dispatchRateLimitBannerNotice(
  session: ReplSession,
  options: PersistentReplSubstrateOptions,
  detectorId: string,
  now: number,
): void {
  const severity = severityForBannerDetectorId(detectorId)
  if (severity === undefined) return // unreachable (caller already filtered)
  // Re-derive the matched line from the SAME bottom-N + doc-quote window the
  // detector saw (the ring is unchanged on this synchronous tick). The framework's
  // FiredDetection carries only id/keys, so the verbatim banner line is recovered
  // here rather than threaded through the latch state.
  const ctx = buildDetectorContext(session.ring.text(), RATE_LIMIT_BANNER_BOTTOM_N, now)
  const matched = matchRateLimitBanner(severity, ctx.lines) ?? '(rate-limit banner)'
  const message =
    severity === 'usage-cap'
      ? `🚧 Claude usage limit reached — the subscription window is capped and won't auto-recover until it resets.\n${matched}`
      : `⏳ Claude is temporarily rate-limited / overloaded (transient — it will retry on its own).\n${matched}`
  session.activeTurn?.channel.push({ kind: 'status', message })
  process.stderr.write(
    `[rate-limit-banner] ${severity} session=${session.sessionId.slice(0, 8)} matched=${matched}\n`,
  )
  try {
    options.onRateLimitBanner?.({
      reason: 'rate_limit_banner',
      sessionId: session.sessionId,
      severity,
      matched,
    })
  } catch {
    // A bad notice hook must never crash the scan tick.
  }
}

/** A CLI auth-failure that crossed the rising edge on the PTY ring — the `claude`
 *  child reported an invalid/expired credential (see `auth-failure-signature.ts`).
 *  Surfaced through the injected {@link PersistentReplSubstrateOptions.onAuthInvalid}
 *  seam (the gateway wires real chat delivery; the substrate is a runtime-layer
 *  module and MUST NOT import the gateway). NOTIFY-ONLY: there is no keystroke and no
 *  auto-retry — the fix is an out-of-band reconnect of the owner's Claude token. */
export interface AuthFailureNotice {
  /** Stable discriminator (mirrors {@link RateLimitBannerNotice.reason}). */
  reason: 'auth_invalid'
  /** The owning REPL session. */
  sessionId: string
  /** The verbatim (trimmed) CLI error line that matched — surfaced so an operator
   *  can cross-check which credential error fired. */
  matched: string
}

/** Record + surface a CLI auth-failure on the rising edge. Sets the session's
 *  `authFailureAt`/`authFailureMatched` (the pool driver's timeout watchdog reads
 *  these to fail the turn FAST + distinctly as `auth_invalid` instead of a generic
 *  freeze-timeout), logs an operator stderr notice, and calls the injected
 *  `onAuthInvalid` hook if wired. The scanner already stamped the per-detector
 *  edge-latch BEFORE this runs, so it is fire-once per rising edge and a hook
 *  failure can NOT un-latch or re-fire (invariant §1/§4). No inline chat push here:
 *  the SINGLE user-facing message is the reconnect bubble the gateway's turn-failure
 *  classifier ships once the turn actually ends. */
export function dispatchAuthFailureNotice(
  session: ReplSession,
  options: PersistentReplSubstrateOptions,
  now: number,
): void {
  // Re-derive the matched line from the SAME bottom-N + doc-quote window the
  // detector saw (the ring is unchanged on this synchronous tick).
  const ctx = buildDetectorContext(session.ring.text(), AUTH_FAILURE_BOTTOM_N, now)
  const matched = matchAuthFailure(ctx.lines) ?? '(auth failure)'
  session.authFailureAt = now
  session.authFailureMatched = matched
  process.stderr.write(
    `[auth-failure] session=${session.sessionId.slice(0, 8)} matched=${matched}\n`,
  )
  try {
    options.onAuthInvalid?.({
      reason: 'auth_invalid',
      sessionId: session.sessionId,
      matched,
    })
  } catch {
    // A bad notice hook must never crash the scan tick.
  }
}

/** A reply recovered by the replay-after-resume path (#106). The substrate is a
 *  runtime-layer module and MUST NOT import the gateway delivery layer, so the
 *  gateway injects `onRecoveredReply` (a runtime→gateway DI seam) and the
 *  substrate calls back with the routing handle + text. */
export interface RecoveredReply {
  /** The user's reconnect channel (`web:<user_id>` — `webTopicId`). */
  topic_id: string
  /** Idempotency key — the `<incarnation>:<seq>` of the dropped turn (§3). The
   *  gateway sink dedupes a live-delivered + persisted race on this. */
  turn_id: string
  /** The recovered assistant reply text. */
  text: string
  /** Owning instance (advisory — logging / scoping). */
  instance_slug?: string
}

/** Options to construct a persistent-REPL substrate. Superset of the retired
 *  `ClaudeCodeSubstrateOptions` so the flip-sites pass the same opts bag. */
export interface PersistentReplSubstrateOptions {
  /** Carried back on `completion.substrate_instance_id`. Also the instance+role
   *  discriminator folded into the warm-pool key (`cc-llm-*` / `cc-llm-router-*`
   *  / `cc-import-*` / `cc-email-*` never share a REPL; see `poolKeyFor`). */
  substrate_instance_id: string
  /** CWD for the REPL (instance home). DERIVED, not keyed (S3 #104/§2): two turns
   *  for the same (instance,user,project,credential) MUST land on the same warm
   *  REPL even if a caller computed `cwd` differently. Threaded into the spawn. */
  cwd?: string
  /** Conversational user identity — per-user warm-pool namespace (S3 §2). One
   *  user-per-instance today (`owner_user_id`); folded into `poolKeyFor` so two
   *  distinct users never collapse into one REPL. */
  user_id?: string
  /** Active project for the turn (`'default'` = the General surface). Per-project
   *  warm-pool namespace (S3 §2); folded into `poolKeyFor`. */
  project_id?: string
  /** The SELECTED credential id (`PooledCredential.id`, NEVER the token/secret).
   *  Folded into `poolKeyFor` so a credential rotation (A→cooldown→B) re-keys to
   *  a fresh REPL spawned under B's env, and cooldown attribution matches the
   *  child serving the turn (closes #104). */
  credential_identity?: string
  /** The user's reconnect channel id (`web:<user_id>`) for replay-redelivery
   *  (#106). Recorded on a dropped-turn pending entry so the boot-drain can route
   *  a recovered reply without reconstructing it. */
  delivery_topic_id?: string
  /** Owning instance slug (advisory — redelivery logging / scoping). */
  instance_slug?: string
  /** Injected redelivery sink (#106). The gateway provides this; the replay path
   *  calls it with the recovered reply + routing handle instead of discarding it.
   *  Runtime-layer DI seam — keeps the substrate from importing `gateway/*`. */
  onRecoveredReply?: (reply: RecoveredReply) => void | Promise<void>
  /** Operator-alert sink for the wedged-interactive-prompt recovery: fired ONCE
   *  when the escape→escape→ctrl-c ladder cannot clear a deadlocked menu (the
   *  question is also surfaced to the active turn's chat channel). Default: write
   *  the alert to stderr. Mirrors `ReplWatchdogOptions.postAlert`. */
  postWedgeAlert?: (text: string) => void
  /** Per-turn API-5xx dead-turn notice sink (master-table row #11). Fired on the
   *  rising edge when the JSONL watcher sees a mid-turn 5xx
   *  (`Overloaded`/`overloaded_error`/`rate_limit_error`/`internal_server_error`)
   *  on a `result`/`system`/`error` record — the turn died before `reply()`, so
   *  the user saw nothing (Ryan 2026-06-16). The gateway wires this to the
   *  user-facing "resend your last message" retry affordance; runtime-layer DI
   *  seam (mirrors `onRecoveredReply`/`postWedgeAlert`). Default: a structured
   *  stderr notice. */
  onDeadTurnNotice?: (notice: DeadTurnNotice) => void | Promise<void>
  /** Rate-limit / overload BANNER notice sink (master-table row #10). Fired on the
   *  rising edge when the output scanner sees a `temporary` (429/529/overload/502)
   *  or `usage-cap` (subscription window) banner in the ring — NOTIFY-ONLY, no
   *  keystroke. Edge-triggered per `threadId::severity` (one detector per severity)
   *  so a stale banner in an idle pane NEVER re-fires (the hourly-re-fire bug). The
   *  gateway wires this to a richer chat-surface alert; runtime-layer DI seam
   *  (mirrors `onDeadTurnNotice`). Default: a structured stderr notice + an inline
   *  status push if a turn is in flight. */
  onRateLimitBanner?: (notice: RateLimitBannerNotice) => void | Promise<void>
  /** CLI auth-failure notice sink. Fired on the rising edge when the output scanner
   *  sees an invalid/expired-credential banner in the ring (`OAuth access token is
   *  invalid` / `Please run /login` / a 401·403 `API Error`; see
   *  `auth-failure-signature.ts`) — NOTIFY-ONLY, no keystroke, no auto-retry.
   *  Edge-triggered (fire-once per rising edge). The gateway may wire this to a
   *  richer operator alert; the turn-failure classification (via the stamped
   *  `auth_invalid` error) is what surfaces the owner's reconnect bubble. Runtime-
   *  layer DI seam (mirrors `onRateLimitBanner`). Default: a structured stderr
   *  notice. */
  onAuthInvalid?: (notice: AuthFailureNotice) => void | Promise<void>
  /**
   * STATELESS-ONE-SHOT mode (Argus r4 BLOCKER, 2026-06-08). When `true`, a
   * `start(spec)` dispatch that carries NO `spec.session` gets its OWN fresh,
   * disposable REPL — spawned under a unique never-reused key (so it can't share
   * the warm pool), driven for exactly one turn, then TERMINATED. It is never
   * pooled by `poolKeyFor`, so two distinct stateless purposes on the same
   * (instance, user, project, credential) can NOT collapse into one shared
   * `--resume` transcript — restoring the pre-S3 "fresh `claude -p` per one-shot"
   * isolation the rip-replace (d3c7a0e) removed, AND bounding transcript growth.
   *
   * Scope: the gateway wires this ONLY on the SHARED `cc-llm-*` substrate that
   * every stateless utility caller (scribe, phase-spec resolver, agent-watcher,
   * nudge, research, wow, the onboarding suggesters/persona/seed composers)
   * dispatches through. The conversational + router REPLs leave it unset so they
   * keep their warm pooled session. A dispatch that DOES carry `spec.session`
   * (a genuine multi-turn resume) pools normally even on an ephemeral substrate —
   * the flag only changes the SESSION-LESS path.
   */
  ephemeral?: boolean
  /**
   * PER-TURN CONTEXT RESET (2026-06-17, import warm-session sprint). When `true`,
   * a session-less dispatch on a REUSED warm REPL (one that has already served a
   * turn this incarnation) is preceded by a `/clear` slash-command written
   * directly to the REPL's PTY stdin, so each turn runs on a freshly-cleared
   * conversation. This is the "ONE warm process, isolated per-turn context" mode:
   * the heavy `claude` spawn is paid ONCE (warm pool), but no turn accumulates a
   * prior turn's transcript — the bounded-context guarantee the `ephemeral` path
   * gets by spawning a fresh REPL per turn, WITHOUT paying the per-turn spawn.
   *
   * Wired ONLY on the history-import substrate (`cc-import-*`), where every Pass-1
   * / Pass-2 chunk is a fully self-contained, INDEPENDENT request that must not
   * see prior chunks. Pass-1 concurrency is pinned to 1 so the `/clear` ↔ inject
   * sequence is never raced by a concurrent turn on the same REPL.
   *
   * Mechanism note: `/clear` cannot ride the dev-channel `/message` path (that
   * delivers text as conversation CONTENT — "/clear" would be a literal user
   * message, not the TUI command). The reset therefore goes through the direct
   * PTY-write seam (the same `child.write(...)` the disclaimer-dismiss path uses).
   * It produces no correlated `reply`, so it is NOT modelled as an ActiveTurn — it
   * is a fire-then-wait-for-idle interstitial gated on the REPL being quiet on
   * both sides. Mutually exclusive with `ephemeral` in practice (ephemeral already
   * isolates by respawn); if both are set, `ephemeral` wins (no warm REPL to clear).
   */
  reset_context_per_turn?: boolean
  /** `claude` binary override. Default `process.env.CLAUDE_BIN ?? 'claude'`. */
  claude_bin?: string
  /** Append `--dangerously-skip-permissions` (managed headless REPLs MUST). */
  skip_permissions?: boolean
  /**
   * Task 6 (T5 write-containment spike) — when `true`, DO NOT register the
   * `tool-use-approve` auto-approver detector (`spawn.ts`) for this session, so a
   * `permissions.deny` rule (below) is LOAD-BEARING rather than auto-approved
   * past. Default `undefined` = today's behavior: the auto-approver IS registered
   * (it presses `['1','enter']` = "Yes" on any tool-use permission prompt, incl.
   * Bash via `runthiscommand` — `signatures.ts:89-90`). Set by the ritual
   * write-containment variant ONLY; every OTHER detector (dev-channel disclaimer,
   * the wedged-prompt deadlock-recovery ladder, rate-limit, resume-picker,
   * compact-resume, banners) stays unconditionally registered so a genuine wedge
   * still self-clears (the no-hang backstop). */
  disableToolUseAutoApprove?: boolean
  /**
   * Task 6 (T5 write-containment spike) — optional CC `permissions` block
   * forwarded to `buildSettings` and written into the per-session `--settings`
   * JSON alongside the Stop hook. When set on a ritual REPL WITH
   * `disableToolUseAutoApprove: true` and `skip_permissions` OFF, a `deny` rule
   * fails a write closed headlessly instead of prompting. Absent ⇒ Stop hook
   * only (unchanged for every existing caller). */
  permissions?: SettingsPermissions
  /** Auth/env overlay. `undefined` values delete from `process.env` (scrub). */
  env?: Record<string, string | undefined>

  /**
   * P0-1 — opt this REPL into the native-MCP tool bridge: a SECOND `mcpServers`
   * entry (alongside the dev-channel) that fronts the gateway's in-process
   * `ToolRegistry` so the spawned `claude` can make structured, self-initiated
   * Core/tool calls mid-reasoning. SECURITY-CRITICAL default-off: only the
   * owner's WARM conversational REPL sets this. The untrusted history-import
   * REPL and the disposable Trident build REPLs leave it false so a
   * prompt-injection in imported data can never reach a Core tool. No-op unless
   * a `ReplToolBridge` was also wired via `setReplToolBridge`.
   */
  enableToolBridge?: boolean
  // --- host / test injection (all optional; production uses defaults) ---
  /** PTY backend. Default: Bun-native terminal host. Tests inject a fake. */
  ptyHost?: PtyHost
  /** Path to the dev-channel MCP server script. Default: the shipped one. */
  devChannelPath?: string
  /** Path to the tools-bridge MCP server script. Default: the shipped one. */
  toolsBridgePath?: string
  /** Path to the agent-base system prompt. Default: the shipped one. */
  appendSystemPromptFile?: string
  /** Per-instance `~/.claude/projects` root for the JSONL ghost-gate AND the
   *  session-size watchdog's post-compact measurement (row #13). */
  projectsDir?: string
  /** Vajra port row #13: notified when a warm session's POST-COMPACT transcript
   *  size crosses a rising edge into the warn (≥5 MB) / critical (≥10 MB) band. A
   *  gateway wires this to a Reset/Compact/Snooze affordance; unset → the alert
   *  still surfaces to the active turn channel + an operator stderr log. */
  onSizeAlert?: (info: { sessionKey: string; severity: SizeSeverity; sizeBytes: number }) => void
  /** Override the session-size watchdog cadence (ms). Default 5 min. */
  sizeCheckIntervalMs?: number
  /** Override the idle-quiescence window (ms) the size watchdog's auto-compaction
   *  POLICY (gap #4) requires before injecting `escape`+`/compact`. Default
   *  {@link SESSION_COMPACT_IDLE_QUIESCE_MS} (30 s). Exposed mainly for tests that
   *  drive a deterministic idle tick; production uses the default. */
  sizeCompactIdleQuiesceMs?: number
  /**
   * Per-instance `CLAUDE_CONFIG_DIR`. When set, the child's claude config (login,
   * trust state, MCP cache) is isolated under this dir and auth flows via the
   * scrubbed `CLAUDE_CODE_OAUTH_TOKEN` env. When unset, the child uses the
   * default `~/.claude` (Open self-host single-login). Either way the
   * first-run trust + bypass dialogs are pre-seeded (see `ensure-claude-trust`).
   */
  claudeConfigDir?: string
  /** Skip the first-run trust/bypass pre-seed (tests with a fake host). */
  skipTrustSeed?: boolean
  /** Per-turn INACTIVITY window (ms) — the turn is abandoned with a retryable
   *  `turn timeout` error only after this long with NO PTY activity from the
   *  child (an actively-working turn resets it on every byte). Default
   *  `DEFAULT_TURN_INACTIVITY_MS` (90s). Overridable per-turn via
   *  `spec.turn_timeout_ms`. NOT a fixed wall clock — see the constant's doc. */
  turnTimeoutMs?: number
  /** Per-turn ABSOLUTE-CEILING backstop (ms) — the hard upper bound a single turn
   *  can run even while it keeps producing PTY activity (a live-but-livelocked
   *  child). Default `DEFAULT_TURN_ABSOLUTE_CEILING_MS` (45min). Overridable
   *  per-turn via `spec.turn_absolute_ceiling_ms`. Always coerced ≥ the inactivity
   *  window. */
  turnAbsoluteCeilingMs?: number
  /** Pre-inject idle-quiet window (ms the PTY must be silent before injecting
   *  the next turn). Default 900. Tests with a fake host set this to ~0. */
  idleQuietMs?: number
  /** Defensive cap on the pre-inject idle wait (ms). Default 6000. */
  idleMaxMs?: number
  /** Liveness-keepalive cadence (ms): while a turn is in flight and the child is
   *  alive, emit a `status` heartbeat this often so a long SILENT turn isn't
   *  false-wedged by a consumer's idle detector (2026-06-18). Default
   *  `REPL_LIVENESS_KEEPALIVE_MS` (env `NEUTRON_REPL_KEEPALIVE_MS`, 10s). Tests
   *  shrink it to observe a keepalive within a short in-flight window. */
  livenessKeepaliveMs?: number
  /** Post-spawn assertion budgets. */
  assertConfig?: SpawnAssertionConfig
  /** Ghost-gate capture poll budgets (tests shrink these). */
  captureConfig?: CaptureSessionConfig
  /** Session-id generator (tests pin it). Default `randomUUID`. */
  idGen?: () => string

  // --- Sprint-2 supervision (all optional; supervision is OFF unless a
  //     registry path is provided, keeping S1 behavior byte-identical) ---
  /**
   * Path to the persisted REPL registry JSON (brief § 2 row #12). When SET,
   * the substrate (a) writes a registry record per spawn, (b) consults it on
   * `getOrSpawnSession` so a respawn / next-turn-after-crash `--resume`s the
   * captured session instead of cold-spawning fresh (closes the S1
   * context-loss gap, brief § 0), and (c) the watchdog + admin respawn paths
   * become available. When UNSET, behavior is exactly S1 (fresh spawn, no
   * registry, no lock) — all existing S1 tests stay green. Production wires
   * `<owner_home>/.neutron/repl-registry.json`. */
  replRegistryPath?: string
  /** Path to the pending-respawns drain queue (restart-idempotent, brief § 2
   *  row #11). Defaults to `<dir(replRegistryPath)>/.pending-respawns.json`
   *  when a registry path is set. */
  pendingRespawnsPath?: string
  /** Path to the restart-rate crash-loop guard's marker file (Vajra mechanism
   *  #20). When set, each watchdog boot records a restart marker and, if two
   *  restarts land <5min apart, posts a crash-loop warning once (edge-latched)
   *  via `postAlert` (else stderr). Defaults to
   *  `<dir(replRegistryPath)>/.restart-markers.json`. */
  restartMarkersPath?: string
  /** Override the JSONL-existence probe that flips a record's `has_session`
   *  true (consumes `captureSession`'s result). Tests inject `() => true`;
   *  production uses `makeJsonlExistsProbe(projectsDir)`. */
  jsonlExistsProbe?: (sessionId: string, cwd: string) => boolean
  /** Path to the model-update watchdog's persisted state JSON (Vajra port row
   *  #16). When set, the 6h model-version probe + idle-gated graceful upgrade run
   *  for this instance. Defaults to `<dir(replRegistryPath)>/.model-update-state.json`.
   *  Unset (and no registry path) → the watchdog does not start. */
  modelUpdateStatePath?: string
  /** Vajra port row #16: notified once (edge) when a genuinely-new top-tier
   *  Claude model is detected and the graceful upgrade begins. A gateway wires
   *  this to a dev-channel notice; unset → the notice surfaces via an operator
   *  stderr log. */
  onModelUpdate?: (notice: { newModel: string; oldModel: string; text: string }) => void
  /** Override the model-update probe (tests inject a fake; production uses the
   *  real `claude -p --model opus` probe with NO `--fallback-model`). */
  modelProbe?: () => Promise<import('./model-update-watchdog.ts').ProbeResult>
  /** Override the model-update watchdog cadence + probe-gate (tests). */
  modelCheckTickMs?: number
  modelCheckIntervalMs?: number
  /** Override the graceful-upgrade idle gate + cadence (tests drive a fast,
   *  deterministic upgrade; production uses the 30s/5s/5s/30min defaults). */
  modelUpgradeIdleQuiesceMs?: number
  modelUpgradeJsonlFreshMs?: number
  modelUpgradePollMs?: number
  modelUpgradePerSessionTimeoutMs?: number
}

/** Why a child-kill was requested — threads through the respawn trigger. */

/** A registry-resume directive: spawn with `--resume <sessionId>` instead of a
 *  fresh `--session-id`. Internal — built by `getOrSpawnSession` from the
 *  registry, or passed by the respawn actuation. */
export interface ResumeDirective {
  sessionId: string
}

export interface ActiveTurn {
  channel: EventChannel
  settled: boolean
  settle: () => void
  substrateInstanceId: string
  sessionId: string
  /** Globally-unique id for THIS turn, stamped at turn construction and
   *  round-tripped through the dev-channel: the substrate injects it with the
   *  prompt (`injectMessage` → `/message {turn_id}`), the dev-channel tags the
   *  matching `reply` POST with it, and `onReply` accepts a reply ONLY when its
   *  `turn_id` equals this. This is what eliminates stale-reply misattribution in
   *  every window (Argus r5 / r6 / Codex GPT-5 BLOCKER):
   *
   *  Shape: `<incarnation>:<seq>` (see `ReplSession.nextTurnId`). `seq` is the
   *  per-session monotonic counter; `incarnation` is a per-spawn nonce. Both
   *  matter:
   *
   *    - WITHIN one incarnation (the r5 windows): a straggler from a timed-out /
   *      cancelled prior turn carries that turn's `seq`, so `t.turnId !== turnId`
   *      rejects it — whether it lands BEFORE this turn injects (pre-inject-park)
   *      or DURING this turn's inject POST round-trip (inject-in-flight). A reply
   *      tagged with THIS turn's id cannot exist before THIS turn injects (no
   *      message carrying it was sent), so the correlation alone closes both
   *      windows — no separate "has this turn injected yet" flag is needed.
   *    - ACROSS incarnations (the r6 cross-resume collision): `seq` RESETS per
   *      `ReplSession`, but a resume re-attaches the SAME `sessionId`, so without
   *      the nonce a straggler from a KILLED incarnation tagged `seq=1` would
   *      match the NEW incarnation's first turn (also `seq=1`). The per-spawn
   *      `incarnation` nonce makes `<oldNonce>:1` ≠ `<newNonce>:1`, so a straggler
   *      from a prior incarnation can never complete a turn in the new one. */
  turnId: string
  /** Set true by `onDeath` when the REPL process exited mid-turn — signals the
   *  driver to enqueue this turn's dropped inbound for replay-after-resume
   *  (pending-respawns queue, brief § 2 row #11 / § 6 acceptance #1). */
  diedMidTurn?: boolean
}
