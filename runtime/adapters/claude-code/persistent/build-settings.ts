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

export interface BuildSettingsInput {
  /** Absolute path to write the settings JSON to. */
  settingsPath: string
  /** Override the enforce-reply hook path (tests). Default: the lifted hook. */
  hookPath?: string
  /** Override the bun binary used to run the hook. Default `bun`. */
  bunBin?: string
}

/**
 * Write the per-session settings JSON wiring the Stop hook and return the
 * path. The hook guarantees a channel-originated turn cannot end without a
 * `reply()` tool call — the exactly-one-reply invariant the bridge depends on.
 */
export function buildSettings(input: BuildSettingsInput): string {
  const hookPath = input.hookPath ?? ENFORCE_REPLY_HOOK_PATH
  const bunBin = input.bunBin ?? 'bun'
  atomicWriteFileSync(
    input.settingsPath,
    JSON.stringify(
      {
        hooks: {
          Stop: [{ matcher: '', hooks: [{ type: 'command', command: `${bunBin} ${hookPath}` }] }],
        },
      },
      null,
      2,
    ),
    // 0600, not 0644 (adversarial security review 2026-07-20). This file is the
    // session's Stop-hook wiring today and becomes the session's PERMISSION
    // POLICY under the tool-security redesign. World-readable was already
    // unnecessary; world-readable security policy would be a hole. Its parent
    // dir is 0700 per-spawn (spawn.ts).
    { mode: 0o600 },
  )
  return input.settingsPath
}
