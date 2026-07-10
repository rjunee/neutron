// persistent-repl-substrate.ts → signatures.ts
// Low-level constants + pure keystroke/output-scan/notice helpers (D2 split).

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TokenUsage } from '../../../events.ts'
import { type Key, encodeKey, encodeKeys } from './keystrokes.ts'
import type { PtyChild } from './pty-host.ts'
import { severityForBannerDetectorId } from './rate-limit-banner.ts'
import { patchRecord } from './repl-registry.ts'
import { RESUME_PICKER_DETECTOR_ID, runResumePickerRecovery } from './resume-picker-detector.ts'
import { findLatestResumableSession } from './session-disk-recovery.ts'
import type { SizeSeverity } from './session-size-watchdog.ts'
import { WEDGED_PROMPT_DETECTOR_ID, runWedgedRecovery } from './wedged-prompt-detector.ts'
import { type PersistentReplSubstrateOptions, dispatchRateLimitBannerNotice } from './types.ts'
import type { ReplSession } from './repl-session.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Separator between the warm-pool key components (S3: `substrate_instance_id`,
 *  `user_id`, `project_id`, `credential_identity`). A NUL byte — never present in
 *  a slug / uuid / credential-id, so the key is unambiguous. Shared by the key
 *  construction and the pending-respawns drain so the two can never drift. */
export const SESSION_KEY_SEP = '\0'
export const DEFAULT_DEV_CHANNEL_PATH = join(HERE, 'dev-channel.ts')
// P0-1 native-MCP tool bridge — the SECOND `mcpServers` entry (alongside the
// dev-channel) that fronts the gateway's in-process `ToolRegistry` to the
// spawned `claude` over stdio. Attached ONLY when a spawn opts in via
// `enableToolBridge` AND a `ReplToolBridge` has been wired (see
// `setReplToolBridge`).
export const DEFAULT_TOOLS_BRIDGE_PATH = join(HERE, 'tools-bridge.ts')
/** The MCP server name the tools-bridge registers under; tools surface to the
 *  agent as `mcp__<this>__<toolname>`. Also the `--allowedTools` namespace the
 *  argv permits so the agent can invoke them without a per-call approval. */
export const TOOLS_BRIDGE_SERVER_NAME = 'neutron'
// Co-located with the substrate (NOT in the P0 `prompts/` package, whose
// KNOWN_PROMPTS registry strictly enumerates the instance-substituted gateway
// prompts). This is a static substrate asset read by absolute path.
export const DEFAULT_AGENT_BASE_PROMPT = join(HERE, 'repl-agent-base.md')

export const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }
/**
 * ACTIVITY-BASED turn timeout (2026-07-01). The per-turn budget is NOT a fixed
 * wall clock — it is an INACTIVITY window. `session.lastDataAt` advances on every
 * PTY byte the `claude` child emits (spinner ticks, streamed tokens, tool output),
 * so an ACTIVELY-working turn keeps resetting the idle clock and runs as long as it
 * needs (a long-but-live build no longer dies at an arbitrary 180s). Only a
 * GENUINELY frozen turn — no PTY output for `DEFAULT_TURN_INACTIVITY_MS` — trips the
 * timeout. Kept modest (~90s) so a truly wedged warm turn still fails reasonably
 * fast; the composer auto-retries a freeze once and surfaces a Retry affordance.
 *
 * Historical note: this constant used to be `DEFAULT_TURN_TIMEOUT_MS = 180_000`, a
 * FIXED wall-clock cap that hard-failed a slow-but-active turn (Ryan live-test
 * 2026-07-01: a "weave timer+tracker together then do full e2e testing" turn was
 * killed at elapsed_ms=180009 while the agent was still working). Now it is the
 * idle window; `turnTimeoutMs` / `spec.turn_timeout_ms` override it per-turn.
 */
export const DEFAULT_TURN_INACTIVITY_MS = 90_000
/**
 * ABSOLUTE-CEILING backstop for a single turn (2026-07-01). Even the
 * activity-based watchdog keeps a hard upper bound so a live-but-livelocked child
 * (emitting PTY noise forever without ever settling the turn) cannot run
 * unbounded. Very high — a real turn, however long, settles well under this;
 * `turnAbsoluteCeilingMs` / `spec.turn_absolute_ceiling_ms` override it.
 */
export const DEFAULT_TURN_ABSOLUTE_CEILING_MS = 45 * 60_000
/** Signature of the `--dangerously-load-development-channels` first-run
 *  disclaimer, matched against the PTY text with ALL ANSI escapes + whitespace
 *  stripped (the Ink TUI positions each word with cursor-move escapes, so the
 *  phrase is never contiguous in the raw stream). */
