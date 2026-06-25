/**
 * @neutronai/runtime — Claude Code substrate adapter.
 *
 * Implements the locked `Substrate` interface (`runtime/substrate.ts`) by
 * hosting ONE persistent interactive `claude` REPL per
 * `(substrate_instance_id, user_id, project_id, credential_identity)` and
 * driving each turn over a dev-channel (see `persistent/`). This is the SOLE
 * spawn shape: there is no per-turn `claude -p` path and no feature flag (the
 * legacy per-turn `claude -p` transport was HARD-DELETED in the substrate-lift
 * S3 rip-replace, 2026-06-07). The interactive REPL is required
 * because `claude -p` becomes metered/capped June-15-2026 while an interactive
 * Max session stays exempt — see `docs/plans/substrate-lift-brief.md` § 7.
 *
 * `tool_resolution = 'internal'` — MCP tool calls are resolved by Claude Code
 * itself inside the REPL; the `respondToTool` method on the resulting
 * `SessionHandle` THROWS if ever called (caller bug).
 *
 * The `claude` binary resolves its own credentials via the env the composer
 * threads in (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, scrubbed per
 * ISSUES #49) or `~/.claude/.credentials.json`. Multi-turn resume is delegated
 * to Claude Code's own `--session-id` / `--resume` (CC owns the transcript at
 * `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`).
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Substrate } from '../../substrate.ts'
import {
  createPersistentReplSubstrate,
  registerSupervisedSubstrate,
  startReplWatchdog,
  type PersistentReplSubstrateOptions,
  type RateLimitBannerNotice,
  type RecoveredReply,
} from './persistent/persistent-repl-substrate.ts'
import type { DeadTurnNotice } from './persistent/api5xx-dead-turn-watcher.ts'
import type { SizeSeverity } from './persistent/session-size-watchdog.ts'

export type { RecoveredReply } from './persistent/persistent-repl-substrate.ts'
export type { RateLimitBannerNotice } from './persistent/persistent-repl-substrate.ts'

export interface ClaudeCodeSubstrateOptions {
  /**
   * Identifier carried back on `completion.substrate_instance_id`. The
   * gateway typically passes a per-instance+role label (`cc-{role}-{instance}`,
   * OSS-split C4-a § 2.3) so observability can attribute load AND so the
   * warm-pool key separates roles (conversational / router / import) for
   * the same instance.
   */
  substrate_instance_id: string
  /**
   * Working directory for the REPL. Affects both the binary's `--session-id`
   * transcript path (`~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`) and
   * the CWD the REPL inherits. DERIVED, not part of the warm-pool key. Default:
   * `process.cwd()`.
   */
  cwd?: string
  /**
   * Override the `claude` binary path. Default:
   * `process.env.CLAUDE_BIN ?? 'claude'`.
   */
  claude_bin?: string
  /**
   * When true, append `--dangerously-skip-permissions` to the REPL argv.
   * Managed-tier deployments set this; Open-tier dev sessions typically don't.
   * Default: false.
   */
  skip_permissions?: boolean
  /**
   * Extra env vars to layer on top of `process.env` for the REPL. Used by
   * per-instance composers to thread BYO keys (`ANTHROPIC_API_KEY` /
   * `CLAUDE_CODE_OAUTH_TOKEN`) — the `claude` binary's own auth resolution
   * honours these. Max OAuth owners typically pass `{}` and rely on
   * `~/.claude/.credentials.json`.
   *
   * ISSUES #49 (2026-05-28) — `undefined` values are treated as "delete from
   * parentEnv" by the merge step, so per-instance composers can explicitly UNSET
   * host-inherited auth env vars and the REPL can't auth with a stale fallback
   * instead of the pool credential the caller selected.
   */
  env?: Record<string, string | undefined>
  /**
   * Per-instance `CLAUDE_CONFIG_DIR` — the isolated `claude` config dir holding the
   * owner's login state (`.credentials.json` with its OAuth refresh_token), trust
   * state, and MCP cache. When set, it is threaded onto the persistent child as
   * `CLAUDE_CONFIG_DIR` so the interactive-Max-login child SELF-REFRESHES its own
   * OAuth token from its refresh_token (the child's token never goes stale mid-
   * conversation, independent of the per-dispatch env token). When UNSET, the
   * child authenticates via the scrubbed `CLAUDE_CODE_OAUTH_TOKEN` env alone and
   * the substrate's credential-freshness reuse guard evicts + respawns on a token
   * rotation. Default `~/.claude` (Open self-host single-login).
   *
   * Argus r3 IMPORTANT (2026-06-08): no live gateway caller sets this today, so
   * the self-refresh branch is DORMANT plumbing — the credential-freshness reuse
   * guard (below) is the PRIMARY prod stale-token defense, not a complement to a
   * live self-refresh path. Kept wired so a future interactive-Max-login caller
   * activates it without re-plumbing.
   */
  claude_config_dir?: string
  /**
   * S3 §2 — conversational warm-pool namespace. The persistent substrate folds
   * these into its pool key so distinct (user, project) sessions never collapse
   * into one warm REPL and a credential rotation re-keys (#104). `user_id` is the
   * the owner today; `project_id` defaults to `'default'` (General);
   * `credential_identity` is the selected `PooledCredential.id` (NEVER the secret).
   */
  user_id?: string
  project_id?: string
  credential_identity?: string
  /** S3 §2 — owning instance slug (advisory: redelivery logging / scoping). */
  instance_slug?: string
  /** S3 #106 — the user's reconnect channel (`web:<user_id>`) for replay-
   *  redelivery. Recorded on a dropped-turn entry so the boot-drain can route a
   *  recovered reply. */
  delivery_topic_id?: string
  /** S3 #106 — injected redelivery sink. The gateway provides it; the persistent
   *  substrate's replay path calls it with a recovered reply instead of discarding
   *  it. Runtime-layer DI seam (the substrate never imports `gateway/*`). */
  onRecoveredReply?: (reply: RecoveredReply) => void | Promise<void>
  /** Notice-family DI seams — runtime→gateway sinks the persistent substrate fires
   *  on the rising edge of a detected condition (the substrate never imports
   *  `gateway/*`). Without forwarding them here, a caller built through
   *  `createClaudeCodeSubstrateAuto` could not deliver them and they degraded to a
   *  stderr-only fallback (Codex review, PR #67). All three are notify-only:
   *   - `onDeadTurnNotice` (row #11) — a mid-turn API 5xx killed a turn before
   *     `reply()`; surface a "resend your last message" retry affordance.
   *   - `onSizeAlert` (row #13) — a warm session's post-compact transcript crossed
   *     the warn (≥5 MB) / critical (≥10 MB) band; surface Reset/Compact.
   *   - `onRateLimitBanner` (row #10) — a rate-limit / overload BANNER appeared;
   *     surface a notify-only alert (no keystroke, no auto-retry). */
  onDeadTurnNotice?: (notice: DeadTurnNotice) => void | Promise<void>
  onSizeAlert?: (info: { sessionKey: string; severity: SizeSeverity; sizeBytes: number }) => void
  onRateLimitBanner?: (notice: RateLimitBannerNotice) => void | Promise<void>
  /**
   * Argus r4 BLOCKER (2026-06-08) — STATELESS-ONE-SHOT mode. When `true`, a
   * dispatch with no `spec.session` runs on a fresh disposable REPL that is
   * terminated after its single turn, so distinct stateless purposes sharing one
   * (instance, user, project, credential) never collapse into one `--resume`
   * transcript (cross-purpose bleed + unbounded growth). The gateway sets this on
   * the SHARED `cc-llm-*` substrate that every one-shot utility caller dispatches
   * through; the conversational + router warm REPLs leave it unset. See
   * `PersistentReplSubstrateOptions.ephemeral`.
   */
  ephemeral?: boolean
  /**
   * PER-TURN CONTEXT RESET (2026-06-17, import warm-session). When `true`, a
   * session-less dispatch on a REUSED warm REPL is preceded by a `/clear`
   * (written to the REPL PTY) so each turn runs on a freshly-cleared context —
   * ONE warm process, isolated per-turn context. Wired on the history-import
   * substrate (`cc-import-*`) only. See
   * `PersistentReplSubstrateOptions.reset_context_per_turn`.
   */
  reset_context_per_turn?: boolean
}

