/**
 * build-settings.ts — generate the per-session `--settings` JSON that wires
 * the enforce-reply Stop hook.
 *
 * LIFTED from Nova `gateway/index.ts` `generateSettingsConfig` (§ 1 #6,
 * ◆ ADAPTED-AT-BOUNDARY). Keeps the atomic-write + Stop→enforce-reply wiring.
 * DROPS the Nova-only hooks (email-draft UserPromptSubmit, PreCompact,
 * SessionStart) per the brief — those are Telegram/Nova-specific. Optionally
 * the SessionStart→checkpoint injection returns in Sprint 3.
 *
 * The Stop hook command is `bun <abs path to persistent/hooks/enforce-reply.ts>`.
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteFileSync } from '../../../atomic-write.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Absolute path to the lifted enforce-reply Stop hook. */
export const ENFORCE_REPLY_HOOK_PATH = join(HERE, 'hooks', 'enforce-reply.ts')
/** Absolute path to the TodoWrite→Work Board PostToolUse hook (WAVE 3.5 task B). */
export const TODO_SYNC_HOOK_PATH = join(HERE, 'hooks', 'todo-sync.ts')
/** Absolute path to the Activity Inspector's Pre/PostToolUse tool tap. */
export const ACTIVITY_TAP_HOOK_PATH = join(HERE, 'hooks', 'activity-tap.ts')

/**
 * Claude Code `permissions` block for a per-session `--settings` file (task 6,
 * T5 write-containment spike). Mirrors CC's settings-permissions schema: `allow`
 * / `deny` / `ask` are arrays of rule strings (`Write(/abs/scope/**)`,
 * `Edit(...)`, `Bash`, …) and `defaultMode` sets the base posture (e.g.
 * `'default'`). When present on a ritual REPL, the `deny` rules are LOAD-BEARING
 * write containment — but ONLY if the substrate's `tool-use-approve`
 * auto-approver is also disabled (`disableToolUseAutoApprove`), or the approver
 * clicks "Yes" past the prompt and the deny is theater. Shape-only here; the
 * spike empirically determines the exact rule strings that fail closed. */
export interface SettingsPermissions {
  allow?: string[]
  deny?: string[]
  ask?: string[]
  defaultMode?: string
}

/**
 * Coordinates the TodoWrite→Work Board PostToolUse hook needs to POST the agent's
 * todo list back to the substrate sink. Baked into the hook COMMAND (as an env
 * prefix) at spawn time — the sink port/token/session are all known then. When
 * present, `buildSettings` emits a `PostToolUse` matcher scoped to `TodoWrite`.
 */
export interface TodoSyncHookConfig {
  /** The substrate reply-sink loopback port. */
  sinkPort: number
  /** Shared secret for sink POSTs (X-Sink-Token). */
  sinkToken: string
  /** The substrate's `--session-id` (the sink's session key). */
  sessionId: string
  /** Override the todo-sync hook path (tests). Default: the shipped hook. */
  hookPath?: string
}

/**
 * Coordinates the Activity Inspector's tool tap needs to POST each tool
 * start/finish back to the substrate sink. Same shape + same baked-env-prefix
 * mechanism as {@link TodoSyncHookConfig}. When present, `buildSettings` emits a
 * `PreToolUse` hook AND an additional unscoped `PostToolUse` matcher group, so
 * every tool the agent touches is reported on both phases (a `pre` with no `post`
 * is the hang signal the inspector exists to show).
 */
export interface ActivityTapHookConfig {
  /** The substrate reply-sink loopback port. */
  sinkPort: number
  /** Shared secret for sink POSTs (X-Sink-Token). */
  sinkToken: string
  /** The substrate's `--session-id` (the sink's session key). */
  sessionId: string
  /** Override the activity-tap hook path (tests). Default: the shipped hook. */
  hookPath?: string
}

export interface BuildSettingsInput {
  /** Absolute path to write the settings JSON to. */
  settingsPath: string
  /** Override the enforce-reply hook path (tests). Default: the lifted hook. */
  hookPath?: string
  /** Override the bun binary used to run the hook. Default `bun`. */
  bunBin?: string
  /**
   * WAVE 3.5 task B — when supplied, a `PostToolUse` hook (matcher `TodoWrite`) is
   * wired ALONGSIDE the Stop hook, forwarding the agent's TodoWrite list to the
   * sink's `/todo-sync` so multi-step work auto-populates the Work Board. Absent ⇒
   * no `PostToolUse` key (byte-identical to today for every REPL that doesn't opt
   * in — e.g. the disposable Trident build REPLs). */
  todoSync?: TodoSyncHookConfig
  /**
   * ACTIVITY INSPECTOR — when supplied, the tool tap is wired on `PreToolUse`
   * (unscoped matcher) plus an extra unscoped `PostToolUse` matcher group, so the
   * inspector panel can show what the agent is doing right now. Absent ⇒ neither
   * is emitted (byte-identical to today for every REPL that doesn't opt in — the
   * disposable Trident build REPLs and the untrusted history-import REPL). */
  activityTap?: ActivityTapHookConfig
  /**
   * Optional CC `permissions` block written ALONGSIDE the Stop hook (task 6).
   * When provided, a `permissions` key is emitted into the settings JSON with
   * exactly the sub-keys the caller set (empty/undefined sub-arrays are dropped
   * so the written policy is minimal). Absent ⇒ today's behavior (Stop hook
   * only, no `permissions` key), byte-identical for every existing caller. */
  permissions?: SettingsPermissions
}

