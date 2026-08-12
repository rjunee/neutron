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

import { existsSync } from 'node:fs'
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

/**
 * Is this worktree holding work that exists NOWHERE ELSE? (ISSUES #541)
 *
 * `--untracked-files=all` is load-bearing: the #541 incident's lost work included
 * files git had never seen, and a status that omits them reports a tree full of
 * brand-new files as CLEAN. Ignored files (node_modules, build output) are NOT
 * counted — they are not work.
 *
 * UNVERIFIABLE COUNTS AS DIRTY. If the probe cannot run in a directory that DOES
 * exist (broken worktree admin, a throwing host) we cannot prove the tree is
 * clean, and the failure mode of guessing wrong here is unrecoverable data loss.
 * A path that does not exist at all is not "unverifiable" — there is no working
 * tree there to preserve, only a stale admin entry for `prune`.
 *
 * @returns the dirty porcelain output, or `null` when the tree is provably clean
 *          (or absent).
 */
async function worktreeDirt(run_host: RunHostCommand, wt: string): Promise<string | null> {
  if (!existsSync(wt)) return null
  try {
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
 * @returns the dirty output when the worktree was PRESERVED, `null` when it was
 *          removed (or was already absent).
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
      log.warn('worktree_preserved_dirty', { worktree: wt, dirty: dirt })
      return dirt
    }
    await run_host(['git', '-C', repo, 'worktree', 'remove', wt], repo)
    await run_host(['git', '-C', repo, 'worktree', 'prune'], repo)
    return null
  } catch {
    // Swallow — a cleanup miss is cosmetic; the merge/refs are already durable.
    return null
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
 * LOUDLY instead, naming the path — the operator recovers or deletes it, and the
 * next run gets a fresh (run-keyed) path anyway.
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
      `refusing to reuse the merge worktree ${wt}: it has uncommitted changes that exist nowhere else — recover or delete it by hand, then re-run the merge`,
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
 * DIRTY one is preserved (never `--force`d) and the merge proceeds to fail its
 * own `git checkout <branch>` loudly rather than silently eating the work.
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
  let curPath: string | null = null
  for (const raw of list.stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('worktree ')) {
      curPath = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      if (ref === wantRef && curPath !== null && curPath !== keepPath) {
        await removeWorktreePath(run_host, repo, curPath)
      }
    }
  }
  await run_host(['git', '-C', repo, 'worktree', 'prune'], repo)
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
      const reviewed_head = reviewedHeadOid(run)
      if (reviewed_head === null) {
        throw new TridentMergeError(
          'pr-mode merge requires the reviewed head OID (no `reviewedHead` in the inner result) — refusing to merge an unpinned head',
          'precondition',
          { ok: false, stdout: '', stderr: 'reviewedHead missing/not a full OID', exit_code: -1 },
        )
      }
      // `--match-head-commit` makes GitHub reject the merge if the PR head moved
      // since the review — a LOUD failure instead of shipping unreviewed code.
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
          await rebaseBranchOntoBase(run_host, wt, base, branch, run, opts.resolve_conflict)
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
 * the caller then checks out `base` + merges (a clean no-ff). Throws:
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
): Promise<void> {
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
