import { createHash } from 'node:crypto'
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

/** #1133 (G166): the environment the raw-graph range listing runs under. Legacy grafts have no
 * command-line switch; `/dev/null` names an existing, empty graft file so `$GIT_DIR/info/grafts`
 * is never consulted. Exported so a test can prove the listing carries it.
 */
export const RAW_GRAPH_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_GRAFT_FILE: '/dev/null' })
const RAW_GRAPH = ['--no-replace-objects', '--shallow-file', '/dev/null', '-c', 'core.commitGraph=false', '-c', 'advice.graftFileDeprecated=false']

/** #1133 (G166): a commit object's own byte size, measured INDEPENDENTLY of the capture that
 * is being checked against it. `--no-replace-objects` on this read too: a replacement object
 * could otherwise report the substitute's size and make a short read of the real object look
 * complete. Strict decimal — an exit-0 call with empty or non-numeric stdout is a measurement
 * of nothing, not a zero, and returns `null` so the caller fails closed. (merge.ts `objectSize`
 * is private to that module and reads without the replace-objects override; not reused here.)
 */
async function rawCommitSize(run: RunHostCommand, repo: string, sha: string): Promise<number | null> {
  const measured = await run(['git', '--no-replace-objects', '-C', repo, 'cat-file', '-s', sha], repo)
  if (!measured.ok) return null
  const text = measured.stdout.trim()
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) return null
  const size = Number(text)
  return Number.isSafeInteger(size) ? size : null
}

/** The first line of a raw commit object. Used only to tell a headers-only capture that really
 * is a whole object from one that was cut before the header block ended.
 */
