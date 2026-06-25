/**
 * persistent-repl-substrate.ts — THE BRIDGE (brief § 3 SPRINT 1 deliverable #4).
 *
 * `PersistentReplSubstrate implements Substrate`. It drives ONE persistent
 * interactive `claude` REPL per (instance, cwd) session key over the dev-channel,
 * and bridges the REPL's `reply`-tool output onto Neutron's locked
 * `Event`-stream `Substrate` contract — so every existing drain call site
 * (`collectTokensToString`, the 6 sibling drains) keeps working UNCHANGED.
 *
 * THE CRUX — why exactly-one-completion is clean:
 *   The `enforce-reply` Stop hook guarantees the REPL emits PRECISELY one
 *   `reply()` per channel turn. That maps 1:1 to one `completion` Event. The
 *   reply text is surfaced as a single `token` event immediately followed by
 *   the `completion`. The drain loop accumulates the token and returns on
 *   completion — identical to the retired per-turn `claude -p` path.
 *
 * Lifecycle per turn:
 *   start(spec) → ensure the session's REPL exists (spawn-or-reuse by key)
 *              → inject spec.prompt via dev-channel POST /message
 *              → return a SessionHandle whose events:
 *                   • {status} on inject (drives typing)
 *                   • {token}+{completion} when reply() fires for this turn
 *                   • {error, retryable} on process death / turn timeout
 *
 * tool_resolution = 'internal' (CC resolves its own MCP tools inside the REPL).
 * respondToTool throws (caller bug). cancel() aborts the in-flight turn and
 * leaves the REPL WARM (does not kill the child).
 *
 * Auth (brief § 1 #16): the PTY child inherits the caller's already-scrubbed
 * env (ANTHROPIC_* unset, CLAUDE_CODE_OAUTH_TOKEN set). No lift needed — the
 * interactive `claude` reads it natively.
 */

import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AgentSpec, Substrate } from '../../../substrate.ts'
import type { SessionHandle } from '../../../session-handle.ts'
import type { Event, TokenUsage } from '../../../events.ts'
import { EventChannel } from './event-channel.ts'
import { buildReplArgv } from './build-repl-argv.ts'
import { buildSettings } from './build-settings.ts'
import { assertReplAlive, type SpawnAssertionConfig } from './post-spawn-assertion.ts'
import { captureSession, makeJsonlExistsProbe, type CaptureSessionConfig } from './session-capture.ts'
import { bunTerminalHost } from './bun-terminal-host.ts'
import { ensureClaudeTrust } from './ensure-claude-trust.ts'
import type { PtyChild, PtyHost } from './pty-host.ts'
import { PtyRing, type RecentOutputOpts } from './pty-ring.ts'
import { OutputScanner } from './output-scan.ts'
import { normalizePtyText } from './pty-text.ts'
import {
  createWedgedPromptDetector,
  runWedgedRecovery,
  WEDGED_PROMPT_DETECTOR_ID,
} from './wedged-prompt-detector.ts'
import { encodeKeys, encodeKey, type Key } from './keystrokes.ts'
import { resolveRespawnStrategy } from './respawn-strategy.ts'
import {
  getRecord,
  loadRegistry,
  patchRecord,
  upsertRecord,
  withRegistry,
  type ReplRegistryRecord,
} from './repl-registry.ts'
import {
  buildRespawnNoticeText,
  executeRespawn,
  planRespawn,
  shouldPostRespawnNotice,
  type RespawnDeps,
  type RespawnOutcome,
  type RespawnTrigger,
  type SpawnReplOutcome,
} from './session-respawn.ts'
import {
  buildWedgeAlertText,
  buildWedgeCapHitAlertText,
  buildWedgeRecoveryInProgressText,
  decideWedgeAction,
  detectReplWedged,
  type ReplWedgeProbe,
} from './wedge-detector.ts'
import { dispatchWedgeRespawn } from './wedge-respawn-dispatch.ts'
import {
  basenameOf,
  cmdlineMatchesSession,
  defaultReadCmdline,
  registerOrphanKill,
} from './orphan-adoption.ts'
import { makeInFlightGate, type InFlightGate } from './in-flight-gate.ts'
import { startHeartbeatWatchdog, type HeartbeatWatchdog } from './heartbeat-watchdog.ts'
import {
  clearPendingRespawns,
  enqueuePendingRespawn,
  loadPendingRespawns,
  planZombieRespawns,
  removeEntryBySessionKey,
  savePendingRespawns,
  type PendingRespawnEntry,
} from './pending-respawns-queue.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Separator between the warm-pool key components (S3: `substrate_instance_id`,
 *  `user_id`, `project_id`, `credential_identity`). A NUL byte — never present in
 *  a slug / uuid / credential-id, so the key is unambiguous. Shared by the key
 *  construction and the pending-respawns drain so the two can never drift. */
const SESSION_KEY_SEP = '\0'
const DEFAULT_DEV_CHANNEL_PATH = join(HERE, 'dev-channel.ts')
// Co-located with the substrate (NOT in the P0 `prompts/` package, whose
// KNOWN_PROMPTS registry strictly enumerates the instance-substituted gateway
// prompts). This is a static substrate asset read by absolute path.
const DEFAULT_AGENT_BASE_PROMPT = join(HERE, 'repl-agent-base.md')

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }
const DEFAULT_TURN_TIMEOUT_MS = 180_000
/** Signature of the `--dangerously-load-development-channels` first-run
 *  disclaimer, matched against the PTY text with ALL ANSI escapes + whitespace
 *  stripped (the Ink TUI positions each word with cursor-move escapes, so the
 *  phrase is never contiguous in the raw stream). */
const DEV_CHANNEL_DISCLAIMER_RE = /forlocalchanneldevelopment|usingthisforlocaldevelopment/i
/** Bottom-N line window the disclaimer detector scans. Generous (vs the default
 *  bottom-24) because the disclaimer renders as a multi-line box at spawn; this
 *  preserves the old whole-ring match behavior while still excluding unbounded
 *  scrollback. */
const DISCLAIMER_BOTTOM_N = 200
/** P1 auto-approve tool-use prompt (port row #2). BOTH cues are required: the
 *  question line AND the `❯ 1. Yes` selector — matching just one false-fires on
 *  scrollback (a previous approval's `❯ 1. Yes` lingers without the live
 *  question). Matched against the whitespace-stripped `normalized` view because
 *  Ink shreds each word across cursor-move escapes (same reason as the
 *  disclaimer; see pty-text.ts), so the spec regex
 *  `/Do you want to (make this edit|proceed|run this command|create)/i` is
 *  carried here in its space-free normalized form. These prompts render even
 *  under `--dangerously-skip-permissions` for key-to-kingdom paths
 *  (`.git/hooks/*`, writes outside the project root), so the substrate must
 *  clear them itself. */
const TOOL_USE_QUESTION_RE = /doyouwantto(makethisedit|proceed|runthiscommand|create)/i
const TOOL_USE_SELECTOR_RE = /❯1\.yes/i
/** P1 /rate-limit-options org-cap auto-stop (port row #4). BOTH cues are
 *  required in the bottom-30 lines: the `/rate-limit-options` slash command name
 *  AND option 3's verbatim text `Stop and wait for limit to reset` — a single
 *  cue (a conversational mention or a quoted brief) must not trip it. Matched
 *  against the whitespace-stripped `normalized` view because Ink shreds the
 *  picker across cursor-move escapes (same reason as the disclaimer/tool-use
 *  cues; see pty-text.ts), so the spec substrings are carried here in their
 *  space-free normalized form. */
const RATE_LIMIT_OPTIONS_RE = /\/rate-limit-options/i
const RATE_LIMIT_STOP_RE = /stopandwaitforlimittoreset/i
/** Bottom-N window the rate-limit-options detector scans (Vajra
 *  RATE_LIMIT_OPTIONS_BOTTOM_N_LINES). LOAD-BEARING positional guard — see the
 *  registration comment for why. */
const RATE_LIMIT_OPTIONS_BOTTOM_N = 30
/** Debounce floor for the rate-limit-options auto-stop (Vajra
 *  RATE_LIMIT_OPTIONS_DEDUPE_MS) — suppresses a re-press if the picker
 *  re-renders briefly while the prior `3`+enter is still settling. */
const RATE_LIMIT_OPTIONS_DEBOUNCE_MS = 60_000
const REPL_DEBUG = process.env['NEUTRON_REPL_DEBUG'] === '1'
/** After a turn's reply settles, hold the turn lock until the REPL's PTY has
 *  been quiet for this long (claude returned to idle) before allowing the next
 *  inject — closes the back-to-back-turn drop race. */
const DEFAULT_IDLE_QUIET_MS = 900
/** Cap on the post-reply idle wait (defensive — a TUI that never goes fully
 *  quiet still releases after this). */
const DEFAULT_IDLE_MAX_MS = 6_000
/**
 * LIVENESS KEEPALIVE cadence (2026-06-18 synthesis false-wedge fix). While a turn
 * is in flight AND the `claude` child is still alive, the session emits a `status`
 * heartbeat every this-many ms. The synthesis drain's idle-heartbeat resets on
 * every event, so a read pass that reads + thinks SILENTLY (no tokens) for longer
 * than the consumer's idle window is no longer FALSELY wedged: the child being
 * alive surfaces as periodic activity. Must stay comfortably BELOW the synthesis
 * idle window (`SYNTHESIS_IDLE_TIMEOUT_MS_DEFAULT`, 120 s) so several keepalives
 * land per window. A true hang (child exited) stops the keepalive immediately and
 * trips `onDeath`'s error event fast. Env-overridable (`NEUTRON_REPL_KEEPALIVE_MS`). */
const REPL_LIVENESS_KEEPALIVE_MS = ((): number => {
  const raw = process.env['NEUTRON_REPL_KEEPALIVE_MS']
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 10_000
})()
/** Default watchdog tick cadence (ms). */
const DEFAULT_WATCHDOG_INTERVAL_MS = 15_000
/** The TUI slash command that wipes the conversation transcript while keeping
 *  the `claude` process (and its MCP servers / dev-channel / system prompt)
 *  alive. Used by the `reset_context_per_turn` warm-import mode to isolate each
 *  chunk's context without respawning the REPL. */
const CONTEXT_RESET_COMMAND = '/clear'
/** A respawn-in-flight stamp older than this is treated as stale (the prior
 *  respawn crashed before clearing it) and a new respawn may proceed. */
const RESPAWN_IN_FLIGHT_TTL_MS = 90_000
/** Rolling window for the respawn-rate cap. */
const RESPAWN_CAP_WINDOW_MS = 60 * 60 * 1000
/** Max respawns per `RESPAWN_CAP_WINDOW_MS` before the hard cap trips (auto-
 *  recovery OFF until an operator clears `capped_at`). */
const RESPAWN_CAP_MAX = 3
/** Grace period a respawn waits for a wedged child to exit after SIGTERM before
 *  escalating to SIGKILL. The `--resume` replacement is NOT spawned until the old
 *  child is dead, so exactly one process owns the session transcript at a time
 *  (Argus r3 BLOCKER 1). */
const CHILD_KILL_GRACE_MS = 2_000
/** Send a structured key sequence to a PTY child, degrading to a raw `write`
 *  when the backend predates the F2 `writeKeys` extension (every real
 *  `bun-terminal-host` child implements it; a lightweight test fake may not).
 *  Used to actuate an output-scan detector's fired keystrokes (`output-scan.ts`,
 *  F3). The encoding is the pure `encodeKeys` (`keystrokes.ts`), so this stays a
 *  single fire-once write per detection (invariant §4). */
function sendKeys(child: PtyChild, keys: readonly Key[]): void {
  if (keys.length === 0) return
  if (child.writeKeys !== undefined) child.writeKeys(keys)
  else child.write(encodeKeys(keys))
}

/** Send ONE structured key, degrading to a raw `write(encodeKey(...))` when the
 *  backend predates the F2 `writeKey` extension. The wedged-prompt recovery
 *  ladder writes keys one-at-a-time (escape→verify→escape→verify→ctrl-c), so it
 *  needs the single-key seam rather than `sendKeys`. */
function sendKey(child: PtyChild, key: Key): void {
  if (child.writeKey !== undefined) child.writeKey(key)
  else child.write(encodeKey(key))
}

/**
 * Run the registered output-scan detectors against the session ring and actuate
 * the ones that fired on this tick's rising edge. Shared by BOTH drive sites:
 * the PTY `onData` callback (fires while the menu is still rendering output) AND
 * the per-turn liveness keepalive (fires on a STATIC wedge that emits no further
 * output — the case the inactivity watchdog used to just kill). `scan` stamps
 * each detector's latch BEFORE returning, so every keystroke write here is
 * fire-once even if the transport throws (invariant §4).
 *
 * The wedged-interactive-prompt detector carries NO `keys` (its recovery is the
 * multi-step escape/ctrl-c verify ladder, not a fire-once keystroke); when it
 * fires we launch {@link dispatchWedgeRecovery} instead of `sendKeys`.
 */
function runOutputScan(
  session: ReplSession,
  child: PtyChild,
  options: PersistentReplSubstrateOptions,
  now: number,
): void {
  for (const fired of session.scanner.scan(session.ring.raw(), now)) {
    if (fired.id === WEDGED_PROMPT_DETECTOR_ID) {
      dispatchWedgeRecovery(session, child, options)
    } else if (fired.keys !== undefined) {
      sendKeys(child, fired.keys)
    }
  }
}

/** Launch the wedged-interactive-prompt escape/ctrl-c recovery ladder (P0). The
 *  scanner latch already prevents a re-fire while the menu is still present, but
 *  the ladder is async, so `session.wedgeRecovering` additionally guards the
 *  in-flight window. Fire-and-forget: the ladder writes its own keystrokes and
 *  surfaces/alerts on a persistent block. */
