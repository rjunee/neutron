/**
 * session-config-paths.ts — where a REPL's per-session config files live.
 *
 * ONE OWNER FOR A PATH THAT IS DERIVED TWICE (#539). `spawn.ts` computes these when
 * it writes them; the boot-adoption pass computes them again for a child it did NOT
 * spawn, so that teardown can still unlink them when that child finally dies. A
 * second, hand-copied derivation would leave a re-adopted session unable to reclaim
 * files that carry its dev-channel CREDENTIAL in plaintext — and the failure would be
 * invisible, because nothing observes a file that is merely never deleted.
 *
 * THE CHANNEL NAME IS THE KEY, and that is what makes re-deriving them sound: it is
 * 16 random bytes minted per spawn (`spawn.ts`), it is persisted on the registry row,
 * and it names the directory. Same channel name, same files, whichever process is
 * asking.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The per-session config file set for `channelName`. Pure — creates nothing. */
export interface ReplSessionConfigPaths {
  /** The 0700 per-spawn directory holding all of them. */
  dir: string
  /** `--mcp-config`: wires the dev-channel. CARRIES THE CHILD'S SINK CREDENTIAL. */
  mcpConfigPath: string
  /** `--settings`: the enforce-reply Stop hook (plus any write-containment block). */
  settingsPath: string
  /** The tool-bridge manifest — written ONLY when the bridge is attached. */
  toolsManifestPath: string
}

export function replSessionConfigPaths(channelName: string): ReplSessionConfigPaths {
  const dir = join(tmpdir(), `neutron-repl-${channelName}`)
  const base = join(dir, 'session')
  return {
    dir,
    mcpConfigPath: `${base}-mcp.json`,
    settingsPath: `${base}-settings.json`,
    toolsManifestPath: `${base}-tools.json`,
  }
}
