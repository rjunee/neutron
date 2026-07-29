/**
 * Producer-side substrate-error classification for the persistent-REPL adapter (O3).
 *
 * The persistent REPL is the PRODUCER of spawn/channel failures, so it stamps the
 * typed `SubstrateErrorClass` on the `error` event it emits — the composer's
 * credential-pool ladder then classifies on `code` first (falling back to its
 * message regexes for one release). This keeps the taxonomy contract's promise
 * that codes are stamped AT the producer, not re-derived downstream from prose.
 *
 * The two classes surfaced here (a subprocess spawn ENOENT and a REPL
 * spawn/channel-bind failure) mirror the composer's `detectBinaryNotFound` /
 * `detectChannelWedged` — but the adapter cannot import UP into the gateway, so
 * the shape-matching lives here alongside the producer.
 */

import type { SubstrateErrorClass } from '../../../events.ts'

/**
 * Map a spawn/channel failure MESSAGE (surfaced by `getOrSpawnSession` /
 * `spawnEphemeralSession` / the post-spawn assertion) to its typed class, or
 * `undefined` when it is neither a missing-binary nor a channel-wedge failure
 * (an ordinary retryable turn error the composer classifies by its own ladder).
 */
export function classifySpawnError(message: string): SubstrateErrorClass | undefined {
  // Bun's `spawn` → `Executable not found in $PATH: "claude"`; node/posix →
  // `spawn claude ENOENT`; a shell layer → `claude: command not found`. A
  // missing binary is FATAL — it must never launder into a 429 cooldown. Every
  // branch requires a `claude` mention so a spawn failure for SOME OTHER
  // executable (e.g. a helper the child shells out to) is not mislabelled as
  // "Claude not on PATH" — the real producer messages all name the binary.
  if (/executable not found in \$?path/i.test(message) && /claude/i.test(message)) return 'binary_not_found'
  if (/\bENOENT\b/.test(message) && /claude/i.test(message)) return 'binary_not_found'
  if (/claude:\s*command not found/i.test(message)) return 'binary_not_found'
  if (/no such file or directory/i.test(message) && /claude/i.test(message)) return 'binary_not_found'
  // The post-spawn assertion / respawn throw the four reasons via
  // `spawn failed (<reason>; …)`; the bare `channel-wedged` stderr tag and the
  // `channel not ready` turn-start guard are the same substrate-failure class.
  if (/spawn failed \((?:channel-wedged|no-channel-ready|no-http-health|dead-child)/i.test(message)) {
    return 'channel_wedged'
  }
  if (/\bchannel-wedged\b/i.test(message)) return 'channel_wedged'
  if (/persistent-repl:\s*channel not ready/i.test(message)) return 'channel_wedged'
  return undefined
}