function dispatchWedgeRecovery(
  session: ReplSession,
  child: PtyChild,
  options: PersistentReplSubstrateOptions,
): void {
  if (session.wedgeRecovering) return
  session.wedgeRecovering = true
  const alert =
    options.postWedgeAlert ?? ((text: string) => process.stderr.write(`[wedge-recover] ${text}\n`))
  void runWedgedRecovery({
    writeKey: (key) => sendKey(child, key),
    // In-process ring read always returns a string; the null-as-not-cleared
    // contract is honoured at the module boundary for hosts that can fail a
    // re-capture (the Vajra tmux `capture-pane` lesson).
    readRing: () => session.ring.raw(),
    delay: (ms) => new Promise((res) => setTimeout(res, ms)),
    // Surface the still-wedged question to the active turn's chat channel (the
    // dev-channel surface) so the user can see what the agent is blocked on.
    surface: (questionText) => {
      session.activeTurn?.channel.push({
        kind: 'status',
        message: `⚠️ Blocked on an interactive prompt I couldn't auto-dismiss:\n${questionText}`,
      })
    },
    alert,
    now: () => Date.now(),
  })
    .catch((err: unknown) => {
      process.stderr.write(`[wedge-recover] ladder threw: ${String(err)}\n`)
    })
    .finally(() => {
      session.wedgeRecovering = false
    })
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
  /** Auth/env overlay. `undefined` values delete from `process.env` (scrub). */
  env?: Record<string, string | undefined>

  // --- host / test injection (all optional; production uses defaults) ---
  /** PTY backend. Default: Bun-native terminal host. Tests inject a fake. */
  ptyHost?: PtyHost
  /** Path to the dev-channel MCP server script. Default: the shipped one. */
  devChannelPath?: string
  /** Path to the agent-base system prompt. Default: the shipped one. */
  appendSystemPromptFile?: string
  /** Per-instance `~/.claude/projects` root for the JSONL ghost-gate. */
  projectsDir?: string
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
  /** Per-turn timeout before emitting a retryable error. Default 180s. */
  turnTimeoutMs?: number
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
  /** Override the JSONL-existence probe that flips a record's `has_session`
   *  true (consumes `captureSession`'s result). Tests inject `() => true`;
   *  production uses `makeJsonlExistsProbe(projectsDir)`. */
  jsonlExistsProbe?: (sessionId: string, cwd: string) => boolean
}

/** Why a child-kill was requested — threads through the respawn trigger. */
export type { RespawnTrigger, RespawnOutcome } from './session-respawn.ts'

/** A registry-resume directive: spawn with `--resume <sessionId>` instead of a
 *  fresh `--session-id`. Internal — built by `getOrSpawnSession` from the
 *  registry, or passed by the respawn actuation. */
interface ResumeDirective {
  sessionId: string
}

interface ActiveTurn {
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

// ---------------------------------------------------------------------------
// Reply sink — one loopback HTTP server the dev-channels POST back to.
// Module singleton so it is shared across every per-turn substrate instance.
// ---------------------------------------------------------------------------

class ReplSink {
  private server: ReturnType<typeof Bun.serve> | undefined
  readonly token: string = randomBytes(24).toString('hex')
  private readonly sessions = new Map<string, ReplSession>()

  ensureStarted(): void {
    if (this.server !== undefined) return
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => this.handle(req),
    })
  }

  get port(): number {
    if (this.server === undefined) throw new Error('repl-sink: not started')
    const p = this.server.port
    if (p === undefined) throw new Error('repl-sink: server has no bound port')
    return p
  }

  register(sessionId: string, session: ReplSession): void {
    this.sessions.set(sessionId, session)
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Identity-guarded unregister: only drop the mapping if it STILL points at
   *  `session`. A respawn re-attaches the SAME sessionId via `--resume`, so the
   *  dying OLD child's death handler must not evict the NEW session that already
   *  re-registered under that id (the resume race the P2-3 regression caught). */
  unregisterIf(sessionId: string, session: ReplSession): void {
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (req.method === 'POST') {
      const token = req.headers.get('X-Sink-Token')
      if (token !== this.token) {
        return Response.json({ status: 'unauthorized' }, { status: 401 })
      }
      let body: Record<string, unknown> = {}
      try {
        body = (await req.json()) as Record<string, unknown>
      } catch {
        return Response.json({ status: 'bad-json' }, { status: 400 })
      }
      const sessionId = typeof body['session_id'] === 'string' ? (body['session_id'] as string) : ''
      if (REPL_DEBUG) {
        process.stderr.write(`[repl-sink] ${url.pathname} session=${sessionId.slice(0, 8)} active=${this.sessions.get(sessionId)?.activeTurn !== undefined}\n`)
      }
      const session = this.sessions.get(sessionId)
      if (session === undefined) {
        return Response.json({ status: 'no-session' }, { status: 404 })
      }
      if (url.pathname === '/channel-ready') {
        const port = typeof body['channel_port'] === 'number' ? (body['channel_port'] as number) : 0
        session.onChannelReady(port)
        return Response.json({ status: 'ok' })
      }
      if (url.pathname === '/reply') {
        const text = typeof body['text'] === 'string' ? (body['text'] as string) : ''
        const turnId = typeof body['turn_id'] === 'string' ? (body['turn_id'] as string) : undefined
        session.onReply(text, turnId)
        return Response.json({ status: 'ok' })
      }
      if (url.pathname === '/typing') {
        session.onTyping()
        return Response.json({ status: 'ok' })
      }
    }
    return new Response('not found', { status: 404 })
  }
}

const sink = new ReplSink()

/** Exposed for tests acting as the dev-channel: the live sink coordinates. */
export function getReplSinkInfo(): { port: number; token: string } {
  sink.ensureStarted()
  return { port: sink.port, token: sink.token }
}

// ---------------------------------------------------------------------------
// ReplSession — one warm REPL + its dev-channel + its turn serialization.
// ---------------------------------------------------------------------------

class ReplSession {
  channelPort: number | undefined
  private readyResolve: (() => void) | undefined
  readonly ready: Promise<void>
  activeTurn: ActiveTurn | undefined
  /** ABANDON-POISON flag (2026-06-18 warm-session hang fix). Set true when a turn
   *  on this warm REPL is ABANDONED before its reply lands — the caller's budget
   *  elapsed (`handle.cancel()`, e.g. the synthesis `dispatchTurn` 90s timeout) OR
   *  the substrate's own `turnTimeoutMs` fired. The REPL keeps RUNNING that
   *  abandoned turn; its late `reply()` then arrives while the NEXT turn is in
   *  flight, where the dev-channel's stale-reply debt strips the reply's `turn_id`
   *  (`got_turn=<none>`) and the substrate rejects it — so the next turn (and
   *  every turn after it) never delivers. ONE runaway turn permanently poisons the
   *  warm session = the production hang (synthesis import: every read pass timed
   *  out, dollars_spent=0, the empty fallback "completed"). `getOrSpawnSession`
   *  treats a poisoned session like a failed freshness guard: it evicts + respawns
   *  a CLEAN REPL (fresh dev-channel, no debt, no runaway) before the next turn, so
   *  a single slow/wedged turn can no longer cascade. The accumulating synthesis
   *  model survives a respawn because each read prompt carries the running model
   *  explicitly (`buildReadPrompt` runningProjects/runningPeople), not only the
   *  REPL's in-context memory. */
  poisoned = false
  /** Timestamp of the last byte the REPL's PTY emitted. Used to gate the NEXT
   *  turn's inject on the REPL going idle — injecting a channel notification
   *  while claude is still finishing the prior turn drops the notification
   *  (the back-to-back-turn race that timed out the 3-turn proof). */
  lastDataAt = Date.now()
  /** F1: the public, line-addressable PTY ring. Every chunk the child emits is
   *  appended here; `getRecentOutput` reads it (line-addressable, bottom-N,
   *  optionally normalized). Replaces the old debug-gated 16 KB closure. */
  readonly ring = new PtyRing()
  /** F3: the output-scan detector framework. The disclaimer auto-dismiss is
   *  registered here (generalized from the old inline `onData` check); the
   *  P0/P1 recovery detectors register signature+action in follow-on PRs. */
  readonly scanner = new OutputScanner()
  /** True while the wedged-interactive-prompt escape/ctrl-c recovery ladder is
   *  in flight, so a second scan tick can't launch a concurrent ladder on the
   *  same still-present menu (the scanner latch already guards the rising edge;
   *  this guards the async window the ladder runs in). */
  wedgeRecovering = false
  /** The built-in tool surface this REPL was SPAWNED with, as a stable
   *  comma-joined key (`--tools` value). The reuse guard refuses to serve a turn
   *  whose requested surface differs, so a less-privileged turn (e.g. an import
   *  `tools:[]`) can never reuse a more-privileged warm REPL (Codex-r1-P1). */
  toolSurface = ''
  /** Fingerprint of the auth secret this REPL was SPAWNED with (`CLAUDE_CODE_
   *  OAUTH_TOKEN` / `ANTHROPIC_API_KEY`), hashed so no second plaintext copy of
   *  the secret lives on the long-held session. The credential-freshness reuse
   *  guard compares the CURRENT dispatch's fingerprint against this: the pool key
   *  folds the STABLE `PooledCredential.id`, NOT the rotating token VALUE, so a
   *  per-dispatch OAuth refresh under the same credential id would otherwise keep
   *  serving turns on the warm child's now-expired token (Codex r2 P1). Empty
   *  when no env auth secret is present — the interactive-Max-login model
   *  authenticates via `claudeConfigDir`'s credentials.json and self-refreshes,
   *  so there is nothing to fingerprint and the guard is correctly inert. */
  authFingerprint = ''
  /** Per-session temp config files (`neutron-repl-*-mcp.json` + `*-settings.json`)
   *  this REPL was spawned with. Stashed so teardown can unlink them — an ephemeral
   *  one-shot spawns a fresh pair per call, so without cleanup they accumulate in
   *  `tmpdir()` forever, directly countering the bounding-growth goal (Argus r5
   *  IMPORTANT). Unlinked on dispose + on child exit (covers pool + crash). */
  configPaths: readonly string[] = []
  /** The PTY child — attached right after spawn (we register the session in
   *  the sink BEFORE spawning so a fast /channel-ready can't race). */
  private childRef: PtyChild | undefined
  /** Per-session turn mutex: only one turn injected at a time. */
  private turnTail: Promise<void> = Promise.resolve()
  /** Monotonic per-incarnation turn-sequence source. Combined with `incarnation`
   *  into `activeTurn.turnId` so a reply can be correlated to the exact turn that
   *  produced it (see `ActiveTurn.turnId`). RESETS per `ReplSession` — which is
   *  why a bare seq is not enough across a resume (see `incarnation`). */
  private turnSeq = 0
  /** Per-spawn (per-incarnation) nonce. A resume re-attaches the SAME
   *  `sessionId` under a NEW `ReplSession`, where `turnSeq` restarts at 0; this
   *  nonce makes a turn-id from a prior (killed) incarnation un-matchable against
   *  this one, closing the cross-resume turnId collision (Argus r6). One
   *  `ReplSession` == one incarnation == one nonce. */
  private readonly incarnation: string = randomBytes(4).toString('hex')

  /** Mint this incarnation's next turn-id as `<incarnation>:<seq>` — globally
   *  unique across incarnations of the same `sessionId` (see `ActiveTurn.turnId`). */
  nextTurnId(): string {
    this.turnSeq += 1
    return `${this.incarnation}:${this.turnSeq}`
  }

  /** Number of turns this incarnation has begun (the monotonic `turnSeq`).
   *  0 ⇒ no turn injected yet on this freshly-spawned/resumed REPL — its
   *  conversation is empty, so the per-turn context-reset (`/clear`) is a
   *  no-op and is skipped. >0 ⇒ this warm REPL already served a turn, so a
   *  reset is needed before the next one to isolate per-turn context. */
  turnsServedThisIncarnation(): number {
    return this.turnSeq
  }

  constructor(
    readonly sessionKey: string,
    readonly sessionId: string,
    readonly channelName: string,
  ) {
    this.ready = new Promise<void>((res) => {
      this.readyResolve = res
    })
  }

  attachChild(child: PtyChild): void {
    this.childRef = child
  }

  /** F1 public ring-read accessor. Recent PTY output for a content detector:
   *  `{ bottomN }` for a line-addressed bottom-N slice, `{ normalize }` to
   *  collapse Ink ANSI for contiguous-signature matching. Always available (no
   *  longer `NEUTRON_REPL_DEBUG`-gated). */
  getRecentOutput(opts: RecentOutputOpts = {}): string {
    return this.ring.getRecentOutput(opts)
  }

  get child(): PtyChild {
    if (this.childRef === undefined) throw new Error('repl-session: child not attached')
    return this.childRef
  }

  hasChildExited(): boolean {
    return this.childRef === undefined || this.childRef.hasExited()
  }

  onChannelReady(port: number): void {
    if (port > 0) this.channelPort = port
    if (this.readyResolve) {
      this.readyResolve()
      this.readyResolve = undefined
    }
  }

  onReply(text: string, turnId?: string): void {
    const t = this.activeTurn
    // Accept a reply ONLY if its turn-id correlates to the CURRENT turn (Argus
    // r5 / r6 / Codex GPT-5 BLOCKER — see `ActiveTurn.turnId`). The
    // `<incarnation>:<seq>` id rejects a straggler from a prior turn (different
    // seq) AND from a prior incarnation of the same resumed session (different
    // nonce), in both the pre-inject-park and inject-in-flight windows. A real
    // reply for this turn always carries this turn's id, so this never drops a
    // legitimate completion — and a reply tagged with this turn's id cannot
    // exist before this turn injects, so no separate `injected` flag is needed.
    if (t === undefined || t.settled || t.turnId !== turnId) {
      // Telemetry: a drop is never silent (Argus r6). Only an actual reject —
      // an idle session with no active turn produces no reply, so this fires on
      // a genuine straggler / desync, not steady state.
      if (t !== undefined && !t.settled) {
        process.stderr.write(
          `[repl-sink] dropped uncorrelated reply: session=${this.sessionId.slice(0, 8)} expected_turn=${t.turnId} got_turn=${turnId ?? '<none>'}\n`,
        )
      }
      return
    }
    t.settled = true
    // The 1:1 bridge: one reply → one token + one completion.
    t.channel.push({ kind: 'token', text })
    t.channel.push({
      kind: 'completion',
      usage: ZERO_USAGE,
      session: { id: t.sessionId, last_active_at: Date.now() },
      substrate_instance_id: t.substrateInstanceId,
    })
    t.channel.close()
    t.settle()
  }

  onTyping(): void {
    const t = this.activeTurn
    if (t === undefined || t.settled) return
    t.channel.push({ kind: 'status', message: 'working' })
  }

  /** Fail the in-flight turn (process death). Retryable so the caller respawns. */
  onDeath(): void {
    const t = this.activeTurn
    if (t === undefined || t.settled) return
    t.settled = true
    t.diedMidTurn = true
    t.channel.push({ kind: 'error', message: 'persistent-repl: REPL process exited', retryable: true })
    t.channel.close()
    t.settle()
  }

  /** Acquire the per-session turn slot; returns a release fn. Serializes turns
   *  so the warm REPL never has two channel turns in flight at once. */
  async acquireTurn(): Promise<() => void> {
    let release: () => void = () => {}
    const prev = this.turnTail
    this.turnTail = new Promise<void>((res) => {
      release = res
    })
    await prev
    return release
  }
}

const pool = new Map<string, Promise<ReplSession>>()

/** Synchronous mirror of the warm child handle per pool key. The pool stores a
 *  `Promise<ReplSession>`, so a respawn cannot read the live child out of it
 *  synchronously to decide "is this an alive-but-wedged respawn?". This map lets
 *  `killChild` make that decision without awaiting (Argus r3 BLOCKER 1). Always
 *  overwritten by the newest spawn for the key; deleted on death/kill. */