/**
 * S2 supervision state-file paths under an instance home. The single source of
 * truth for the `<home>/.neutron/*` layout — used both by the substrate selector
 * (to wire the watchdog) and by the gateway boot (to mount the admin-respawn
 * endpoint against the SAME registry path, so the operator route resolves the
 * live supervised substrate without path drift).
 */
export interface ReplSupervisionPaths {
  stateDir: string
  replRegistryPath: string
  pendingRespawnsPath: string
  restartMarkersPath: string
  heartbeatFile: string
}

export function deriveReplSupervisionPaths(home: string): ReplSupervisionPaths {
  const stateDir = join(home, '.neutron')
  return {
    stateDir,
    replRegistryPath: join(stateDir, 'repl-registry.json'),
    pendingRespawnsPath: join(stateDir, '.pending-respawns.json'),
    restartMarkersPath: join(stateDir, '.restart-markers.json'),
    heartbeatFile: join(stateDir, '.heartbeat'),
  }
}

/**
 * Construct the Claude Code substrate. UNCONDITIONALLY builds the persistent
 * interactive-REPL substrate — there is no env toggle and no fallback (the
 * `NEUTRON_PERSISTENT_REPL` flag + the legacy per-turn `claude -p` path were
 * removed in the S3 rip-replace; `git revert` is the only rollback). The options
 * bag is mapped onto `createPersistentReplSubstrate` (one warm interactive
 * `claude` REPL per (substrate_instance_id, user, project, credential), driven
 * over the dev-channel, exempt from the June-15 `claude -p` cap). Every drain
 * call site consumes the same `Event` union.
 */
