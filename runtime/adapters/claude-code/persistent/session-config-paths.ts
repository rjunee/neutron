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
import { join, resolve, sep } from 'node:path'

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

/**
 * THE CONTAINMENT PROPERTY, ENFORCED WHERE THE PATH IS BUILT (#539, Argus r27).
 *
 * These paths are not merely read: the child-exit path UNLINKS them
 * (`repl-session.ts`, `session.configPaths`). So whatever reaches this function decides
 * which files get deleted, and until adoption existed the answer was always a channel
 * name `spawn.ts` had generated in-process moments earlier. **Adoption is the first
 * caller that takes the value from DISK** — where it can be corrupted, hand-edited, or
 * written by anything else running as this user — and `join` is happy to resolve
 * `x/../../../some/dir` right out of the temp directory.
 *
 * THIS CHECK IS LEXICAL, AND CLAIMS ONLY THAT (Argus r28). It answers "could this STRING
 * ever name something outside the temp dir" — a real question, worth answering at
 * construction, and holding for every caller including ones that do not exist yet. It
 * cannot answer the other one: `/tmp/neutron-repl-<32hex>` passes every lexical test while
 * BEING A SYMLINK elsewhere, and no amount of string resolution sees that.
 *
 * The filesystem question is answered where it is answerable — `unlinkSessionConfigs`, the
 * destructive site, where the directory exists. It cannot be answered here: this builder
 * runs at SPAWN time, before the directory exists, so a `realpath` would throw on a
 * legitimate first spawn. Three layers, three questions: the registry's shape check asks
 * whether the row could have come from this system, this asks whether the string can
 * escape, and cleanup asks where the directory really is.
 *
 * Throws rather than sanitising: a name that escapes is not a name with a typo, and
 * silently rewriting it would hand back paths the caller did not ask for and then delete
 * files at them.
 */
export function replSessionConfigPaths(channelName: string): ReplSessionConfigPaths {
  const dir = join(tmpdir(), `neutron-repl-${channelName}`)
  const root = resolve(tmpdir())
  const resolved = resolve(dir)
  // `sep` on the prefix so `/tmp/neutron-repl-x` cannot be satisfied by `/tmpevil/...`,
  // and the equality case rejected too: the temp root itself is not a session directory.
  if (resolved === root || !resolved.startsWith(root + sep)) {
    throw new Error(
      `persistent-repl: refusing to derive session config paths for channel ` +
        `${JSON.stringify(channelName)} — they resolve to ${resolved}, outside the temp directory. ` +
        'These paths are unlinked when the child exits, so a name that escapes containment would ' +
        'delete files elsewhere.',
    )
  }
  const base = join(dir, 'session')
  return {
    dir,
    mcpConfigPath: `${base}-mcp.json`,
    settingsPath: `${base}-settings.json`,
    toolsManifestPath: `${base}-tools.json`,
  }
}