const childByKey = new Map<string, PtyChild>()

/** Live disposable one-shot sessions that are NOT in `pool` (the ephemeral path).
 *  Tracked so `shutdownAllPersistentRepls` can terminate in-flight one-shots —
 *  the pool teardown loop only walks `pool`, so without this an ephemeral child
 *  mid-turn at shutdown would orphan (Argus r5 IMPORTANT). Added on spawn,
 *  removed on dispose. */
const ephemeralSessions = new Set<ReplSession>()

/** Per-key pending graceful-kill promise. Set by `killChild` when it SIGTERMs an
 *  alive-but-wedged child; awaited by `spawnResume` so the `--resume` replacement
 *  is not spawned until the old process has fully exited (one owner per session
 *  transcript). Cleared when consumed. */
const pendingChildKills = new Map<string, Promise<void>>()

/** Graceful child termination: SIGTERM, await exit up to `CHILD_KILL_GRACE_MS`,
 *  then SIGKILL if it overstays. Resolves once the child is gone (or the force
 *  deadline elapses). Safe on an already-dead child (resolves immediately). */
async function terminateChild(child: PtyChild): Promise<void> {
  if (child.hasExited()) return
  try {
    child.kill()
  } catch {
    /* already gone */
  }
  const exited = child.exited.then(() => true)
  const graced = Bun.sleep(CHILD_KILL_GRACE_MS).then(() => false)
  const cleanlyExited = await Promise.race([exited, graced]).catch(() => false)
  if (cleanlyExited || child.hasExited()) return
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  await Promise.race([child.exited, Bun.sleep(CHILD_KILL_GRACE_MS)]).catch(() => undefined)
}

/** Graceful termination by raw PID — the cross-restart orphan path where there is
 *  no `PtyChild` handle (the surviving process belongs to a prior gateway
 *  incarnation). SIGTERM, poll for exit up to `CHILD_KILL_GRACE_MS`, then SIGKILL
 *  and poll AGAIN for exit before resolving. Safe on an already-dead pid (returns
 *  immediately). Called ONLY after `adoptOrKillOrphan` has VERIFIED the pid is our
 *  `claude` for the session (ISSUES #105) — never on an unverified / recycled pid.
 *
 *  The post-SIGKILL poll is load-bearing for the one-process-per-transcript
 *  invariant (Codex P2): `spawnResume` AWAITS this promise before launching the
 *  `--resume` replacement, so if a stubborn orphan ignores SIGTERM through the
 *  grace window we must not resolve the instant SIGKILL is *sent* — SIGKILL reaps
 *  asynchronously, and resolving early would let the replacement briefly co-own the
 *  transcript with a not-yet-dead orphan. Mirror `terminateChild`: poll until the
 *  pid is gone (or a second grace window elapses — the SAFE bound; a pid that
 *  survives SIGKILL is unkillable by us, so blocking forever buys nothing).
 *
 *  `stillOurs` is re-checked IMMEDIATELY before SIGKILL (recycled-pid safety, Codex
 *  P2 round 2): the verified orphan can exit under SIGTERM and the OS can recycle
 *  its pid onto an UNRELATED process during the multi-second grace window, after
 *  which a blind SIGKILL would hit that innocent process. Re-reading the cmdline
 *  here collapses the grace-window TOCTOU to a synchronous one (the same residual
 *  window every signal has). Default `() => true` preserves behavior for callers
 *  that don't supply an identity predicate. */
async function terminatePidGracefully(
  pid: number,
  stillOurs: () => boolean = () => true,
): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return // already gone
  }
  if (await waitForPidExit(pid, CHILD_KILL_GRACE_MS)) return
  // The orphan outlasted the SIGTERM grace window. Before force-killing, confirm
  // the pid is STILL our claude — if it exited and the OS recycled the number, the
  // SIGKILL must NOT fire on the recycled process.
  if (!stillOurs()) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return // reaped between the poll and the signal
  }
  await waitForPidExit(pid, CHILD_KILL_GRACE_MS)
}

/** Poll `defaultIsPidAlive(pid)` until the pid is gone or `budgetMs` elapses.
 *  Returns true if it observed the pid exit within the budget, false on timeout.
 *  Pure liveness poll — issues no signals. */
async function waitForPidExit(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!defaultIsPidAlive(pid)) return true
    await Bun.sleep(50)
  }
  return !defaultIsPidAlive(pid)
}

/** Unlink a session's temp config files (`neutron-repl-*-mcp.json` +
 *  `*-settings.json`). Best-effort + idempotent (ENOENT ignored), so it is safe to
 *  call from both the dispose path and the child-exit handler. Without this, every
 *  ephemeral one-shot leaves two permanent files in `tmpdir()` (Argus r5). */
function unlinkSessionConfigs(session: ReplSession): void {
  for (const p of session.configPaths) {
    try {
      unlinkSync(p)
    } catch {
      /* already gone / never written */
    }
  }
}

function mergeEnv(overlay: Record<string, string | undefined> | undefined): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = { ...process.env }
  if (overlay !== undefined) {
    // ISSUES #49 — an `undefined` overlay value means "DELETE from the inherited
    // env", not "set to undefined". This is the credential-scrub contract: a
    // composer unsets the three Anthropic auth vars and sets exactly the selected
    // one, so a host-leaked `ANTHROPIC_API_KEY` can't survive into the child and
    // out-rank the pool credential (cross-credential billing leak). Now that the
    // persistent REPL is the sole substrate this delete MUST happen here (it was
    // formerly the retired per-turn path's env-merge responsibility).
    for (const [k, v] of Object.entries(overlay)) {
      if (v === undefined) delete base[k]
      else base[k] = v
    }
  }
  return base
}

/** Fingerprint the auth secret an env overlay carries (the one the composer
 *  scrubs to per ISSUES #49), so the warm-reuse credential-freshness guard can
 *  detect a per-dispatch OAuth token REFRESH under the SAME credential id. The
 *  pool key folds the STABLE `PooledCredential.id`, not the rotating token VALUE
 *  (#104), so without this a warm REPL keeps serving turns on an expired token
 *  after the access token rotates (Codex r2 P1). Hashed (never the plaintext
 *  secret) so no second copy of the token lives on the long-held session object.
 *  Returns `''` when no auth secret is present — the interactive-Max-login model
 *  authenticates via `claudeConfigDir`'s credentials.json + self-refresh, so
 *  there is no env token to fingerprint and the guard stays inert. */
function authFingerprintFor(env: Record<string, string | undefined> | undefined): string {
  if (env === undefined) return ''
  const secret = env['CLAUDE_CODE_OAUTH_TOKEN'] ?? env['ANTHROPIC_AUTH_TOKEN'] ?? env['ANTHROPIC_API_KEY']
  if (typeof secret !== 'string' || secret.length === 0) return ''
  return createHash('sha256').update(secret).digest('hex').slice(0, 16)
}

/** Health-probe deadline. A dev-channel wedged enough to ACCEPT the connection
 *  but never answer `/health` would otherwise hang this fetch forever — and since
 *  `runReplWatchdogTick` awaits the probe while holding its per-registry tick gate,
 *  one hung probe would stall ALL later ticks + respawn recovery, defeating the wedge
 *  detector in exactly the failure mode it exists to catch (Codex P2). The probe
 *  must finish well inside the watchdog cadence; a timeout reads as health-dead →
 *  the tick proceeds to respawn. */
const HEALTH_PROBE_TIMEOUT_MS = 2_000

export interface HttpHealthOptions {
  /** Expected dev-channel session id. When set, a `/health` whose `session_id`
   *  doesn't match is treated as NOT healthy — defends against a recorded port
   *  that the OS recycled to a DIFFERENT REPL while this session is wedged (the
   *  dev-channel echoes `session_id` for exactly this guard). When omitted, any
   *  `{ok:true}` passes (back-compat / identity-agnostic probe). */
  expectedSessionId?: string
  /** Probe deadline. */
  timeoutMs?: number
}

export async function httpHealth(port: number, opts: HttpHealthOptions = {}): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(opts.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS),
    })
    if (!resp.ok) return false
    const body = (await resp.json()) as { ok?: boolean; session_id?: string }
    if (body.ok !== true) return false
    // Port-recycle guard: a recycled port serving a DIFFERENT session reads as
    // wedged (→ respawn), never as this session being healthy.
    if (opts.expectedSessionId !== undefined && body.session_id !== opts.expectedSessionId) {
      return false
    }
    return true
  } catch {
    // Network error, non-2xx, malformed body, OR the probe deadline — all mean
    // "not provably healthy" → the wedge detector treats it as health-dead.
    return false
  }
}