export function createClaudeCodeSubstrateAuto(options: ClaudeCodeSubstrateOptions): Substrate {
  const p: PersistentReplSubstrateOptions = {
    substrate_instance_id: options.substrate_instance_id,
  }
  if (options.cwd !== undefined) p.cwd = options.cwd
  if (options.claude_bin !== undefined) p.claude_bin = options.claude_bin
  if (options.skip_permissions !== undefined) p.skip_permissions = options.skip_permissions
  if (options.env !== undefined) p.env = options.env
  // Thread the per-instance config dir so the interactive-Max-login child can
  // self-refresh its own OAuth token from its `.credentials.json` (Codex r2 P1).
  if (options.claude_config_dir !== undefined) p.claudeConfigDir = options.claude_config_dir
  // S3 §2 — thread the conversational identity + selected credential into the
  // pool key (closes #104; makes the substrate instance-isolation-SAFE).
  if (options.user_id !== undefined) p.user_id = options.user_id
  if (options.project_id !== undefined) p.project_id = options.project_id
  if (options.credential_identity !== undefined) p.credential_identity = options.credential_identity
  // S3 #106 — redelivery routing + injected sink.
  if (options.instance_slug !== undefined) p.instance_slug = options.instance_slug
  if (options.delivery_topic_id !== undefined) p.delivery_topic_id = options.delivery_topic_id
  if (options.onRecoveredReply !== undefined) p.onRecoveredReply = options.onRecoveredReply
  // Notice-family DI seams (rows #10/#11/#13) — forward so the gateway path can
  // wire user-facing delivery instead of the stderr-only fallback (Codex PR #67).
  if (options.onDeadTurnNotice !== undefined) p.onDeadTurnNotice = options.onDeadTurnNotice
  if (options.onSizeAlert !== undefined) p.onSizeAlert = options.onSizeAlert
  if (options.onRateLimitBanner !== undefined) p.onRateLimitBanner = options.onRateLimitBanner
  // Argus r4 BLOCKER — stateless one-shot disposable-REPL mode (session-less
  // dispatches get a fresh, terminated-after-turn REPL; no shared transcript).
  if (options.ephemeral !== undefined) p.ephemeral = options.ephemeral
  // Import warm-session — per-turn `/clear` reset on a reused warm REPL.
  if (options.reset_context_per_turn !== undefined) {
    p.reset_context_per_turn = options.reset_context_per_turn
  }

  // Sprint-2 supervision: derive a per-instance persisted REPL registry + state dir
  // under the instance home and ensure the live watchdog (wedge/crash detect →
  // `--resume` respawn) + heartbeat run once per registry.
  const home = options.cwd ?? process.env['NEUTRON_HOME']
  if (home !== undefined) {
    const paths = deriveReplSupervisionPaths(home)
    // Create the state dir up-front: registry-lock opens `<dir>/.registry.lock`
    // and the heartbeat opens `<dir>/.heartbeat` with O_WRONLY|O_CREAT, both of
    // which ENOENT (and silently degrade supervision) if the parent is missing.
    try {
      mkdirSync(paths.stateDir, { recursive: true })
    } catch {
      /* best-effort; a write failure later degrades supervision, never bricks */
    }
    p.replRegistryPath = paths.replRegistryPath
    p.pendingRespawnsPath = paths.pendingRespawnsPath
    p.restartMarkersPath = paths.restartMarkersPath
    // Register the live options so the watchdog tick + the operator admin-respawn
    // endpoint actuate each session with its OWNING substrate's options (keyed by
    // pool key).
    registerSupervisedSubstrate(p)
    // Idempotent per registry (startReplWatchdog self-dedupes + tracks its handle
    // for shutdown), so a per-turn call starts exactly ONE watchdog per instance
    // registry and a post-shutdown restart re-arms cleanly.
    startReplWatchdog(p, { heartbeatFile: paths.heartbeatFile })
  }
  return createPersistentReplSubstrate(p)
}
