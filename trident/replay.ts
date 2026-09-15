/**
 * Branch replay onto an observed remote base: inventory G087–G097, keep-in-place.
 * Owns shallow healing, ancestry and patch checks, scratch replay, bounded conflict
 * resolution with staged-content verification, commit provenance, and ref comparison.
 */
import { existsSync, readFileSync } from 'node:fs'
import { gitRangeArgv } from './git-range.ts'
import { MAX_CONFLICT_ROUNDS, type MergeConflictResolver, type RunHostCommand } from './merge.ts'
import type { TridentRun } from './store.ts'
import { ensureAsBuiltMergeDriver } from './as-built-merge-driver.ts'
import { publishFailureReason, redactPushError } from './publish-failure.ts'


/**
 * A line of `git diff --cached` output that ADDS a conflict marker. `<<<<<<<` and `>>>>>>>` only —
 * these are the labelled markers, which carry a branch name after the run and so end in a space
 * or a tab. A bare `=======` separator is caught separately by `CONFLICT_SEPARATOR_ADDED` below
 * (exact-line, and exempt in markdown, where it is a setext underline). `|||||||` remains
 * unmatched: it only appears under `merge.conflictStyle=diff3`, and catching it is a follow-up.
 *
 * Four or more catches the narrowest marker width this gate deliberately supports as well as
 * git's default and wider configured markers. Because candidates are paths known to have
 * conflicted in this replay, an added four-wide labelled run fails closed as residue.
 */
const CONFLICT_MARKER_ADDED = /^\+(?:<{4,}|>{4,})(?: |\t|\r?$)/

/**
 * A `git diff --cached -U1` line that ADDS git's bare conflict SEPARATOR. Unlike `<<<<<<<` and
 * `>>>>>>>`, the separator line git writes carries NO label — it is exactly a run of `=` and
 * nothing else — so anything with trailing content (a heredoc sentinel, a quoted string, an
 * indented docstring underline) never matches. Git permits `conflict-marker-size` to narrow the
 * marker as well as widen it; four is the fail-closed lower bound shared with the outer-marker
 * scan. Shorter punctuation remains ordinary generated content. `\r?` covers
 * a CRLF file. This is the residue MOST likely to
 * survive a sloppy hand-resolution: the outer markers
 * are the visually obvious ones, and deleting them while leaving `=======` used to pass this
 * gate entirely.
 */
const CONFLICT_SEPARATOR_ADDED = /^\+={4,}\r?$/

/**
 * Markdown permits an all-`=` Setext H1 underline. Text around it cannot safely corroborate that
 * interpretation: conflict sides can have the identical title/blank/paragraph shape. The narrow
 * exemption therefore requires affirmative diff evidence that the resolver added the nonblank
 * title immediately before the underline, and that the resulting next line is blank or EOF.
 * Surviving conflict-side content immediately after the separator is therefore refused. Scanning
 * each candidate separately avoids decoding git-quoted path headers.
 */
const SETEXT_UNDERLINE_PATHS = /\.(?:md|markdown)$/i

function stagedDiffAddsConflictMarker(diff: string, path: string): boolean {
  const lines = diff.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (CONFLICT_MARKER_ADDED.test(line)) return true
    if (!CONFLICT_SEPARATOR_ADDED.test(line)) continue
    if (!SETEXT_UNDERLINE_PATHS.test(path)) return true

    const addedTitle = /^\+(.+)\r?$/.exec(lines[i - 1] ?? '')?.[1] ?? ''
    if (addedTitle.trim() === '') return true

    // Removed lines do not exist in the staged result. The first context/added line after them is
    // the line after the underline; a hunk/file boundary means the underline is at EOF.
    let after = i + 1
    while ((lines[after] ?? '').startsWith('-') && !lines[after]?.startsWith('---')) after += 1
    const next = lines[after]
    const atEof = next === undefined || next === '' || next.startsWith('@@') || next.startsWith('diff --git ')
    const followedByBlank = next === '+' || next === '+\r' || next === ' ' || next === ' \r'
    if (!atEof && !followedByBlank) return true
  }
  return false
}