export const DEV_CHANNEL_DISCLAIMER_RE = /forlocalchanneldevelopment|usingthisforlocaldevelopment/i
/** Bottom-N line window the disclaimer detector scans. Generous (vs the default
 *  bottom-24) because the disclaimer renders as a multi-line box at spawn; this
 *  preserves the old whole-ring match behavior while still excluding unbounded
 *  scrollback. */
export const DISCLAIMER_BOTTOM_N = 200
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
export const TOOL_USE_QUESTION_RE = /doyouwantto(makethisedit|proceed|runthiscommand|create)/i
export const TOOL_USE_SELECTOR_RE = /❯1\.yes/i
/** P1 /rate-limit-options org-cap auto-stop (port row #4). BOTH cues are
 *  required in the bottom-30 lines: the `/rate-limit-options` slash command name
 *  AND option 3's verbatim text `Stop and wait for limit to reset` — a single
 *  cue (a conversational mention or a quoted brief) must not trip it. Matched
 *  against the whitespace-stripped `normalized` view because Ink shreds the
 *  picker across cursor-move escapes (same reason as the disclaimer/tool-use
 *  cues; see pty-text.ts), so the spec substrings are carried here in their
 *  space-free normalized form. */
export const RATE_LIMIT_OPTIONS_RE = /\/rate-limit-options/i
export const RATE_LIMIT_STOP_RE = /stopandwaitforlimittoreset/i
/** Bottom-N window the rate-limit-options detector scans (Vajra
 *  RATE_LIMIT_OPTIONS_BOTTOM_N_LINES). LOAD-BEARING positional guard — see the
 *  registration comment for why. */
export const RATE_LIMIT_OPTIONS_BOTTOM_N = 30
/** Debounce floor for the rate-limit-options auto-stop (Vajra
 *  RATE_LIMIT_OPTIONS_DEDUPE_MS) — suppresses a re-press if the picker
 *  re-renders briefly while the prior `3`+enter is still settling. */
export const RATE_LIMIT_OPTIONS_DEBOUNCE_MS = 60_000
/** P1 compact-resume picker (port row #3). CC renders this summary-vs-full menu
 *  when resuming an auto-compacted session. EXACT-STRING ONLY — match one of the
 *  two literal option labels and NOTHING broader. LESSON: a prior broad
 *  `summary+full+numbered` match fired on NORMAL conversation and injected
 *  `2<Enter>` into live panes. The picker is ARROW-driven, NOT number-key, so
 *  the action is `down`+`enter` (the spawn-loop path), never a digit. Matched on
 *  the whitespace-stripped `normalized` view because Ink shreds each word across
 *  cursor-move escapes (see pty-text.ts), so the exact labels are carried here
 *  in their space-free form. */
export const COMPACT_RESUME_SUMMARY_RE = /resumefromsummary\(recommended\)/i
export const COMPACT_RESUME_FULL_RE = /resumefullsessionas-is/i
/** After a turn's reply settles, hold the turn lock until the REPL's PTY has
 *  been quiet for this long (claude returned to idle) before allowing the next
 *  inject — closes the back-to-back-turn drop race. */
export const DEFAULT_IDLE_QUIET_MS = 900
/** Cap on the post-reply idle wait (defensive — a TUI that never goes fully
 *  quiet still releases after this). */
export const DEFAULT_IDLE_MAX_MS = 6_000
/** Quiescence window the size-watchdog's idle-gated auto-compaction (Vajra port
 *  row #13, gap #4) requires before it injects `escape`+`/compact`. Generous on
 *  purpose: the auto-compaction must only fire when the session is GENUINELY at
 *  rest, not merely between PTY chunks mid-turn. `activeTurn === undefined`
 *  already proves no turn is in flight; this PTY-quiet floor is the secondary
 *  guard against a background write landing right as we actuate. 30 s mirrors the
 *  model-update watchdog's idle quiesce — the other keystroke-injecting
 *  watchdog. */
export const SESSION_COMPACT_IDLE_QUIESCE_MS = 30_000
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
export const REPL_LIVENESS_KEEPALIVE_MS = ((): number => {
  const raw = process.env['NEUTRON_REPL_KEEPALIVE_MS']
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 10_000
})()
/** Default watchdog tick cadence (ms). */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 15_000
/** Default cwd-drift watchdog tick cadence (ms). Slower than the wedge tick —
 *  lsof is heavier than a `/health` fetch and a drifted-but-alive child is far
 *  less urgent than a dead one. */
export const DEFAULT_CWD_DRIFT_INTERVAL_MS = 60_000
/** The TUI slash command that wipes the conversation transcript while keeping
 *  the `claude` process (and its MCP servers / dev-channel / system prompt)
 *  alive. Used by the `reset_context_per_turn` warm-import mode to isolate each
 *  chunk's context without respawning the REPL. */
