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

export interface BuildSettingsInput {
  /** Absolute path to write the settings JSON to. */
  settingsPath: string
  /** Override the enforce-reply hook path (tests). Default: the lifted hook. */
  hookPath?: string
  /** Override the bun binary used to run the hook. Default `bun`. */
  bunBin?: string
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
  const settings: Record<string, unknown> = {
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: `${bunBin} ${hookPath}` }] }],
    },
  }
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
