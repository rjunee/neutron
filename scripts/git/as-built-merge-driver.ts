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
 * reason a tracked `.gitattributes` is NOT used here. Stated as measured, because an earlier cut of
 * this paragraph claimed a declared-but-unconfigured driver is always FATAL and that is true of only
 * one of the two ways to be unconfigured (git 2.50.1, attribute present):
 *
 *     $ git merge --no-edit other   # attribute, merge.<name>.name set, no .driver
 *     fatal: custom merge driver as-built-log lacks command line.        MERGE_EXIT=128
 *
 *     $ git merge --no-edit other   # attribute, no merge.<name>.* config at all
 *     CONFLICT (content): Merge conflict in docs/AS_BUILT.md            MERGE_EXIT=1
 *
 * A fresh clone is the SECOND state, so committing the attribute would not hard-fail it — it would
 * silently swap the `merge=union` this path gets today for a conflict on every concurrent append,
 * for every outside contributor and for CI, and leave each of them one stray `merge.<name>.name`
 * away from the 128. Both outcomes are for `git merge` AND for the `git apply --3way` the publisher
 * uses. Keeping the attribute untracked means it is never present without the driver it names — the
 * same rule `scripts/install-git-hooks.sh` applies to the leak gate and its denylist: "a control and
 * its pattern source have to be installed together or neither is real." (The reverse half-state, a
 * driver config nothing points at, is inert and IS reachable; `scripts/install-merge-drivers.sh`
 * says exactly when.) Without the install the repo
 * behaves as it does today — `.gitattributes` gives this path `merge=union`, which interleaves
 * rather than conflicting; with the install, `$GIT_COMMON_DIR/info/attributes` takes precedence over
 * the tracked file and concurrent appends merge whole entries instead.
 *
 * THE FALLBACK IS TODAY'S BEHAVIOUR — EXCEPT WHERE TODAY'S BEHAVIOUR IS THE BUG. A textual
 * disagreement (both sides rewriting one entry, a diverged header, a file that does not parse as
 * this log) is handed to `git merge-file`, which writes git's own conflict markers and returns
 * git's own exit code. But a refusal whose CONTENT is "an entry present on one side is absent from
 * the other" must never be delegated, because a line-based merge reads a one-sided deletion as a
 * clean hunk and RESOLVES it: measured on a 20-entry log with `ours` truncated newest-first to two
 * entries, `git merge-file` exited 0, wrote no markers, and left 3 of 21 headings — the refusal
 * fired, said the right thing on stderr, and the entries were deleted anyway. Those refusals are
 * terminated here instead, by writing a conflict this process constructs: both sides verbatim
 * between markers, non-zero exit. Nothing downstream can resolve it silently and no byte of either
 * side is dropped on the way.
 *
 * ONLY THIS ONE PATH. `%P` is checked, so a `.gitattributes` in some checked-out repository that
 * points `merge=as-built-log` at other files gets git's own merge for them rather than this log's
 * semantics. It is a semantics guard, not a security one — nothing here executes anything from the
 * checkout — but a merge driver bound to a path it was not written for should decline, not improvise.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

import { mergeAsBuiltLog } from './as-built-log-merge.ts'

/** The one path this driver understands. Anything else is git's. */
const LOG_PATH = 'docs/AS_BUILT.md'

/**
 * The widest conflict marker this process will WRITE, whatever `%L` asks for.
 *
 * `%L` is not ours: git derives it from the `conflict-marker-size` attribute of the path, which a
 * TRACKED `.gitattributes` in the merged repository sets — verified by handing git a driver that
 * does nothing but print `%L`, which reported `2000000` from a committed attributes file. The
 * conflict this file constructs writes that many characters three times, so the same refusal that
 * costs 302 bytes at the default cost 6,000,281 bytes at that setting, scaling linearly with a
 * number the checkout chooses.
 *
 * WHAT THIS DOES AND DOES NOT CLOSE, because the honest version is narrower than "clamped".
 * `delegateToGit` still passes `%L` to `git merge-file` unclamped, and git does not bound it either
 * — measured, the same 2000000 produces 6,000,148 bytes from git alone on a three-line file. That
 * path is deliberately left alone: its stated property is that the fallback is byte-for-byte what
 * an unconfigured repo does, and clamping it would make that false to fix an amplification the
 * unconfigured repo has anyway. So this bound covers the output THIS code authors, and the
 * remaining exposure is git's own, identical with or without this driver installed. Git's default
 * is 7 and no real setting is near three digits, so 200 is far above any legitimate use.
 */