export const CONTEXT_RESET_COMMAND = '/clear'
/** A respawn-in-flight stamp older than this is treated as stale (the prior
 *  respawn crashed before clearing it) and a new respawn may proceed. */
export const RESPAWN_IN_FLIGHT_TTL_MS = 90_000
/** Rolling window for the respawn-rate cap. */
export const RESPAWN_CAP_WINDOW_MS = 60 * 60 * 1000
/** Max respawns per `RESPAWN_CAP_WINDOW_MS` before the hard cap trips (auto-
 *  recovery OFF until an operator clears `capped_at`). */
export const RESPAWN_CAP_MAX = 3
/** Grace period a respawn waits for a wedged child to exit after SIGTERM before
 *  escalating to SIGKILL. The `--resume` replacement is NOT spawned until the old
 *  child is dead, so exactly one process owns the session transcript at a time
 *  (Argus r3 BLOCKER 1). */
export const CHILD_KILL_GRACE_MS = 2_000
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
export function sendKey(child: PtyChild, key: Key): void {
  if (child.writeKey !== undefined) child.writeKey(key)
  else child.write(encodeKey(key))
}

/** Resolve the Claude Code transcript root the SAME way the JSONL ghost gate and
 *  the API-5xx dead-turn watcher do: an explicit `options.projectsDir` wins
 *  (custom / per-instance transcript root); else `CLAUDE_CONFIG_DIR`'s `projects`
 *  (CC writes transcripts there when `claudeConfigDir` is set); else the default
 *  `~/.claude/projects`. Shared so the resume-picker disk recovery
 *  (`findLatestResumableSession`) and the dead-turn watcher can never diverge on
 *  WHERE the transcripts live — a divergence would make the recovery scan miss
 *  the isolated-config session and falsely report "no prior session" (Codex P2). */