/**
 * Write the per-session settings JSON wiring the Stop hook and return the
 * path. The hook guarantees a channel-originated turn cannot end without a
 * `reply()` tool call — the exactly-one-reply invariant the bridge depends on.
 */
export function buildSettings(input: BuildSettingsInput): string {
  const hookPath = input.hookPath ?? ENFORCE_REPLY_HOOK_PATH
  const bunBin = input.bunBin ?? 'bun'
  const hooks: Record<string, unknown> = {
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: `${bunBin} ${hookPath}` }] }],
  }
  // WAVE 3.5 task B — the TodoWrite→Work Board PostToolUse hook. Its command bakes
  // SINK_PORT/SINK_TOKEN/SESSION_ID as an env prefix so the hook subprocess can
  // reach the loopback sink; the token here matches the mcp-config's SINK_TOKEN
  // (this settings file is written 0600, same owner-only posture). Absent ⇒ no
  // PostToolUse key at all.
  if (input.todoSync !== undefined) {
    const t = input.todoSync
    const todoHookPath = t.hookPath ?? TODO_SYNC_HOOK_PATH
    const envPrefix = `SINK_PORT=${t.sinkPort} SINK_TOKEN=${t.sinkToken} SESSION_ID=${t.sessionId}`
    hooks['PostToolUse'] = [
      {
        matcher: 'TodoWrite',
        hooks: [{ type: 'command', command: `${envPrefix} ${bunBin} ${todoHookPath}` }],
      },
    ]
  }
  // ACTIVITY INSPECTOR — the tool tap, on BOTH phases with an unscoped matcher.
  // `PreToolUse` gives "started Bash: bun test"; the extra unscoped `PostToolUse`
  // group gives "finished Bash". APPENDS to any PostToolUse array the todo-sync
  // block created above rather than replacing it — CC evaluates every matcher
  // group, so the TodoWrite→board sync and the tap coexist. Absent config ⇒
  // neither key is touched.
  if (input.activityTap !== undefined) {
    const a = input.activityTap
    const tapPath = a.hookPath ?? ACTIVITY_TAP_HOOK_PATH
    const base = `SINK_PORT=${a.sinkPort} SINK_TOKEN=${a.sinkToken} SESSION_ID=${a.sessionId}`
    const cmd = (phase: 'pre' | 'post'): string =>
      `${base} TAP_PHASE=${phase} ${bunBin} ${tapPath}`
    hooks['PreToolUse'] = [
      { matcher: '', hooks: [{ type: 'command', command: cmd('pre') }] },
    ]
    const post = Array.isArray(hooks['PostToolUse']) ? (hooks['PostToolUse'] as unknown[]) : []
    hooks['PostToolUse'] = [
      ...post,
      { matcher: '', hooks: [{ type: 'command', command: cmd('post') }] },
    ]
  }
  const settings: Record<string, unknown> = { hooks }
  // Task 6 (T5 write-containment) — emit a `permissions` block ALONGSIDE the Stop
  // hook when the caller provides one (the ritual write-containment variant). Only
  // the sub-keys actually set are written, so a deny-only ritual doesn't emit an
  // empty `allow`/`ask`. Absent ⇒ no `permissions` key at all (byte-identical to
  // the pre-task-6 write for every existing caller).
  if (input.permissions !== undefined) {
    const p = input.permissions
    const perms: Record<string, unknown> = {}
    if (p.allow !== undefined && p.allow.length > 0) perms['allow'] = p.allow
    if (p.deny !== undefined && p.deny.length > 0) perms['deny'] = p.deny
    if (p.ask !== undefined && p.ask.length > 0) perms['ask'] = p.ask
    if (p.defaultMode !== undefined) perms['defaultMode'] = p.defaultMode
    // Only emit `permissions` when at least one sub-key survived the minimality
    // filter above — an all-empty input must not write a hollow `permissions: {}`
    // (Argus r1 nit; keeps the "minimal policy" contract in the header).
    if (Object.keys(perms).length > 0) settings['permissions'] = perms
  }
  atomicWriteFileSync(
    input.settingsPath,
    JSON.stringify(settings, null, 2),
    // 0600, not 0644 (adversarial security review 2026-07-20). This file is the
    // session's Stop-hook wiring today and becomes the session's PERMISSION
    // POLICY under the tool-security redesign. World-readable was already
    // unnecessary; world-readable security policy would be a hole. Its parent
    // dir is 0700 per-spawn (spawn.ts).
    { mode: 0o600 },
  )
  return input.settingsPath
}