const MAX_MARKER_SIZE = 200

/**
 * Hand the merge back to git. Writes standard conflict markers into `ours` and returns git's exit
 * status, so this floor is byte-for-byte what an unconfigured repo does.
 *
 * ONLY EVER CALLED WHERE GIT'S ANSWER IS A REAL ONE. Anything that could resolve away an entry goes
 * to `writeConflict` instead — see the header.
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

/**
 * Write a conflict NOTHING can resolve for us: both sides whole, between markers, into `%A`.
 *
 * The reason rides on the marker LABEL rather than in the body, so the human who opens the file
 * reads why it refused without a single byte of either side being altered — and `git checkout
 * --ours/--theirs` style recovery still finds each side intact.
 */
function writeConflict(oursPath: string, ours: string, theirs: string, markerSize: string, reason: string): number {
  const size = /^\d+$/.test(markerSize) ? Number(markerSize) : 7
  const width = Number.isFinite(size) && size >= 7 ? Math.min(size, MAX_MARKER_SIZE) : 7
  const withNewline = (text: string): string => (text === '' || text.endsWith('\n') ? text : `${text}\n`)
  writeFileSync(
    oursPath,
    `${'<'.repeat(width)} ours — REFUSED by as-built-merge-driver: ${reason}\n` +
      `${withNewline(ours)}${'='.repeat(width)}\n${withNewline(theirs)}${'>'.repeat(width)} theirs\n`,
  )
  return 1
}

export function runDriver(argv: string[]): number {
  const [base, ours, theirs, markerSize = '7', path = LOG_PATH] = argv
  if (base === undefined || ours === undefined || theirs === undefined) {
    process.stderr.write('as-built-merge-driver: expected %O %A %B %L %P\n')
    return 2
  }

  let contents: { base: string; ours: string; theirs: string }
  try {
    contents = {
      base: readFileSync(base, 'utf8'),
      ours: readFileSync(ours, 'utf8'),
      theirs: readFileSync(theirs, 'utf8'),
    }
  } catch (err) {
    // The inputs could not even be read, so there is nothing to construct a conflict OUT of. git
    // will fail on them too, which is the loud outcome; a clean exit here is the only wrong answer.
    process.stderr.write(`as-built-merge-driver: ${path}: ${String(err)} — leaving it to git\n`)
    const code = delegateToGit(base, ours, theirs, markerSize)
    return code === 0 ? 1 : code
  }

  // Bound to a path this driver was not written for — decline to impose this log's semantics on it.
  if (path.replaceAll('\\', '/') !== LOG_PATH && !path.replaceAll('\\', '/').endsWith(`/${LOG_PATH}`)) {
    process.stderr.write(`as-built-merge-driver: ${path} is not ${LOG_PATH} — leaving it to git\n`)
    return delegateToGit(base, ours, theirs, markerSize)
  }

  try {
    const merged = mergeAsBuiltLog(contents.base, contents.ours, contents.theirs)
    if (merged.ok) {
      writeFileSync(ours, merged.text)
      return 0
    }
    if (merged.wouldLoseEntries) {
      process.stderr.write(`as-built-merge-driver: ${path}: ${merged.reason} — REFUSED, conflict left for a human\n`)
      return writeConflict(ours, contents.ours, contents.theirs, markerSize, merged.reason)
    }
    process.stderr.write(`as-built-merge-driver: ${path}: ${merged.reason} — leaving it to git\n`)
    return delegateToGit(base, ours, theirs, markerSize)
  } catch (err) {
    // An unexpected throw means this code does not understand the input, which is exactly when it
    // has no business asserting that a deletion in it was deliberate. Conflict, not delegation.
    process.stderr.write(`as-built-merge-driver: ${path}: ${String(err)} — REFUSED, conflict left for a human\n`)
    return writeConflict(ours, contents.ours, contents.theirs, markerSize, String(err))
  }
}

if (import.meta.main) process.exit(runDriver(process.argv.slice(2)))
