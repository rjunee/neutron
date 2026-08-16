/**
 * The git MERGE DRIVER for `docs/AS_BUILT.md`.
 *
 * git calls this with `%O %A %B %L %P` — base file, ours file, theirs file, conflict-marker size,
 * and the path being merged. The merged result must be written back over `%A`; exit 0 means
 * "merged cleanly", any non-zero exit means "conflicted, I left markers".
 *
 * INSTALLED, NEVER DECLARED IN A TRACKED FILE. The attribute that binds this driver to the path
 * lives in `.git/info/attributes`, written by `scripts/install-merge-drivers.sh` in the SAME step
 * that writes the `merge.as-built-log.driver` config. That pairing is deliberate and it is the
 * reason a tracked `.gitattributes` is NOT used here: a `merge=as-built-log` line committed to the
 * repo would reach every clone, and git treats a declared-but-unconfigured driver as FATAL rather
 * than falling back —
 *
 *     $ git merge --no-edit other        # attribute present, driver not configured
 *     fatal: custom merge driver probe lacks command line.
 *     MERGE_EXIT=128
 *
 * — for `git merge` AND for the `git apply --3way` the publisher uses. So a fresh clone, an
 * outside contributor, or CI would hard-fail on any merge touching this file until somebody ran an
 * install step they had no reason to know about. Keeping the attribute untracked means the
 * attribute and its driver are installed together or neither is, which is the same rule
 * `scripts/install-git-hooks.sh` already applies to the leak gate and its denylist: "a control and
 * its pattern source have to be installed together or neither is real." Without the install the
 * repo behaves exactly as it does today; with it, concurrent appends merge.
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
