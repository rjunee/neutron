/**
 * The git MERGE DRIVER for `docs/AS_BUILT.md`.
 *
 * git calls this with `%O %A %B %L %P` — base file, ours file, theirs file, conflict-marker size,
 * and the path being merged. The merged result must be written back over `%A`; exit 0 means
 * "merged cleanly", any non-zero exit means "conflicted, I left markers".
 *
 * DECLARED IN THE TRACKED `.gitattributes`; ONLY THE COMMAND IS INSTALLED.
 * `docs/AS_BUILT.md merge=as-built-log` is committed, and `scripts/install-merge-drivers.sh` writes
 * only the `merge.as-built-log.driver` config that says how to run this file.
 *
 * An earlier cut of this docblock asserted the opposite — that the attribute had to stay untracked
 * because git treats a declared-but-unconfigured driver as FATAL. That is measurably wrong, and it
 * was the load-bearing justification for the whole design, so here is the measurement (git 2.50.1,
 * fresh repo, attribute tracked, two divergent branches):
 *
 *     no merge.as-built-log.* config at all
 *       git merge --no-edit other  → CONFLICT (content) ...            exit 1
 *       git apply --3way --index   →                                   exit 0
 *
 *     merge.as-built-log.name set, merge.as-built-log.driver UNSET
 *       git merge --no-edit other  → fatal: ... lacks command line.     exit 128
 *
 * Exit 128 is real, but it is reachable ONLY from a half-written config — a state the installer
 * used to be able to create and now cannot, because it never writes `.name` at all. The
 * unconfigured case, which is what a fresh clone, an outside contributor, CI and GitHub's own
 * server-side merge actually get, is an ORDINARY CONFLICT. So tracking the attribute costs those
 * consumers nothing and is the only way any of them see the rule; a checkout that has run the
 * installer gets the clean entry-aware merge on top.
 *
 * THE FALLBACK IS TODAY'S BEHAVIOUR. Anything this driver will not merge — both sides editing one
 * entry, a diverged header, a file that does not parse as a log, an unexpected throw — is handed
 * to `git merge-file`, which writes git's own conflict markers and returns git's own exit code. A
 * merge driver's failure mode has to be "a conflict a human reads", never "a plausible-looking
 * file nobody diffed".
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

import { mergeAsBuiltLog } from './as-built-log-merge.ts'

/**
 * Hand the merge back to git. Writes standard conflict markers into `ours` and returns git's exit
 * status, so the floor of this mechanism is byte-for-byte what an unconfigured repo does.
 */
function delegateToGit(base: string, ours: string, theirs: string, markerSize: string): number {
  const size = /^\d+$/.test(markerSize) ? markerSize : '7'
  const res = spawnSync(
    'git',
    ['merge-file', `--marker-size=${size}`, '-L', 'ours', '-L', 'base', '-L', 'theirs', ours, base, theirs],
    { stdio: 'inherit' },
  )
  // A signal, or a git that would not run at all, is not a clean merge.
  return res.status ?? 1
}

export function runDriver(argv: string[]): number {
  const [base, ours, theirs, markerSize = '7', path = 'docs/AS_BUILT.md'] = argv
  if (base === undefined || ours === undefined || theirs === undefined) {
    process.stderr.write('as-built-merge-driver: expected %O %A %B %L %P\n')
    return 2
  }

  try {
    const merged = mergeAsBuiltLog(
      readFileSync(base, 'utf8'),
      readFileSync(ours, 'utf8'),
      readFileSync(theirs, 'utf8'),
    )
    if (!merged.ok) {
      process.stderr.write(`as-built-merge-driver: ${path}: ${merged.reason} — leaving it to git\n`)
      return delegateToGit(base, ours, theirs, markerSize)
    }
    writeFileSync(ours, merged.text)
    return 0
  } catch (err) {
    process.stderr.write(`as-built-merge-driver: ${path}: ${String(err)} — leaving it to git\n`)
    return delegateToGit(base, ours, theirs, markerSize)
  }
}

if (import.meta.main) process.exit(runDriver(process.argv.slice(2)))
