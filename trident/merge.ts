/**
 * @neutronai/trident — merge + cleanup, per git-mode.
 *
 * Fills in the `MergeCleanupDeps` bodies the PR-2 `cleanupAfterMerge`
 * seam (git-mode.ts) calls on the `argus APPROVE → done` transition.
 * Both modes are host-command sequences over an injected runner (the
 * same `(cmd, cwd) => HostCommandResult` shape `defaultGitModeProbe`
 * uses), so tests assert the exact git/gh calls without shelling out.
 *
 *   • `'pr'`    → `gh pr merge <pr> --squash --match-head-commit <reviewed OID>`,
 *                 then delete the REMOTE branch (`git push origin --delete`) +
 *                 the local branch.
 *   • `'local'` → merge the feature branch into the base locally, then
 *                 delete the local branch.
 *
 * BASE-DRIFT HOLD (ISSUES #542). BOTH modes are gated on the base not having
 * moved MATERIALLY between the review and the merge — otherwise an APPROVE lands
 * against a base the reviewer never saw. See the block above `assessBaseDrift`
 * for what "materially" means here, why the review-time base sha is DERIVED from
 * the fork point rather than recorded by the reviewer, and what the gate
 * deliberately does not catch.
 *
 * WORKTREE CLEANUP — ENFORCED (Trident v2, D-1/C3). The prior "Ryan-locked: NO
 * `git worktree remove`" rule held while Open ran plain branches. Trident v2's
 * inner workflow builds in `isolation:'worktree'` worktrees, and the harness
 * removes a worktree ONLY IF UNCHANGED — a Forge build always commits, so the
 * worktree is orphaned unless trident removes it (the June fseventsd CPU-peg
 * wedge driver). The inner workflow's `finally{}` cleans up on every inner path;
 * this is the OUTER backstop: after the merge + branch teardown, if `run.worktree`
 * is set, best-effort `git worktree remove` + `git worktree prune` so
 * `git worktree list` is clean after EVERY merge. Best-effort + non-fatal: the
 * merge has already landed, so a failed worktree removal is logged, never thrown
 * (it must not undo a completed merge).
 *
 * …WITH ONE HARD BOUND (ISSUES #541): a DIRTY worktree — uncommitted changes
 * INCLUDING untracked files, or a tree we cannot prove clean — is PRESERVED, and
 * no removal here ever passes `--force`. Force-removal from a cleanup path is
 * what destroyed 197 insertions across 7 files on PR #171; an orphaned worktree
 * is cosmetic, work that exists nowhere else is not. See `removeWorktreePath`.
 *
 * THE MERGE IS PINNED TO THE REVIEWED COMMIT (#545). A bare `gh pr merge` merges
 * whatever the PR head is AT MERGE TIME, which is not necessarily what Argus
 * reviewed: between the APPROVE and this call anyone (a human, another agent, a
 * lingering Forge worktree) can push, and the merge would ship code no reviewer
 * ever saw. That window is not theoretical — it was OBSERVED on this repo (PR
 * #171 went clean → dirty mid-review). So the inner workflow records the OID OF
 * THE COMMIT THE REVIEWED DIFF WAS GENERATED FROM — the building agent reports
 * its `commitSha` alongside that diff, never a fresh head probe (a third party's
 * push satisfies a probe just as well, and pinning to it would certify code no
 * reviewer read) — and carries it in the typed terminal result
 * (`reviewedHead`); `mergePr` reads it back off the run and passes
 * `--match-head-commit`, so a moved head makes GitHub REFUSE the merge and the
 * run fails LOUDLY. Fail-CLOSED: no recorded reviewed OID → no merge (an
 * unpinnable merge is exactly the unreviewable merge this prevents).
 */

import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import { createLogger } from '@neutronai/logger'

import type { HostCommandResult } from './git-mode.ts'
import type { MergeCleanupDeps } from './git-mode.ts'
import type { TridentRun } from './store.ts'

export type RunHostCommand = (cmd: string[], cwd?: string) => Promise<HostCommandResult>

const log = createLogger('trident-merge')

/** Thrown when a merge/cleanup host command exits non-zero. */
export class TridentMergeError extends Error {
  constructor(
    message: string,
    readonly step: string,
    readonly result: HostCommandResult,
  ) {
    super(message)
    this.name = 'TridentMergeError'
  }
}

/**
 * ISSUES #542 — thrown when the base branch moved MATERIALLY between the review
 * and the merge, so landing would apply an APPROVE to a base the review never
 * saw. The OUTER loop (`orchestrator.applyResult`) maps this to a `failed` run
 * whose `failure_reason` is `message` — the terminal delivery posts exactly that
 * to chat, so the hold is LOUD rather than a silent land.
 *
 * `detail` carries the machine-readable provenance (both shas + the overlapping
 * paths) for the audit trail; `message` is the plain-English, no-raw-git-stderr
 * text the owner reads.
 */
export class TridentBaseDriftHold extends Error {
  constructor(
    message: string,
    readonly detail: {
      /** The base sha the reviewed diff was computed against (the fork point). */
      review_base_sha: string | null
      /** The base tip the merge would have landed on. */
      current_base_sha: string | null
      /** Reviewed-diff paths the moved base ALSO changed, minus the ones git
       *  raised a conflict on (those went through the resolver). */
      silent_overlap: string[]
    },
  ) {
    super(message)
    this.name = 'TridentBaseDriftHold'
  }
}

/**
 * Thrown when a rebase conflict is genuinely un-resolvable/ambiguous and the
 * bounded Forge resolver ESCALATED (or automatic resolution was unavailable).
 * The OUTER loop (`orchestrator.applyResult`) maps this to a `failed` run whose
 * `failure_reason` is the SPECIFIC question — the terminal delivery posts that
 * question to chat, never a raw "merge failed" (#342 step 3).
 */
export class TridentMergeConflictEscalation extends Error {
  constructor(readonly question: string) {
    super(question)
    this.name = 'TridentMergeConflictEscalation'
  }
}

/**
 * A bounded Forge that resolves a git REBASE conflict IN the repo's working
 * tree (mid-rebase, conflict markers present). Production is
 * `buildForgeConflictResolver` (`conflict-resolver.ts`) over the composer's
 * ephemeral substrate factory; tests inject a stub. It resolves + `git add`s the
 * conflicts (the OUTER `mergeLocal` runs `git rebase --continue`), returning:
 *   - `{ resolved: true }`               → conflicts staged, safe to continue.
 *   - `{ resolved: false; question }`    → ambiguous → escalate to chat.
 */
export interface MergeConflictResolver {
  (input: {
    /** The repo working tree (cwd, mid-rebase). */
    repo_path: string
    /** The build's branch being rebased. */
    branch: string
    /** The base branch it is rebasing onto. */
    base_branch: string
    run: TridentRun
    /** Files with unresolved conflict markers (`--diff-filter=U`). */
    conflicted_files: string[]
  }): Promise<{ resolved: true } | { resolved: false; question: string }>
}

/** Bound the rebase-continue loop so a pathological history can't spin forever. */
const MAX_CONFLICT_ROUNDS = 12

/**
 * Resolve the base branch to merge into. Tries `origin/HEAD`'s symbolic
 * target, then a local `main`/`master`, defaulting to `main`. Never
 * throws — a probe failure degrades to `main`.
 */
