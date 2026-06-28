/**
 * @neutronai/gbrain-memory — absolute `gbrain` command + child-PATH resolver.
 *
 * THE production reachability bug (dogfood 2026-06-28 §gbrain): `install.sh`
 * GUARANTEES `gbrain` at `~/.bun/bin/gbrain` (#91), but that dir is ONLY on the
 * install script's own shell PATH. The generated launchd plist / systemd unit
 * give the SERVICE a curated PATH that OMITS the bun global-bin dir, so the
 * running server's `Bun.which('gbrain')` returns `null` → entity-page memory
 * sync DISABLED, the brain is never `gbrain init`'d (the init guard can't spawn
 * the binary), and recall silently falls back to Claude-Code file-memory. ND1
 * (#95) fixed the init *logic* but not *reachability*, so memory still didn't
 * work on the live install.
 *
 * This module is the runtime fix that repairs EXISTING installs on a code-update
 * + restart (no plist regeneration needed): resolve gbrain to an ABSOLUTE path
 * via a small probe list, and build a child PATH that carries both the gbrain
 * dir AND a `bun` dir so the binary's `#!/usr/bin/env bun` shebang re-resolves
 * even under the service's narrow PATH. A complementary one-line fix in
 * `neutron-service.sh` (`_service_path` gains `$BUN_INSTALL/bin`) makes freshly
 * generated plists/units correct from the start.
 *
 * Fail-soft by contract: when no `gbrain` is found anywhere, `resolveGbrainCommand`
 * returns `null` and callers preserve the existing one-time "memory DISABLED"
 * warning + logged-no-op degrade path — it never throws.
 */

import { accessSync, constants as fsConstants } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/** True when `p` exists and is executable (follows symlinks — the bun global
 * install symlinks `~/.bun/bin/gbrain` → its `src/cli.ts`, which carries +x). */
function isExecutableFile(p: string): boolean {
  if (p.length === 0) return false
  try {
    accessSync(p, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The ordered absolute probe paths for the `gbrain` binary, from `env`. The bun
 * global-bin dir (`$BUN_INSTALL/bin`, default `$HOME/.bun/bin`) — where
 * `bun install -g github:garrytan/gbrain` lands it — comes first, then the
 * conventional system bins. Exported for the unit test + reuse.
 */
export function gbrainProbePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = typeof env['HOME'] === 'string' ? env['HOME'] : ''
  const bunInstall =
    typeof env['BUN_INSTALL'] === 'string' && env['BUN_INSTALL'].length > 0
      ? env['BUN_INSTALL']
      : home.length > 0
        ? join(home, '.bun')
        : ''
  const candidates = [
    bunInstall.length > 0 ? join(bunInstall, 'bin', 'gbrain') : '',
    home.length > 0 ? join(home, '.bun', 'bin', 'gbrain') : '',
    '/usr/local/bin/gbrain',
    '/opt/homebrew/bin/gbrain',
    home.length > 0 ? join(home, '.local', 'bin', 'gbrain') : '',
  ]
  // Dedup (e.g. when BUN_INSTALL is exactly $HOME/.bun) preserving order.
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of candidates) {
    if (c.length === 0 || seen.has(c)) continue
    seen.add(c)
    out.push(c)
  }
  return out
}

/**
 * Resolve an ABSOLUTE path to the `gbrain` executable, or `null` if none is
 * found. PATH is honored FIRST (`Bun.which` — if the service PATH already
 * resolves gbrain, use exactly that), then the ordered probe list. The returned
 * path is always absolute, so spawning it does not depend on the child's PATH
 * for the binary itself (only the `bun` shebang re-resolution, which
 * {@link resolveGbrainChildPath} covers).
 */
export function resolveGbrainCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  // Honor the GIVEN env's PATH (not the ambient process PATH) so the doctor's
  // injected env + the unit test are deterministic; in the real boot path
  // `env` IS `process.env`, so this matches today's `Bun.which` behavior.
  const pathEnv = typeof env['PATH'] === 'string' ? env['PATH'] : ''
  const onPath = pathEnv.length > 0 ? Bun.which('gbrain', { PATH: pathEnv }) : null
  if (onPath !== null && isExecutableFile(onPath)) return onPath
  for (const candidate of gbrainProbePaths(env)) {
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

/**
 * Resolve the directory holding a usable `bun`. The running server IS a bun
 * process, so `process.execPath`'s dir is the most reliable bun location and is
 * always correct under the service's narrow PATH; `Bun.which('bun')` and the
 * conventional install dirs are fallbacks for odd launch contexts.
 */
export function resolveBunDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof process.execPath === 'string' && process.execPath.length > 0) {
    return dirname(process.execPath)
  }
  const onPath = Bun.which('bun')
  if (onPath !== null) return dirname(onPath)
  const home = typeof env['HOME'] === 'string' ? env['HOME'] : ''
  const bunInstall =
    typeof env['BUN_INSTALL'] === 'string' && env['BUN_INSTALL'].length > 0
      ? env['BUN_INSTALL']
      : home.length > 0
        ? join(home, '.bun')
        : ''
  const probes = [
    bunInstall.length > 0 ? join(bunInstall, 'bin', 'bun') : '',
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
    home.length > 0 ? join(home, '.local', 'bin', 'bun') : '',
  ]
  for (const p of probes) {
    if (isExecutableFile(p)) return dirname(p)
  }
  return null
}

/**
 * Build the PATH string for the spawned `gbrain` child. Prepends the resolved
 * gbrain dir and a `bun` dir (deduped) to the inherited PATH so the binary's
 * `#!/usr/bin/env bun` shebang re-resolves even when the service PATH omits the
 * bun global-bin dir. Pure (apart from `process.execPath` / `Bun.which`) so the
 * child env stays unit-testable.
 */
export function resolveGbrainChildPath(input: {
  command: string | null
  env: NodeJS.ProcessEnv
}): string {
  const { command, env } = input
  const existing = (typeof env['PATH'] === 'string' ? env['PATH'] : '')
    .split(':')
    .filter((d) => d.length > 0)
  const prepend: string[] = []
  // Only prepend the command's dir when it's an ABSOLUTE path — a bare
  // `gbrain` has `dirname` `.`, which must never pollute PATH.
  if (command !== null && isAbsolute(command)) prepend.push(dirname(command))
  const bunDir = resolveBunDir(env)
  if (bunDir !== null) prepend.push(bunDir)
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of [...prepend, ...existing]) {
    if (!seen.has(d)) {
      seen.add(d)
      out.push(d)
    }
  }
  return out.join(':')
}
