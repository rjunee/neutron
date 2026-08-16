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
 * The widest conflict marker this process will cause to be written, whatever `%L` asks for.
 *
 * `%L` is not ours: git derives it from the `conflict-marker-size` attribute of the path, which a
 * TRACKED `.gitattributes` in the merged repository sets — verified by handing git a driver that
 * does nothing but print `%L`, which reported `2000000` from a committed attributes file. A
 * conflict writes that many characters three times, so the same refusal that costs 302 bytes at
 * the default costs 6,000,281 at that setting, scaling linearly with a number the checkout chooses.
 *
 * IT BOUNDS BOTH CONFLICT PATHS, AND THE FIRST CUT OF IT BOUNDED ONLY ONE. That cut left
 * `delegateToGit` forwarding `%L` to `git merge-file` untouched, on the reasoning that the
 * delegated path's stated property is to be byte-for-byte what an unconfigured repo does, so
 * clamping it would make that claim false. THE REASONING WAS WRONG, and the file that disproves it
 * is in this repository: `.gitattributes` gives `docs/AS_BUILT.md` `merge=union`, and union never
 * reports a conflict at all. An unconfigured repo therefore writes ZERO markers on this path, not
 * six megabytes of them — so `git merge-file` was never the unconfigured behaviour here, and there
 * was no floor property to protect. (`docs/SYSTEM-OVERVIEW.md` had this right in the same words
 * while this docblock had it wrong; the measured 6,000,148 bytes from git alone was real, and only
 * the conclusion drawn from it was not.) Both call sites go through `markerWidth` now.
 *
 * THE VALUE IS A POLICY, NOT A MEASUREMENT, and is labelled as one. git's default is 7 and nothing
 * legitimate is near three digits, so 200 is far above any real setting while bounding the output
 * at a few hundred bytes of markers. It is not derived from a limit in git, which has none.
 */
const MAX_MARKER_SIZE = 200

/**
 * `%L` as a width this process is willing to act on: git's default for anything unparseable, at
 * least `minimum`, and never more than `MAX_MARKER_SIZE`.
 *
 * The ceiling is the whole point — see `MAX_MARKER_SIZE`. A digit string too large for a double
 * parses to `Infinity`, which `Math.min` pins to the ceiling like any other oversized value, so
 * there is no separate finiteness case to get wrong.
 */
function markerWidth(markerSize: string, minimum: number): number {
  const parsed = /^\d+$/.test(markerSize) ? Number(markerSize) : 7
  return Math.min(Math.max(parsed, minimum), MAX_MARKER_SIZE)
}

/**
 * Hand the merge back to git. Writes standard conflict markers into `ours` and returns git's exit
 * status.
 *
 * ONLY EVER CALLED WHERE GIT'S ANSWER IS A REAL ONE. Anything that could resolve away an entry goes
 * to `writeConflict` instead — see the header.
 */
function delegateToGit(base: string, ours: string, theirs: string, markerSize: string): number {
  // Floor of 0: git owns its own minimum on this path, and the only thing being imposed here is the
  // ceiling. `writeConflict` floors at 7 because it formats the markers itself.
  const size = markerWidth(markerSize, 0)
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
  const width = markerWidth(markerSize, 7)
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
