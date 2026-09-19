import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitRangeArgv } from '../git-range.ts'
import { MERGE_DIFF_BYTES_MAX, mergeDiffTooLargeReason } from '../merge-diff-limit.ts'
import type { BuildSnapshot, GateResult } from '../build-run.ts'
import type { RunHostCommand } from '../merge.ts'
import { assessBaseDrift, shouldHoldForBaseDrift } from '../merge.ts'
import { unknownCause } from './unknown-cause.ts'

const fullOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const unknown = (detail: string): GateResult => ({ kind: 'unknown', detail })
const blocked = (on: string): GateResult => ({ kind: 'blocked', on })

/** #1133 (G166): a commit-message line that begins the session trailer. Deliberately NO `u`
 * flag: in non-unicode mode ECMAScript's Canonicalize never folds a code unit >= 128 onto an
 * ASCII one, so this is exactly the wrapper's ASCII-only `[Cc][Ll]...[Nn]:` bracket pattern
 * (trident/commit-with-resolved-head.sh) expressed in JS — a look-alike letter from another
 * script does not match, the same as it does not match there. Line-anchored: a mention of the
 * token inside a sentence is not a trailer.
 */
const sessionTrailerLine = /^claude-session:/i

/** Every commit in `launchBase..head` whose raw message carries a session-trailer line.
 * The message is read from the raw object (`git cat-file commit`), the same bytes the wrapper
 * strips, never from `git log` porcelain. Any step that cannot be measured is `unknown`, so a
 * range that cannot be listed or a commit that cannot be read never publishes on the strength
 * of what was not seen. (The host runner decodes stdout as UTF-8; a non-UTF-8 body decodes with
 * U+FFFD, and the line structure and the ASCII token survive that.)
 */
async function sessionTrailerCarriers(
  run: RunHostCommand, repo: string, launchBase: string, head: string,
): Promise<{ kind: 'carriers'; shas: string[] } | { kind: 'unknown'; detail: string }> {
  if (!fullOid.test(launchBase)) return { kind: 'unknown', detail: 'Publication launch base is not a full OID' }
  const listed = await run(gitRangeArgv({ repo_path: repo, subcommand: 'rev-list', base: launchBase, head }), repo)
  if (!listed.ok) return { kind: 'unknown', detail: 'Publication commit range could not be listed' }
  const shas = listed.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (shas.some(sha => !fullOid.test(sha))) return { kind: 'unknown', detail: 'Publication commit range listing is malformed' }
  const carriers: string[] = []
  for (const sha of shas) {
    const object = await run(['git', '-C', repo, 'cat-file', 'commit', sha], repo)
    if (!object.ok) return { kind: 'unknown', detail: `Publication commit ${sha} could not be read` }
    // A commit object is headers, one blank line, then the message. The host runner trims
    // stdout, so a commit whose message is EMPTY (`--allow-empty-message`, which the wrapper
    // honours) arrives as its headers alone with no separator left: that is a measured empty
    // message — no line can carry the trailer — not an unreadable object, and it is allowed.
    // Every header line is `name value` or a ` `-continued gpgsig line, so the first `\n\n` is
    // always the header/message boundary and never falls inside the headers.
    const separator = object.stdout.indexOf('\n\n')
    const message = separator < 0 ? '' : object.stdout.slice(separator + 2)
    if (message.split('\n').some(line => sessionTrailerLine.test(line))) carriers.push(sha)
  }
  return { kind: 'carriers', shas: carriers }
}

/** #1133 (G166) as one gate result, shared by EVERY path that pushes a build branch to origin:
 * the checked publishers (`publicationReadiness` below) and the stranded-work salvage push
 * (`trident/publication.ts` `publishBuiltCommit`). `blocked` names every carrier in
 * `launchBase..head`; `unknown` is a range or commit that could not be measured, and a caller
 * must refuse on it the same as on `blocked` — a push on the strength of what was not seen is
 * the defect this gate exists to close.
 */
export async function sessionTrailerReadiness(
  run: RunHostCommand, repo: string, launchBase: string, head: string,
): Promise<GateResult> {
  const trailers = await sessionTrailerCarriers(run, repo, launchBase, head)
  if (trailers.kind === 'unknown') return unknown(trailers.detail)
  if (trailers.shas.length > 0) {
    return blocked(`Publication branch carries a Claude-Session trailer on ${trailers.shas.length} commit(s) above the launch base: ${trailers.shas.join(', ')}`)
  }
  return { kind: 'allow' }
}

/** G083, G085, G086, G166: measure the branch, launch ancestry and commit messages before
 * publication. Lease enforcement and the post-push witness stay in the publication effect.
 */