export function resolveTranscriptProjectsDir(options: PersistentReplSubstrateOptions): string {
  return (
    options.projectsDir ??
    (options.claudeConfigDir !== undefined
      ? join(options.claudeConfigDir, 'projects')
      : join(homedir(), '.claude', 'projects'))
  )
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
export function runOutputScan(
  session: ReplSession,
  child: PtyChild,
  options: PersistentReplSubstrateOptions,
  now: number,
): void {
  for (const fired of session.scanner.scan(session.ring.raw(), now)) {
    if (fired.id === WEDGED_PROMPT_DETECTOR_ID) {
      dispatchWedgeRecovery(session, child, options)
    } else if (fired.id === RESUME_PICKER_DETECTOR_ID) {
      dispatchResumePickerRecovery(session, child, options)
    } else if (severityForBannerDetectorId(fired.id) !== undefined) {
      // Master-table row #10: a temporary / usage-cap BANNER crossed the rising
      // edge. NOTIFY-ONLY — surface a notice, never a keystroke (`scan` already
      // stamped the per-`threadId::severity` latch, so this is fire-once and
      // clears only when the banner falls off — invariant §1/§4).
      dispatchRateLimitBannerNotice(session, options, fired.id, now)
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

/** Launch the resume-session-failure picker escape-then-recover ladder (P2,
 *  master-table row #7). When `--resume <stale-id>` drops to CC's interactive
 *  "Resume Session" picker, this ESCAPES out (never blind-answers), scans disk
 *  JSONL for the user's most-recent real session, and surfaces a recovered/lost
 *  notice. The scanner latch guards the rising edge; `session.resumePickerRecovering`
 *  additionally guards the async window so a second scan tick can't launch a
 *  concurrent ladder on the still-present picker. Fire-and-forget. */
function dispatchResumePickerRecovery(
  session: ReplSession,
  child: PtyChild,
  options: PersistentReplSubstrateOptions,
): void {
  if (session.resumePickerRecovering) return
  session.resumePickerRecovering = true
  const cwd = options.cwd ?? process.cwd()
  // Resolve the transcript root the SAME way the spawn / dead-turn watcher do so
  // an isolated `CLAUDE_CONFIG_DIR` session's JSONL is actually found (Codex P2) —
  // a raw `options.projectsDir` is undefined under claudeConfigDir and would fall
  // back to `~/.claude/projects`, missing the recoverable transcript.
  const projectsDir = resolveTranscriptProjectsDir(options)
  void runResumePickerRecovery({
    writeKey: (key) => sendKey(child, key),
    // JSONL/disk is the source of truth (invariant §5). Exclude the session this
    // REPL was spawned under: if it's the stale id that dropped us into the
    // picker, we must not "recover" the very session that just failed to resume.
    findLatestSession: () =>
      findLatestResumableSession(cwd, projectsDir, { excludeSessionId: session.sessionId }),
    // This detector fires during SPAWN, BEFORE start() assigns activeTurn, so a
    // direct `activeTurn?.channel.push` would be a silent no-op and DROP the
    // required recovered/lost notice (Codex P2). Route through `pushNotice`, which
    // buffers until the first live turn flushes it.
    surface: (text) => session.pushNotice(text),
    // Actually move the live REPL onto the recovered session (Codex P1). Two
    // mechanisms, covering the live-next-turn path AND the durable crash path:
    //   • IN-MEMORY: record the recovered id + POISON. `getOrSpawnSession` does not
    //     re-read `resolveResumeDirective` while an unpoisoned warm child is alive,
    //     so the poison is what makes the NEXT turn evict + respawn with
    //     `pendingResumeSessionId` carried as the `forceResume` directive (`--resume`
    //     the recovered transcript). The current in-flight turn finishes on the
    //     fresh child; the notice says the recovered context is active next message.
    //   • DURABLE: patch the REGISTRY to the recovered id. The in-memory flags are
    //     lost if this child exits before the next dispatch (the pool drops the
    //     session on `child.exited`), so the crash/watchdog respawn — which reads the
    //     registry, not the session — must see the recovered id, else it re-`--resume`s
    //     the stale id and reopens the picker (Codex P2). `spawnSession`'s own
    //     flag-aware registry write covers the reverse ordering (recovery finishing
    //     before that write); together every ordering converges on the recovered id.
    requestResume: (recoveredSessionId) => {
      session.pendingResumeSessionId = recoveredSessionId
      session.poisoned = true
      if (options.replRegistryPath !== undefined) {
        try {
          patchRecord(options.replRegistryPath, session.sessionKey, {
            sessionId: recoveredSessionId,
            has_session: true,
          })
        } catch {
          /* best-effort — a registry write failure must never brick a live REPL */
        }
      }
    },
    // MISS: nothing recoverable on disk. `spawnSession` optimistically persisted
    // `has_session: true` for the stale `--resume` id, so a later crash/watchdog
    // respawn would re-`--resume` it and reopen the picker. (IN-MEMORY) flag a
    // forced-fresh respawn + poison so the next turn cleanly respawns FRESH; AND
    // (DURABLE) patch the registry `has_session: false` now so the decision survives
    // this child exiting before the next dispatch — breaking the stale-resume loop
    // (Codex P2). The current fresh child keeps serving until the next turn.
    onNoRecovery: () => {
      session.forceFreshRespawn = true
      session.poisoned = true
      if (options.replRegistryPath !== undefined) {
        try {
          patchRecord(options.replRegistryPath, session.sessionKey, { has_session: false })
        } catch {
          /* best-effort */
        }
      }
    },
    alert: (text) => process.stderr.write(`[resume-picker] ${text}\n`),
    delay: (ms) => new Promise((res) => setTimeout(res, ms)),
  })
    .catch((err: unknown) => {
      process.stderr.write(`[resume-picker] ladder threw: ${String(err)}\n`)
    })
    .finally(() => {
      session.resumePickerRecovering = false
    })
}

/** Surface a session-size warn/critical affordance (Vajra port row #13). The
 *  watchdog has crossed a rising edge into the warn (≥5 MB) / critical (≥10 MB)
 *  post-compact band. We surface it to (a) the active turn's channel if one is in
 *  flight, so the user sees it inline, (b) an operator stderr log (always), and
 *  (c) the injected `onSizeAlert` hook so a gateway can wire a richer
 *  Reset/Compact/Snooze affordance. This SURFACE path never actuates a
 *  compaction itself — the watchdog's separate idle-gated POLICY does that at the
 *  critical band when the session is at rest (see the `isIdle` wiring above and
 *  `maybeAutoCompact` in session-size-watchdog.ts), and a gateway/user can still
 *  press the surfaced affordance via `requestSessionCompact`. */
export function surfaceSizeAlert(
  session: ReplSession,
  sessionKey: string,
  severity: SizeSeverity,
  sizeBytes: number,
  options: PersistentReplSubstrateOptions,
): void {
  const mb = (sizeBytes / (1024 * 1024)).toFixed(1)
  const message =
    severity === 'critical'
      ? `🛑 This session's transcript is ${mb} MB of live context (≥10 MB) — \`--resume\` will soon be refused and the session could wedge. Reset the session or compact it now.`
      : `⚠️ This session's transcript is ${mb} MB of live context (≥5 MB) and growing. Consider compacting or resetting it before it gets large enough to block resume.`
  session.activeTurn?.channel.push({ kind: 'status', message })
  process.stderr.write(
    `[session-size] ${severity} session=${session.sessionId.slice(0, 8)} post_compact=${mb}MB\n`,
  )
  try {
    options.onSizeAlert?.({ sessionKey, severity, sizeBytes })
  } catch {
    // A bad alert hook must never crash the watchdog tick.
  }
}
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