async function spawnSession(
  sessionKey: string,
  options: PersistentReplSubstrateOptions,
  spec: AgentSpec,
  resume?: ResumeDirective,
): Promise<ReplSession> {
  sink.ensureStarted()
  const cwd = options.cwd ?? process.cwd()
  const model = spec.model_preference[0]
  if (model === undefined) {
    throw new Error('persistent-repl: model_preference is empty; at least one model required')
  }
  // Respawn-is-always-resume (brief § 0 / § 2): when a resume directive is
  // present (from the registry on a post-crash next-turn, or from the watchdog /
  // admin respawn actuation), re-attach the captured session UUID via `--resume`
  // instead of cold-spawning a fresh `--session-id`. This is the wiring that
  // closes the S1 context-loss gap.
  const sessionId = resume?.sessionId ?? (options.idGen ?? randomUUID)()
  const channelName = `neutron-${randomBytes(4).toString('hex')}`
  const ptyHost = options.ptyHost ?? bunTerminalHost
  const devChannelPath = options.devChannelPath ?? DEFAULT_DEV_CHANNEL_PATH
  const appendSystemPromptFile = options.appendSystemPromptFile ?? DEFAULT_AGENT_BASE_PROMPT

  // Per-session config files (mcp-config wires the dev-channel; settings wires
  // the enforce-reply Stop hook).
  const cfgBase = join(tmpdir(), `neutron-repl-${channelName}`)
  const mcpConfigPath = `${cfgBase}-mcp.json`
  const settingsPath = `${cfgBase}-settings.json`

  writeFileSync(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          [channelName]: {
            command: 'bun',
            args: [devChannelPath],
            env: {
              SINK_PORT: String(sink.port),
              SINK_TOKEN: sink.token,
              SESSION_ID: sessionId,
              CHANNEL_NAME: channelName,
            },
          },
        },
      },
      null,
      2,
    ),
  )
  buildSettings({ settingsPath })

  // SECURITY-CRITICAL (Codex-r1-P1): thread the spec's declared tool surface into
  // the REPL spawn so the persistent path honors `tools: []` exactly like the
  // retired per-turn path did. An empty surface → `--tools ""` (no built-in tools),
  // closing the prompt-injection vector for untrusted-content callers (history-
  // import) running under `--dangerously-skip-permissions`. The tool surface is a
  // SPAWN-time property of the REPL; the reuse guard below refuses to serve a turn
  // whose surface differs from the warm REPL's, so a less-privileged (e.g. import)
  // turn can never bleed onto a more-privileged warm session.
  const toolSurface = spec.tools.map((t) => t.name)
  const argv = buildReplArgv({
    ...(options.claude_bin !== undefined ? { claudeBin: options.claude_bin } : {}),
    sessionId,
    resume: resume !== undefined,
    channelName,
    mcpConfigPath,
    settingsPath,
    appendSystemPromptFile,
    model,
    addDir: cwd,
    tools: toolSurface,
    ...(options.skip_permissions !== undefined ? { skipPermissions: options.skip_permissions } : {}),
  })

  // Construct + register the session BEFORE spawning so a fast /channel-ready
  // POST from the dev-channel can never race ahead of the sink registration.
  const session = new ReplSession(sessionKey, sessionId, channelName)
  session.toolSurface = toolSurface.join(',')
  // Stash the temp config paths so teardown can unlink them (Argus r5 IMPORTANT —
  // ephemeral one-shots write a fresh pair per call; leaked otherwise).
  session.configPaths = [mcpConfigPath, settingsPath]
  // Stamp the auth fingerprint the child is being spawned with so the warm-reuse
  // freshness guard can evict on a same-credential-id token refresh (Codex r2 P1).
  session.authFingerprint = authFingerprintFor(options.env)
  sink.register(sessionId, session)

  // Pre-seed the first-run trust + bypass-permissions acceptance so the
  // interactive REPL doesn't wedge on a blocking Ink dialog before it loads
  // the dev-channel MCP server (the `no-channel-ready` failure class).
  const childEnv = mergeEnv(options.env)
  if (options.skipTrustSeed !== true) {
    const trustInput: Parameters<typeof ensureClaudeTrust>[0] = { cwd }
    if (options.claudeConfigDir !== undefined) trustInput.configDir = options.claudeConfigDir
    ensureClaudeTrust(trustInput)
  }
  if (options.claudeConfigDir !== undefined) {
    childEnv['CLAUDE_CONFIG_DIR'] = options.claudeConfigDir
  }

  // F3 output-scan tick: the `--dangerously-load-development-channels` flag
  // renders a first-run disclaimer ("…using this for local development?") that
  // has NO config seed (unlike trust + bypass) and BLOCKS MCP-server loading
  // until dismissed; its default-selected option IS the accept, so a single
  // Enter clears it. We GENERALIZE that one-off check into a registered detector
  // on the session's `OutputScanner` (F3) rather than a competing scan loop —
  // the P0/P1 recovery detectors register the same way in follow-on PRs. Without
  // this dismiss the spawn wedges `no-channel-ready` forever.
  session.scanner.register({
    id: 'dev-channel-disclaimer',
    bottomN: DISCLAIMER_BOTTOM_N,
    present: (ctx) => DEV_CHANNEL_DISCLAIMER_RE.test(ctx.normalized),
    keys: ['enter'],
  })
  // P0 wedged-interactive-prompt detect+recover (master-table row #1). An
  // `AskUserQuestion` / arrow-menu rendered mid-turn deadlocks the REPL with no
  // keystroke path from chat; rather than let the inactivity watchdog KILL the
  // agent, this detector (footer + live `^❯` cursor + 2-tick stability + the
  // framework's doc-quote guard) trips the bounded escape→escape→ctrl-c recovery
  // ladder in `runOutputScan` (it carries no `keys` — recovery is a verify
  // ladder, never an auto-pick).
  session.scanner.register(createWedgedPromptDetector())
  // P1: auto-approve CC's tool-use permission prompt. BOTH cues required
  // (question + `❯ 1. Yes` selector) — single-cue matching false-fires on
  // scrollback. `1`+`enter` selects "Yes". The framework stamps the latch +
  // 5s debounce BEFORE returning the fired detection, so this keystroke is
  // fire-once per rising edge — a transport failure can NOT retry and risk a
  // DOUBLE-Enter onto the approval (output-scan.ts invariant §4).
  //
  // KNOWN LIMITATION (substrate-level, not specific to this detector): the F1
  // ring is an append-only byte log, so a just-approved prompt's text lingers
  // in the bottom-N window until enough new output scrolls it out. If a second
  // prompt renders with < bottomN lines of intervening output the latch may
  // still be up, so it won't see a fresh rising edge until the prior signature
  // clears. We deliberately do NOT mitigate in-detector: a tighter positional
  // window would MISS live prompts (the `❯ 1. Yes` selector sits ABOVE its
  // 2./3. option lines — the widened-window Robobuddha lesson), and a timed
  // re-fire would inject a stray `1`+enter into a live session. The proper fix
  // is substrate-level (a rendered-screen ring or latch-clear-on-fresh-data);
  // the P0 wedge-recovery detector (#1) is the backstop for a genuinely-stuck
  // prompt. Flagged by Codex cross-model review; tracked for the broader port.
  session.scanner.register({
    id: 'tool-use-approve',
    debounceMs: 5000,
    present: (ctx) =>
      TOOL_USE_QUESTION_RE.test(ctx.normalized) && TOOL_USE_SELECTOR_RE.test(ctx.normalized),
    keys: ['1', 'enter'],
  })
  // P1: /rate-limit-options org-cap auto-stop (master-table row #4). When the
  // Claude org hits its monthly usage cap, CC injects an interactive picker that
  // blocks the REPL until an option is chosen. Ryan 2026-05-23 directive: "I need
  // you to handle when this pane appears. Just select stop and wait for limit to
  // reset." Option 3 = "Stop and wait for limit to reset", so `3`+`enter` selects
  // it (position-independent — pressing `3` highlights option 3 regardless of the
  // cursor's resting row).
  //
  // The positional bottom-30 guard (`RATE_LIMIT_OPTIONS_BOTTOM_N`) is LOAD-
  // BEARING and unique to this detector: pressing `3` STOPS CC, so NO new output
  // scrolls the picker text away afterward — it just sits in the ring until the
  // monthly cap resets. Without the bottom-N window the stale picker text would
  // satisfy `present` on every later tick and `select-stop` would re-inject
  // `3`+Enter into the dead input for days (Vajra PR #132 r1). Once CC has
  // stopped, idle whitespace / a shell prompt pushes the picker text up past the
  // bottom-30 threshold, which lets the detector correctly STOP firing. The
  // framework's bottom-N windowing (`buildDetectorContext`) provides this guard;
  // the latch + debounce-before-await make the `3`+enter fire-once per rising
  // edge (invariant §4) so a transport failure can't double-send.
  //
  // The Vajra "cheap viewport pre-check gates the recapture" lesson (Argus PR
  // #132 r3 BLOCKER — an unconditional `tmux capture-pane -S -100` was ~120 extra
  // captures/min) is architecturally obviated here: Neutron's ring is an
  // in-memory byte log, so the bottom-N read (`bottomNLines`) is already the
  // cheap viewport check — there is no separate scrollback recapture to gate.
  session.scanner.register({
    id: 'rate-limit-options-stop',
    bottomN: RATE_LIMIT_OPTIONS_BOTTOM_N,
    debounceMs: RATE_LIMIT_OPTIONS_DEBOUNCE_MS,
    present: (ctx) =>
      RATE_LIMIT_OPTIONS_RE.test(ctx.normalized) && RATE_LIMIT_STOP_RE.test(ctx.normalized),
    keys: ['3', 'enter'],
  })
  // The spawn `const child` isn't assigned when the `onData` closure is defined,
  // so route fired-detector keystrokes through this mirror (set right after
  // spawn, before any onData can fire on the event loop).
  let scanChild: PtyChild | undefined

  const child = ptyHost.spawn(argv, {
    cwd,
    env: childEnv,
    onData: (chunk) => {
      session.ring.append(Buffer.from(chunk).toString('utf8'))
      const now = Date.now()
      session.lastDataAt = now
      const target = scanChild
      if (target === undefined) return
      // Run the registered detectors against the ring and actuate the ones that
      // fired on the rising edge (disclaimer Enter, wedged-prompt recovery, …).
      // `scan` stamps each detector's latch BEFORE returning, so the keystroke
      // write is fire-once even if the transport throws — a failed write can't
      // retry next tick and double-send onto an approval prompt (invariant §4).
      runOutputScan(session, target, options, now)
    },
  })
  scanChild = child
  session.attachChild(child)
  // Synchronous handle mirror so a respawn can detect alive-but-wedged without
  // awaiting the pool promise (Argus r3 BLOCKER 1). Newest spawn wins the key.
  childByKey.set(sessionKey, child)

  // Wire process death → fail in-flight turn + evict from pool so the next
  // start() respawns. Leaves cleanup to GC; the dev-channel SIGTERMs itself.
  // IDENTITY-GUARDED: a respawn re-attaches the SAME sessionId/sessionKey, so a
  // dying OLD child must not evict the NEW session a concurrent respawn already
  // installed (the resume race the P2-3 regression caught).
  void child.exited.then(async () => {
    session.onDeath()
    sink.unregisterIf(sessionId, session)
    // Reclaim the temp config files now the child is gone (covers pool eviction,
    // crash, and shutdown — the ephemeral dispose path unlinks eagerly too).
    unlinkSessionConfigs(session)
    // Drop the synchronous handle mirror only if it still points at THIS child —
    // a concurrent respawn may have already installed a fresh one for the key.
    if (childByKey.get(sessionKey) === child) childByKey.delete(sessionKey)
    const pooled = pool.get(sessionKey)
    if (pooled !== undefined) {
      try {
        if ((await pooled) === session) pool.delete(sessionKey)
      } catch {
        pool.delete(sessionKey)
      }
    }
  })

  // Post-spawn assertion: child alive → dev-channel handshake → HTTP /health.
  const assertion = await assertReplAlive(
    { pid: child.pid },
    {
      isChildAlive: () => !child.hasExited(),
      getChannelPort: () => session.channelPort,
      hasHttpHealth: (port) => httpHealth(port),
      sleep: (ms) => Bun.sleep(ms),
      now: () => Date.now(),
    },
    options.assertConfig ?? {},
  )
  if (!assertion.ok) {
    child.kill()
    if (childByKey.get(sessionKey) === child) childByKey.delete(sessionKey)
    sink.unregister(sessionId)
    pool.delete(sessionKey)
    throw new Error(`persistent-repl: spawn failed (${assertion.reason}; ${assertion.detail ?? ''})`)
  }

  // Sprint-2 supervision: persist a registry record so this session is
  // recoverable across crash / gateway-restart. has_session starts true on a
  // resume (we already know the JSONL exists) and false on a fresh spawn (the
  // capture gate below flips it once the JSONL lands).
  if (options.replRegistryPath !== undefined) {
    const record: ReplRegistryRecord = {
      sessionKey,
      sessionId,
      cwd,
      channelName,
      has_session: resume !== undefined,
      model,
      pid: child.pid,
      first_ready_at: Date.now(),
    }
    if (session.channelPort !== undefined) record.devchannel_port = session.channelPort
    try {
      // Merge onto any prior row BUT clear the transient `respawn_in_flight_at`
      // stamp: this spawn just COMPLETED the in-flight respawn, so a stale stamp
      // must not survive to block the next tick's recovery (Codex P2-3).
      withRegistry(options.replRegistryPath, (registry) => {
        const prev = registry[sessionKey]
        const { respawn_in_flight_at: _drop, ...merged } = prev ? { ...prev, ...record } : record
        registry[sessionKey] = merged
        return { registry, result: undefined }
      })
    } catch {
      // A registry write failure must never brick a live REPL; supervision
      // degrades to "no auto-resume for this session" until the next write.
    }
  }

  // Ghost-session gate (best-effort, non-blocking): confirm the JSONL lands so
  // a Sprint-2 respawn can `--resume` safely. We do NOT block the first turn on
  // it — the warm REPL is already serving. CONSUME the result (closing the S1
  // fire-and-forget gap, brief § 0): on a fresh spawn, flip the registry
  // record's `has_session` true once the transcript exists, so a future
  // respawn / next-turn-after-crash resolves to `--resume` instead of fresh.
  const jsonlProbe = options.jsonlExistsProbe ?? makeJsonlExistsProbe(options.projectsDir)
  void captureSession(
    sessionId,
    cwd,
    { jsonlExists: jsonlProbe, sleep: (ms) => Bun.sleep(ms) },
    options.captureConfig ?? {},
  )
    .then((result) => {
      if (result.captured && resume === undefined && options.replRegistryPath !== undefined) {
        try {
          patchRecord(options.replRegistryPath, sessionKey, { has_session: true })
        } catch {
          /* best-effort */
        }
      }
    })
    .catch(() => undefined)

  return session
}

/**
 * Resolve whether a (re)spawn for `sessionKey` should `--resume` a captured
 * session. Reads the persisted registry and routes the record through the
 * (previously-DORMANT) `resolveRespawnStrategy` — the respawn-is-always-resume
 * core. Returns a directive only when the strategy resolves to a resumable
 * `session-id`; otherwise undefined (cold/fresh spawn). Supervision-off
 * (`replRegistryPath` unset) always returns undefined → exact S1 behavior.
 */
function resolveResumeDirective(
  sessionKey: string,
  options: PersistentReplSubstrateOptions,
): ResumeDirective | undefined {
  if (options.replRegistryPath === undefined) return undefined
  const record = getRecord(options.replRegistryPath, sessionKey)
  if (record === undefined) return undefined
  const resolutionInput: { session_id?: string; has_session: boolean } = {
    has_session: record.has_session,
  }
  if (record.has_session && record.sessionId) resolutionInput.session_id = record.sessionId
  const resolution = resolveRespawnStrategy(resolutionInput)
  if (resolution.strategy === 'session-id' && resolution.sessionId) {
    return { sessionId: resolution.sessionId }
  }
  return undefined
}

async function getOrSpawnSession(
  sessionKey: string,
  options: PersistentReplSubstrateOptions,
  spec: AgentSpec,
  forceResume?: ResumeDirective,
): Promise<ReplSession> {
  const requestedToolSurface = spec.tools.map((t) => t.name).join(',')
  const existing = pool.get(sessionKey)
  if (existing !== undefined) {
    const session = await existing
    if (!session.hasChildExited()) {
      // Two reuse guards gate serving a turn on the warm child; BOTH must pass or
      // the child is evicted + respawned (resuming the captured session when
      // supervised, so conversational context survives the respawn):
      //
      //   1. SECURITY-CRITICAL (Codex-r1-P1) tool-surface guard: a warm REPL is
      //      locked to the tool surface it was SPAWNED with. A turn requesting a
      //      DIFFERENT surface must not reuse it, so a less-privileged turn (e.g. an
      //      import `tools:[]`) can never inherit a more-privileged warm session's
      //      tools. In practice the trust boundary aligns with `substrate_instance_id`
      //      (in the key), so this rarely fires; it's defense-in-depth that makes the
      //      tool restriction local, not dependent on keying.
      //
      //   2. CREDENTIAL-FRESHNESS guard (Codex-r2-P1): the pool key folds the STABLE
      //      `PooledCredential.id`, NOT the rotating OAuth token VALUE. The composer
      //      refreshes `CLAUDE_CODE_OAUTH_TOKEN` per dispatch, but warm reuse can't
      //      re-apply env to a running child — so after the access token rotates, a
      //      warm REPL would keep serving turns on the EXPIRED token until it died,
      //      breaking Max-OAuth instances exactly when S3 makes the persistent REPL the
      //      sole default. Re-checking the live token fingerprint on EVERY dispatch
      //      means a rotated token evicts + respawns BEFORE the next turn runs, while
      //      an UNCHANGED token (the refresh returned the still-valid cached value)
      //      reuses the warm child, so we don't churn the REPL on every dispatch.
      //      This is the PRIMARY (in prod, SOLE) stale-token defense — the
      //      `claudeConfigDir` self-refresh model below is dormant plumbing with no
      //      live caller, so when it IS threaded both fingerprints are empty and
      //      this guard simply never fires (it does not REPLACE the guard).
      //
      //      Argus r3 IMPORTANT (2026-06-08) — residual window, accurately scoped:
      //      this check runs in `getOrSpawnSession`, BEFORE the caller's
      //      `acquireTurn()` mutex wait + inject. The COMMON case (token already
      //      rotated at dispatch time) is eliminated here. But a token that EXPIRES
      //      during this turn's own mutex-wait/inject — or, fundamentally, at any
      //      instant after the check, since warm reuse can't re-apply env to the
      //      running child — can still be served ONCE on the stale token. No
      //      synchronous re-check (even one re-run after `acquireTurn`) fully closes
      //      that: expiry-in-flight is inherent to a long-lived child holding a
      //      time-bounded token. The real, complete defense is the failure path: the
      //      stale turn surfaces as at most a SINGLE retryable 401, and the
      //      immediately-following dispatch refreshes the env token → this same
      //      freshness guard then evicts + respawns (resuming the captured session,
      //      so conversational context survives). Self-healing within one turn; NOT
      //      a "there is no window" guarantee.
      const freshSurface = session.toolSurface === requestedToolSurface
      const freshCredential = session.authFingerprint === authFingerprintFor(options.env)
      // ABANDON-POISON guard (2026-06-18 warm-session hang fix): a session whose
      // prior turn was abandoned (caller timeout / substrate turn-timeout) is left
      // with a RUNAWAY turn still executing on the warm child + a desynced
      // dev-channel correlation. Reusing it lands the next turn's inject on a busy
      // REPL whose stale-reply debt strips the next reply's turn_id → the turn
      // never delivers (the cascade). Evict + respawn a clean REPL instead, exactly
      // like the freshness guards below. NOT silent — log so the eviction is
      // observable in prod.
      if (freshSurface && freshCredential && !session.poisoned) return session
      if (session.poisoned) {
        process.stderr.write(
          `[repl] evicting abandon-poisoned warm session=${session.sessionId.slice(0, 8)} key-respawn (prior turn abandoned before reply; clean respawn for the next turn)\n`,
        )
      }
      // Evict, then AWAIT the old child's exit before falling through to spawn so a
      // supervised `--resume` replacement (same sessionId) never co-owns the session
      // transcript with the dying child (the Argus-r3 one-owner invariant). The
      // credential-freshness path fires on every token rotation (regularly), unlike
      // the rarely-firing tool-surface mismatch, so honoring the await here matters.
      pool.delete(sessionKey)
      if (childByKey.get(sessionKey) === session.child) childByKey.delete(sessionKey)
      await terminateChild(session.child)
    } else {
      pool.delete(sessionKey)
    }
  }
  const resume = forceResume ?? resolveResumeDirective(sessionKey, options)
  const spawning = spawnSession(sessionKey, options, spec, resume)
  pool.set(sessionKey, spawning)
  spawning.catch(() => {
    pool.delete(sessionKey)
    // An async spawn failure (assertion / health) on a RESUME must clear the
    // in-flight stamp so the watchdog retries on the next tick instead of seeing
    // a latched "respawn in progress" that never completes (Codex P2-4).
    if (resume !== undefined && options.replRegistryPath !== undefined) {
      clearRespawnInFlight(options.replRegistryPath, sessionKey)
    }
  })
  return spawning
}