/**
 * A rebase that CONFLICTS is an ATTENTION state, never a verdict.
 *
 * A branch conflicting with its base is a MERGEABILITY fact about the branch's relationship to
 * `main` — not a judgement about the code. Recording it as `REQUEST_CHANGES` tells the owner his
 * build was rejected when no reviewer read a line of it. So this is a typed failure carrying the
 * conflicting paths.
 *
 * AND THIS IS THE PATH THAT RESOLVES FIRST. A configured `resolve_conflict` resolver is invoked
 * here, in the scratch worktree `git apply --3way` just left the markers in, bounded by
 * `MAX_CONFLICT_ROUNDS` AND by a per-round progress requirement. The local-mode merge path has a
 * human present who could reconcile the branch by hand; this one is autonomous and has nobody, so
 * it is exactly where auto-resolution earns its keep. `TridentRebaseConflict` remains the outcome
 * when no resolver is configured, when the resolver declines/escalates, when a round makes no
 * progress, when the round bound is exhausted, and when a "resolution" empties the branch's delta.
 *
 * THE RESOLVER'S WORD IS NEVER THE EVIDENCE. A claimed RESOLVED is checked against git twice —
 * the unmerged set (`--diff-filter=U`) AND the staged bytes (`--cached`, scanned for added
 * conflict markers), because `git add` clears the unmerged bit for a path whose markers are still
 * inside it.
 *
 * A RESOLVED REBASE IS NOT AN APPROVED ONE. Resolution is a MERGEABILITY operation, not a
 * verdict — the branch still faces the full review gate afterwards, exactly as an unconflicted
 * replay does.
 */
export class TridentRebaseConflict extends Error {
  constructor(
    public branch: string,
    public base: string,
    public paths: string[],
  ) {
    super(
      `REBASE CONFLICT — needs attention: branch ${branch} conflicts with ${base} in: ${paths.length > 0 ? paths.join(', ') : '(paths unreadable)'}. Nothing was auto-resolved and no reviewer judged this code — the branch needs a human (or a fresh build) to reconcile it with ${base}.`,
    )
  }
}

/**
 * Heal a shallow checkout before replay. On 2026-08-15 five builds died because a depth-1
 * checkout cannot `git apply --3way`: the blobs named by the diff's index lines do not exist,
 * and every failure was misreported as `REBASE CONFLICT … (paths unreadable)`.
 */
export async function healShallowCheckout(run_host: RunHostCommand, repoPath: string): Promise<void> {
  const probe = await run_host(['git', '-C', repoPath, 'rev-parse', '--is-shallow-repository'], repoPath)
  if (!probe.ok) {
    throw new Error(publishFailureReason('probe the checkout depth of', repoPath, probe.stderr))
  }
  if (probe.stdout.trim() === 'false') return
  if (probe.stdout.trim() !== 'true') {
    throw new Error(publishFailureReason('probe the checkout depth of', repoPath, `unexpected answer: ${probe.stdout.trim()}`))
  }

  const fetch = await run_host(['git', '-C', repoPath, 'fetch', '--no-tags', '--unshallow', 'origin'], repoPath)
  if (fetch.ok) return

  let depth = 'unreadable'
  let boundary = 'unreadable'
  try {
    const measured = await run_host(['git', '-C', repoPath, 'rev-list', '--count', 'HEAD'], repoPath)
    if (measured.ok && measured.stdout.trim() !== '') depth = measured.stdout.trim()
  } catch {}
  try {
    const path = await run_host(['git', '-C', repoPath, 'rev-parse', '--git-path', 'shallow'], repoPath)
    if (path.ok && path.stdout.trim() !== '') {
      const read = await run_host(['cat', path.stdout.trim()], repoPath)
      if (read.ok && read.stdout.trim() !== '') boundary = read.stdout.trim()
    }
  } catch {}
  throw new Error(
    `Could not heal shallow checkout ${repoPath} (depth ${depth}, shallow boundary ${boundary}): ${redactPushError(fetch.stderr)}; a shallow checkout cannot 3-way replay — the blobs the diff names do not exist`,
  )
}

/**
 * Replay `branch` onto the ls-remote-OBSERVED tip of `base`, shallow-safely.
 *
 * The shared build checkout MAY arrive shallow: install.sh used to clone at depth 1, and hand-made
 * clones still can. `healShallowCheckout` repairs that defect at entry. Regardless of depth, NO
 * `git rebase` runs here, ever, and never in the shared working tree: other lanes share it and a
 * failed rebase there poisons every lane. Instead: take the branch's own diff from its true merge-base — the
 * FORGE (`gh pr diff <n>`, computed server-side against a full history) when a PR exists, or the
 * two-dot `git diff <base>..<branch>` for a first publish — and `git apply --3way` it onto the
 * observed base tip in a THROWAWAY detached worktree. The branch ref then moves by
 * compare-and-swap (`update-ref <new> <old>`): if anything moved the branch underneath us we
 * refuse rather than force.
 *
 * The replay SQUASHES the branch into one commit. Deliberate — the PR merge is `--squash` anyway.
 *
 * RETURNS THE OBSERVED BASE TIP as well as the head, because the caller needs BOTH to describe
 * what was built: the review diff is `<baseSha>..<head>`, and `baseSha` is the only value in the
 * process that is guaranteed to be the tip the head sits on. `''` means the remote has no such
 * base branch at all. See the review-diff comment in `publishBuiltCommit` for what taking the
 * LOCAL `<base>` ref instead cost.
 */