export async function publicationReadiness(
  run: RunHostCommand, repo: string, branch: string, launchBase: string, snapshot: BuildSnapshot, runId: string,
): Promise<GateResult> {
  try {
    const local = await run(['git', '-C', repo, 'rev-parse', '--verify', `refs/heads/${branch}`], repo)
    const head = local.stdout.trim()
    if (!local.ok || !fullOid.test(head)) return unknown('Publication branch head could not be resolved')
    if (head !== snapshot.head) return blocked('Publication branch differs from reviewed head')
    const remote = await run(['git', '-C', repo, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`], repo)
    if (!remote.ok) return unknown('Publication remote branch state could not be read')
    const rows = remote.stdout.trim()
    if (rows !== '' && !new RegExp(`^(?:[0-9a-f]{40}|[0-9a-f]{64})\\s+${escapeRegex(`refs/heads/${branch}`)}$`).test(rows)) {
      return unknown('Publication remote branch observation is malformed')
    }
    if (rows === '') {
      const ancestry = await run(['git', '-C', repo, 'merge-base', '--is-ancestor', launchBase, head], repo)
      if (!ancestry.ok) return ancestry.exit_code === 1
        ? blocked('Publication branch does not contain the pinned launch base')
        : unknown('Publication launch ancestry could not be established')
    }
    // #1133 (G166): the commit wrapper strips the trailer from the commit it made and refuses
    // (exit 69/70/74/76) when it cannot prove the ref it committed on. A refusal Forge ignored,
    // or a commit that reached the branch any other way, is caught HERE — the last measurement
    // before `git push` — so "no loop-authored commit carries the trailer" is a property of the
    // published history, not of one process's exit code. Unconditional: a re-publication with
    // the remote branch already present is scanned the same as a first push. The stranded-work
    // salvage push (`publishBuiltCommit`) runs the same scan itself — it never reaches this gate.
    return sessionTrailerReadiness(run, repo, launchBase, head)
  } catch (error) { return unknownCause('Publication host observation failed', error, runId) }
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** G107, G108: use the PR's actual refs, never the configured default base.
 * The merge effect must enforce --match-head-commit (build-run.ts:195).
 */
export async function pinnedMergeReadiness(
  run: RunHostCommand, repo: string, snapshot: BuildSnapshot, runId: string,
): Promise<GateResult> {
  if (!fullOid.test(snapshot.head) || snapshot.pr === null || !Number.isSafeInteger(snapshot.pr.number) || snapshot.pr.number <= 0) {
    return blocked('Merge requires a PR number and full reviewed head OID')
  }
  if (snapshot.pr.state !== 'OPEN' || snapshot.pr.head !== snapshot.head) return blocked('Merge PR does not match the reviewed head')
  try {
    const observed = await run(['gh', 'pr', 'view', String(snapshot.pr.number), '--json', 'headRefName,baseRefName,isCrossRepository,headRefOid,state'], repo)
    if (!observed.ok) return unknown('Merge PR refs could not be read')
    const pr = JSON.parse(observed.stdout)
    if (typeof pr?.headRefName !== 'string' || !pr.headRefName || typeof pr.baseRefName !== 'string' || !pr.baseRefName || typeof pr.isCrossRepository !== 'boolean') {
      return unknown('Merge PR head, base or repository identity could not be established')
    }
    if (pr.isCrossRepository) return blocked('Merge head is in a different repository')
    if (pr.state !== 'OPEN' || pr.headRefOid !== snapshot.head) return blocked('Remote PR differs from reviewed head')
    for (const ref of [pr.baseRefName, pr.headRefName]) {
      const valid = await run(['git', 'check-ref-format', `refs/heads/${ref}`], repo)
      if (!valid.ok) return unknown('Merge PR ref could not be validated')
    }
    const base = `refs/remotes/origin/${pr.baseRefName}`
    const branch = `refs/remotes/origin/${pr.headRefName}`
    const fetched = await run(['git', '-C', repo, 'fetch', 'origin', `+refs/heads/${pr.baseRefName}:${base}`, `+refs/heads/${pr.headRefName}:${branch}`], repo)
    if (!fetched.ok) return unknown('Merge PR refs could not be refreshed')
    // Same file-backed measurement as merge.ts:203–238; stdout may be capped.
    const dir = await mkdtemp(join(tmpdir(), 'build-host-merge-diff-'))
    let bytes: number
    try {
      const path = join(dir, 'merge.diff')
      const diff = await run(gitRangeArgv({ repo_path: repo, subcommand: 'diff',
        flags: ['--binary', '--no-ext-diff', '--full-index', `--output=${path}`],
        base, head: branch, dots: '...',
      }), repo)
      if (!diff.ok) return unknown('Merge diff could not be read')
      bytes = (await stat(path)).size
    } finally { await rm(dir, { recursive: true, force: true }) }
    if (bytes > MERGE_DIFF_BYTES_MAX) return blocked(mergeDiffTooLargeReason(bytes))
    const drift = await assessBaseDrift(run, repo, base, branch)
    if (!drift.assessable) return unknown('Base drift could not be assessed')
    if (drift.branch_head_sha !== snapshot.head) return blocked('Fetched PR head differs from reviewed head')
    if (shouldHoldForBaseDrift(drift, new Set(), { hold_when_unassessable: true })) return blocked('Base drift overlaps reviewed changes')
    return { kind: 'allow' }
  } catch (error) { return unknownCause('Merge host observation could not be decoded', error, runId) }
}