/** Resolve once the REPL's PTY has been quiet for `quietMs` (claude is idle and
 *  ready for the next channel turn), or after `maxMs` as a defensive cap. */
async function waitForReplIdle(session: ReplSession, quietMs: number, maxMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (Date.now() - session.lastDataAt >= quietMs) return
    await Bun.sleep(100)
  }
}

async function injectMessage(channelPort: number, text: string, turnId: string): Promise<void> {
  const resp = await fetch(`http://127.0.0.1:${channelPort}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sink-Token': sink.token },
    // `turn_id` round-trips through the dev-channel onto the matching reply so
    // `onReply` can correlate the completion to this exact turn (Argus r5 fix).
    body: JSON.stringify({ text, turn_id: turnId }),
  })
  if (!resp.ok) {
    throw new Error(`persistent-repl: inject failed (${resp.status})`)
  }
}

// ---------------------------------------------------------------------------
// Pending-respawns queue wiring (brief § 2 row #11 / § 6 acceptance #1).
// Disk-is-source-of-truth deferred-respawn replay: a turn dropped when its REPL
// died mid-turn is enqueued, then replayed after the session resumes — in-
// process via the watchdog tick's drain, or across a gateway restart via the
// boot-drain. The replay re-injects the dropped inbound through the SAME
// dev-channel `POST /message` path a normal turn uses ("replay sink").
// ---------------------------------------------------------------------------

/** Record a mid-turn-dropped inbound for replay-after-resume. No-op when the
 *  pending-respawns queue is not configured (supervision off). Best-effort: a
 *  queue write failure degrades to "no replay for this inbound", never bricks
 *  the live path. */
function enqueueDroppedInbound(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  session: ReplSession,
  droppedInbound: string,
  turnId: string,
): void {
  const path = options.pendingRespawnsPath
  if (path === undefined) return
  const entry: PendingRespawnEntry = {
    sessionKey,
    sessionId: session.sessionId,
    cwd: options.cwd ?? process.cwd(),
    substrate_instance_id: options.substrate_instance_id,
    droppedInbound,
  }
  if (session.channelPort !== undefined) entry.devchannel_port = session.channelPort
  // S3 #106: record the redelivery routing so the replay path can re-deliver the
  // recovered reply to the user on reconnect (deduped on `turn_id`). `topic_id`
  // is persisted explicitly so the boot-drain (pre-registration) can route it.
  if (options.delivery_topic_id !== undefined) entry.topic_id = options.delivery_topic_id
  if (options.instance_slug !== undefined) entry.instance_slug = options.instance_slug
  entry.turn_id = turnId
  try {
    enqueuePendingRespawn(path, entry)
  } catch {
    /* best-effort */
  }
}

/** Replay ONE queued dropped inbound through the OWNING substrate's registered
 *  options (`ownerOptions`, resolved by the caller from `supervisedBySessionKey`).
 *  Drives a full turn so `getOrSpawnSession` `--resume`s the captured session and
 *  the driver re-injects the dropped inbound via the dev-channel `POST /message`.
 *  Returns true once the replay turn completes. A turn with no actual inbound
 *  (empty `droppedInbound`) is a no-op.
 *
 *  Routing correctness (Codex P2): the pending queue is SHARED by every substrate
 *  under one instance registry (`cc-llm-*`, `cc-llm-router-*`, `cc-import-*` all
 *  write `<owner_home>/.neutron/.pending-respawns.json`). Replaying through the
 *  drain's own options would resume the WRONG substrate's session and with the
 *  wrong env. The caller resolves the owner by `entry.sessionKey`, so the
 *  computed pool key === `entry.sessionKey` and env/identity are exactly the
 *  owning substrate's; unregistered entries are retained for a later drain rather
 *  than replayed with a fallback (see `drainPendingRespawns`).
 *
 *  S3 REDELIVERY (#106 — closes the prior S2 limitation): this re-drives the
 *  resumed REPL so it PROCESSES the dropped inbound AND now CAPTURES the recovered
 *  assistant reply (the completion's preceding `token` text). When the owning
 *  substrate threaded an `onRecoveredReply` sink + the entry carries a routing
 *  handle (`topic_id` + `turn_id`), the recovered reply is handed to that sink —
 *  which delivers it to the user's reconnect channel now (if online) or persists
 *  it as an undelivered row the existing reconnect re-emit path flushes (deduped
 *  on `turn_id`). The substrate is a runtime-layer module and never imports the
 *  gateway delivery layer; the sink is the injected seam. */
async function replayPendingInbound(
  ownerOptions: PersistentReplSubstrateOptions,
  entry: PendingRespawnEntry,
): Promise<boolean> {
  if (entry.droppedInbound === undefined || entry.droppedInbound === '') return false
  const record =
    ownerOptions.replRegistryPath !== undefined
      ? getRecord(ownerOptions.replRegistryPath, entry.sessionKey)
      : undefined
  const replaySpec: AgentSpec = {
    prompt: entry.droppedInbound,
    tools: [],
    model_preference: [record?.model ?? 'claude-opus-4-7'],
  }
  const handle = createPersistentReplSubstrate(ownerOptions).start(replaySpec)
  let recoveredText = ''
  try {
    for await (const ev of handle.events) {
      if (ev.kind === 'token') {
        recoveredText += ev.text
        continue
      }
      if (ev.kind === 'completion') {
        await deliverRecoveredReply(ownerOptions, entry, recoveredText)
        return true
      }
      if (ev.kind === 'error') return false
    }
  } catch {
    return false
  }
  return false
}

/** Hand a recovered reply to the gateway's injected redelivery sink (#106). The
 *  routing handle (`topic_id` + `turn_id`) is required — without it the recovered
 *  reply can't be addressed to a user channel, so it is dropped (the turn's
 *  conversation state already advanced in the resumed transcript). Best-effort:
 *  a sink throw never bricks the drain. */
async function deliverRecoveredReply(
  ownerOptions: PersistentReplSubstrateOptions,
  entry: PendingRespawnEntry,
  text: string,
): Promise<void> {
  const sink = ownerOptions.onRecoveredReply
  if (sink === undefined) return
  if (entry.topic_id === undefined || entry.turn_id === undefined) return
  const reply: RecoveredReply = {
    topic_id: entry.topic_id,
    turn_id: entry.turn_id,
    text,
  }
  if (entry.instance_slug !== undefined) reply.instance_slug = entry.instance_slug
  try {
    await sink(reply)
  } catch (err) {
    process.stderr.write(
      `[repl-redelivery] sink failed for topic=${entry.topic_id} turn=${entry.turn_id}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
  }
}