export async function detectBaseBranch(
  run_host: RunHostCommand,
  repo_path: string,
): Promise<string> {
  try {
    const sym = await run_host(
      ['git', '-C', repo_path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      repo_path,
    )
    if (sym.ok && sym.stdout.trim().length > 0) {
      // e.g. "origin/main" → "main"
      const ref = sym.stdout.trim()
      const slash = ref.indexOf('/')
      return slash >= 0 ? ref.slice(slash + 1) : ref
    }
  } catch {
    // fall through to the default
  }
  return 'main'
}

// ---------------------------------------------------------------------------
// BASE-DRIFT HOLD (ISSUES #542)
// ---------------------------------------------------------------------------
//
// THE HOLE. Nothing held a merge when the base moved after the review, so an
// APPROVE could be applied to a base the reviewer never saw. Local mode rebases
// onto the LATEST base and lands; a TEXTUAL conflict hits the bounded Forge
// resolver, but a SEMANTIC one — base and branch edit the same file in places
// git reconciles silently — lands with nothing having looked at the combination.
// PR mode had exactly one other mechanism forcing a branch to contain current
// main, GitHub's `strict_required_status_checks_policy`, and that was turned OFF
// on this repo 2026-08-11. With both absent there is no protection at all.
//
// WHY THE REVIEW-TIME BASE SHA IS DERIVED HERE, NOT RECORDED BY THE REVIEWER.
// The obvious implementation is a `review_base_sha` column written by the inner
// workflow's argus checkpoint step. It is the weaker design, for three reasons:
//   1. IT WOULD RECORD THE WRONG SHA. That writer's only cheap option is
//      `git rev-parse <base>` in the repo of record AT REVIEW TIME — but a
//      sibling build can land in that shared checkout DURING the review, so the
//      recorded value can name a base the review never saw. The fork point
//      cannot: the build worktree is cut from base at build start and the
//      reviewed diff is `git diff <base>..HEAD` computed inside it, so
//      `merge-base(branch, base)` IS the tree the review was computed against.
//   2. IT FAILS OPEN BY OMISSION. That writer is an LLM-driven Bash step; a
//      missed/garbled write leaves the column null and silently disables the
//      gate — the exact failure class this issue is about. A value derived from
//      refs that must exist for the merge to happen at all cannot go missing.
//   3. IT WOULD NOT COVER RUNS ALREADY IN FLIGHT (nor any row written before the
//      column existed), which is where the next silent land actually comes from.
// So: no new column, no new writer, no new failure mode — the same fact, read
// from git at merge time. (The name is kept: `review_base_sha` is what it is.)
//
// WHAT "MATERIALLY" MEANS HERE — THE CHOICE, AND WHY.
// Material drift = the base moved AND its new commits changed at least one file
// the reviewed diff also changes AND git raised no conflict on that file.
// Rejected alternatives, and what each costs:
//   * ANY base movement → hold. Correct-by-construction and useless: on a repo
//     where main moves several times a day and a build takes an hour, this holds
//     essentially every merge, and a gate that always fires gets turned off.
//   * File overlap alone → hold. This is the one the issue's own wording points
//     at, and it is ALMOST right — but it swallows the textual-conflict path
//     whole. A file git DID conflict on was already handed to the bounded Forge
//     resolver with both sides in context, or escalated to chat as a specific
//     question. That mechanism exists, is deliberate, and is the thing the issue
//     says already works ("textual ones hit the resolver"). Holding there adds
//     no safety and deletes a working feature.
// Subtracting the conflicted files leaves EXACTLY the uncovered gap the issue
// names: base and branch both touched the file, git merged them with no
// complaint, and therefore nothing — not the reviewer (who never saw the new
// base), not the resolver (never invoked) — ever looked at the combination.
//
// WHAT THIS DELIBERATELY DOES NOT CATCH, stated so nobody reads more into a
// green merge than is there. Four holes, all chosen:
//
//   1. CROSS-FILE SEMANTIC COUPLING. If the base changes the behaviour of a
//      helper in `a.ts` and the branch adds a caller in `b.ts`, the file sets do
//      not intersect and this lands. Catching that requires re-running the
//      review, not a git query.
//
//   2. THE UNCONFLICTED HUNKS OF A CONFLICTED FILE. The resolver exemption is
//      per PATH, not per hunk: once every branch commit touching `F` has been
//      through the resolver, ALL of `F` is exempt — including hunks git
//      reconciled silently at the other end of the file. Concretely: base edits
//      line 10, branch edits line 20, and the two collide only at line 1. The
//      resolver is handed the line-1 conflict, resolves it, and the line-10 /
//      line-20 combination lands with nobody having compared them.
//      This is the deliberate choice, not an oversight:
//        * The alternative — hold whenever a conflicted file also has silently
//          merged hunks — holds nearly every file that conflicts at all, because
//          a file worth conflicting on is usually edited in more than one place.
//          That deletes the resolver path in practice, and the issue is explicit
//          that the textual path already works.
//        * The resolver is not given a hunk. It is given the file, mid-rebase,
//          with both sides in the working tree, and it is a Forge — the whole
//          file is in its context whether or not git marked it. Coverage here is
//          "a reviewer looked at this file against this base", which is true.
//        * Erring the other way costs a re-run of a build that already conflicted
//          once; the gate that always fires is the gate that gets turned off.
//      So: a conflicted path is treated as reviewed-against-this-base as a
//      WHOLE. If that ever proves too generous, the narrowing is to intersect
//      `git diff <review_base> <current_base> -- F` hunk ranges with the
//      resolver's — a strictly bigger change than this circuit breaker.
//
//   3. A BASE THAT WAS REWOUND BELOW THE FORK POINT (pr mode). The fork point is
//      derived, so it can only ever name a commit the CURRENT base still
//      contains. Graph `A─B─F`, branch `F` reviewed as `B..F`, then `base` is
//      force-reset from `B` back to `A`: `merge-base(A, F)` is `A`, which equals
//      the base tip, so this reports `moved: false` and lands — even though the
//      reviewed base was `B`, and a squash of `A..F` reintroduces `B`'s changes
//      that someone deliberately rewound. The `+` refspec on the fetch below
//      accepts exactly such a force-update, so this is a reachable input, not a
//      theoretical one. It is NOT closable from a derived fork point: nothing in
//      the repo at merge time distinguishes "the branch contains the base tip
//      because it was rebased onto it" from "…because the base was rewound under
//      it". Closing it needs the recorded `review_base_sha` this section rejects
//      above, and would buy this one case at the cost of the three failure modes
//      listed there — a trade worth making only if a rewound base ever actually
//      bites. A rewind is a deliberate human act on `main`; a stale review is the
//      routine one, and the routine one is what this gate is for.
//
//   4. A BASE THAT MOVES BETWEEN THE ASSESSMENT AND `gh pr merge` (pr mode).
//      The assessment reads `origin/<base>`; the land is a SERVER-side squash
//      that GitHub performs against whatever `<base>` is when it runs. Nothing in
//      the GitHub merge API takes a base precondition — `--match-head-commit`
//      pins the PR HEAD only — so a sibling lane landing in that window merges
//      onto a tip this gate never scored. The window is the single process spawn
//      between the two calls, down from "the whole review" before this gate
//      existed, and the assessment is deliberately the LAST thing before the
//      merge so it stays that small. Making it ZERO is a GitHub setting, not
//      code: `strict_required_status_checks_policy` (require branches to be up to
//      date) makes the server itself refuse a branch that does not contain the
//      current base. That setting was turned off on this repo 2026-08-11; this
//      gate is what covers the gap while it is off, and it does not replace it.
//
// This gate is the circuit breaker for the same-file silent-merge case, at file
// granularity, against a base that moved FORWARD; it is not a claim of semantic
// safety, and it is not atomic with the merge it guards.

/** A base-drift verdict over one (base, branch) pair. Pure data — the decision
 *  to hold is the caller's, because local mode must also subtract the files the
 *  rebase raised a conflict on. */
export interface BaseDriftAssessment {
  /** The base sha the reviewed diff was computed against (fork point), or null
   *  when it could not be resolved. */
  review_base_sha: string | null
  /** The base tip this merge would land on, or null when unresolvable. */
  current_base_sha: string | null
  /** The branch tip AS REVIEWED, or null when unresolvable. Captured because a
   *  local-mode rebase MOVES the branch ref, and the hold has to be able to put
   *  it back (a rebased branch no longer carries the drift being held on). */
  branch_head_sha: string | null
  /** True when the base tip is not the reviewed base — i.e. the base carries
   *  commits the reviewed diff never saw. */
  moved: boolean
  /** Reviewed-diff paths the moved base ALSO changed. Empty unless `moved`. */
  overlap: string[]
  /**
   * False when git could not answer the question. Paired with `moved` this is
   * deliberately ASYMMETRIC, and the asymmetry is MODE-DEPENDENT — see
   * `shouldHoldForBaseDrift`'s `hold_when_unassessable`:
   *   • `moved && !assessable` — we KNOW the base moved and could not determine
   *     what it changed. Fail CLOSED in every mode: once drift is established,
   *     an unassessable materiality must not be assumed benign.
   *   • `!moved && !assessable` — we never established that the base moved (a
   *     ref would not resolve). LOCAL mode may fail open, because the rebase +
   *     `git merge` that follow run in that same broken repo and fail loudly by
   *     themselves. PR mode may NOT: `gh pr merge` is a SERVER-side call that
   *     succeeds no matter how broken the local checkout is, so failing open
   *     there lands the PR with the gate having checked nothing at all.
   */
  assessable: boolean
}

/** A git object name, as `rev-parse`/`merge-base` print it (abbreviated or full).
 *  Anything else — most importantly the EMPTY stdout of a probe that resolved
 *  nothing — is treated as "did not resolve". */
const SHA_RE = /^[0-9a-f]{7,64}$/i

/** Resolve a ref to a commit sha, or null when it does not resolve to one. */
async function revParseCommit(
  run_host: RunHostCommand,
  repo: string,
  ref: string,
): Promise<string | null> {
  const res = await run_host(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo)
  const sha = res.stdout.trim()
  return res.ok && SHA_RE.test(sha) ? sha : null
}

/** The PR's head branch per GitHub, or null when it cannot be determined. Used
 *  only to make the drift gate answerable for a run whose `branch` column is
 *  null — never to widen what the merge then deletes. */
async function prHeadBranch(run_host: RunHostCommand, repo: string, pr: number): Promise<string | null> {
  const res = await run_host(
    ['gh', 'pr', 'view', String(pr), '--json', 'headRefName', '-q', '.headRefName'],
    repo,
  )
  const name = res.stdout.trim()
  return res.ok && name.length > 0 ? name : null
}

/**
 * `git diff --name-only <a> <b>` → the changed paths, or null when git failed.
 *
 * `--no-renames` is LOAD-BEARING, not tidiness. With git's default rename
 * detection, a base that renames `mod.ts` → `renamed.ts` reports only
 * `renamed.ts`; the reviewed diff still edits `mod.ts`, the path sets do not
 * intersect, and the gate lands exactly the same-file silent reconciliation it
 * exists to catch (the rebase happily applies the branch's hunk to the renamed
 * file). Suppressing rename detection reports the rename as delete-`mod.ts` +
 * add-`renamed.ts`, so the old path is in the set and the overlap fires. It
 * errs toward MORE holds, which is the correct direction for a circuit breaker.
 */
async function changedPaths(
  run_host: RunHostCommand,
  repo: string,
  a: string,
  b: string,
): Promise<string[] | null> {
  const res = await run_host(['git', '-C', repo, 'diff', '--name-only', '--no-renames', a, b], repo)
  if (!res.ok) return null
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Assess base drift for `branch_ref` against `base_ref` in `repo`. MUST be
 * called BEFORE any rebase: a rebase replays the branch onto the base tip, which
 * makes the fork point equal the tip and ERASES the very drift being measured.
 */
export async function assessBaseDrift(
  run_host: RunHostCommand,
  repo: string,
  base_ref: string,
  branch_ref: string,
): Promise<BaseDriftAssessment> {
  const current_base_sha = await revParseCommit(run_host, repo, base_ref)
  const branch_head = await revParseCommit(run_host, repo, branch_ref)
  const mb = await run_host(['git', '-C', repo, 'merge-base', base_ref, branch_ref], repo)
  const mbSha = mb.stdout.trim()
  const review_base_sha = mb.ok && SHA_RE.test(mbSha) ? mbSha : null
  if (current_base_sha === null || branch_head === null || review_base_sha === null) {
    return {
      review_base_sha,
      current_base_sha,
      branch_head_sha: branch_head,
      moved: false,
      overlap: [],
      assessable: false,
    }
  }
  if (review_base_sha === current_base_sha) {
    // The branch already contains the base tip — the reviewed diff's base IS the
    // base being landed on. Nothing moved; no file lists needed.
    //
    // This is also hole 3 (see the section header): a base REWOUND below the fork
    // point lands here reporting `moved: false`, because a derived fork point can
    // only ever name a commit the current base still contains.
    return {
      review_base_sha,
      current_base_sha,
      branch_head_sha: branch_head,
      moved: false,
      overlap: [],
      assessable: true,
    }
  }
  // Note an emergent nicety: if the base moved but its NET tree diff is empty
  // (a revert, a merge that restored the tree), `baseTouched` is `[]` and this
  // correctly reports no material drift — the reviewed diff's premise is the
  // TREE it was computed against, not the sha that names it.
  const baseTouched = await changedPaths(run_host, repo, review_base_sha, current_base_sha)
  const reviewed = await changedPaths(run_host, repo, review_base_sha, branch_head)
  if (baseTouched === null || reviewed === null) {
    // Drift ESTABLISHED, materiality unknown → fail closed (see `assessable`).
    return {
      review_base_sha,
      current_base_sha,
      branch_head_sha: branch_head,
      moved: true,
      overlap: [],
      assessable: false,
    }
  }
  const reviewedSet = new Set(reviewed)
  const overlap = [...new Set(baseTouched.filter((f) => reviewedSet.has(f)))].sort()
  return {
    review_base_sha,
    current_base_sha,
    branch_head_sha: branch_head,
    moved: true,
    overlap,
    assessable: true,
  }
}

/**
 * True when this assessment must HOLD the merge. `conflicted` are the paths the
 * rebase raised a textual conflict on for EVERY branch commit that touched them
 * (already routed through the resolver / chat escalation) — empty for modes that
 * never rebase locally.
 *
 * `hold_when_unassessable` picks the fail-open/fail-closed policy for the
 * "could not even establish whether the base moved" case. It exists because the
 * two modes have genuinely different backstops: after a fail-open in LOCAL mode
 * the same broken repo still has to survive a rebase and a `git merge`, which
 * fail loudly; PR mode's next step is `gh pr merge`, executed by GitHub, which
 * does not care that the local checkout is broken. So PR mode passes `true`.
 */
export function shouldHoldForBaseDrift(
  assessment: BaseDriftAssessment,
  conflicted: ReadonlySet<string> = new Set(),
  opts: { hold_when_unassessable?: boolean } = {},
): boolean {
  if (!assessment.assessable) {
    if (assessment.moved) return true
    if (opts.hold_when_unassessable === true) return true
    // LOCAL mode's fail-open rests on one claim: the same broken repo still has
    // to survive a rebase and a `git merge`, which fail loudly. That claim holds
    // only while THE REPO is the broken thing — a ref that would not resolve
    // breaks those steps too. It does NOT hold when both refs resolved fine and
    // git still could not answer, because then nothing is broken: the two
    // histories are simply unrelated. A rebase of unrelated history replays the
    // commits and `git merge --no-ff` lands them, with no fork point having ever
    // established what the review was computed against. Nothing downstream is
    // loud there, so this fails closed.
    return assessment.current_base_sha !== null && assessment.branch_head_sha !== null
  }
  if (!assessment.moved) return false
  return assessment.overlap.some((f) => !conflicted.has(f))
}

/** The commits in `base..head` that touched `path`, or null when git failed.
 *  These are the ORIGINAL (pre-rebase) commit shas — the same identities
 *  `REBASE_HEAD` reports while they are being replayed, which is what makes the
 *  two sets in `resolverCoveredPaths` directly comparable. */
async function commitsTouching(
  run_host: RunHostCommand,
  repo: string,
  base_sha: string,
  head_sha: string,
  path: string,
): Promise<string[] | null> {
  const res = await run_host(
    ['git', '-C', repo, 'log', '--format=%H', `${base_sha}..${head_sha}`, '--', path],
    repo,
  )
  if (!res.ok) return null
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => SHA_RE.test(s))
}

/**
 * Of the paths the rebase conflicted on, the ones the resolver ACTUALLY saw the
 * whole story for — the only ones the #542 hold may subtract.
 *
 * Membership is not enough. A branch that touches `F` in two commits, where the
 * first conflicts against the drifted base and the second then replays cleanly
 * on top of the resolution, gives the resolver commit-1-vs-base and nothing
 * else: nobody ever saw base-vs-(C1+C2). Exempting `F` on the strength of that
 * one conflict is exactly the silent reconciliation this gate exists to stop.
 *
 * So a path is covered only when EVERY branch commit that touches it conflicted
 * and was handed to the resolver. This is matched by COMMIT IDENTITY, not by
 * counting rounds: rounds are loop iterations, and one commit can occupy several
 * of them (a resolver that stages nothing leaves `--continue` refusing, git
 * re-reports the same conflict, and the same commit is offered again). Counting
 * those as two would let one commit's resolution vouch for a second commit
 * nobody ever saw — coverage inflated to exactly the un-reviewed combination
 * this gate exists to stop.
 *
 * Anything we cannot establish — a failed `git log`, a path with no commits
 * behind it, a round whose `REBASE_HEAD` would not resolve (and so was never
 * attributed) — leaves the path NOT covered, so the hold fires. Erring toward a
 * hold costs a re-run; erring the other way costs an un-reviewed merge.
 */
async function resolverCoveredPaths(
  run_host: RunHostCommand,
  repo: string,
  conflicted: ReadonlyMap<string, ReadonlySet<string>>,
  review_base_sha: string | null,
  branch_head_sha: string | null,
): Promise<Set<string>> {
  const covered = new Set<string>()
  if (review_base_sha === null || branch_head_sha === null) return covered
  for (const [path, resolvedCommits] of conflicted) {
    const touching = await commitsTouching(run_host, repo, review_base_sha, branch_head_sha, path)
    if (touching === null || touching.length === 0) continue
    if (touching.every((sha) => resolvedCommits.has(sha))) covered.add(path)
  }
  return covered
}

/**
 * Move `branch` back to `sha` from the worktree that has it checked out, and
 * VERIFY it landed there. Returns whether the ref now points at `sha`.
 *
 * `git branch -f` refuses a branch checked out in another worktree, so the reset
 * is issued from `wt` (which the rebase left on `branch`); the verification is
 * read from the shared repo, because that is the ref every later run will see.
 */
async function restoreBranchRef(
  run_host: RunHostCommand,
  wt: string,
  repo: string,
  branch: string,
  sha: string | null,
): Promise<boolean> {
  if (sha === null) return false
  await run_host(['git', '-C', wt, 'reset', '--hard', sha], wt)
  return (await revParseCommit(run_host, repo, branch)) === sha
}

/** Short, stable sha rendering for the owner-facing hold message. */
function shortSha(sha: string | null): string {
  return sha === null ? 'unknown' : sha.slice(0, 7)
}

/** Cap the path list so one huge overlap can't produce an unreadable chat post. */
function renderPaths(paths: string[]): string {
  const head = paths.slice(0, 5)
  const rest = paths.length - head.length
  return rest > 0 ? `${head.join(', ')} and ${rest} more` : head.join(', ')
}

/**
 * The owner-facing hold text. PLAIN prose — no raw git stderr, no paths outside
 * the repo, no identities — mirroring the conflict escalation's contract (#342
 * step 3), because this string is posted verbatim to chat.
 */
export function baseDriftHoldMessage(
  branch: string,
  base: string,
  assessment: BaseDriftAssessment,
  silent_overlap: string[],
): string {
  if (!assessment.assessable && !assessment.moved) {
    // We never even established that the base moved (a fetch that failed, a ref
    // that would not resolve, a merge-base that would not answer). Say exactly
    // that instead of narrating a drift we did not observe — a hold nobody
    // believes is a hold nobody acts on.
    //
    // NAME THE REF THAT ACTUALLY FAILED. The assessment already says which:
    // a null sha is a ref that did not resolve, and if BOTH resolved then the
    // failure was the fork point between them. Blaming the base for a branch
    // that would not resolve sent the reader to look at `main` — which is fine —
    // and prescribed a re-run that cannot fix a missing branch ref.
    const unresolved: string[] = []
    if (assessment.current_base_sha === null) unresolved.push(`\`${base}\``)
    if (assessment.branch_head_sha === null) unresolved.push(`\`${branch}\``)
    const cause =
      unresolved.length > 0
        ? `I could not establish where ${unresolved.join(' or ')} ` +
          `${unresolved.length > 1 ? 'are' : 'is'} right now`
        : `I could not establish what \`${branch}\` and \`${base}\` have in common`
    return (
      `I'm holding the merge of \`${branch}\` into \`${base}\`: ${cause}, so I cannot tell ` +
      `whether this was reviewed against it. Nothing has confirmed that combination, so I am ` +
      `not landing it — re-run the build to get the diff reviewed against the current ` +
      `\`${base}\`.`
    )
  }
  const head =
    `I'm holding the merge of \`${branch}\` into \`${base}\`: it was reviewed against ` +
    `\`${base}\` at \`${shortSha(assessment.review_base_sha)}\`, but \`${base}\` has since ` +
    `moved to \`${shortSha(assessment.current_base_sha)}\``
  const why = assessment.assessable
    ? ` and those new commits changed ${silent_overlap.length} file(s) the reviewed diff also ` +
      `changes (${renderPaths(silent_overlap)}) with no conflict for anything to catch`
    : ` and I could not determine which files it changed`
  return (
    `${head}${why}. Nothing has reviewed that combination, so I am not landing it — ` +
    `re-run the build to get the diff reviewed against the current \`${base}\`.`
  )
}

/**
 * Per-working-tree serialization for LOCAL-mode merges. Two parallel builds in
 * the SAME project share ONE build workspace (`ensureProjectBuildWorkspace` keys
 * the `code` dir on the project slug), so both runs carry the IDENTICAL
 * `repo_path`. A local merge is `git checkout <base>` + `git merge --no-ff` in
 * that single working tree; running two concurrently collides — build A's
 * committed-but-not-yet-merged files show up as UNTRACKED when build B checks
 * out `base`, and git aborts B with "untracked working tree files would be
 * overwritten". A per-`repo_path` promise chain forces the second merge to WAIT
 * for the first: by the time B checks out `base`, A's files are TRACKED on
 * `base` and B merges cleanly on top. Keyed on `repo_path` so merges in
 * DIFFERENT workspaces (different projects) still run fully in parallel. The
 * PR-mode path merges the remote and never touches the shared tree, so it is
 * NOT gated here.
 */
const localMergeChains = new Map<string, Promise<void>>()

function withLocalMergeLock(repo_path: string, body: () => Promise<void>): Promise<void> {
  const prev = localMergeChains.get(repo_path) ?? Promise.resolve()
  // Chain off the prior merge REGARDLESS of whether it settled ok — a failed
  // predecessor must not wedge the workspace's queue (swallow its result here;
  // that call already surfaced its own rejection to its own caller).
  const next = prev.then(
    () => body(),
    () => body(),
  )
  localMergeChains.set(repo_path, next)
  // GC the tail once it settles so the map can't grow unbounded across builds.
  // `then(cleanup, cleanup)` (not `.finally`) so this bookkeeping never produces
  // an unhandled rejection — `next` itself (returned below) still carries the
  // real merge result/rejection to the caller.
  const cleanup = (): void => {
    if (localMergeChains.get(repo_path) === next) localMergeChains.delete(repo_path)
  }
  next.then(cleanup, cleanup)
  return next
}

/** A full git object id — the only form `--match-head-commit` accepts (an
 *  abbreviated sha would be rejected by the API, turning the guard into an
 *  unconditional merge failure). */
const FULL_OID = /^[0-9a-f]{40}$/

/**
 * The head OID the reviewers actually judged, read back off the run's typed
 * terminal result (`inner_result`, the `reviewedHead` field `inner-workflow.mjs`
 * writes at review time). Returns null when the column is absent/unparseable or
 * the value is not a full OID — the caller must then REFUSE to merge (#545): a
 * merge we cannot pin is a merge we cannot prove was reviewed.
 */
export function reviewedHeadOid(run: TridentRun): string | null {
  if (typeof run.inner_result !== 'string' || run.inner_result.trim().length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(run.inner_result)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const head = (parsed as Record<string, unknown>).reviewedHead
  if (typeof head !== 'string') return null
  const oid = head.trim().toLowerCase()
  return FULL_OID.test(oid) ? oid : null
}

function must(step: string, res: HostCommandResult): HostCommandResult {
  if (!res.ok) {
    throw new TridentMergeError(
      `${step} failed: ${res.stderr || res.stdout || `exit ${res.exit_code}`}`,
      step,
      res,
    )
  }
  return res
}

/** Where a run's dedicated MERGE worktree lives: `<repo>/.trident-worktrees/<slug>-<id8>`.
 *  Pure + deterministic (keyed on the run so N same-project builds get DISTINCT
 *  paths), so the store's `worktree` column, the provisioning, and the teardown all
 *  agree without threading a path around. `.trident-worktrees/` is inside the
 *  project's own storage (the leak-gate + fseventsd-CPU lesson: never scatter
 *  worktrees outside the repo). */
export function runWorktreePath(repo_path: string, run: Pick<TridentRun, 'id' | 'slug'>): string {
  const id8 = run.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'run'
  const slug = run.slug.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'build'
  return join(repo_path, '.trident-worktrees', `${slug}-${id8}`)
}

/**
 * FIX 2 (#351/#352) — DEFENSIVE stale-state auto-recovery. Before ANY merge/rebase
 * touches the shared base repo, abort a lingering merge/rebase left by a PRIOR
 * build (a crash, or a pre-#342 hard-fail) and hard-reset to a clean base. Without
 * this, ONE poisoned checkout (`.git/MERGE_HEAD` / `.git/rebase-merge` /
 * `.git/rebase-apply` present) makes EVERY later build in that repo trip
 * "you need to resolve your current index first" (the verified 2026-07-03 kvwal
 * failure). Self-healing: `git merge --abort` / `git rebase --abort` each succeed
 * ONLY when that operation was actually in progress, so their exit code is an
 * accurate "was-dirty" probe; a `reset --hard` then restores a clean HEAD. All
 * best-effort — a clean repo makes every command a harmless no-op.
 */
export async function recoverStaleGitState(run_host: RunHostCommand, repo: string): Promise<boolean> {
  const mergeAbort = await run_host(['git', '-C', repo, 'merge', '--abort'], repo)
  const rebaseAbort = await run_host(['git', '-C', repo, 'rebase', '--abort'], repo)
  const wasDirty = mergeAbort.ok || rebaseAbort.ok
  if (wasDirty) {
    // A merge/rebase WAS in progress and is now aborted; hard-reset restores the
    // index+working tree to HEAD so the next checkout/merge starts from clean.
    // Deliberately NOT `git clean` — the shared checkout may hold a real project's
    // untracked files, and a build never depends on wiping them.
    await run_host(['git', '-C', repo, 'reset', '--hard'], repo)
  }
  return wasDirty
}

/** Symlink-resolved path, or the input when it cannot be resolved. */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Is this worktree holding work that exists NOWHERE ELSE? (ISSUES #541)
 *
 * Untracked files count as dirt: the #541 incident's lost work included files git
 * had never seen. `--untracked-files=all` then EXPANDS an untracked DIRECTORY into
 * its individual files — plain `--porcelain` collapses a whole new `src/feature/`
 * into one `?? src/feature/` line, and this output is what names the work for the
 * operator. Ignored files (node_modules, build output) are NOT counted — they are
 * not work.
 *
 * THE PROBE MUST BE POINTED AT A WORKTREE ROOT. `git -C <dir> status` walks UP to
 * the enclosing repo, so a leftover PLAIN DIRECTORY inside the checkout (a crashed
 * `worktree add`, a hand-made dir at the deterministic path) reports the SHARED
 * CHECKOUT's dirt as its own — an empty directory would then look like precious
 * work and fail every merge. `--show-toplevel` must name `wt` itself.
 *
 * UNVERIFIABLE COUNTS AS DIRTY. If the probe cannot run in a directory that DOES
 * exist (broken worktree admin, a throwing host) we cannot prove the tree is
 * clean, and the failure mode of guessing wrong here is unrecoverable data loss.
 * That includes `rev-parse` itself failing: a directory git cannot classify at
 * all is NOT the same as one it classifies as "somebody else's repo". A path that
 * does not exist at all is not "unverifiable" either — there is no working tree
 * there to preserve, only a stale admin entry for `prune`, which is why the
 * `existsSync` gate is load-bearing rather than a shortcut for the probe.
 *
 * @returns the dirty porcelain output, or `null` when the tree is provably clean
 *          (or absent, or a directory rooted in some OTHER repo).
 */
async function worktreeDirt(run_host: RunHostCommand, wt: string): Promise<string | null> {
  if (!existsSync(wt)) return null
  try {
    const top = await run_host(['git', '-C', wt, 'rev-parse', '--show-toplevel'], wt)
    const top_path = top.ok ? top.stdout.trim() : ''
    // The directory exists but git cannot say what it is → unverifiable → dirty.
    if (top_path === '')
      return top.stderr || top.stdout || `git rev-parse --show-toplevel exited ${top.exit_code}`
    // Rooted in a DIFFERENT repo: a plain directory whose status would be the
    // PARENT repo's, not this tree's. Nothing here is preservable work of ours.
    // git prints the SYMLINK-RESOLVED root, so `/tmp/x` on a platform where /tmp
    // is a symlink must still match — compare against the resolved path too.
    if (top_path !== wt && top_path !== realpathOrSelf(wt)) return null
    const res = await run_host(['git', '-C', wt, 'status', '--porcelain', '--untracked-files=all'], wt)
    if (!res.ok) return res.stderr || res.stdout || `git status exited ${res.exit_code}`
    return res.stdout.trim() === '' ? null : res.stdout.trim()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Remove a specific worktree path + prune stale admin entries — UNLESS it is
 * dirty (ISSUES #541).
 *
 * This used to be an unconditional `git worktree remove --force`, the outer twin
 * of the inner workflow's force-removing cleanup agent that destroyed 197
 * insertions across 7 files on PR #171. A dirty tree is now left exactly as it
 * is, and the removal of a clean one uses a PLAIN `git worktree remove` so git's
 * own dirty check is a second, independent gate on top of ours.
 *
 * `prune` is safe either way: it only drops admin entries whose working directory
 * is already gone — it never deletes a working tree.
 *
 * @returns the reason the worktree was PRESERVED — its dirty paths, or why the
 *          removal was refused — and `null` when it was removed (or was already
 *          absent, or was never a worktree of ours).
 */
async function removeWorktreePath(
  run_host: RunHostCommand,
  repo: string,
  wt: string,
): Promise<string | null> {
  try {
    const dirt = await worktreeDirt(run_host, wt)
    if (dirt !== null) {
      // Nothing is force-removed and nothing is pruned out from under it: the
      // caller decides whether a preserved tree is fatal (provisioning) or merely
      // reported (post-merge cleanup).
      log.warn('worktree_preserved_dirty', {
        worktree: wt,
        dirty: dirt,
        action: `trident preserved uncommitted work at ${wt} — nothing was force-removed; recover or delete it by hand`,
      })
      return dirt
    }
    // A REFUSED REMOVAL IS NOT A REMOVAL. `git worktree remove` declines a locked
    // tree, one with submodules, or one that was dirtied in the window between the
    // probe above and this call (the plain — never `--force` — remove is exactly
    // the second gate that catches that race). Ignoring the result reported those
    // survivors as removed: `freeBranchFromWorktrees` then skipped its preservation
    // error and the merge died three lines later on git's raw "already checked out
    // at <path>", the confusing message this file exists to replace. The SHELL twin
    // already scored a declined remove as `PRESERVED … reason=unverifiable`; this is
    // the same rule on this side.
    //
    // ESCALATE ONLY FOR A WORKTREE ROOT THAT SURVIVED, because `remove` also fails
    // (exit 128, "is not a working tree") for a path that was never a worktree —
    // which is the ORDINARY provisioning case, where nothing is at that path at all.
    // Treating that as preserved work would throw on every clean merge. The same
    // `--show-toplevel` test `worktreeDirt` uses tells the two apart: a leftover
    // PLAIN directory is rooted in the enclosing repo, not itself, and holds no work
    // of ours to preserve.
    const removal = await run_host(['git', '-C', repo, 'worktree', 'remove', wt], repo)
    if (!removal.ok && existsSync(wt)) {
      const top = await run_host(['git', '-C', wt, 'rev-parse', '--show-toplevel'], wt)
      const top_path = top.ok ? top.stdout.trim() : ''
      if (top_path === wt || top_path === realpathOrSelf(wt)) {
        const why =
          removal.stderr || removal.stdout || `git worktree remove exited ${removal.exit_code}`
        log.warn('worktree_preserved_unverifiable', {
          worktree: wt,
          reason: why,
          action: `trident could not remove ${wt} and did NOT force it — the tree is still there; unlock or clear it by hand`,
        })
        return why
      }
    }
    await run_host(['git', '-C', repo, 'worktree', 'prune'], repo)
    return null
  } catch (err) {
    // A THROWN removal is not a removal either — the same rule as the REFUSED one
    // above, which this used to contradict. Swallowing the throw and returning
    // `null` told `provisionRunWorktree` the path was clear, and it went straight
    // on to `git worktree add --force` over a tree that is still sitting there.
    // (`add` then refuses a non-empty directory, so nothing was destroyed — but
    // the operator got git's "already exists" instead of the preservation error
    // this function promises, which is the confusing message it exists to replace.)
    //
    // A path that is GONE is still safely "removed": there is no working tree
    // there to preserve. Anything else is UNVERIFIABLE — we cannot re-probe with a
    // host that is throwing — and unverifiable preserves, by construction.
    if (!existsSync(wt)) return null
    const why = err instanceof Error ? err.message : String(err)
    log.warn('worktree_preserved_unverifiable', {
      worktree: wt,
      reason: why,
      action: `trident could not remove ${wt} and did NOT force it — the tree is still there; unlock or clear it by hand`,
    })
    return why
  }
}

/**
 * FIX 1 (#351) — provision the run's DEDICATED merge worktree, detached at `base`.
 * Detached (`--detach`) so it never collides with `base` being checked out in the
 * shared repo ("`<base>` is already checked out"). Idempotent: any stale worktree
 * at the path (a crash-resumed run reusing the deterministic path) is removed +
 * pruned first. The whole rebase (the conflict-prone step) then runs HERE, so a
 * failed rebase can only dirty THIS throwaway worktree — never the shared checkout.
 *
 * A stale worktree that is DIRTY is NOT force-removed (ISSUES #541): it may hold
 * a half-finished conflict resolution that exists nowhere else. The merge FAILS
 * LOUDLY instead, naming the path.
 *
 * AND IT KEEPS FAILING UNTIL A HUMAN LOOKS. `runWorktreePath` is keyed on
 * `run.id` + `run.slug`, both stable across retries, and #194 made slugs reusable
 * — so a retry re-derives THIS path and re-hits THIS dirty tree. That is the
 * intended trade and not a bug to route around: the conflict resolver is told to
 * write logs and run tests in here, so the tree it leaves behind is exactly the
 * kind of "exists nowhere else" work #541 is about, and a merge that is wedged is
 * recoverable while one that force-removed the resolution is not. The error names
 * the path and the two ways out (recover it, or `git worktree remove` it) so the
 * wedge is a 30-second fix rather than a mystery.
 */
async function provisionRunWorktree(
  run_host: RunHostCommand,
  repo: string,
  wt: string,
  base: string,
): Promise<void> {
  const preserved = await removeWorktreePath(run_host, repo, wt)
  if (preserved !== null) {
    throw new TridentMergeError(
      `refusing to reuse the merge worktree ${wt}: it has uncommitted changes that exist nowhere else, or could not be removed. Every retry re-derives this same path, so the merge will keep failing until a human clears it: rescue whatever is in that directory, then \`git -C ${repo} worktree remove --force ${wt}\` and re-run the merge`,
      'git worktree add',
      { ok: false, stdout: preserved, stderr: '', exit_code: -1 },
    )
  }
  must(
    'git worktree add',
    await run_host(['git', '-C', repo, 'worktree', 'add', '--detach', '--force', wt, base], repo),
  )
}

/**
 * Free `branch` from ANY lingering worktree (other than `keepPath`) that still has
 * it checked out — the inner-workflow build worktree the harness/inner-cleanup may
 * have missed. Without this, checking `branch` out in the merge worktree would fail
 * "already checked out at <path>". Parses `git worktree list --porcelain`. Best-effort.
 *
 * A lingering build worktree is EXACTLY the tree #541 is about — the inner
 * cleanup left it behind, which usually means the build died mid-edit — so a
 * DIRTY one is preserved (never `--force`d) and the merge FAILS.
 *
 * It fails HERE, naming the path, rather than three lines later at `git checkout
 * <branch>` with git's own "already checked out at <path>". That raw message is
 * what the operator would otherwise see in chat, and it reads like a trident bug
 * instead of what it is: trident kept your uncommitted work, and it is waiting
 * for you at a path you now know.
 *
 * THE SHARED CHECKOUT IS NEVER A CANDIDATE — the same rule the SHELL twin applies,
 * for the same reason. `git worktree remove` refuses a main working tree outright
 * ("is a main working tree"), and that path IS its own `--show-toplevel`, so
 * `removeWorktreePath` would score the refusal as PRESERVED and this function
 * would throw — blocking the merge over a shared checkout that holds no
 * uncommitted work at all. Today step (0a) of `mergeLocal` moves the checkout onto
 * `base` before we are called, so the branch match cannot reach it; that ordering
 * is the only thing standing between this and a merge that fails forever, which is
 * too thin a guarantee to leave the twins disagreeing about. git documents the
 * main worktree as the FIRST `worktree` record (git-worktree(1): "The main
 * worktree is listed first"), so it is skipped positionally, exactly as the shell
 * twin skips it with `n > 1`.
 */
async function freeBranchFromWorktrees(
  run_host: RunHostCommand,
  repo: string,
  branch: string,
  keepPath: string,
): Promise<void> {
  const list = await run_host(['git', '-C', repo, 'worktree', 'list', '--porcelain'], repo)
  if (!list.ok) return
  const wantRef = `refs/heads/${branch}`
  const preserved: { path: string; dirt: string }[] = []
  let curPath: string | null = null
  let seen = 0
  for (const raw of list.stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('worktree ')) {
      curPath = line.slice('worktree '.length).trim()
      seen += 1
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      // `seen > 1` skips the main working tree — see the doc comment above.
      if (ref === wantRef && curPath !== null && curPath !== keepPath && seen > 1) {
        const dirt = await removeWorktreePath(run_host, repo, curPath)
        if (dirt !== null) preserved.push({ path: curPath, dirt })
      }
    }
  }
  await run_host(['git', '-C', repo, 'worktree', 'prune'], repo)
  if (preserved.length > 0) {
    throw new TridentMergeError(
      `trident PRESERVED uncommitted work instead of merging: ${preserved
        .map((p) => p.path)
        .join(', ')} still ${preserved.length === 1 ? 'has' : 'have'} changes that exist nowhere else (branch ${branch}). Nothing was force-removed. Every retry re-checks the same paths, so this blocks until a human clears ${preserved.length === 1 ? 'it' : 'them'}: rescue the work, then \`git -C ${repo} worktree remove --force <path>\` and re-run the merge.`,
      'worktree preserved (dirty)',
      { ok: false, stdout: preserved.map((p) => `${p.path}\n${p.dirt}`).join('\n'), stderr: '', exit_code: -1 },
    )
  }
}

/**
 * Build the `MergeCleanupDeps` (mergePr / mergeLocal) over a host
 * command runner. The `cleanupAfterMerge` switch picks the right one
 * from `run.merge_mode`.
 */
export function buildMergeCleanupDeps(
  run_host: RunHostCommand,
  opts: { base_branch?: string; resolve_conflict?: MergeConflictResolver } = {},
): MergeCleanupDeps {
  return {
    async mergePr(run: TridentRun): Promise<void> {
      const repo = run.repo_path
      const branch = run.branch
      if (run.pr === null) {
        throw new TridentMergeError('pr-mode merge requires a PR number', 'precondition', {
          ok: false,
          stdout: '',
          stderr: 'run.pr is null',
          exit_code: -1,
        })
      }
      // PIN THE MERGE TO THE REVIEWED COMMIT (#545). No recorded OID → refuse:
      // merging an unpinnable head is how code no reviewer saw ships silently.
      // Checked FIRST, before the drift gate's host calls, so an unpinnable
      // merge is refused without touching the network at all.
      const reviewed_head = reviewedHeadOid(run)
      if (reviewed_head === null) {
        throw new TridentMergeError(
          'pr-mode merge requires the reviewed head OID (no `reviewedHead` in the inner result) — refusing to merge an unpinned head',
          'precondition',
          { ok: false, stdout: '', stderr: 'reviewedHead missing/not a full OID', exit_code: -1 },
        )
      }
      // BASE-DRIFT HOLD (#542). The head pin above answers "is this the commit
      // the reviewers read?"; it says nothing about the BASE that commit lands
      // on. PR mode's only other mechanism forcing a branch to contain current
      // base is GitHub's `strict_required_status_checks_policy`, which a repo
      // need not have enabled — when it is off this gate is the ONLY thing
      // standing between a stale review and `base`. Assessed against
      // `origin/<base>` — the tip GitHub will actually merge into.
      //
      // EVERY degraded path here fails CLOSED, because the step this gate
      // guards is `gh pr merge`: a SERVER-side call that lands the PR happily
      // no matter what state the local checkout is in. There is no downstream
      // step to catch what this one waves through, so "we could not check" must
      // never render as "we checked and it was fine".
      {
        const base = opts.base_branch ?? (await detectBaseBranch(run_host, repo))
        // The branch is what makes the gate answerable. `run.branch` is nullable
        // (a resumed/adopted run may carry the PR but not the branch), so
        // recover it from the PR itself rather than skipping the gate — skipping
        // it was a hole big enough to drive the whole un-reviewed merge through.
        const branchForGate = branch ?? (await prHeadBranch(run_host, repo, run.pr))
        if (branchForGate === null) {
          throw new TridentMergeError(
            'pr-mode merge could not determine the PR head branch, so base drift could not be assessed',
            'precondition',
            { ok: false, stdout: '', stderr: 'run.branch is null and `gh pr view` gave no headRefName', exit_code: -1 },
          )
        }
        // Refresh BOTH sides from origin, with EXPLICIT refspecs.
        //
        // A FAILED fetch leaves the remote-tracking refs at whatever they
        // happened to be — typically the sha this branch forked from, which
        // reports `moved:false` with total confidence. Discarding this result was
        // the difference between a gate and a decoration, so an unrefreshable tip
        // is itself a hold.
        //
        // The refspecs are spelled out rather than left to `git fetch origin
        // <base>`: that short form's contract is FETCH_HEAD, and whether it also
        // advances `refs/remotes/origin/<base>` depends on the remote's configured
        // refspec (a `--no-tags`/mirror/partial clone, or a remote with no
        // fetch refspec at all, need not update it). The gate rev-parses the
        // remote-tracking ref, so "fetch succeeded" must MEAN "that ref is
        // current" — otherwise a stale tip scores `moved:false` and the silent
        // stale-review merge path is open again. `+` forces the update, so a
        // force-pushed branch does not fail the fetch and thereby hold forever.
        const fetched = await run_host(
          [
            'git',
            '-C',
            repo,
            'fetch',
            'origin',
            `+refs/heads/${base}:refs/remotes/origin/${base}`,
            `+refs/heads/${branchForGate}:refs/remotes/origin/${branchForGate}`,
          ],
          repo,
        )
        if (!fetched.ok) {
          const unknown: BaseDriftAssessment = {
            review_base_sha: null,
            current_base_sha: null,
            branch_head_sha: null,
            moved: false,
            overlap: [],
            assessable: false,
          }
          throw new TridentBaseDriftHold(baseDriftHoldMessage(branchForGate, base, unknown, []), {
            review_base_sha: null,
            current_base_sha: null,
            silent_overlap: [],
          })
        }
        // ASSESS THE REFS GITHUB WILL MERGE — the REMOTE ones, on BOTH sides.
        // `gh pr merge` squashes `refs/heads/<branch>` AS ORIGIN HOLDS IT into
        // `refs/heads/<base>` AS ORIGIN HOLDS IT; this local checkout is not a
        // participant. Passing the bare branch name here scored the wrong tree
        // entirely, because `git rev-parse <name>` searches `refs/heads/` BEFORE
        // `refs/remotes/`: on a checkout that still had a stale local copy of the
        // branch the gate measured the stale head (while the real, drifted head
        // landed), and on one that never had it — the normal case, since the
        // merge host does not check out every PR — the ref did not resolve at
        // all, which fails closed into a hold no re-run can clear. Both refs are
        // guaranteed present by the explicit-refspec fetch above; if one still
        // will not resolve, the assessment is unassessable and PR mode holds,
        // which is the correct direction for a server-side merge with no
        // downstream step to catch it.
        const assessment = await assessBaseDrift(
          run_host,
          repo,
          `origin/${base}`,
          `origin/${branchForGate}`,
        )
        // No `conflicted` set to subtract: nothing rebases locally here, and a PR
        // with TEXTUAL conflicts is refused by GitHub itself (`gh pr merge` exits
        // non-zero → TridentMergeError). So every drift that reaches a mergeable
        // PR is precisely the silent-reconciliation case.
        if (shouldHoldForBaseDrift(assessment, new Set(), { hold_when_unassessable: true })) {
          throw new TridentBaseDriftHold(
            baseDriftHoldMessage(branchForGate, base, assessment, assessment.overlap),
            {
              review_base_sha: assessment.review_base_sha,
              current_base_sha: assessment.current_base_sha,
              silent_overlap: assessment.overlap,
            },
          )
        }
      }
      // `--match-head-commit` makes GitHub reject the merge if the PR head moved
      // since the review — a LOUD failure instead of shipping unreviewed code.
      // It pins the HEAD only: there is no base precondition in the merge API, so
      // the gate above is not atomic with this call (hole 4 in the section
      // header). Nothing may be inserted between them — every line added here
      // widens the window in which a sibling lane can move `base`.
      must(
        'gh pr merge',
        await run_host(
          ['gh', 'pr', 'merge', String(run.pr), '--squash', '--match-head-commit', reviewed_head],
          repo,
        ),
      )
      if (branch !== null) {
        // Best-effort branch teardown — the merge already landed, so a
        // failed delete is logged but not fatal to the merge itself.
        await run_host(['git', '-C', repo, 'push', 'origin', '--delete', branch], repo)
        await run_host(['git', '-C', repo, 'branch', '-D', branch], repo)
      }
      await removeWorktree(run_host, run)
    },

    async mergeLocal(run: TridentRun): Promise<void> {
      const repo = run.repo_path
      const branch = run.branch
      if (branch === null) {
        throw new TridentMergeError('local-mode merge requires a branch', 'precondition', {
          ok: false,
          stdout: '',
          stderr: 'run.branch is null',
          exit_code: -1,
        })
      }
      // Serialize per BASE repo — parallel same-project builds share this
      // `repo_path`; the final land onto `base` (the one op that touches the shared
      // checkout) must not interleave. The lock makes N same-project builds land in
      // order (#342): each waits for the prior merge, THEN rebases onto the
      // now-updated base + merges. Keyed on `repo_path` so DIFFERENT projects still
      // merge fully in parallel.
      await withLocalMergeLock(repo, async () => {
        const base = opts.base_branch ?? (await detectBaseBranch(run_host, repo))
        // (0-) BASE-DRIFT SNAPSHOT (#542) — taken FIRST, before anything mutates a
        //     ref, and INSIDE the lock so a sibling build that just landed is
        //     already part of `current_base_sha`. It MUST precede the rebase in
        //     (2): the rebase replays the branch onto the base tip, which makes
        //     the fork point equal the tip and erases the drift being measured.
        //     The hold itself is deferred to (2a) because the decision subtracts
        //     the files the rebase raised a conflict on.
        const drift = await assessBaseDrift(run_host, repo, base, branch)
        // (0) DEFENSIVE stale-state recovery (FIX 2): heal any merge/rebase a PRIOR
        //     build left in the shared checkout BEFORE we touch it — else one old
        //     poisoned index makes every later merge fail "resolve your current
        //     index first" (the verified kvwal failure).
        await recoverStaleGitState(run_host, repo)
        // (0a) Move the shared checkout OFF any feature branch back onto base. A
        //     recovered stale rebase/merge of THIS branch (legacy poison, or an
        //     `--abort` that returns HEAD to the branch it started on) can leave the
        //     shared checkout still ON `branch` — the merge worktree's `git checkout
        //     <branch>` below would then fail "already checked out at <shared repo>".
        //     Clean after the reset, so this checkout is safe (Codex [P1]).
        must('git checkout base', await run_host(['git', '-C', repo, 'checkout', base], repo))
        // (1) ISOLATION (FIX 1): provision this run's OWN detached worktree and run
        //     the whole rebase there. A rebase conflict that hard-fails can only
        //     dirty THIS throwaway worktree — never the shared checkout — so one
        //     build's failed merge can never poison another's.
        const wt = run.worktree ?? runWorktreePath(repo, run)
        // Free the branch from any lingering build worktree first (else the merge
        //     worktree's `git checkout <branch>` fails "already checked out").
        await freeBranchFromWorktrees(run_host, repo, branch, wt)
        await provisionRunWorktree(run_host, repo, wt, base)
        try {
          // (2) REBASE the build's branch onto the LATEST base IN THE WORKTREE so it
          //     replays on top of any sibling build that merged before it. On a real
          //     content conflict, dispatch the bounded Forge resolver; on a genuinely
          //     ambiguous one, escalate to chat (TridentMergeConflictEscalation).
          const conflicted = await rebaseBranchOntoBase(run_host, wt, base, branch, run, opts.resolve_conflict)
          // (2a) BASE-DRIFT HOLD (#542) — the rebase just replayed the reviewed
          //     diff on top of a base the review never saw. Files the resolver
          //     was handed with BOTH sides in context are subtracted (see
          //     `resolverCoveredPaths`, which will not subtract a file the
          //     resolver only half-saw); what remains is base-vs-branch edits to
          //     the SAME file that git merged silently, which nothing reviewed.
          //     Throw BEFORE the land in (3) — the `finally` tears the throwaway
          //     worktree down and the shared checkout is never touched.
          const covered = await resolverCoveredPaths(
            run_host,
            repo,
            conflicted,
            drift.review_base_sha,
            drift.branch_head_sha,
          )
          if (shouldHoldForBaseDrift(drift, covered)) {
            const silent = drift.overlap.filter((f) => !covered.has(f))
            // (2b) PUT THE BRANCH BACK. The rebase in (2) MOVED `refs/heads/
            //     <branch>` onto the current base tip — and that ref is shared,
            //     not worktree-local. Leaving it there destroys the evidence for
            //     this very hold: the next resume/retry of this run forks from
            //     the tip, measures no drift, and lands the un-reviewed
            //     combination with the gate reporting all-clear. Resetting in
            //     the throwaway worktree (still ON `branch`) moves the ref back;
            //     the `finally` then removes the worktree. If it will not go
            //     back, SAY SO in the held message rather than let a later run
            //     discover a silently rebased branch.
            const restored = await restoreBranchRef(run_host, wt, repo, branch, drift.branch_head_sha)
            const suffix = restored
              ? ''
              : ` (heads up: I could not put \`${branch}\` back to the exact commit that was reviewed, ` +
                `so re-review it from scratch rather than re-running the merge)`
            throw new TridentBaseDriftHold(
              `${baseDriftHoldMessage(branch, base, drift, silent)}${suffix}`,
              {
                review_base_sha: drift.review_base_sha,
                current_base_sha: drift.current_base_sha,
                silent_overlap: silent,
              },
            )
          }
          // (3) LAND onto base in the shared checkout — the branch now CONTAINS base
          //     (rebased on top), so this no-ff merge is fast-forwardable and CANNOT
          //     conflict. Heal-then-land defensively (the repo is still clean here).
          await recoverStaleGitState(run_host, repo)
          must('git checkout base', await run_host(['git', '-C', repo, 'checkout', base], repo))
          must(
            'git merge',
            await run_host(['git', '-C', repo, 'merge', '--no-ff', branch, '-m', `Merge ${branch}`], repo),
          )
        } finally {
          // (4) Tear down the per-run worktree on EVERY terminal path (success OR a
          //     thrown escalation) — never orphan a changed worktree (the fseventsd
          //     CPU-peg lesson). Frees the branch so the delete below succeeds.
          await removeWorktreePath(run_host, repo, wt)
        }
        // Branch teardown after a successful merge (best-effort).
        await run_host(['git', '-C', repo, 'branch', '-D', branch], repo)
      })
    },
  }
}

/** True when a git result's output names a merge/rebase conflict. */
function isRebaseConflict(res: HostCommandResult): boolean {
  const s = `${res.stdout}\n${res.stderr}`.toLowerCase()
  return (
    s.includes('conflict') ||
    s.includes('could not apply') ||
    s.includes('needs merge') ||
    s.includes('resolve all conflicts')
  )
}

/** The files with unresolved conflict markers (`git diff --diff-filter=U`). */
async function listConflictedFiles(run_host: RunHostCommand, repo: string): Promise<string[]> {
  const res = await run_host(['git', '-C', repo, 'diff', '--name-only', '--diff-filter=U'], repo)
  if (!res.ok) return []
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Abort an in-progress rebase and return the working tree to `base`. Best-effort. */
async function abortRebase(run_host: RunHostCommand, repo: string, base: string): Promise<void> {
  await run_host(['git', '-C', repo, 'rebase', '--abort'], repo)
  await run_host(['git', '-C', repo, 'checkout', base], repo)
}

/**
 * Rebase `branch` onto `base` in the shared working tree, resolving any content
 * conflict with the bounded Forge `resolver`. Assumes the caller holds the
 * per-repo merge lock (so the tree is exclusively ours). On success the branch
 * has been replayed on top of `base` and the working tree is left on `branch`;
 * the caller then checks out `base` + merges (a clean no-ff). RETURNS, per path,
 * WHICH BRANCH COMMITS the resolver was handed a conflict for — the base-drift
 * hold (#542) subtracts a path only when that covers every branch commit that
 * touched it, so the identities (not just membership, and not a round count) are
 * what the caller needs.
 * Throws:
 *   - `TridentMergeConflictEscalation` when the resolver escalates (ambiguous)
 *     OR no resolver is configured on a conflict — the OUTER loop turns this into
 *     a chat-delivered specific question.
 *   - `TridentMergeError` for any other (non-conflict) rebase failure.
 */
async function rebaseBranchOntoBase(
  run_host: RunHostCommand,
  repo: string,
  base: string,
  branch: string,
  run: TridentRun,
  resolver: MergeConflictResolver | undefined,
): Promise<Map<string, Set<string>>> {
  // Per path, the SET OF BRANCH COMMITS the resolver was handed a conflict for,
  // accumulated across rounds (a later round's `--diff-filter=U` no longer lists
  // an earlier round's file, and the #542 hold must account for all of them, not
  // just the last round's).
  //
  // Keyed on the commit being replayed (`REBASE_HEAD`), NOT on a round counter.
  // Rounds are loop iterations and a single commit can occupy several of them:
  // a resolver that edits the file but forgets to `git add` leaves
  // `rebase --continue` refusing, git re-reports the identical conflict, and we
  // come round again on the SAME commit. Counting rounds scored that as two
  // commits' worth of coverage, which is how one resolved commit came to vouch
  // for a second commit nobody had ever looked at.
  const conflictedAll = new Map<string, Set<string>>()
  must('git checkout branch', await run_host(['git', '-C', repo, 'checkout', branch], repo))
  let res = await run_host(['git', '-C', repo, 'rebase', base], repo)
  let rounds = 0
  while (!res.ok && isRebaseConflict(res)) {
    if (rounds >= MAX_CONFLICT_ROUNDS) {
      await abortRebase(run_host, repo, base)
      throw new TridentMergeConflictEscalation(
        `merging \`${branch}\` into \`${base}\` hit conflicts across more than ${MAX_CONFLICT_ROUNDS} commits — it needs a manual rebase before I can land it.`,
      )
    }
    rounds++
    const conflicted = await listConflictedFiles(run_host, repo)
    // The ORIGINAL branch commit git is replaying right now. A round we cannot
    // attribute to a commit is attributed to NONE — it simply does not count
    // toward coverage, so the path stays held rather than being exempted on the
    // strength of a conflict we cannot place.
    const replaying = await revParseCommit(run_host, repo, 'REBASE_HEAD')
    if (replaying !== null) {
      for (const f of conflicted) {
        const seen = conflictedAll.get(f)
        if (seen === undefined) conflictedAll.set(f, new Set([replaying]))
        else seen.add(replaying)
      }
    }
    if (resolver === undefined) {
      await abortRebase(run_host, repo, base)
      throw new TridentMergeConflictEscalation(
        `\`${branch}\` conflicts with \`${base}\` in ${conflicted.join(', ') || 'the branch'} and I have no way to auto-resolve it here — it needs a manual merge.`,
      )
    }
    const outcome = await resolver({
      repo_path: repo,
      branch,
      base_branch: base,
      run,
      conflicted_files: conflicted,
    })
    if (!outcome.resolved) {
      await abortRebase(run_host, repo, base)
      throw new TridentMergeConflictEscalation(outcome.question)
    }
    // The resolver staged its resolutions; advance the rebase (which may surface
    // the NEXT conflicting commit → loop). `core.editor=true` so the replayed
    // commit never blocks on an interactive editor in this headless path.
    res = await run_host(
      ['git', '-C', repo, '-c', 'core.editor=true', 'rebase', '--continue'],
      repo,
    )
  }
  if (!res.ok) {
    // A non-conflict rebase failure (or the resolver staged nothing so
    // `--continue` had no changes) — abort + fail loudly.
    await abortRebase(run_host, repo, base)
    throw new TridentMergeError(
      `git rebase of ${branch} onto ${base} failed: ${res.stderr || res.stdout || `exit ${res.exit_code}`}`,
      'rebase',
      res,
    )
  }
  return conflictedAll
}

/**
 * D-1/C3 — best-effort worktree cleanup after a merge has LANDED. The inner
 * workflow's `finally{}` already removes its build worktree on every inner path;
 * this is the OUTER backstop for a `run.worktree` the run row still carries.
 * Non-fatal: the merge is irreversible by this point, so any failure is
 * swallowed (a thrown removal must never undo a completed merge). Goal: `git
 * worktree list` is clean after every merge — EXCEPT for a dirty worktree, which
 * is preserved and logged (#541): an orphan worktree is cosmetic, and destroying
 * uncommitted work is not.
 */
async function removeWorktree(run_host: RunHostCommand, run: TridentRun): Promise<void> {
  if (run.worktree === null) return
  await removeWorktreePath(run_host, run.repo_path, run.worktree)
}