export async function rebaseOntoObservedBase(
  run_host: RunHostCommand,
  repoPath: string,
  branch: string,
  base: string,
  pr: number | null,
  scratchDir: string,
  /** Optional bounded auto-resolution for a conflicting replay. Absent → a conflict throws. */
  resolve?: { run: TridentRun; resolve_conflict: MergeConflictResolver },
): Promise<{ head: string; rebased: boolean; baseSha: string }> {
  // Heal on use — no install-time fix reaches a hand-made clone, and both 2026-08-15 incidents came from hand-made clones.
  await healShallowCheckout(run_host, repoPath)
  // (a) The base tip as OBSERVED on the remote — the same kind of observation the lease uses, and
  //     for the same reason: a remote-tracking ref is whatever the last fetch left behind.
  //
  //     THIS OBSERVATION AGES. Auto-resolution can now sit between here and the commit for minutes
  //     (a Forge turn is bounded at 8 of them), so the published head can be based on a `main` that
  //     has since moved. That is SAFE but not free: the branch move is still a compare-and-swap and
  //     the lease push re-observes the branch, so nothing is overwritten — the branch simply
  //     arrives at review stale and gets replayed again on the next publish, which is the ordinary
  //     behaviour for any branch cut before a sibling landed. It is the reason the resolution loop
  //     below bails on the FIRST round that makes no progress instead of spending the full bound.
  const observedBase = await run_host(
    ['git', '-C', repoPath, 'ls-remote', '--heads', 'origin', `refs/heads/${base}`],
    repoPath,
  )
  if (!observedBase.ok) {
    throw new Error(publishFailureReason('read the remote base of', branch, observedBase.stderr))
  }
  const readHead = async (): Promise<string> => {
    const head = await run_host(['git', '-C', repoPath, 'rev-parse', `refs/heads/${branch}`], repoPath)
    if (!head.ok) throw new Error(publishFailureReason('read the local tip of', branch, head.stderr))
    return head.stdout.trim()
  }
  let baseSha = observedBase.stdout.trim().split(/\s+/)[0] ?? ''
  // No remote base at all → there is nothing to rebase ONTO. Not an error (a brand-new origin).
  if (baseSha === '') return { head: await readHead(), rebased: false, baseSha: '' }

  // (b) The branch tip we are about to move, captured BEFORE anything touches it — it is the
  //     compare-and-swap expectation in (h).
  const oldHead = await readHead()

  // (c) Already contains the base tip → nothing to do. On a SHALLOW checkout this check may ERROR
  //     rather than answer (the commit is beyond the shallow boundary); any non-ok is read as
  //     "behind". A redundant replay is safe; a skipped one strands the branch as CONFLICTING.
  const contains = await run_host(
    ['git', '-C', repoPath, 'merge-base', '--is-ancestor', baseSha, `refs/heads/${branch}`],
    repoPath,
  )
  //     `contains.ok` also PROVES `baseSha` is a local object — git could only answer the
  //     ancestry question by reading it — which is what makes it safe to hand back as a
  //     diff base on a shallow checkout that never reaches the fetch below.
  if (contains.ok) return { head: oldHead, rebased: false, baseSha }

  // (d) The entry guard already unshallowed the checkout; this fetch only makes the just-observed
  //     tip local. Keep `--no-tags` because tags are irrelevant to replay.
  const fetchBase = async () => run_host(['git', '-C', repoPath, 'fetch', '--no-tags', 'origin', base], repoPath)
  let fetched = await fetchBase()
  let present = await run_host(['git', '-C', repoPath, 'rev-parse', '--verify', `${baseSha}^{commit}`], repoPath)
  if (!present.ok) {
    // The base moved between the observation and the fetch — re-observe ONCE and adopt it.
    const reObserved = await run_host(
      ['git', '-C', repoPath, 'ls-remote', '--heads', 'origin', `refs/heads/${base}`],
      repoPath,
    )
    const reSha = reObserved.ok ? (reObserved.stdout.trim().split(/\s+/)[0] ?? '') : ''
    if (reSha !== '') baseSha = reSha
    fetched = await fetchBase()
    present = await run_host(['git', '-C', repoPath, 'rev-parse', '--verify', `${baseSha}^{commit}`], repoPath)
    if (!present.ok) {
      throw new Error(publishFailureReason('fetch the base tip for', branch, present.stderr || fetched.stderr))
    }
  }

  // (e) The branch's own changes, from a source with an HONEST merge-base. Never a local
  //     three-dot diff — that is exactly the computation the shallow boundary corrupts.
  const diffFile = `/tmp/trident-rebase-${branch.replace(/[^A-Za-z0-9._-]/g, '-')}.diff`
  // THE BRANCH'S OWN WORK IS `<fork point>..<branch>`, AND THE FORK POINT IS THE MERGE-BASE —
  // not either ref's tip. Both tips are wrong, in opposite directions:
  //
  //   `refs/heads/<base>..<branch>`  — the local ref, which step (d) NEVER moves (it fetches into
  //       `refs/remotes/origin/<base>`). MEASURED 2026-08-15: `refs/heads/main` sat at d8324cc
  //       while the observed tip was d5ba62b, so the diff carried 103 files instead of the
  //       branch's own 22 — 236 commits of already-merged work. Applied onto the observed tip,
  //       every already-present hunk fails, `git apply` stages NOTHING as conflicted, and the
  //       caller reports `conflicts with main in: (paths unreadable)` — naming a conflict that
  //       does not exist. Five builds died on this in one day, across two projects.
  //
  //   `<baseSha>..<branch>`  — the observed tip. A two-dot diff is "how to turn A into B", so
  //       this also REVERSES everything the base gained since the fork: replaying it DELETES
  //       main's own new files, and a genuine conflict applies cleanly as a revert instead of
  //       raising. `publish-rebase-realgit.test.ts` catches both (a lost `docs.txt`, and a
  //       conflict that returned null). Do not "simplify" back to it.
  //
  // The merge-base is what `gh pr diff` computes server-side, which is why the PR path above has
  // never had this bug.
  //
  // NO FALLBACK TO `refs/heads/<base>` — IT FAILS CLOSED. CODEX REVIEW [Blocker]: the first cut
  // fell back to the local ref when merge-base could not answer, which is EXACTLY the shallow
  // checkout this function expects. That reinstated the defective base in precisely the condition
  // that produced it, and would have shipped a fix that silently does the broken thing whenever it
  // matters most. A fork point that cannot be established is an INFRASTRUCTURE fault about the
  // checkout — deepen it (see the shallow-provisioning card) — not a licence to replay a diff we
  // know to be wrong. Better a named refusal than a false conflict nobody can read.
  //
  // COMPUTED ONLY ON THE PATH THAT NEEDS IT. `gh pr diff` already resolves the fork point
  // server-side against a full history, so a PR-mode replay must not be made to depend on — or be
  // refused by — the local checkout's depth.
  const localForkPoint = async (): Promise<string> => {
    const read = async () =>
      run_host(['git', '-C', repoPath, 'merge-base', baseSha, `refs/heads/${branch}`], repoPath)
    let forkPoint = await read()
    if (!forkPoint.ok || forkPoint.stdout.trim() === '') {
      // Belt-and-braces behind the entry guard: one bounded deepen, then re-ask. Modern git rejects
      // `--unshallow` on a complete repo; that harmless failure is followed by the decisive re-read.
      await run_host(['git', '-C', repoPath, 'fetch', '--no-tags', '--unshallow', 'origin'], repoPath)
      forkPoint = await read()
    }
    if (!forkPoint.ok || forkPoint.stdout.trim() === '') {
      throw new Error(
        publishFailureReason(
          'establish the fork point of',
          branch,
          `no merge-base between ${baseSha} and refs/heads/${branch} even after deepening — the build checkout cannot describe this branch's own changes, so replaying it would send already-merged work through review`,
        ),
      )
    }
    return forkPoint.stdout.trim()
  }
  // PATCH BYTES ARE NOT TEXT TO BE TIDIED — `--output` WRITES THEM, NOTHING ROUND-TRIPS A STRING.
  //
  // `spawnCapture` returns `stdout.trim()`. That is harmless for every other reader and FATAL for
  // a patch: a unified diff whose final line is a context line for a BLANK line ends `" \n"` —
  // space, newline. `.trim()` removes BOTH, and restoring only the newline cannot put the space
  // back. The last hunk is then one line short of its `@@` count, `git apply` exits 128 with
  // `corrupt patch at line N`, and — because nothing was ever staged — `--diff-filter=U` names no
  // files, so the caller reported `REBASE CONFLICT … (paths unreadable)`.
  //
  // MEASURED in production on run 578fa30e against deployed trident d5ba62b7: the real
  // patch was 19,222 bytes ending `…each other.\n \n`; trimmed it was 19,220 ending
  // `…each other.\n`. Untrimmed it applied cleanly against four separate bases; trimmed it gave
  // `corrupt patch at line 42, rc=128, unmerged=[]`. A plain `git rebase` of the same branch
  // succeeded with no intervention — the patch was never in conflict at all.
  //
  // The previous comment here believed the trailing-newline restore had closed this. It had not:
  // it addressed a missing `\n` and could never address a stripped `" "`. The existing real-git
  // fixture's last line is non-blank, which is exactly why the half-fix looked complete.
  // AND THE FIX ABOVE LANDED ON ONLY ONE BRANCH OF THIS `if`. #292 converted the `pr === null`
  // path to `--output` and left the PR path — the COMMON one, taken on every round after the first
  // — still doing `writeFileSync(diffFile, patch.stdout…)` over a TRIMMED capture. It failed
  // exactly as the comment above predicts, six hours later: run 63b16fb1 (PR #295, 2026-08-15
  // 20:36Z) died with `corrupt patch at line 746`, and its replay patch cbcfb65..26c19dd is 746
  // lines whose final line is `" \n"`. Regenerated through `--output` the same patch applies
  // CLEANLY onto both its fork point and the observed tip. The comment was right and the code
  // under it was still wrong; the reason it read as fixed is that the diff of #292 showed the
  // comment and the `else` together.
  //
  // So there is NO STRING PATH LEFT ON EITHER BRANCH. The PR path keeps `gh pr diff` — it resolves
  // the fork point server-side against a full history, which is deliberately independent of this
  // checkout's depth — but REDIRECTS it to the file instead of capturing it. `spawnCapture` never
  // sees the bytes, so it cannot trim them. Nothing here may pass patch bytes through a JS string
  // again; if a future reader needs the diff's content, read it back off disk.
  if (pr !== null) {
    const written = await run_host(
      ['sh', '-c', `gh pr diff ${Number(pr)} > ${JSON.stringify(diffFile)}`],
      repoPath,
    )
    if (!written.ok) throw new Error(publishFailureReason('read the diff of', branch, written.stderr))
  } else {
    // `--output` hands the bytes to git, which writes them verbatim. No capture, no trim, no
    // reconstruction. Do not "simplify" this back to reading stdout.
    const written = await run_host(
      // `--end-of-options` after every option and before the operand: `localForkPoint()`
      // answers a sha today, but a range operand is a range operand and the marker costs
      // nothing. Uniform across every git range in this module (#546) so the claim is
      // "all of them" rather than "the ones whose value I reasoned about".
      gitRangeArgv({
        repo_path: repoPath,
        subcommand: 'diff',
        flags: [`--output=${diffFile}`],
        base: await localForkPoint(),
        head: `refs/heads/${branch}`,
      }),
      repoPath,
    )
    if (!written.ok) throw new Error(publishFailureReason('read the diff of', branch, written.stderr))
  }
  if (!existsSync(diffFile) || readFileSync(diffFile, 'utf8').trim() === '')
    throw new Error('outer publisher refused to rebase an empty diff')

  // (e2) TEACH THIS CHECKOUT TO MERGE THE AS_BUILT LOG BEFORE ANY REPLAY TOUCHES IT.
  //      The log is newest-first and every build prepends at the same offset under the same three
  //      header lines, so two concurrent builds conflict on it by construction — three publishes
  //      died on that file and nothing else on 2026-08-15T23:20Z. The entry-aware driver in
  //      `scripts/git/as-built-merge-driver.ts` unions whole entries instead, and `git apply
  //      --3way` below DOES consult it (verified against real git, not assumed). Installed here
  //      rather than assumed present because the binding lives in `.git/info/attributes`, which is
  //      untracked by design — see the driver's docblock for why committing it would be fatal.
  //      This binds THIS installation's driver and runs nothing out of `repoPath`; see the
  //      docblock on `ensureAsBuiltMergeDriver` for what running the checkout's own script cost.
  await ensureAsBuiltMergeDriver(run_host, repoPath)

  // (f) Replay in an ISOLATED worktree. NEVER the shared working tree: a failed apply there would
  //     poison every other lane's build.
  const added = await run_host(
    ['git', '-C', repoPath, 'worktree', 'add', '--detach', '--force', scratchDir, baseSha],
    repoPath,
  )
  if (!added.ok) throw new Error(publishFailureReason('provision a rebase worktree for', branch, added.stderr))
  // The scratch worktree is OURS and disposable, so this `--force` removal is safe on every exit.
  const dropScratch = async () => {
    await run_host(['git', '-C', repoPath, 'worktree', 'remove', '--force', scratchDir], repoPath)
  }
  try {
    /** Non-null once auto-resolution landed, carrying every path it ever touched (for diagnosis). */
    let autoResolved: string[] | null = null
    const applied = await run_host(['git', '-C', scratchDir, 'apply', '--3way', '--index', diffFile], scratchDir)
    if (!applied.ok) {
      // Name the files a human has to look at. Read in a LOOP now: this is also how a claimed
      // resolution is VERIFIED, and that second role is why it must not fail open.
      //
      // AN UNREADABLE CONFLICT STATE IS NOT AN EMPTY ONE. This used to swallow the command's
      // failure and return `[]`, which the post-resolution check at the bottom of the loop reads
      // as "nothing unmerged — the resolver succeeded". A `git diff` that never ran would have
      // been accepted as git's own evidence that the tree is clean, and the loop would go on to
      // commit and force-push whatever the resolver left behind. The resolver's word is never the
      // evidence; if git cannot be asked, there IS no evidence, and the only safe answer is to
      // refuse. Same reasoning as the wholesale-apply carve-out below: never report one condition
      // in the costume of another.
      //
      // `-z` + `core.quotePath=false` BECAUSE THIS LIST IS MACHINE-CONSUMED. It becomes the
      // resolver's `CONFLICTED FILES` and the literal pathspec of the staged-marker scan below; git's
      // default C-quoting renders `ünicode file.txt` as `"\303\274nicode file.txt"` — a name that
      // opens nothing and matches no pathspec. `-z` emits the raw bytes, NUL-separated.
      const unreadableConflictState = (detail: string): Error =>
        new Error(
          publishFailureReason(
            'read the conflict state of',
            branch,
            `${detail} — git could not be asked which paths are unmerged, so a claimed resolution CANNOT be verified; refusing rather than treating an unreadable index as a clean one`,
          ),
        )
      const readUnmerged = async (): Promise<string[]> => {
        let unmerged
        try {
          unmerged = await run_host(
            ['git', '-C', scratchDir, '-c', 'core.quotePath=false', 'diff', '-z', '--name-only', '--diff-filter=U'],
            scratchDir,
          )
        } catch (err) {
          throw unreadableConflictState(err instanceof Error ? err.message : String(err))
        }
        if (!unmerged.ok) throw unreadableConflictState(unmerged.stderr || 'git diff --diff-filter=U failed with no output')
        return unmerged.stdout.split('\0').filter((l) => l !== '')
      }
      /**
       * THE UNMERGED BIT IS NOT PROOF OF RESOLUTION. `git add <path>` clears the unmerged bit for
       * the WHOLE path regardless of what is still inside the file, so a resolver that fixes hunk
       * 1 of 2 and stages reads as RESOLVED to `--diff-filter=U` — and the orchestrator would then
       * commit `<<<<<<<` and force-push it to the shared branch. Realistic, not theoretical: the
       * resolver's own contract tells it to `git add` every conflicted file.
       *
       * So the STAGED CONTENT is scanned too: any candidate path whose staged delta ADDS a
       * conflict-marker line is still unresolved and goes back into the loop. Only ADDED lines
       * count (a marker that was already in the base is the base's problem, not this replay's),
       * and only the paths that ever conflicted are scanned (a fixture elsewhere in the repo that
       * legitimately contains marker text is none of our business).
       *
       * AND IT FAILS CLOSED, for the same reason `readUnmerged` does: a scan that could not run
       * found no markers in exactly the way a clean tree does, and the difference is a `<<<<<<<`
       * on the shared branch.
       */
      const stagedMarkerFiles = async (candidates: string[]): Promise<string[]> => {
        if (candidates.length === 0) return []
        const marked: string[] = []
        // Deliberate per-path subprocesses: markdown classification needs the candidate path, and
        // literal pathspecs avoid parsing quoted diff headers. Conflict sets are normally tiny.
        for (const candidate of candidates) {
          let res
          try {
            res = await run_host(
              ['git', '-C', scratchDir, 'diff', '--cached', '-U1', '--', `:(literal)${candidate}`],
              scratchDir,
            )
          } catch (err) {
            throw unreadableConflictState(err instanceof Error ? err.message : String(err))
          }
          if (!res.ok) throw unreadableConflictState(res.stderr || 'git diff --cached failed with no output')
          if (stagedDiffAddsConflictMarker(res.stdout, candidate)) marked.push(candidate)
        }
        return marked
      }
      let paths = await readUnmerged()
      // A FAILED APPLY WITH NOTHING UNMERGED IS NOT A CONFLICT. `git apply` refuses a malformed or
      // unappliable patch WHOLESALE (`corrupt patch at line N`, exit 128) without staging anything,
      // so `--diff-filter=U` legitimately names no files. Reporting that as a conflict produced the
      // single most expensive message of 2026-08-15: `conflicts with main in: (paths unreadable)`,
      // which sent two projects hunting for a merge conflict that did not exist while the actual
      // cause — a truncated patch, and separately a stale diff base — sat in git's own stderr,
      // discarded. The empty path list WAS the diagnosis and it read like a footnote.
      //
      // So: `TridentRebaseConflict` is reserved for the case where at least one file is genuinely
      // unmerged. Anything else surfaces git's own words. THE RESOLVER IS NEVER INVOKED HERE either
      // — there is nothing unmerged for it to reconcile, so handing it this failure would only
      // relabel a wrong patch as a conflict, which is the exact defect this carve-out fixed.
      if (paths.length === 0) {
        throw new Error(
          publishFailureReason(
            'apply the replay patch for',
            branch,
            `${applied.stderr || 'git apply failed with no output'} — the apply failed WHOLESALE and left nothing unmerged, so this is NOT a merge conflict; the patch or its base is wrong`,
          ),
        )
      }
      // No resolver configured → the attention state, byte-identical to the behaviour before
      // auto-resolution existed.
      if (resolve === undefined) throw new TridentRebaseConflict(branch, base, paths)
      // Bounded auto-resolution, mirroring `rebaseBranchOntoBase`. `repo_path` is the SCRATCH
      // worktree — the tree holding the markers — never the shared checkout other lanes build in.
      // Re-reading the unresolved set after a claimed RESOLVED is the lie-detector: the resolver's
      // word is never the evidence, git's index and git's staged bytes are.
      const everConflicted = new Set(paths)
      let rounds = 0
      while (paths.length > 0) {
        if (rounds >= MAX_CONFLICT_ROUNDS) throw new TridentRebaseConflict(branch, base, paths)
        rounds++
        const outcome = await resolve.resolve_conflict({
          repo_path: scratchDir,
          branch,
          base_branch: base,
          run: resolve.run,
          conflicted_files: paths,
          // The tree is a detached replay worktree, NOT a rebase in progress, and it has no
          // installed dependencies. The resolver's contract differs on both counts.
          mode: 'replay',
        })
        if (!outcome.resolved) throw new TridentRebaseConflict(branch, base, paths)
        const remaining = [
          ...new Set([...(await readUnmerged()), ...(await stagedMarkerFiles([...everConflicted]))]),
        ]
        // EVERY ROUND MUST SHRINK THE SET. `rebaseBranchOntoBase` can afford 12 rounds because
        // each one is USUALLY a different commit that `git rebase --continue` advanced onto —
        // #541 made that "usually" rather than "always": an arbiter-directed retry there
        // re-runs the resolver on the SAME commit, deliberately — and the reason is weaker
        // than it looks, so state it honestly: the resolver is NONDETERMINISTIC, so a second
        // attempt may succeed where the first failed. It carries NO new information. The
        // arbiter's reasoning is deliberately not threaded into that turn (passing an
        // untrusted judge's prose into a credentialed, write-capable agent was a
        // privilege-escalation path — `SPEC.md` Decisions Log 2026-09-12 names its absence as
        // the trap), so what a retry buys is another draw, not a better brief. Writing that
        // down is what stops someone restoring the channel to make this comment true. It
        // still spends a round and never resets the counter, so the cap remains the bound. No such tier exists here; there is
        // exactly one apply, so a round that leaves the same work undone will leave it undone
        // twelve times. Each round is a real Forge turn bounded at 8 minutes, awaited inside the
        // serial tick sweep — so 12 no-progress rounds is ~96 minutes during which no other run in
        // the process makes any progress at all. Zero progress once is the answer.
        if (remaining.length > 0 && remaining.length >= paths.length)
          throw new TridentRebaseConflict(branch, base, remaining)
        for (const p of remaining) everConflicted.add(p)
        paths = remaining
      }
      // Resolved: fall through to the ordinary commit + compare-and-swap below. The resolver's
      // contract has it `git add` its resolutions and forbids committing, so the replay commits
      // exactly as an unconflicted apply would — and still faces the full review gate.
      autoResolved = [...everConflicted]
    }
    // THE REPLAY NOTE IS METADATA, NEVER A SUBJECT. This was measured on main in e6d4610d
    // (#354), 47144a2a (#348), bce629e2 (#327), and d2680a09 (#328): every PR title on
    // 2026-08-17/18 was this replay string instead of the builder's subject. Carrying `%B` makes
    // the note body-only metadata. A replay of a replay reads that carried message again, so the
    // original subject survives arbitrarily many replays and every replay appends exactly one
    // provenance line. The read fails CLOSED: committing the note alone when git cannot read the
    // original would silently reproduce the measured defect precisely when git is broken.
    const replayNote =
      `rebase ${branch} onto ${base} @ ${baseSha.slice(0, 7)} (replayed from ${oldHead.slice(0, 7)})`
    const originalMessage = await run_host(
      ['git', '-C', scratchDir, 'log', '-1', '--format=%B', oldHead],
      scratchDir,
    )
    if (!originalMessage.ok)
      throw new Error(
        publishFailureReason(
          'read the commit message of',
          branch,
          originalMessage.stderr || 'git log -1 failed with no output',
        ),
      )
    const carried = originalMessage.stdout.trim()
    const commitMessage = carried === '' ? replayNote : `${carried}\n\n${replayNote}`
    const committed = await run_host(
      [
        'git',
        '-C',
        scratchDir,
        '-c',
        'user.name=trident',
        '-c',
        'user.email=trident@neutron.local',
        'commit',
        '-m',
        commitMessage,
      ],
      scratchDir,
    )
    if (!committed.ok) {
      // GIT'S DIAGNOSIS, WHEREVER GIT PUT IT. `git commit` writes "nothing to commit" to STDOUT,
      // and forwarding only stderr collapsed the single most informative failure on this path into
      // a bare `outer publisher could not commit the rebase of branch X` — no cause, and the
      // `finally` below has already deleted the tree that held it. Same defect class as the
      // wholesale-apply carve-out above: never discard what git actually said.
      const said = [committed.stderr, committed.stdout]
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .join(' — ')
      // A RESOLUTION THAT LEFT NOTHING TO COMMIT IS AN ATTENTION STATE, NOT A GIT FAILURE. It means
      // the resolver took the base's side of every hunk verbatim, so the branch now contributes
      // nothing — exactly the silent-tautology outcome the #290 hand-resolution shows is the
      // dangerous one. It is a mergeability fact about the branch, so it gets the same non-verdict
      // typed failure the conflict it came from would have got.
      if (autoResolved !== null && /nothing (?:added )?to commit|no changes added/i.test(said))
        throw new TridentRebaseConflict(branch, base, autoResolved)
      throw new Error(
        publishFailureReason('commit the rebase of', branch, said || `git commit exited ${committed.exit_code}`),
      )
    }
    const replayed = await run_host(['git', '-C', scratchDir, 'rev-parse', 'HEAD'], scratchDir)
    if (!replayed.ok) throw new Error(publishFailureReason('read the replayed tip of', branch, replayed.stderr))
    const newHead = replayed.stdout.trim()

    // (h) COMPARE-AND-SWAP. `update-ref <ref> <new> <old>` fails if the branch is no longer at
    //     `<old>` — something else moved it, so we refuse instead of overwriting it.
    const swapped = await run_host(
      ['git', '-C', repoPath, 'update-ref', `refs/heads/${branch}`, newHead, oldHead],
      repoPath,
    )
    if (!swapped.ok) throw new Error(publishFailureReason('advance', branch, swapped.stderr))
    return { head: newHead, rebased: true, baseSha }
  } finally {
    await dropScratch()
  }
}