export interface DrainPendingRespawnsOptions {
  /** Stagger base (ms) between entry replays — `planZombieRespawns(entries,
   *  baseDelayMs)`. Default 500 (boot-drain anti-thundering-herd). The per-tick
   *  drain passes 0. Tests pass 0. */
  baseDelayMs?: number
  /** DI sleep (tests pass a no-op). Default `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Drain the pending-respawns queue, replaying each entry's dropped inbound after
 * its session resumes. Used at gateway boot (replay anything a prior crash left
 * queued) AND on every watchdog tick (replay an inbound dropped since the last
 * tick, once the crash-respawn has resumed the session). No-op when the queue is
 * unconfigured/absent. Single-shot per REPLAYED entry: the entry is removed from
 * disk BEFORE its replay so a replay that itself crashes can't infinite-loop the
 * recovery (Nova "single-shot per restart" semantic). A corrupt queue file is
 * dropped, never replayed.
 *
 * An entry whose owning substrate is NOT registered in `supervisedBySessionKey`
 * (e.g. a cross-restart boot-drain before that substrate's first turn) is SKIPPED
 * and RETAINED on disk — never replayed with another substrate's env/identity
 * (Codex P2). It is picked up by a later drain once its owner re-registers (its
 * first post-restart turn), or covered by respawn-is-always-resume on that turn.
 */
export async function drainPendingRespawns(
  options: PersistentReplSubstrateOptions,
  dopts: DrainPendingRespawnsOptions = {},
): Promise<Array<{ sessionKey: string; replayed: boolean; skipped?: string }>> {
  const path = options.pendingRespawnsPath
  if (path === undefined) return []
  const loaded = loadPendingRespawns(path)
  if (loaded.kind === 'corrupt') {
    clearPendingRespawns(path)
    return []
  }
  if (loaded.kind === 'absent' || loaded.entries.length === 0) return []
  const sleep = dopts.sleep ?? ((ms: number) => Bun.sleep(ms))
  const plan = planZombieRespawns(loaded.entries, dopts.baseDelayMs ?? 500)
  const results: Array<{ sessionKey: string; replayed: boolean; skipped?: string }> = []
  for (const { entry, delayMs } of plan) {
    // Resolve the OWNING substrate's options by the entry's pool key. Unregistered
    // → retain on disk (don't replay with the wrong env) and report the skip.
    const owner = supervisedBySessionKey.get(entry.sessionKey)
    if (owner === undefined) {
      results.push({ sessionKey: entry.sessionKey, replayed: false, skipped: 'unregistered' })
      continue
    }
    if (delayMs > 0) await sleep(delayMs)
    // Single-shot claim. Two drains can overlap (a staggered boot-drain still
    // sleeping while the watchdog tick fires), both planning from the same
    // initial snapshot. Re-read the queue and resolve THIS key's CURRENT entry:
    //   - absent  → a concurrent drain already replayed+removed it; skip, because
    //     replaying our stale snapshot copy would process the dropped inbound
    //     twice (round-6 Codex P2).
    //   - present → replay the CURRENT entry, NOT the planned snapshot. A same-key
    //     replacement (entry B carrying a NEWER dropped inbound) may have been
    //     upserted during the stagger sleep by a second crash on the same REPL;
    //     `enqueuePendingRespawn` removes the old A and pushes B under the one key.
    //     Replaying the snapshot A here would (a) replay A's now-superseded inbound
    //     and (b) `removeEntryBySessionKey` would delete B — silently losing B's
    //     newer inbound. Replaying the current entry instead means B survives, and
    //     the dropped-twice guard above still holds (Codex GPT-5 r4 BLOCKER).
    const current = loadPendingRespawns(path)
    const currentEntries = current.kind === 'loaded' ? current.entries : []
    const currentEntry = currentEntries.find((e) => e.sessionKey === entry.sessionKey)
    if (currentEntry === undefined) {
      results.push({ sessionKey: entry.sessionKey, replayed: false, skipped: 'already-drained' })
      continue
    }
    savePendingRespawns(path, removeEntryBySessionKey(currentEntries, entry.sessionKey))
    let replayed = false
    try {
      replayed = await replayPendingInbound(owner, currentEntry)
    } catch {
      replayed = false
    }
    results.push({ sessionKey: entry.sessionKey, replayed })
  }
  return results
}

/** The module-level warm-pool key for a substrate's options. The SINGLE
 *  definition of the key shape — used by the substrate itself, the supervised-
 *  options registry, and the pending-respawns drain, so none can drift. Every
 *  consumer keys on the VALUE this returns (never on a hand-built literal), so
 *  the S3 re-namespace is a change to this function's composition only, not a
 *  rewrite of any consumer (lift-not-rewrite, brief §2 / §8 #2).
 *
 *  S3 re-namespace (closes #104, makes the substrate instance-isolation-SAFE — the
 *  precondition for the persistent REPL becoming the sole substrate, now done):
 *  the conversational session identity is
 *  `(substrate_instance_id, user_id, project_id, credential_identity)`.
 *    - `substrate_instance_id` is `cc-{role}-{instance}` (OSS-split C4-a § 2.3;
 *      the `{instance}` segment is the per-instance handle value, so no
 *      legacy ownership token is emitted in the label) — it ALREADY encodes the
 *      instance boundary AND the substrate role, so the router (`cc-llm-router-*`),
 *      import (`cc-import-*`) and email (`cc-email-*`) substrates never collapse
 *      into the conversational REPL (the §2 "router exception"), and two instances
 *      never share a REPL. Keeping it IS the role+instance discriminator the brief
 *      calls for.
 *    - `user_id` + `project_id` split what used to collapse: every non-router
 *      LLM turn for one instance shared ONE REPL regardless of user/project; now a
 *      distinct (user, project) gets a distinct REPL.
 *    - `credential_identity` (the `PooledCredential.id`, NEVER the secret) folds
 *      the selected credential in (#104): a rotation re-keys to a fresh REPL
 *      under the new env, so the child serving a turn always matches the
 *      credential cooldown is attributed to.
 *    - `cwd` is DERIVED, not keyed: two turns for the same identity land on the
 *      same REPL even if a caller computed `cwd` differently.
 *
 *  Back-compat: when NONE of the conversational identity fields are threaded
 *  (legacy / platform-internal / test callers that pass only
 *  `substrate_instance_id` + `cwd`), fall back to the S1/S2 key shape so the
 *  supervision suite + S1 fixtures compose unchanged (they key on whatever this
 *  returns). Production always threads `credential_identity`, so the new shape
 *  is always taken on the live path. */
export function poolKeyFor(options: PersistentReplSubstrateOptions): string {
  if (
    options.user_id !== undefined ||
    options.project_id !== undefined ||
    options.credential_identity !== undefined
  ) {
    return [
      options.substrate_instance_id,
      options.user_id ?? '_platform',
      options.project_id ?? 'default',
      options.credential_identity ?? '_nocred',
    ].join(SESSION_KEY_SEP)
  }
  return `${options.substrate_instance_id}${SESSION_KEY_SEP}${options.cwd ?? process.cwd()}`
}

/**
 * Spawn a FRESH, never-pooled, disposable REPL for one stateless one-shot turn
 * (Argus r4 BLOCKER). The key is `poolKeyFor(options)` suffixed with a unique
 * nonce so it can NEVER collide with the warm pool or another ephemeral session
 * in `childByKey` / a death handler — and it is deliberately NOT inserted into
 * `pool`, so nothing can reuse it. Supervision is stripped (`replRegistryPath` /
 * `pendingRespawnsPath` deleted): a one-turn disposable session must never be
 * registered for watchdog respawn, `--resume`, or pending-replay. The caller
 * (`start`'s driver) terminates it via `disposeEphemeralSession` after the turn.
 *
 * Exported for the #112 invariant test; not part of the substrate's public API.
 */
export async function spawnEphemeralSession(
  options: PersistentReplSubstrateOptions,
  spec: AgentSpec,
): Promise<ReplSession> {
  // Defensive invariant (#112): the disposable one-shot path is reached ONLY
  // when `spec.session === undefined`. The `ephemeral` gate in `start()` ANDs
  // `options.ephemeral === true` with `spec.session === undefined`, so a
  // session-ful dispatch always pools (and may `--resume`) instead of landing
  // here. An ephemeral REPL must therefore never carry a resumable session id:
  // if one ever did, a future edit would have wired a session dimension into the
  // disposable path and this turn would `--resume` and replay a transcript a
  // one-shot must never share. Fail fast on the impossible input rather than
  // silently leak a shared transcript. No behaviour change today (unreachable).
  if (spec.session !== undefined) {
    throw new Error(
      'persistent-repl invariant violation (#112): ephemeral disposable session ' +
        `reached with a resumable spec.session.id (${spec.session.id}); one-shot ` +
        'REPLs are session-less by construction (see the start() ephemeral gate)',
    )
  }
  const ephemeralKey = `${poolKeyFor(options)}${SESSION_KEY_SEP}ephemeral${SESSION_KEY_SEP}${randomUUID()}`
  const ephemeralOptions: PersistentReplSubstrateOptions = { ...options }
  delete ephemeralOptions.replRegistryPath
  delete ephemeralOptions.pendingRespawnsPath
  const session = await spawnSession(ephemeralKey, ephemeralOptions, spec)
  // Track for shutdown teardown — ephemeral sessions are never pooled, so the
  // pool-walk in `shutdownAllPersistentRepls` would otherwise miss them.
  ephemeralSessions.add(session)
  return session
}

/**
 * Tear down a disposable one-shot REPL after its single turn settled. Terminating
 * the child is the whole point — the disposable REPL must never linger warm, so no
 * later one-shot purpose can reuse its transcript and no transcript can grow
 * unbounded. `terminateChild` is safe on an already-dead child; the spawn's own
 * exit handler clears the `childByKey` mirror once it exits, and we drop the sink
 * registration explicitly so a never-firing exit can't leak it.
 */
async function disposeEphemeralSession(session: ReplSession): Promise<void> {
  ephemeralSessions.delete(session)
  try {
    if (!session.hasChildExited()) await terminateChild(session.child)
  } catch {
    /* already gone */
  }
  sink.unregister(session.sessionId)
  // Eager unlink so the temp configs are gone by the time dispose resolves (the
  // child-exit handler also unlinks, but that fires on its own microtask chain).
  unlinkSessionConfigs(session)
}

/**
 * Construct a persistent-REPL substrate. The session pool is module-level, so
 * per-turn `createPersistentReplSubstrate(opts).start(spec)` calls reuse the
 * same warm REPL keyed by `poolKeyFor(opts)` — S3: `(substrate_instance_id,
 * user_id, project_id, credential_identity)`.
 *
 * EXCEPTION (Argus r4 BLOCKER): when `opts.ephemeral` is set AND a dispatch
 * carries no `spec.session`, that turn runs on a fresh disposable REPL that is
 * terminated after the turn (see `spawnEphemeralSession`) — stateless one-shot
 * purposes never share a transcript. A session-ful dispatch always pools.
 */
export function createPersistentReplSubstrate(options: PersistentReplSubstrateOptions): Substrate {
  const cwd = options.cwd ?? process.cwd()
  const sessionKey = poolKeyFor(options)
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  const idleQuietMs = options.idleQuietMs ?? DEFAULT_IDLE_QUIET_MS
  const idleMaxMs = options.idleMaxMs ?? DEFAULT_IDLE_MAX_MS
  const keepaliveMs = options.livenessKeepaliveMs ?? REPL_LIVENESS_KEEPALIVE_MS

  return {
    start(spec: AgentSpec): SessionHandle {
      const channel = new EventChannel()
      let cancelled = false
      let release: (() => void) | undefined
      let session: ReplSession | undefined
      // Argus r4 BLOCKER: a session-less dispatch on an ephemeral substrate runs
      // on a fresh disposable REPL (terminated after the turn), so stateless
      // one-shot purposes never collapse into one shared transcript. A dispatch
      // carrying a real `spec.session` (a multi-turn resume) always pools.
      const ephemeral = options.ephemeral === true && spec.session === undefined

      const driver = (async (): Promise<void> => {
       try {
        try {
          session = ephemeral
            ? await spawnEphemeralSession(options, spec)
            : await getOrSpawnSession(sessionKey, options, spec)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          channel.push({ kind: 'error', message, retryable: true })
          channel.close()
          return
        }
        release = await session.acquireTurn()
        if (cancelled) {
          channel.close()
          if (release) release()
          return
        }
        await session.ready

        // PER-TURN CONTEXT RESET (import warm-session). Before serving a turn on
        // a warm REPL that has ALREADY served one this incarnation, wipe the
        // prior turn's transcript with a `/clear` slash command written straight
        // to the PTY, so each chunk analysis runs on a fresh, bounded context —
        // ONE warm process, isolated per-turn context. Skipped on the ephemeral
        // path (each ephemeral turn is already a fresh REPL) and on the first
        // turn of a fresh/resumed spawn (`turnSeq === 0` ⇒ context already empty).
        // `/clear` produces no correlated reply, so it is NOT an ActiveTurn — it
        // is a fire-then-wait-for-idle interstitial. Concurrency-1 on the import
        // runner guarantees no live turn races this clear on the same REPL.
        if (
          options.reset_context_per_turn === true &&
          !ephemeral &&
          session.turnsServedThisIncarnation() > 0 &&
          !session.hasChildExited()
        ) {
          try {
            await waitForReplIdle(session, idleQuietMs, idleMaxMs)
            session.child.write(`${CONTEXT_RESET_COMMAND}\r`)
            // Force a beat so `waitForReplIdle` can't short-circuit before the
            // TUI starts reacting to the `/clear`, then wait for it to settle so
            // the subsequent inject lands on a cleared, idle REPL.
            await Bun.sleep(idleQuietMs)
            await waitForReplIdle(session, idleQuietMs, idleMaxMs)
          } catch (err) {
            // A clear failure must not strand the import: log + proceed. Worst
            // case the turn runs with the prior chunk still in context (the
            // pre-sprint warm-reuse behaviour), which the runner tolerates.
            process.stderr.write(
              `[repl] context-reset /clear failed on session=${session.sessionId.slice(0, 8)}: ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            )
          }
          if (cancelled) {
            channel.close()
            session.activeTurn = undefined
            if (release) release()
            return
          }
        }

        const turn: ActiveTurn = {
          channel,
          settled: false,
          settle: () => {},
          substrateInstanceId: options.substrate_instance_id,
          sessionId: session.sessionId,
          turnId: session.nextTurnId(),
        }
        const settledP = new Promise<void>((res) => {
          turn.settle = res
        })
        session.activeTurn = turn

        if (session.channelPort === undefined) {
          turn.settled = true
          channel.push({ kind: 'error', message: 'persistent-repl: channel not ready', retryable: true })
          channel.close()
          session.activeTurn = undefined
          if (release) release()
          return
        }

        // Gate the inject on the REPL being idle: injecting a channel
        // notification while claude is still booting or finishing the prior
        // turn drops the notification (the back-to-back-turn race). Wait for
        // the PTY to go quiet first.
        await waitForReplIdle(session, idleQuietMs, idleMaxMs)
        if (cancelled) {
          if (!turn.settled) {
            turn.settled = true
            channel.close()
          }
          session.activeTurn = undefined
          if (release) release()
          return
        }

        // Inject the turn, then surface a status so the typing indicator lights.
        try {
          // Commit this turn's prompt to the REPL: from here on a `/reply` on
          // this session belongs to THIS turn. `turn.turnId` (`<incarnation>:<seq>`)
          // is injected with the prompt and echoed back on the reply so `onReply`
          // correlates it to exactly this turn — rejecting a delayed straggler
          // from a timed-out/cancelled prior turn (different seq) or a prior
          // incarnation of this resumed session (different nonce), in both the
          // pre-inject-park and inject-in-flight windows (see ActiveTurn.turnId).
          await injectMessage(session.channelPort, spec.prompt, turn.turnId)
          channel.push({ kind: 'status', message: 'working' })
        } catch (err) {
          // (keepalive is started AFTER this try succeeds — see below)
          if (!turn.settled) {
            turn.settled = true
            const message = err instanceof Error ? err.message : String(err)
            channel.push({ kind: 'error', message, retryable: true })
            channel.close()
          }
          // Enqueue-on-crash for the CRASH-DURING-INJECTION case (Codex P2): if the
          // REPL died while the inbound was being injected, this catch returns
          // BEFORE the `await settledP` enqueue block below — so without this the
          // dropped inbound would be lost (only a retryable error, no replay). The
          // REPL having exited (or `onDeath` having stamped `diedMidTurn`) is the
          // crash signal; a plain inject failure on a live REPL is NOT enqueued.
          //
          // EPHEMERAL EXCEPTION (Argus r5 BLOCKER): an ephemeral one-shot must NEVER
          // persist to pending-respawns or replay. The enqueue uses the POOLED
          // `options`/`sessionKey` (which still carry `pendingRespawnsPath` +
          // `delivery_topic_id` + the `cc-llm-*` pooled key registered in the
          // supervision map) — NOT the stripped ephemeral session — so a crashed
          // disposable one-shot's INTERNAL prompt would otherwise be queued, then
          // replayed by the watchdog/boot-drain and routed by `deliverRecoveredReply`
          // to `webTopicId(owner)` = the USER's chat topic: exactly the cross-purpose
          // bleed-to-user this whole fix exists to kill. A crashed ephemeral one-shot
          // just fails its internal call (the caller retries); nothing is persisted.
          if (
            !ephemeral &&
            session !== undefined &&
            (turn.diedMidTurn === true || session.hasChildExited())
          ) {
            enqueueDroppedInbound(options, sessionKey, session, spec.prompt, turn.turnId)
          }
          session.activeTurn = undefined
          if (release) release()
          return
        }

        // LIVENESS KEEPALIVE (2026-06-18 synthesis false-wedge fix). The turn has
        // injected and is now in flight. A synthesis read pass reads + thinks
        // SILENTLY (no tokens / no `send_typing`) before its first token; on a
        // loaded box that silence can exceed the consumer's idle window, which a
        // pure stream-event heartbeat reads as a wedge (the live failure: 100 % of
        // read passes false-wedged). Surface the child's LIVENESS as activity: while
        // the turn is unsettled AND the `claude` child is alive, emit a periodic
        // `status` heartbeat — the synthesis drain resets its idle timer on it, so a
        // silently-reading-but-alive pass is never falsely abandoned. The keepalive
        // self-stops the instant the turn settles, the channel closes, or the child
        // exits (a true hang then trips fast via `onDeath`'s error + the idle window
        // once keepalives cease; the absolute ceiling bounds a live-but-livelocked
        // child). Unref'd so it can never hold the event loop open; cleared
        // deterministically once the turn settles below.
        const keepalive = setInterval(() => {
          if (turn.settled || channel.closed) return
          if (session === undefined || session.hasChildExited()) return
          channel.push({ kind: 'status', message: 'working' })
          // P0: a wedged AskUserQuestion / arrow-menu emits NO further output, so
          // the `onData` scan never re-fires to satisfy the 2-tick stability gate.
          // Re-run the output scan on this same keepalive cadence (the wedge can
          // only happen mid-turn, which is exactly when this interval runs) so a
          // STATIC wedge is detected + recovered instead of being killed by the
          // inactivity watchdog.
          runOutputScan(session, session.child, options, Date.now())
        }, keepaliveMs)
        ;(keepalive as { unref?: () => void }).unref?.()

        const timer = setTimeout(() => {
          if (!turn.settled) {
            if (REPL_DEBUG && session !== undefined) {
              const r = session.getRecentOutput()
              process.stderr.write(`[repl-timeout] PTY tail:\n${normalizePtyText(r).slice(-1200)}\n`)
            }
            turn.settled = true
            // ABANDON-POISON (2026-06-18): the turn budget elapsed but the REPL is
            // still running it (a late reply will arrive after we've moved on).
            // Mark the warm session so the NEXT dispatch respawns a clean REPL
            // rather than landing on the busy/desynced one (the cascade fix).
            if (!ephemeral && session !== undefined) session.poisoned = true
            channel.push({ kind: 'error', message: 'persistent-repl: turn timeout', retryable: true })
            channel.close()
            turn.settle()
          }
        }, turnTimeoutMs)

        await settledP
        clearTimeout(timer)
        clearInterval(keepalive)
        // Enqueue-on-crash (brief § 2 row #11 / § 6 acceptance #1): if the REPL
        // process exited mid-turn, this turn's inbound was dropped (the caller
        // only saw a retryable error). Record it so the supervision layer
        // replays it after the session resumes — in-process via the next
        // watchdog tick's drain, or across a gateway restart via the boot-drain.
        // EPHEMERAL EXCEPTION (Argus r5 BLOCKER): skip for disposable one-shots —
        // see the matching guard in the inject-crash catch above for why an
        // ephemeral crash must never persist/replay to the user's chat topic.
        if (!ephemeral && turn.diedMidTurn === true && session !== undefined) {
          enqueueDroppedInbound(options, sessionKey, session, spec.prompt, turn.turnId)
        }
        if (session.activeTurn === turn) session.activeTurn = undefined
        if (release) release()
       } finally {
         // Dispose the one-shot disposable REPL once its single turn has fully
         // settled (success, error, cancel, or timeout) — it is never reused, so
         // it must not linger warm. Runs for the ephemeral path only; a pooled
         // warm session is left untouched. Fire-and-forget: nothing awaits the
         // driver, and disposal happens AFTER the channel's terminal event was
         // already delivered, so it can't truncate the caller's drain.
         if (ephemeral && session !== undefined) {
           await disposeEphemeralSession(session).catch(() => undefined)
         }
       }
      })()
      void driver

      // The concrete handle is a SUPERSET of the locked `SessionHandle` contract:
      // it additionally exposes `isAlive()` — a child-process liveness probe the
      // synthesis drain reads (structurally, defensively) so an idle-window expiry
      // on a silently-reading-but-alive turn is treated as liveness, not a wedge
      // (2026-06-18 false-wedge fix). The locked `session-handle.ts` interface is
      // unchanged; consumers that don't know about `isAlive` are unaffected.
      const handle: SessionHandle & { isAlive(): boolean } = {
        events: channel,
        respondToTool(): Promise<void> {
          return Promise.reject(
            new Error(
              'persistent-repl: respondToTool called on tool_resolution=internal substrate (caller bug; CC resolves MCP tools server-side)',
            ),
          )
        },
        isAlive(): boolean {
          // Before the session resolves the REPL is still spawning (alive-by-
          // default); after, this reflects the real child. A child that has EXITED
          // returns false so the synthesis drain wedges fast on a true hang; a live
          // (silently reading) child returns true so the idle window doesn't fire a
          // false wedge.
          return session === undefined || !session.hasChildExited()
        },
        cancel(): Promise<void> {
          // Abort the in-flight turn; leave the REPL WARM (do not kill child).
          // Do NOT await the driver — settle the turn so its `settledP`
          // resolves and the driver releases the lock + clears the timer.
          cancelled = true
          const t = session?.activeTurn
          if (t !== undefined && t.channel === channel && !t.settled) {
            // ABANDON-POISON (2026-06-18): the caller gave up on this turn (its
            // budget elapsed — e.g. synthesis `dispatchTurn` cancels at 90s) while
            // the REPL is still running it. The runaway turn's late reply would
            // desync the dev-channel correlation for the next turn on this warm
            // session (stale-reply debt strips its turn_id → never delivers). Mark
            // the session so the next dispatch respawns a clean REPL. Skip for an
            // ephemeral one-shot (it is disposed after its single turn anyway).
            if (!ephemeral && session !== undefined) session.poisoned = true
            t.settled = true
            t.settle()
            if (session !== undefined) session.activeTurn = undefined
          }
          if (!channel.closed) channel.close()
          return Promise.resolve()
        },
        tool_resolution: 'internal',
      }
      return handle
    },
  }
}

/** Live per-registry watchdog handles. Tracked so shutdown stops their
 *  interval + heartbeat timers (Codex P2 — leaked timers keep the Bun event loop
 *  alive after the gateway/test stops). Populated + cleaned by `startReplWatchdog`. */
const activeWatchdogs = new Map<string, ReplWatchdog>()

/** Test/operator helper: SIGTERM every warm REPL and clear the pool. */
export async function shutdownAllPersistentRepls(): Promise<void> {
  // Stop the watchdog/heartbeat timers FIRST so no tick fires mid-teardown.
  for (const w of activeWatchdogs.values()) w.stop()
  activeWatchdogs.clear()
  for (const [key, p] of pool.entries()) {
    pool.delete(key)
    try {
      const session = await p
      session.child.kill()
      sink.unregister(session.sessionId)
      unlinkSessionConfigs(session)
    } catch {
      // ignore
    }
  }
  // Terminate in-flight EPHEMERAL one-shots too (Argus r5 IMPORTANT): they are
  // never pooled, so the pool loop above misses them — a disposable child mid-turn
  // at shutdown would orphan its process + leak its temp configs.
  for (const session of ephemeralSessions) {
    try {
      session.child.kill()
      sink.unregister(session.sessionId)
      unlinkSessionConfigs(session)
    } catch {
      // ignore
    }
  }
  ephemeralSessions.clear()
  // Reset supervision state so tests don't leak per-key gates across cases.
  respawnGates.clear()
  childByKey.clear()
  pendingChildKills.clear()
  supervisedBySessionKey.clear()
}

// ---------------------------------------------------------------------------
// Sprint-2 supervision actuation: respawn-is-always-resume, double-spawn-safe.
// ---------------------------------------------------------------------------

/** Live supervised-substrate options keyed by the EXACT pool key (`poolKeyFor`)
 *  — NOT by `replRegistryPath`. One instance registry is shared by multiple
 *  substrates (`cc-llm-*`, `cc-llm-router-*`, `cc-import-*`) whose `env` /
 *  `substrate_instance_id` / spawn options differ; keying by registry path alone
 *  would force-respawn any session in that registry with whichever substrate
 *  registered LAST → wrong credentials/identity (Codex P2). Keying by the pool
 *  key means a respawn always uses the options of the substrate that owns that
 *  exact session. */
const supervisedBySessionKey = new Map<string, PersistentReplSubstrateOptions>()

/** Register a supervised substrate's options under its pool key so the watchdog
 *  tick + the admin-respawn endpoint actuate each session with the OWNING
 *  substrate's options. No-op when no registry path is set (supervision off). */
export function registerSupervisedSubstrate(options: PersistentReplSubstrateOptions): void {
  if (options.replRegistryPath !== undefined) {
    supervisedBySessionKey.set(poolKeyFor(options), options)
  }
}

/**
 * Operator force-recover entry point for the admin-respawn HTTP endpoint:
 * resolve the OWNING substrate's live options for `sessionKey` and actuate a
 * FORCED `--resume` respawn (clears `capped_at` so a hard-capped REPL the
 * auto-watchdog stopped retrying is released). `replRegistryPath` scopes the
 * lookup to this instance: a session whose registered options point at a DIFFERENT
 * registry is treated as not-found, so the operator route can only recover
 * sessions belonging to the resolved instance. Returns `session-not-found` when no
 * supervised substrate is registered for the key (supervision off, or no turn
 * has spawned a REPL for it yet). `force` still honors the in-flight gate so two
 * rapid operator requests spawn exactly once (acceptance #3 / Argus r1 IMPORTANT #3).
 */
export function respawnSupervisedSession(
  replRegistryPath: string,
  sessionKey: string,
): RespawnOutcome {
  const options = supervisedBySessionKey.get(sessionKey)
  if (options === undefined || options.replRegistryPath !== replRegistryPath) {
    return { ok: false, reason: 'session-not-found', sessionKey }
  }
  return respawnReplSession(options, sessionKey, 'admin-endpoint', 'manual', true)
}

/** Per-`sessionKey` process-local respawn mutex — composes with the registry
 *  flock (cross-process) to guarantee no double-spawn (brief § 6 acceptance #3). */
const respawnGates = new Map<string, InFlightGate>()
/** Per-key last-alert timestamp for the wedge-alert dedupe window. */
const wedgeAlertState = new Map<string, number>()

function gateFor(sessionKey: string): InFlightGate {
  let g = respawnGates.get(sessionKey)
  if (g === undefined) {
    g = makeInFlightGate()
    respawnGates.set(sessionKey, g)
  }
  return g
}

/** Clear a latched `respawn_in_flight_at` stamp (lock-guarded). Used when a
 *  respawn refuses/fails so the next tick can retry without waiting out the TTL. */
function clearRespawnInFlight(registryPath: string, sessionKey: string): void {
  try {
    withRegistry(registryPath, (registry) => {
      const r = registry[sessionKey]
      if (r) {
        const { respawn_in_flight_at: _drop, ...rest } = r
        registry[sessionKey] = rest
      }
      return { registry, result: undefined }
    })
  } catch {
    /* best-effort */
  }
}

/** A resume spec carries only what `spawnSession` needs to re-attach — model
 *  from the registry record, empty prompt (the inject happens in `start()`'s
 *  driver / pending-replay, not the spawn). */
function resumeSpecFor(record: ReplRegistryRecord): AgentSpec {
  return { prompt: '', tools: [], model_preference: [record.model ?? 'claude-opus-4-7'] }
}

/** Build the `executeRespawn` dependency surface wired to the real module pool +
 *  persisted registry. Exposed for tests that want to drive `executeRespawn`
 *  against the live actuation without the watchdog tick. */
export function makeReplRespawnDeps(options: PersistentReplSubstrateOptions): RespawnDeps {
  const registryPath = options.replRegistryPath
  return {
    killChild: (sessionKey) => {
      // Synchronous liveness decision via the handle mirror (the pool only holds
      // a Promise). When the child is ALIVE-but-wedged the pool still owns the
      // process, so we must kill it AND wait for its exit before the `--resume`
      // replacement spawns — otherwise two processes briefly share one session
      // transcript (Argus r3 BLOCKER 1). When it has already exited (the crash
      // path), there is nothing to wait for and the resume spawns synchronously.
      const child = childByKey.get(sessionKey)
      if (child === undefined || child.hasExited()) {
        childByKey.delete(sessionKey)
        // Cross-restart orphan path (ISSUES #105): the in-memory mirror has no
        // live child, but a PRIOR gateway incarnation may have left a
        // `claude --resume` STILL RUNNING whose pid survives only in the persisted
        // registry. Verify-then-adopt-or-kill it BEFORE `spawnResume` so we never
        // run two processes on one session transcript. The identity check
        // (`adoptOrKillOrphan`) terminates the pid ONLY when it is alive AND its
        // cmdline matches our `claude` for this session; a dead pid (the common
        // crash path) or a RECYCLED/unrelated pid (cmdline mismatch) is left
        // untouched — a blind `process.kill(record.pid)` could SIGTERM an
        // unrelated process the OS recycled the pid onto. The registered promise
        // is awaited by `spawnResume` (same seam as the alive-child kill below).
        if (registryPath !== undefined) {
          const orphanRecord = getRecord(registryPath, sessionKey)
          // CONFIGURED binary basename — the identity gate compares argv[0]'s
          // basename against THIS, not the literal `claude`, so a CLAUDE_BIN
          // override (e.g. claude-headless) still recognises our own orphan
          // (Argus r3 BLOCKER). Resolution mirrors build-repl-argv.ts:68 so the
          // matcher's expected basename == what buildReplArgv actually spawned.
          const claudeBasename = basenameOf(
            options.claude_bin ?? process.env['CLAUDE_BIN'] ?? 'claude',
          )
          registerOrphanKill(
            sessionKey,
            orphanRecord,
            {
              isPidAlive: defaultIsPidAlive,
              readCmdline: defaultReadCmdline,
              // Re-verify identity right before the FORCE kill (Codex P2): the
              // verified orphan may exit during the SIGTERM grace window and the OS
              // may recycle its pid onto an unrelated process before SIGKILL — this
              // closure re-reads the cmdline and skips SIGKILL unless the pid is
              // STILL our claude for this session, collapsing the multi-second
              // grace-window TOCTOU to a synchronous check. Recycled-pid safety is
              // the whole point of this module.
              terminatePid: (pid) =>
                terminatePidGracefully(pid, () =>
                  cmdlineMatchesSession(
                    defaultReadCmdline(pid),
                    orphanRecord?.sessionId ?? '',
                    claudeBasename,
                  ),
                ),
            },
            (k, p) => pendingChildKills.set(k, p),
            claudeBasename,
          )
        }
        return
      }
      childByKey.delete(sessionKey)
      // Graceful SIGTERM + await exit (SIGKILL on overstay). `spawnResume` awaits
      // this before launching the resume so exactly one process owns the session.
      pendingChildKills.set(sessionKey, terminateChild(child))
    },
    evictPool: (sessionKey) => {
      pool.delete(sessionKey)
    },
    spawnResume: (record): SpawnReplOutcome => {
      // Consume the pending graceful-kill (if `killChild` found an alive child).
      const pendingKill = pendingChildKills.get(record.sessionKey)
      pendingChildKills.delete(record.sessionKey)
      // Synchronous honesty for the deterministic failure Codex flagged: a ghost
      // cwd would fail the spawn asynchronously and be reported as success. Catch
      // it up-front so the caller propagates `spawn-cwd-invalid` instead. (The
      // background kill still runs — a wedged child is terminated either way.)
      if (!existsSync(record.cwd)) {
        return { ok: false, reason: 'invalid-cwd' }
      }
      try {
        // Kick the resume spawn. forceResume re-attaches the captured UUID. An
        // ASYNC failure (assertion / dev-channel health) clears the in-flight
        // stamp in getOrSpawnSession's catch so the next tick retries rather
        // than treating the key as still-recovering for the whole TTL.
        //
        // Ordering (Argus r3 BLOCKER 1): if `killChild` SIGTERM'd an alive-but-
        // wedged child, AWAIT its exit before `getOrSpawnSession`, so the new
        // `claude --resume` never co-owns the transcript with the dying process.
        // When there is no pending kill (crash path) `getOrSpawnSession` is called
        // synchronously inside this IIFE (no `await` precedes it) — ptyHost.spawn
        // still records synchronously, preserving the fire-and-forget timing.
        void (async () => {
          if (pendingKill !== undefined) await pendingKill
          await getOrSpawnSession(record.sessionKey, options, resumeSpecFor(record), {
            sessionId: record.sessionId,
          })
        })().catch(() => undefined)
        return { ok: true }
      } catch {
        return { ok: false, reason: 'spawn-failed' }
      }
    },
    saveRecord: (record) => {
      if (registryPath !== undefined) upsertRecord(registryPath, record)
    },
    now: () => Date.now(),
  }
}

/** Count respawns inside the rolling cap window. */
function recentRespawnCount(record: ReplRegistryRecord, now: number): number {
  return (record.recent_respawns ?? []).filter((t) => now - t < RESPAWN_CAP_WINDOW_MS).length
}

/**
 * Actuate a respawn for `sessionKey` — the single guarded entry point used by
 * the watchdog tick AND the admin endpoint. Double-spawn-safe: a process-local
 * per-key gate + a registry-flock in-flight stamp serialize concurrent callers
 * so EXACTLY ONE spawn fires (brief § 6 acceptance #3). Respawn-is-always-resume
 * via `dispatchWedgeRespawn → planRespawn → executeRespawn` (brief § 6
 * acceptance #2 & #4). `force` (operator) bypasses the in-flight/cooldown gates
 * and clears `capped_at`.
 */
export function respawnReplSession(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  trigger: RespawnTrigger,
  reason: string,
  force = false,
): RespawnOutcome {
  const registryPath = options.replRegistryPath
  if (registryPath === undefined) {
    return { ok: false, reason: 'session-not-found', sessionKey }
  }
  const gate = gateFor(sessionKey)
  if (!gate.claim()) {
    // Another respawn for this key is already running in-process. The
    // process-local gate applies to `force` too: two rapid operator force
    // requests must NOT both spawn (acceptance #3 — exactly ONE spawn per
    // sessionKey). `force` only bypasses the cooldown/cap below, never the
    // in-flight serialization. (Argus r1 IMPORTANT #3.)
    return { ok: false, reason: 'spawn-failed', sessionKey }
  }
  const now = Date.now()
  try {
    // Cross-process guard + cap enforcement under the registry flock.
    const decision = withRegistry<
      { kind: 'go'; record: ReplRegistryRecord } | { kind: 'no-record' } | { kind: 'in-flight' } | { kind: 'capped' }
    >(registryPath, (registry) => {
      const rec = registry[sessionKey]
      if (!rec) return { registry, result: { kind: 'no-record' } }
      const inFlight =
        rec.respawn_in_flight_at !== undefined && now - rec.respawn_in_flight_at < RESPAWN_IN_FLIGHT_TTL_MS
      if (force) {
        // Operator force-recover: clear cap + bypass the cooldown/cap-count,
        // BUT still honor the cross-process in-flight stamp so two rapid force
        // requests (this or another process) can't both spawn the same
        // sessionKey (acceptance #3 — exactly ONE spawn). Argus r1 IMPORTANT #3.
        if (inFlight) return { registry, result: { kind: 'in-flight' } }
        const { capped_at: _dropped, ...rest } = rec
        const next: ReplRegistryRecord = { ...rest, respawn_in_flight_at: now }
        registry[sessionKey] = next
        return { registry, result: { kind: 'go', record: next } }
      }
      if (inFlight) return { registry, result: { kind: 'in-flight' } }
      if (rec.capped_at !== undefined) return { registry, result: { kind: 'capped' } }
      if (recentRespawnCount(rec, now) >= RESPAWN_CAP_MAX) {
        // Trip the hard cap — auto-recovery OFF until an operator clears it.
        registry[sessionKey] = { ...rec, capped_at: now }
        return { registry, result: { kind: 'capped' } }
      }
      // CLAIM the respawn atomically under the flock: stamp in-flight BEFORE
      // releasing the lock so a racing process/tick that acquires the lock next
      // observes the stamp and refuses (the cross-process double-spawn guard).
      // Cleared below if the dispatch does NOT fire (so a refusal doesn't latch).
      const stamped: ReplRegistryRecord = { ...rec, respawn_in_flight_at: now }
      registry[sessionKey] = stamped
      return { registry, result: { kind: 'go', record: stamped } }
    })

    if (decision.kind === 'no-record') return { ok: false, reason: 'session-not-found', sessionKey }
    if (decision.kind === 'in-flight') return { ok: false, reason: 'spawn-failed', sessionKey }
    if (decision.kind === 'capped') return { ok: false, reason: 'spawn-failed', sessionKey }

    const deps = makeReplRespawnDeps(options)
    if (!shouldPostRespawnNotice(trigger)) {
      delete deps.postNotice
    }
    const dispatch = dispatchWedgeRespawn({
      plan: () => planRespawn(loadRegistry(registryPath), sessionKey),
      execute: (plan) => {
        const rec = getRecord(registryPath, sessionKey)
        if (!rec) return { ok: false, reason: 'session-not-found' }
        const outcome = executeRespawn(rec, plan, trigger, reason, deps)
        return outcome.reason !== undefined
          ? { ok: outcome.ok, reason: outcome.reason }
          : { ok: outcome.ok }
      },
      // We already stamped in-flight under the flock (atomic claim); this refresh
      // is a confirmatory no-op on the fired path.
      markInFlight: () => patchRecord(registryPath, sessionKey, { respawn_in_flight_at: now }),
    })

    // A refused / threw dispatch must NOT leave the in-flight stamp latched (it
    // would block the next tick's retry for the whole TTL with no respawn
    // actually running). Clear the claim so recovery can retry immediately.
    if (dispatch.kind !== 'fired') {
      clearRespawnInFlight(registryPath, sessionKey)
    }

    switch (dispatch.kind) {
      case 'fired':
        return { ok: true, sessionKey, initiatedAt: now }
      case 'plan-refused':
        return { ok: false, reason: refusalFor(dispatch.reason), sessionKey }
      case 'execute-refused':
        return { ok: false, reason: refusalFor(dispatch.reason), sessionKey }
      case 'threw':
        return { ok: false, reason: 'spawn-failed', sessionKey }
    }
  } finally {
    gate.release()
  }
}

function refusalFor(reason: string): NonNullable<RespawnOutcome['reason']> {
  switch (reason) {
    case 'no-session-to-resume':
    case 'session-not-found':
    case 'invalid-session-key':
    case 'spawn-cwd-invalid':
    case 'spawn-failed':
      return reason
    default:
      return 'spawn-failed'
  }
}

// ---------------------------------------------------------------------------
// Sprint-2 supervision: the live watchdog tick + heartbeat.
// ---------------------------------------------------------------------------

export interface ReplWatchdogOptions {
  /** Tick cadence (ms). Default 15s. */
  intervalMs?: number
  /** Heartbeat file path. When set, a 100ms heartbeat tick runs alongside the
   *  watchdog (systemd `Type=notify`/`WatchdogSec` reads its mtime). */
  heartbeatFile?: string
  /** Operator alert sink for wedge notices. */
  postAlert?: (text: string) => void
  /** DI: setInterval shim (tests). */
  setIntervalFn?: (cb: () => void, ms: number) => unknown
  /** DI: clearInterval shim (tests). */
  clearIntervalFn?: (handle: unknown) => void
  /** DI: health probe (tests). Default the real dev-channel `/health` fetch.
   *  `expectedSessionId` lets the default verify the responder's identity (the
   *  port-recycle guard); injected probes may ignore it. */
  healthProbe?: (port: number, expectedSessionId?: string) => Promise<boolean>
  /** DI: pid-liveness probe for the cross-restart / post-crash case where the
   *  pool no longer holds the session but the registry still records a pid.
   *  Default `process.kill(pid, 0)` in a try/catch. */
  isPidAlive?: (pid: number) => boolean
  /** DI clock. */
  now?: () => number
}

export interface ReplWatchdog {
  stop(): void
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Probe one supervised key's liveness against the live pool + dev-channel. The
 *  pool is the authoritative source when it holds the session; otherwise (after
 *  a crash evicted it, or across a gateway restart) the registry's recorded
 *  `pid` is the liveness anchor — exactly Nova's "topic-map pid" fallback. */
async function probeReplLiveness(
  sessionKey: string,
  record: ReplRegistryRecord | undefined,
  healthProbe: (port: number, expectedSessionId?: string) => Promise<boolean>,
  isPidAlive: (pid: number) => boolean,
): Promise<ReplWedgeProbe> {
  const p = pool.get(sessionKey)
  let hasChild = false
  let childAlive = false
  let channelPort: number | undefined
  if (p !== undefined) {
    try {
      const session = await p
      hasChild = true
      childAlive = !session.hasChildExited()
      channelPort = session.channelPort
    } catch {
      hasChild = false
    }
  }
  // No live pool entry but the registry recorded a pid → probe the OS directly
  // (post-crash / cross-restart). A dead recorded pid is the wedge signal.
  if (!hasChild && record?.pid !== undefined) {
    hasChild = true
    childAlive = isPidAlive(record.pid)
  }
  const port = channelPort ?? record?.devchannel_port
  // Pass the recorded session id so the default probe can reject a recycled port
  // serving a DIFFERENT session (port-recycle guard).
  const healthOk = port !== undefined ? await healthProbe(port, record?.sessionId) : false
  return { hasChild, childAlive, healthOk, ccReady: record?.first_ready_at !== undefined }
}

/**
 * Run ONE watchdog tick: scan the registry, probe each REPL's liveness, decide
 * via the pure `detectReplWedged` + `decideWedgeAction` cores, and actuate a
 * `--resume` respawn on a confirmed wedge/crash. Exported so the live wiring is
 * directly testable (brief § 9 anti-pattern #1 — no built-but-not-wired core).
 * Returns a per-key summary of what the tick decided/did.
 */
export async function runReplWatchdogTick(
  options: PersistentReplSubstrateOptions,
  wopts: ReplWatchdogOptions = {},
): Promise<Array<{ sessionKey: string; action: string; respawned: boolean }>> {
  const registryPath = options.replRegistryPath
  if (registryPath === undefined) return []
  const healthProbe =
    wopts.healthProbe ??
    ((port: number, expectedSessionId?: string) =>
      httpHealth(port, expectedSessionId !== undefined ? { expectedSessionId } : {}))
  const isPidAlive = wopts.isPidAlive ?? defaultIsPidAlive
  const now = (wopts.now ?? Date.now)()
  const registry = loadRegistry(registryPath)
  // Scope the scan to THIS instance registry (Codex P2): the registry on disk is
  // already scoped to this instance, but `pool` is module-global — without filtering,
  // instance A's tick would probe/respawn instance B's pooled sessions and misroute B's
  // wedge alerts through A's `postAlert`. Only include pool keys whose registered
  // owning substrate points at this `replRegistryPath`.
  const ownedPoolKeys = [...pool.keys()].filter(
    (k) => supervisedBySessionKey.get(k)?.replRegistryPath === registryPath,
  )
  const keys = new Set<string>([...Object.keys(registry), ...ownedPoolKeys])
  const results: Array<{ sessionKey: string; action: string; respawned: boolean }> = []

  for (const sessionKey of keys) {
    const record = registry[sessionKey]
    const probe = await probeReplLiveness(sessionKey, record, healthProbe, isPidAlive)
    const verdict = detectReplWedged(probe)
    const action = decideWedgeAction({
      verdict,
      firstReadyAt: record?.first_ready_at,
      cappedAt: record?.capped_at,
      respawnInFlight:
        record?.respawn_in_flight_at !== undefined &&
        now - record.respawn_in_flight_at < RESPAWN_IN_FLIGHT_TTL_MS,
      lastWedgeAutoRespawnAt: record?.last_respawn_at,
      lastWedgeAlertAt: wedgeAlertState.get(sessionKey),
      now,
    })

    let respawned = false
    if (action.kind === 'respawn-and-alert') {
      // Respawn with the OWNING substrate's options (env / instance-id / spawn
      // opts), resolved by pool key — one registry is shared by substrates that
      // differ (Codex P2). An unregistered key (a dead session for a substrate
      // that hasn't re-registered post-restart) is NOT actuated with the tick's
      // own options — that would resume it under the wrong env/identity. It is
      // recovered when its owner re-registers (resume-is-always-resume on its next
      // turn, or the next tick once registered). Surface as a skip.
      const keyOptions = supervisedBySessionKey.get(sessionKey)
      if (keyOptions === undefined) {
        results.push({ sessionKey, action: 'unregistered-skip', respawned: false })
        continue
      }
      const trigger: RespawnTrigger =
        action.verdict.reason === 'pid-dead' ? 'crash-watchdog' : 'wedge-watchdog'
      const outcome = respawnReplSession(keyOptions, sessionKey, trigger, action.verdict.detail)
      respawned = outcome.ok
      if (action.alert.send) {
        wopts.postAlert?.(buildWedgeAlertText({ sessionKey, reason: action.verdict.reason }))
        wedgeAlertState.set(sessionKey, now)
      }
    } else if (action.kind === 'cap-hit-alert') {
      if (action.alert.send) {
        wopts.postAlert?.(buildWedgeCapHitAlertText({ sessionKey, reason: action.verdict.reason }))
        wedgeAlertState.set(sessionKey, now)
      }
    } else if (action.kind === 'alert-only') {
      if (action.alert.send) {
        wopts.postAlert?.(buildWedgeRecoveryInProgressText({ sessionKey }))
        wedgeAlertState.set(sessionKey, now)
      }
    }
    // Surface the ignore *reason* (boot-window / never-ready / not-wedged) so
    // the live wiring is observable in tests + logs, not just "ignore".
    const label = action.kind === 'ignore' ? action.reason : action.kind
    results.push({ sessionKey, action: label, respawned })
  }
  // Replay any inbound dropped since the last tick (brief § 6 acceptance #1's
  // replay clause): a crash-respawn above resumed the session, so its dropped
  // inbound can now be re-injected via the dev-channel /message path. No-op when
  // the queue is unconfigured/absent. No stagger — a single fresh crash.
  await drainPendingRespawns(options, { baseDelayMs: 0 })
  return results
}

/**
 * Start the live REPL watchdog: an in-flight-gated tick (default 15s) that
 * self-heals wedged/crashed REPLs via `runReplWatchdogTick`, plus (when
 * `heartbeatFile` is set) the 100ms heartbeat that the systemd
 * `Type=notify`/`WatchdogSec` supervisor reads. No-op (returns a stop() that
 * does nothing) when `replRegistryPath` is unset — supervision is OFF.
 */
export function startReplWatchdog(
  options: PersistentReplSubstrateOptions,
  wopts: ReplWatchdogOptions = {},
): ReplWatchdog {
  if (options.replRegistryPath === undefined) {
    return { stop: () => {} }
  }
  // Idempotent per registry: a second start for the same instance returns the live
  // handle rather than spawning a second 15 s tick + 100 ms heartbeat. The handle
  // is tracked so `shutdownAllPersistentRepls` can stop the timers — otherwise an
  // in-process gateway/test run with the flag on would leak both intervals and
  // keep the Bun event loop from draining after shutdown (Codex P2).
  const registryPath = options.replRegistryPath
  const live = activeWatchdogs.get(registryPath)
  if (live !== undefined) return live
  const intervalMs = wopts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS
  const setIntervalFn =
    wopts.setIntervalFn ?? ((cb: () => void, ms: number) => globalThis.setInterval(cb, ms))
  const clearIntervalFn =
    wopts.clearIntervalFn ??
    ((h: unknown) => globalThis.clearInterval(h as Parameters<typeof globalThis.clearInterval>[0]))

  let heartbeat: HeartbeatWatchdog | undefined
  if (wopts.heartbeatFile !== undefined) {
    heartbeat = startHeartbeatWatchdog({ heartbeatFile: wopts.heartbeatFile })
  }

  // Boot-drain (brief § 6 acceptance #1): replay anything a prior gateway crash
  // left queued — each entry is a turn whose REPL died mid-flight and whose
  // in-process replay never fired because the gateway itself went down. Fire-and-
  // forget with the default anti-thundering-herd stagger; errors are swallowed so
  // a poisoned entry can't block watchdog startup.
  void drainPendingRespawns(options).catch((e) =>
    console.error(`repl-watchdog: boot-drain error: ${e}`),
  )

  // Per-registry tick gate (Argus r3 MINOR 3): scoped to THIS watchdog so a slow
  // tick for one instance's registry never serializes another instance's tick in a
  // hosted single-process deployment. Consistent with round-8 per-registry pool
  // scoping. Lives in the closure → GC'd when the watchdog stops.
  const tickGate = makeInFlightGate()
  const tick = (): void => {
    // in-flight gate: skip if a prior tick is still running (the work can take
    // longer than the cadence; double-firing would race the respawn).
    if (!tickGate.claim()) return
    void runReplWatchdogTick(options, wopts)
      .catch((e) => console.error(`repl-watchdog: tick error: ${e}`))
      .finally(() => tickGate.release())
  }
  const handle = setIntervalFn(tick, intervalMs)

  let stopped = false
  const watchdog: ReplWatchdog = {
    stop: () => {
      if (stopped) return
      stopped = true
      clearIntervalFn(handle)
      heartbeat?.stop()
      if (activeWatchdogs.get(registryPath) === watchdog) activeWatchdogs.delete(registryPath)
    },
  }
  activeWatchdogs.set(registryPath, watchdog)
  return watchdog
}

// ---------------------------------------------------------------------------
// Test/operator introspection helpers.
// ---------------------------------------------------------------------------

/** Read the persisted registry (snapshot). Operator/test helper. */
export function getReplRegistrySnapshot(registryPath: string): Record<string, ReplRegistryRecord> {
  return loadRegistry(registryPath)
}

/** Whether the module pool currently holds a (possibly dead) session for a key. */
export function poolHasSessionForTest(sessionKey: string): boolean {
  return pool.has(sessionKey)
}