const treeHeaderLine = /^tree (?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** Authenticate the decoded capture against Git's object identity. A short read may only
 * recover LF terminators; size alone cannot distinguish a lost colon or lossy UTF-8 decoding.
 */
function restoredCommitMatches(capture: string, missing: number, sha: string): boolean {
  const bytes = Buffer.from(capture + '\n'.repeat(missing), 'utf8')
  const oid = createHash(sha.length === 64 ? 'sha256' : 'sha1')
    .update(`commit ${bytes.length}\0`).update(bytes).digest('hex')
  return oid === sha
}

const incompleteRead = (sha: string, captured: number, size: number, why: string): { kind: 'unknown'; detail: string } =>
  ({ kind: 'unknown', detail: `Publication commit ${sha} was read incompletely (${captured} of ${size} bytes${why})` })

/** Every commit in `launchBase..head` whose raw message carries a session-trailer line.
 * The message is read from the raw object (`git cat-file commit`), the same bytes the wrapper
 * strips, never from `git log` porcelain. Any step that cannot be measured is `unknown`, so a
 * range that cannot be listed or a commit that cannot be read never publishes on the strength
 * of what was not seen.
 *
 * The host runner decodes stdout as UTF-8. Every accepted capture must reconstruct the
 * listed Git OID, including captures whose decoded byte length equals the raw object's size.
 * Lossy decoding and equal-length substitutions therefore remain unknown. The separate
 * cat-file -s read bounds reconstruction to the supported terminators; it cannot authenticate
 * bytes by itself. A runner that fabricates the range listing remains outside this boundary.
 */
async function sessionTrailerCarriers(
  run: RunHostCommand, repo: string, launchBase: string, head: string,
): Promise<{ kind: 'carriers'; shas: string[] } | { kind: 'unknown'; detail: string }> {
  if (!fullOid.test(launchBase)) return { kind: 'unknown', detail: 'Publication launch base is not a full OID' }
  // BOTH ENDS OF THE RANGE ARE VALIDATED (round 24). `head` used to reach git unchecked, and the
  // two ways that failed are not symmetric with the base:
  //   * `gitRangeArgv` renders `${launchBase}..${head}`, and git reads `<base>..` as
  //     `<base>..HEAD` — measured on git 2.43.0, exit 0. An empty head therefore listed the
  //     CHECKOUT's HEAD instead of the commit about to be published, and normally ALLOWED.
  //   * the value the scan was handed is the value the push then names. `publication.ts`
  //     `publishBuiltCommit` pushes `${headToPublish}:refs/heads/<branch>`, and with an empty
  //     `headToPublish` that is git's branch-DELETE refspec: measured on git 2.43.0,
  //     `git push --force-with-lease=refs/heads/<b>:<observed> origin ':refs/heads/<b>'`
  //     prints `- [deleted]` and EXITS 0 — the lease is satisfied, so it protects nothing — and
  //     the post-push witness then compares a `remoteHead` of '' against a `headToPublish` of ''
  //     and finds them equal. Origin loses the branch while the run records a successful publish.
  // `headToPublish` is `stdout.trim()` of an injected runner's read at `replay.ts:200`,
  // `replay.ts:595` and `leak-preflight.ts:448` — each checks `.ok` and nothing else — so an
  // `ok` answer with empty stdout is the reachable shape, the same class round 22 hardened
  // `rawCommitSize` against. This one guard sits in the scan EVERY origin-facing publisher runs
  // before its push (`publicationReadiness`, `publication.ts` `publishBuiltCommit`,
  // `gates/build-claim.ts` G100 preservation), so it closes all three call sites at once.
  // The value is named so the refusal is diagnosable, and BOUNDED because it is caller input
  // that lands in a persisted refusal string.
  if (!fullOid.test(head)) return { kind: 'unknown', detail: `Publication head is not a full OID: '${head.slice(0, 64)}'` }
  // Measure the object graph that a push publishes. Replacement refs can substitute both
  // messages and parents; shallow boundaries can silently hide parents that still exist.
  // Ignore both views, legacy grafts and the commit-graph cache, so missing raw history fails the
  // walk instead of looking like an empty/clean range. Do not change the repository's state.
  //
  // THE ARGV IS A PLAIN `git` COMMAND. Git has no flag for the graft file — only the
  // `GIT_GRAFT_FILE` environment variable — and it travels here as the runner's typed
  // `extraEnv` parameter (`EnvCapableHostRunner`, trident/git-mode.ts), NOT as an
  // `env GIT_GRAFT_FILE=… git …` argv prefix. Round 19 shipped that prefix and it red
  // 7 tests in two consuming suites (trident/stranded-salvage-realgit.test.ts,
  // gateway/composition/build-core-modules-trident-stranded-sweep.test.ts): every host double
  // on the salvage path admits only `cmd[0] === 'git'` / `'gh'` and throws otherwise, the throw
  // escaped `publishBuiltCommit`, and the salvage recorded no PR. The production runners
  // (`spawnCapture`, `makeCredentialedHostRunner` and its per-command variant) all merge
  // `extraEnv` over the inherited environment, so the graft override reaches git unchanged.
  // `advice.graftFileDeprecated=false` keeps git's 8-line graft-file hint — printed whenever the
  // named graft file exists, and `/dev/null` does — out of every captured stderr.
  const listing = gitRangeArgv({ repo_path: repo, config: RAW_GRAPH, subcommand: 'rev-list', base: launchBase, head })
  const listed = await run(listing, repo, RAW_GRAPH_ENV)
  if (!listed.ok) return { kind: 'unknown', detail: 'Publication commit range could not be listed' }
  const shas = listed.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (shas.some(sha => !fullOid.test(sha))) return { kind: 'unknown', detail: 'Publication commit range listing is malformed' }
  const carriers: string[] = []
  for (const sha of shas) {
    const object = await run(['git', '--no-replace-objects', '-C', repo, 'cat-file', 'commit', sha], repo)
    if (!object.ok) return { kind: 'unknown', detail: `Publication commit ${sha} could not be read` }
    // A commit object is headers, one blank line, then the message. Every header line is
    // `name value` or a ` `-continued gpgsig/mergetag line, so the first `\n\n` is always the
    // header/message boundary and never falls inside the headers.
    //
    // Weigh the capture independently, then authenticate its bytes before scanning its message.
    // With a boundary present, accept direct captures or up to TWO missing LFs (a wrapper commit
    // keeps the blank before a dropped final trailer paragraph, so its raw object ends `\n\n`).
    // Without a boundary, an empty message may have lost one or both separator LFs; require its
    // tree header. Every proposed LF must reproduce the exact Git OID. A gap the LF proposals do
    // not explain gets ONE more chance (round 31): an untrimmed read of the message that proves the
    // capture lost nothing but trailing whitespace; failing that, it is unknown.
    const size = await rawCommitSize(run, repo, sha)
    if (size === null) return { kind: 'unknown', detail: `Publication commit ${sha} size could not be measured` }
    const captured = Buffer.byteLength(object.stdout, 'utf8')
    const missing = size - captured
    if (missing < 0) return incompleteRead(sha, captured, size, ': the UTF-8 decode is larger than the object -- most likely a non-UTF-8 byte replaced by U+FFFD, or a size read that under-reports -- so the raw bytes cannot be authenticated')
    const separator = object.stdout.indexOf('\n\n')
    let why: string | null = null
    if (separator < 0) {
      const emptyMessage = (missing === 2 || (missing === 1 && object.stdout.endsWith('\n')))
        && treeHeaderLine.test(object.stdout.split('\n', 1)[0] ?? '')
      if (!emptyMessage) why = ', no header/message boundary'
    } else if (missing > 2) why = ''
    if (why === null && !restoredCommitMatches(object.stdout, missing, sha)) why = ': captured bytes and proposed terminators do not match the commit OID'
    // Round 31: a TRIMMING runner strips every trailing whitespace code point, not only LFs, so
    // a short capture the LF proposals cannot explain may still be whole up to whitespace. The
    // untrimmed message read below may only explain that trim: see `whitespaceTrimmedMessage`.
    const message = why === null ? (separator < 0 ? '' : object.stdout.slice(separator + 2))
      : missing > 0 ? await whitespaceTrimmedMessage(run, repo, sha, object.stdout, size) : null
    if (message === null) return incompleteRead(sha, captured, size, why ?? '')
    if (message.split('\n').some(line => sessionTrailerLine.test(line))) carriers.push(sha)
  }
  return { kind: 'carriers', shas: carriers }
}

/** #1133 (G166) as one gate result, shared by EVERY path that pushes a build branch to origin:
 * the checked publishers (`publicationReadiness` below) and `trident/publication.ts`
 * `publishBuiltCommit` — which is EVERY legacy-loop publication (the `publish_requested` push
 * after each build and fix round, `trident/orchestrator.ts`) as well as the stranded-work
 * salvage push (`reconcile_stranded`). `blocked` names every carrier in `launchBase..head`;
 * `unknown` is a range or commit that could not be measured — including one whose raw object was
 * read INCOMPLETELY — and a caller must refuse on it the same as on `blocked`: a push on the
 * strength of what was not seen is the defect this gate exists to close.
 *
 * THE WINDOW IS `launchBase..head`, WHATEVER THE CALLER PASSES AS `launchBase`. The salvage path
 * passes the OBSERVED base tip (`publication.ts`); the checked publishers (`publicationReadiness`)
 * start from the run's dispatch-time pin and narrow it with `publishedBaseWindow` (round 31), so a
 * base-branch commit origin already publishes is never this publication's to refuse.
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

/** Scan the reviewed history at either admission boundary, excluding only base
 * commits independently witnessed on origin. Recompute the window on every call.
 */
export async function sessionTrailerReadinessForBase(
  run: RunHostCommand, repo: string, baseBranch: string, launchBase: string, head: string,
): Promise<GateResult> {
  return sessionTrailerReadiness(run, repo, await publishedBaseWindow(run, repo, baseBranch, launchBase, head), head)
}

/** G083, G085, G086, G166: measure the branch, launch ancestry and commit messages before
 * publication. Lease enforcement and the post-push witness stay in the publication effect.
 */
export async function publicationReadiness(
  run: RunHostCommand, repo: string, branch: string, baseBranch: string, launchBase: string, snapshot: BuildSnapshot, runId: string,
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
    // the remote branch already present is scanned the same as a first push. The legacy-loop
    // publisher and the stranded-work salvage push (both `publishBuiltCommit`) run the same scan
    // themselves — they never reach this gate.
    //
    // `return await`, NOT a bare `return` (round 24). This is the only REJECTING statement in
    // this `try`: the launch base had a synchronous `return { kind: 'allow' }` here, and
    // `sessionTrailerCarriers` calls the injected runner with no try/catch of its own, so a
    // throwing runner is a live contract (`release-readiness.test.ts` `gitOnlyRun` and the fake
    // host's `Unexpected command`). Without the `await` the promise adopts AFTER the block exits
    // and its rejection escapes the `catch` below instead of becoming `unknownCause(...)` —
    // and `publishGate` (`build-host.ts`) has no try/catch upstream, so the gate's refusal
    // contract would become an unhandled throw. The sibling at `gates/build-claim.ts:65` awaits
    // correctly; `eslint.config.mjs` carries no `return-await`/`no-floating-promises` rule, so
    // nothing but this comment and its regression keeps it here.
    return await sessionTrailerReadinessForBase(run, repo, baseBranch, launchBase, head)
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

/** #1133 round 31 (G166): the lower bound of the checked publishers' scan. The run's pin is
 * taken once, at a fresh launch, and carried across resumes and fix rounds, while the host
 * rebases the branch onto the CURRENT base tip -- so `pin..head` also lists base-branch commits
 * above the pin. Those are already public on origin and the loop cannot strip them; a carrier
 * among them (a squash that copied a contributor's trailer, as `0fc6cb83` did) refused every
 * such run with no in-run remedy. The window starts at `merge-base(head, <origin's base tip>)`
 * instead, when that descends from the pin:
 *   * the tip is what `ls-remote` says ORIGIN holds, never the local `refs/remotes/origin/*`
 *     ref, which any process with write access to the checkout can move onto the branch head;
 *   * the merge-base is computed over the raw graph (`RAW_GRAPH`, `RAW_GRAPH_ENV`), so a
 *     replacement ref or graft cannot move it onto the branch's own commits;
 *   * every commit excluded is reachable from that merge-base, hence from origin's base tip,
 *     hence already published; and because the merge-base descends from the pin, the window
 *     is a SUBSET of `pin..head` -- this can only narrow the scan, never widen it.
 * Anything not measured cleanly -- a failed or malformed `ls-remote`, no base branch on origin,
 * a tip absent from the local object store, a merge-base that does not descend from the pin --
 * keeps the pin: the stricter window, never an unmeasured narrower one. It issues no fetch and
 * changes no ref.
 */
async function publishedBaseWindow(
  run: RunHostCommand, repo: string, baseBranch: string, launchBase: string, head: string,
): Promise<string> {
  if (baseBranch === '') return launchBase
  const ref = `refs/heads/${baseBranch}`
  const observed = await run(['git', '-C', repo, 'ls-remote', '--heads', 'origin', ref], repo)
  const fields = observed.ok ? observed.stdout.trim().split(/\s+/) : []
  const tip = fields.length === 2 && fields[1] === ref && fullOid.test(fields[0]!) ? fields[0]! : null
  if (tip === null) return launchBase
  const merged = await run(['git', '-C', repo, ...RAW_GRAPH, 'merge-base', '--end-of-options', tip, head], repo, RAW_GRAPH_ENV)
  const mergeBase = merged.stdout.trim()
  if (!merged.ok || !fullOid.test(mergeBase)) return launchBase
  if (mergeBase === launchBase) return launchBase
  const descends = await run(['git', '-C', repo, ...RAW_GRAPH, 'merge-base', '--is-ancestor', '--end-of-options', launchBase, mergeBase], repo, RAW_GRAPH_ENV)
  return descends.ok ? mergeBase : launchBase
}

/** #1133 round 31 (G166): the message of `sha` read so that a TRIMMING runner cannot shorten it,
 * or `null`. `spawnCapture` returns `stdout.trim()`, which strips every trailing whitespace code
 * point -- spaces, tabs, three or more LFs -- while the LF proposals above can only restore up to
 * two LFs, so a `--cleanup=verbatim`, `commit-tree` or tooling-made message ending in any other
 * whitespace was permanently `unknown` and every publisher refused it. `%x00` on BOTH sides of
 * `%B` fences the message with NULs, which no trim removes -- `trim()` strips LEADING whitespace
 * too, so a message that opens with a blank line needs the front fence as much as the back one;
 * `format:` (separator semantics) adds no terminator; `%B` is the raw message after the header
 * block's blank line. The read may only EXPLAIN
 * the first capture's trim, never replace a lost read: the reconstruction must start with the
 * whole capture, may add nothing but whitespace after it (exactly what a trim can remove), must
 * weigh the object's own `cat-file -s` size, and must reproduce the listed OID. A capture cut
 * inside real content therefore stays `unknown`, as does anything `git log` re-encodes (a
 * non-UTF-8 `encoding` header) -- a changed byte cannot reproduce the OID.
 */
async function whitespaceTrimmedMessage(
  run: RunHostCommand, repo: string, sha: string, capture: string, size: number,
): Promise<string | null> {
  const read = await run(['git', '--no-replace-objects', '-C', repo, '-c', 'i18n.logOutputEncoding=UTF-8', 'log', '-1', '--no-walk', '--no-show-signature', '--no-notes', '--format=format:%x00%B%x00', '--end-of-options', sha], repo)
  if (!read.ok || read.stdout.length < 2 || !read.stdout.startsWith('\0') || !read.stdout.endsWith('\0')) return null
  const message = read.stdout.slice(1, -1)
  const separator = capture.indexOf('\n\n')
  if (separator < 0 && !treeHeaderLine.test(capture.split('\n', 1)[0] ?? '')) return null
  const whole = (separator < 0 ? `${capture.replace(/\n$/, '')}\n\n` : capture.slice(0, separator + 2)) + message
  if (!whole.startsWith(capture) || whole.slice(capture.length).trim() !== '') return null
  if (Buffer.byteLength(whole, 'utf8') !== size || !restoredCommitMatches(whole, 0, sha)) return null
  return message
}
