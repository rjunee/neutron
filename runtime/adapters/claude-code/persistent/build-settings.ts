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
 * Optional settings OVERLAY merged into the generated `--settings` JSON. Used by
 * the trident auto-mode launcher to fold its `permissions` (dontAsk allowlist +
 * deny list) and an EXTRA `PreToolUse` deny-guard hook into the SAME settings
 * file that already carries the enforce-reply Stop hook. Other (conversational,
 * import, dispatch) callers omit it → byte-identical behaviour to before.
 *
 * Merge rules: `permissions` is set verbatim; `PreToolUse` hooks are APPENDED to
 * (never replace) the file's hooks, and the enforce-reply `Stop` hook is always
 * preserved (the dev-channel exactly-one-reply invariant must hold for the
 * launcher turn too).
 */
export interface SettingsOverlay {
  permissions?: {
    defaultMode?: string
    allow?: string[]
    deny?: string[]
  }
  hooks?: {
    PreToolUse?: Array<{
      matcher: string
      hooks: Array<{ type: 'command'; command: string }>
    }>
  }
}

export interface BuildSettingsInput {
  /** Absolute path to write the settings JSON to. */
  settingsPath: string
  /** Override the enforce-reply hook path (tests). Default: the lifted hook. */
  hookPath?: string
  /** Override the bun binary used to run the hook. Default `bun`. */
  bunBin?: string
  /** Trident auto-mode overlay (permissions + extra PreToolUse hooks). */
  overlay?: SettingsOverlay
}

/**
 * Write the per-session settings JSON wiring the Stop hook (and, when an
 * `overlay` is supplied, the trident auto-mode permissions + PreToolUse
 * deny-guard) and return the path. The enforce-reply Stop hook is ALWAYS present:
 * it guarantees a channel-originated turn cannot end without a `reply()` tool
 * call — the exactly-one-reply invariant the bridge depends on, including the
 * trident launcher's single TRIDENT_RESULT reply.
 */
export function buildSettings(input: BuildSettingsInput): string {
  const hookPath = input.hookPath ?? ENFORCE_REPLY_HOOK_PATH
  const bunBin = input.bunBin ?? 'bun'
  const hooks: Record<string, unknown> = {
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: `${bunBin} ${hookPath}` }] }],
  }
  const settings: Record<string, unknown> = { hooks }
  const overlay = input.overlay
  if (overlay !== undefined) {
    if (overlay.permissions !== undefined) settings['permissions'] = overlay.permissions
    if (overlay.hooks?.PreToolUse !== undefined) {
      hooks['PreToolUse'] = overlay.hooks.PreToolUse
    }
  }
  atomicWriteFileSync(input.settingsPath, JSON.stringify(settings, null, 2), { mode: 0o644 })
  return input.settingsPath
}
