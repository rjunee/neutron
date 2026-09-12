/**
 * Proactive backstop for the two things a Trident run leaks when it ends anywhere
 * other than the merge path: its WORKTREE, and its BRANCH REF.
 *
 * It NEVER forces removal and NEVER kills a process, and it skips the entire sweep
 * when liveness cannot be proven because `/proc` is absent. This mirrors
 * `codex-build.sh`'s `holder_is_live` prior art: unreadable entries owned by other
 * uids are skipped per pid, because every lane in one instance shares the gateway's
 * uid.
 *
 * ── WHY THIS MODULE NOW DELETES A BRANCH REF (ISSUES #547) ───────────────────────
 *
 * It used to delete none, deliberately: a failed run's committed work lived only on
 * its `trident/*` branch, so the branch was the rescue copy. The consequence was
 * measured on the repo of record on 2026-09-12: 79 `refs/heads/trident/*` refs, 78
 * of them held by no worktree at all, every one of them a ref whose run had ended.
 * A surviving ref is not inert — the next launch of the same card re-enters it
 * (`inner-workflow.mjs`: "RE-ENTER it rather than failing"), so the card's next
 * build starts on a stale base instead of on a fresh branch cut from origin.
 *
 * `worktree-cleanup.sh` tears the ref down too, but only in `delete-branch` mode
 * and only from the inner workflow's `finally{}` — so it never runs for a run whose
 * process died, was cancelled, or was reaped by the hang watchdog, which is every
 * path in the 79.
 *
 * ── WHY A STATE-DRIVEN SWEEP RATHER THAN A HOOK ON EACH TERMINAL PATH ────────────
 *
 * The ref reap is keyed on what the STORE says (every run owning the ref is in a
 * terminal phase), not on being called at the moment of the transition. That covers
 * every terminal path by construction — including the paths that run no code at all
 * (a gateway killed mid-run, whose row is only reaped on the next boot). The tick
 * loop's terminal chain already wakes this loop (`build-core-modules.ts`), so an
 * in-band terminal transition reaps within a tick; everything else reaps within the
 * 15-minute cadence or at the next boot (`immediate: true`).
 *
 * ── THE EVIDENCE GUARD — FOURTEEN CHECKS, SAFER THAN THE 2026-09-01 INCIDENT ──────
 *
 * `docs/as-built/wrong-base-guard-prints-a-destructi.md` records a guard that
 * composed an unconditional `git branch -D` from NOTHING and pointed it at a branch
 * a LIVE locked worktree was holding. A deleted ref under a live lane destroys work;
 * an orphaned ref is a nuisance. So UNPROVABLE REFUSES, everywhere, and a ref is
 * deleted only when ALL of the following are established:
 *
 *   1. `/proc` is readable at all. It is not → the WHOLE sweep does nothing
 *      (`skipped_no_liveness`), worktrees and refs alike. This is the one global gate.
 *   2. The ref is under `refs/heads/trident/` — the namespace trident itself creates
 *      (`board-dispatch.ts`: `trident/${slug}`). A member-mode run builds on a PINNED
 *      branch outside it, and a person's branch is never in it.
 *   3. `git for-each-ref` and `git worktree list --porcelain -z` both answered for
 *      this repo. Either failing is the ABSENCE of a holder measurement, never the
 *      measurement that there is no holder — so no ref in that repo is touched.
 *   4. No worktree holds the ref BY NAME. `worktree list` alone is not enough: git
 *      reports a worktree mid-rebase or mid-bisect as DETACHED and prints no `branch`
 *      attribute, so every detached entry is asked directly (`readRebaseHead`, the
 *      prior art this reuses rather than re-derives — it reads exactly the four places
 *      git itself consults: the HEAD symref, `rebase-merge/head-name`,
 *      `rebase-apply/head-name` and `BISECT_START`). That read answering 'unknown'
 *      refuses every ref in the repo, because what it could not read may name any of
 *      them.
 *   5. No DETACHED LINKED worktree still on disk is standing on the ref's commit. Keyed on the
 *      COMMIT, not a name, which is what makes it survive the sweep boundary: the
 *      worktree pass's own `checkout --detach` leaves HEAD on the tip, so a tree that
 *      pass detached and then PRESERVED (dirty, or inside retention) still points at the
 *      ref however many sweeps later. The per-sweep `detachedThisSweep` map is only a
 *      nicer refusal reason; THIS is the gate. It does not cover a conflicted rebase —
 *      there HEAD is the `onto` commit — and does not need to, because gate 4 does. The
 *      SHARED checkout is excluded (see the loop): it is never a disposable build tree, so
 *      it is never the tree this protects, and including it only refuses on coincidence.
 *   6. No worktree THIS SWEEP detached still exists — a same-sweep fast path, kept only
 *      because it can name the detach in the refusal reason. Gate 5 is what holds that line;
 *      this map lives for ONE sweep. See the detach site in `sweepTridentWorktrees`.
 *   7. At least one run row in this repo names the branch. NO row is not evidence the
 *      ref is disposable — it is the absence of an owner, so it is kept. That single
 *      rule is what protects a hand-made branch and, measured against the 79, it is
 *      what keeps 6 of them.
 *   8. EVERY run row naming it is in a terminal phase. One non-terminal owner keeps
 *      the ref (`listBranchOwners` is unbounded for exactly this reason — see there).
 *   9. No owning run's recorded worktree still EXISTS on disk.
 *
 *      CREDIT THIS GATE WITH NOTHING TODAY. Measured read-only against the production
 *      store on 2026-09-12: 0 of 291 run rows carry a non-null `worktree` (the
 *      orchestrator writes `worktree: null`), so this gate cannot fire and the
 *      preservation of a dirty tree's ref rests on gates 4 and 4c, not on this. It is
 *      kept because it is correct and costs nothing the day that column is populated —
 *      not because it is load-bearing now. A follow-up populates it at provisioning.
 *  10. No live process is standing in an owning run's worktree path, and none is
 *      standing in a path bearing its `workflow_run_id`. The race it is aimed at is
 *      real — the row goes terminal (hang watchdog, cancel, crash latch) while the
 *      detached workflow is still running.
 *
 *      IT ALSO CANNOT FIRE TODAY, for two reasons, and neither is a licence to delete
 *      anything. The worktree half is dead for the same reason as gate 9 (no row carries
 *      a `worktree`). The generation half compares a 36-character run UUID against
 *      `wf_<8hex>-<3hex>-<n>` basenames: measured 0 of 17 matches, because they are
 *      different identifiers — which also makes `claimedByNonTerminalRun` above weaker
 *      than it reads. What actually protects a LIVE workflow is not this gate: its tree
 *      is `isLive`, so the worktree pass never detaches it, so it still holds its branch
 *      by name and gate 4 keeps the ref. A follow-up re-keys or drops this witness.
 *  11. A salvage ref was CREATED first — create-only, never a blind set. 67 of the 79
 *      measured refs carry commits origin does not have, so the delete would otherwise
 *      be the only copy's last reference. `refs/trident-reaped/<slug>/<sha>` keeps them
 *      reachable — outside `refs/heads` so it can never re-enter a launch, and outside
 *      `refs/tags` so it neither clutters `git tag` nor rides a `--follow-tags` push.
 *      Recovery is `git branch <name> <sha>`. Salvage failing REFUSES the delete.
 *  12. NOTHING CLAIMS THE REF AS OF NOW — holders and live owners RE-MEASURED, not
 *      remembered, immediately before the delete.
 *  13. THE DELETE IS ONE ATOMIC COMPARE-AND-SWAP: `git update-ref -d <ref>
 *      <expected-sha>` checks the old value and unlinks the ref under one ref lock, so a
 *      branch that has advanced since the enumeration cannot be deleted at all. There is
 *      no read-then-delete window, because there is no separate read.
 *
 *      THIS IS WHERE THE FIRST CUT OF THIS MODULE WAS WRONG, and it is worth saying so
 *      here rather than only at the call site. It used to `rev-parse` the sha and then
 *      run `git branch -D`, and call the pair a compare-and-swap. Anything could advance
 *      the branch between the two commands, `branch -D` has no old-value check at any
 *      price, and the commit that had just arrived went with it — while the salvage above
 *      preserved the OLD tip. `branch -D` was chosen for a real measurement (git 2.43: it
 *      refuses a branch a worktree holds, where `update-ref -d` does not) that answered
 *      the wrong question: holder safety is gates 4, 5 and 6, which do not depend on the
 *      delete primitive, whereas atomicity can only come FROM the primitive.
 *  14. AND NOTHING CLAIMED IT DURING THE DELETE. The same measurement again, afterwards,
 *      with a CREATE-ONLY restore at the unchanged sha if one did.
 *
 *      WHY BOTH (#547 round 3). The CAS below protects the ref's VALUE and nothing else. A
 *      dispatch can claim the slug and check the branch out at its UNCHANGED tip after the
 *      holder and owner snapshots are taken — so the sha is exactly what was expected, the
 *      CAS succeeds, and a branch a live run is standing on is deleted. `update-ref -d`
 *      does not refuse a checked-out branch, so nothing fails closed on its own.
 *
 *      9a is the ordinary case and 9b is what makes the OUTCOME correct rather than the bad
 *      ordering merely rare: git offers no primitive that compares a HOLDER and unlinks a
 *      ref in one operation (`update-ref --stdin` refuses `verify` + `delete` on one ref),
 *      so the one remaining interleaving is REPAIRED instead of raced. The repair is
 *      lossless — the sha is unchanged by construction, so the claimant's HEAD symref
 *      resolves to the same commit, and the restore is create-only so a claimant that made
 *      its own branch wins. See the call site for the residue this leaves.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, join } from 'node:path'

import { createLogger } from '@neutronai/logger'
import { SupervisedLoop } from '@neutronai/loop'

import type { HostCommandResult } from './git-mode.ts'
import { removeWorktreePath, type RunHostCommand } from './merge.ts'
import { isTerminalPhase } from './state-machine.ts'
import type { TridentBranchOwner, TridentRun } from './store.ts'
import { readRebaseHead, type RebaseHead } from './wrong-base-remedy.ts'

export const DEFAULT_WORKTREE_RETENTION_MS = 24 * 60 * 60 * 1000
export const DEFAULT_REAP_INTERVAL_MS = 15 * 60 * 1000
export const MAX_REMOVALS_PER_SWEEP = 50

/**
 * The ONLY namespace a ref delete may touch (gate 2). `board-dispatch.ts` composes
 * `trident/${slug}`; a member-mode run builds on a pinned branch outside it, and a
 * person's branch is never in it.
 */
export const TRIDENT_REF_PREFIX = 'refs/heads/trident/'

/** Where a reaped tip is kept so its commits stay reachable (gate 11). */
export const SALVAGE_REF_PREFIX = 'refs/trident-reaped/'

/**
 * Deletions attempted per sweep, bounded for the same reason as
 * `MAX_REMOVALS_PER_SWEEP`: one sweep's work stays finite on a repo that has
 * accumulated hundreds. The measured backlog (79) therefore drains over two sweeps.
 */
export const MAX_REF_DELETIONS_PER_SWEEP = 50

/**
 * Attempts at putting a raced ref back (gate 14). Small and fixed: the failure it covers is
 * a transient ref-lock contention, and the thing it must not become is an unbounded wait
 * inside a sweep. Exported so the bound is pinned by VALUE in the tests and not merely by
 * the relation "more than one" — a test that only checks retrying happens cannot see this
 * number change.
 */
export const MAX_RESTORE_ATTEMPTS = 3

/**
 * REF RETENTION IS DELIBERATELY ZERO, unlike the 24 h a worktree gets. A worktree can
 * hold work that exists nowhere else and no probe can read intent out of it, so age is
 * a stand-in for "somebody may still want this". A ref holds commits, which gate 11
 * copies elsewhere before the delete — and the whole point of #547 is that the ref
 * refuses the card's NEXT launch, which can be seconds away. A retention window here
 * would preserve exactly the failure being fixed.
 */

export interface WorktreeReaperStore {
  listRepoPaths(): string[]
  listNonTerminal(
    limit?: number,
  ): Pick<TridentRun, 'worktree' | 'branch' | 'repo_path' | 'workflow_run_id'>[]
  /**
   * Every run row in ONE repo that names a branch (#547, gates 5-8). REQUIRED rather
   * than optional: an optional seam would mean an unwired composition silently runs a
   * ref sweep with no ownership evidence, and "no owner" is the answer that keeps a
   * ref — so the sweep would be inert in exactly the boot where it matters, and the
   * inertness would be invisible. `TridentRunStore.listBranchOwners` satisfies it.
   */
  listBranchOwners(repo_path: string): TridentBranchOwner[]
}

export interface WorktreeReaperOptions {
  store: WorktreeReaperStore
  run_host: RunHostCommand
  now?: () => number
  retention_ms?: number
  proc_root?: string
  /**
   * Reads what a DETACHED worktree's in-progress rebase or bisect is standing on
   * (gate 4). Defaults to the prior art in `wrong-base-remedy.ts`; injectable so the
   * 'unknown' refusal is testable without corrupting a real rebase state directory.
   */
  rebase_head?: (worktree: string) => RebaseHead
  /**
   * MAY THE REF PASS RUN YET? (#547, found by CI against
   * `build-core-modules-trident-stranded-sweep.test.ts`.)
   *
   * The boot rescue for stranded failed PR runs (`sweepStrandedFailures`) publishes such
   * a run's commits by PUSHING ITS BRANCH — so on the very boot where both fire, this
   * sweep's startup pass would delete the ref the rescue was about to push, and the
   * rescue would then find nothing to publish. The composition therefore hands in a
   * predicate that goes true once that rescue has settled.
   *
   * A PREDICATE, not a promise to await: a tick must never block on a rescue that is
   * talking to a remote, and the WORKTREE pass has no reason to wait for it. Answering
   * false leaves every ref alone and records why, so a rescue that never settles costs a
   * nuisance rather than a deletion. Defaults to ready for a composition with no rescue
   * wired — there is then nothing whose turn this could be taking.
   */
  refs_ready?: () => boolean
}

export interface WorktreeReapReport {
  repos_swept: number
  candidates: number
  live_skipped: number
  detached: string[]
  removed: string[]
  preserved: { path: string; reason: string }[]
  protected_nonterminal: string[]
  skipped_no_liveness: boolean
  /** How many `refs/heads/trident/*` refs the sweep looked at. */
  refs_examined: number
  /** Deleted refs with the sha each pointed at — the recovery handle, in the log. */
  refs_deleted: { ref: string; sha: string; salvage: string }[]
  /** Every ref the sweep declined to delete, and the gate that declined it. */
  refs_kept: { ref: string; reason: string }[]
  /**
   * WHOLE-REPO STAND-DOWNS — a ref sweep that declined to look at a repository at all
   * (the boot-rescue latch still shut, an unreadable rebase state, an enumeration that
   * would not answer, a throw). Counted APART from `refs_kept` because these are the
   * conditions that can persist silently forever, and `logSummaryIfActed` treats them as
   * action worth logging while ordinary per-ref refusals stay quiet.
   */
  refs_stood_down: number
  /**
   * Refs DELETED and then PUT BACK because a claim appeared inside the sweep (#547,
   * round 3). Non-zero is not an error — it is this guard doing its job — but it is the
   * signal that a dispatch and a reap collided, so it is counted and logged.
   */
  refs_restored: { ref: string; sha: string }[]
  /**
   * Refs this sweep DELETED, then found a claim for, and then COULD NOT PUT BACK for any
   * reason other than the claimant already owning the name. The ref is absent and a live
   * claimant's HEAD is dangling, so this is the loudest thing this module can report: it is
   * counted apart from `refs_restored` (which claims success), it breaks the summary log's
   * silence the way a whole-repo stand-down does, and the `refs_kept` reason carries the
   * one-line `git branch` recovery. The tip itself is still reachable via the salvage ref.
   */
  refs_restore_failed: { ref: string; sha: string }[]
}

interface WorktreeEntry {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  locked: boolean
  prunable: boolean
  bare: boolean
}

interface TimerSeams {
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const log = createLogger('trident-worktree-reaper')

function emptyReport(): WorktreeReapReport {
  return {
    repos_swept: 0,
    candidates: 0,
    live_skipped: 0,
    detached: [],
    removed: [],
    preserved: [],
    protected_nonterminal: [],
    skipped_no_liveness: false,
    refs_examined: 0,
    refs_deleted: [],
    refs_kept: [],
    refs_stood_down: 0,
    refs_restored: [],
    refs_restore_failed: [],
  }
}

function snapshotProcessCwds(procRoot: string): string[] | null {
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return null
  }

  const cwds: string[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      cwds.push(readlinkSync(join(procRoot, entry, 'cwd')))
    } catch {
      // Same-uid entries are readable; other uids and exit races are per-pid skips.
    }
  }
  return cwds
}

function parseWorktrees(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const block of stdout.trim().split(/\r?\n\r?\n/)) {
    if (block.trim() === '') continue
    const entry: WorktreeEntry = {
      path: '',
      head: null,
      branch: null,
      detached: false,
      locked: false,
      prunable: false,
      bare: false,
    }
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length)
      else if (line.startsWith('branch ')) entry.branch = line.slice('branch '.length)
      else if (line === 'detached') entry.detached = true
      else if (line === 'bare') entry.bare = true
      else if (line === 'locked' || line.startsWith('locked ')) entry.locked = true
      else if (line === 'prunable' || line.startsWith('prunable ')) entry.prunable = true
    }
    if (entry.path !== '') entries.push(entry)
  }
  return entries
}

function resolvedPath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function pathIsWithin(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(`${root}/`)
}

function isLive(path: string, processCwds: string[]): boolean {
  const resolved = resolvedPath(path)
  return processCwds.some(
    (cwd) => pathIsWithin(cwd, path) || (resolved !== null && pathIsWithin(cwd, resolved)),
  )
}

function samePath(left: string, right: string): boolean {
  if (left === right) return true
  const resolvedLeft = resolvedPath(left)
  const resolvedRight = resolvedPath(right)
  return resolvedLeft !== null && resolvedRight !== null && resolvedLeft === resolvedRight
}

function claimedByNonTerminalRun(
  entry: WorktreeEntry,
  repo: string,
  runs: ReturnType<WorktreeReaperStore['listNonTerminal']>,
): boolean {
  return runs.some((run) => {
    if (run.worktree !== null && samePath(run.worktree, entry.path)) return true
    if (
      run.repo_path === repo &&
      run.branch !== null &&
      entry.branch === `refs/heads/${run.branch}`
    ) {
      return true
    }
    return (
      run.workflow_run_id !== null &&
      run.workflow_run_id !== '' &&
      basename(entry.path).includes(run.workflow_run_id)
    )
  })
}

/** git's own words for a refusal, in the order the rest of this module reads them. */
function hostText(result: { stderr: string; stdout: string; exit_code: number }): string {
  return result.stderr || result.stdout || `exit ${result.exit_code}`
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function candidateAgeMs(path: string, now: number): number | null {
  try {
    const newestMtime = Math.max(lstatSync(path).mtimeMs, statSync(join(path, '.git')).mtimeMs)
    return now - newestMtime
  } catch {
    return null
  }
}

/** Sweep every store-known repository for leaked `wf_*` worktrees. */
export async function sweepTridentWorktrees(
  opts: WorktreeReaperOptions,
): Promise<WorktreeReapReport> {
  const report = emptyReport()
  const processCwds = snapshotProcessCwds(opts.proc_root ?? '/proc')
  if (processCwds === null) {
    report.skipped_no_liveness = true
    return report
  }

  const nonTerminalRuns = opts.store.listNonTerminal(500)
  const retentionMs = opts.retention_ms ?? DEFAULT_WORKTREE_RETENTION_MS
  const now = opts.now ?? (() => Date.now())
  let removalAttempts = 0
  // Shared across repos so one sweep's total destructive work stays bounded.
  const refDeletions = { attempts: 0 }
  // Read ONCE per sweep, so every repo in one sweep answers the same question.
  const refsReady = (opts.refs_ready ?? (() => true))()

  for (const repo of new Set(opts.store.listRepoPaths())) {
    if (!existsSync(repo)) continue

    let listed
    try {
      listed = await opts.run_host(['git', '-C', repo, 'worktree', 'list', '--porcelain'], repo)
    } catch (error) {
      // COUNTED, NOT JUST SKIPPED (#547 round 5). These three `continue`s predate the ref
      // reap and are right for the WORKTREE half — there is nothing to sweep in a repo that
      // will not answer. What was wrong was the silence: they also skip the REF half, so an
      // unreadable `worktree list` made a repository indistinguishable from one with nothing
      // to reap, which is precisely the mode this module claims to have fixed. A claim in a
      // header is worth no more than the counter behind it.
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: `repo-unenumerable: ${errText(error)}`,
      })
      report.refs_stood_down += 1
      continue
    }
    if (!listed.ok) {
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: `repo-unenumerable: ${hostText(listed)}`,
      })
      report.refs_stood_down += 1
      continue
    }

    const entries = parseWorktrees(listed.stdout)
    if (entries.length === 0) {
      // An EMPTY listing is not a measurement of a repository: git always reports at least
      // the main working tree, so zero entries means the output was not what was asked for.
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: 'repo-unenumerable: `worktree list` named no worktrees at all, not even the main one',
      })
      report.refs_stood_down += 1
      continue
    }
    report.repos_swept += 1
    /** `refs/heads/trident/*` → the worktree this sweep detached it from. */
    const detachedThisSweep = new Map<string, string>()

    const candidates = entries.slice(1).filter(
      (entry) =>
        basename(entry.path).startsWith('wf_') &&
        !entry.bare &&
        !entry.locked &&
        !entry.prunable,
    )
    report.candidates += candidates.length

    for (const entry of candidates) {
      if (isLive(entry.path, processCwds)) {
        report.live_skipped += 1
        continue
      }

      if (entry.branch?.startsWith('refs/heads/trident/') === true) {
        let detached
        try {
          detached = await opts.run_host(
            ['git', '-C', entry.path, 'checkout', '--detach'],
            entry.path,
          )
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          report.preserved.push({ path: entry.path, reason: `detach failed: ${reason}` })
          log.warn('worktree_reaper_detach_failed', { repo, worktree: entry.path, reason })
          continue
        }
        if (!detached.ok) {
          const reason = detached.stderr || detached.stdout || `exit ${detached.exit_code}`
          report.preserved.push({ path: entry.path, reason: `detach failed: ${reason}` })
          log.warn('worktree_reaper_detach_failed', { repo, worktree: entry.path, reason })
          continue
        }
        report.detached.push(entry.path)
        // THE DETACH THIS SWEEP JUST PERFORMED FREED THIS REF, and that is not the same
        // thing as the ref having been free (#547). A worktree can be detached here and
        // then PRESERVED below — dirty, or inside the retention window — and its ref is
        // the history its uncommitted work sits on top of.
        //
        // THIS MAP LIVES FOR ONE SWEEP AND IS NOT WHAT HOLDS THAT LINE. It is built per
        // repo inside `sweepTridentWorktrees`, so on the NEXT sweep the tree is already
        // detached, `entry.branch` is null, this block never runs, and this map is empty
        // — which is exactly how a preserved dirty tree lost its ref one sweep later.
        // GATE 5 in `reapBranchRefs` is the durable answer: it matches the ref's COMMIT
        // against the HEAD of every listed tree still on disk, and the `--detach` above
        // leaves HEAD on the tip. All this records is the nicer refusal REASON while the
        // sweep that performed the detach is still running.
        detachedThisSweep.set(entry.branch, entry.path)
      }

      const ageMs = candidateAgeMs(entry.path, now())
      if (ageMs === null) {
        report.preserved.push({ path: entry.path, reason: 'age unverifiable' })
        continue
      }
      if (ageMs <= retentionMs) {
        report.preserved.push({ path: entry.path, reason: 'within retention' })
        continue
      }

      if (claimedByNonTerminalRun(entry, repo, nonTerminalRuns)) {
        report.protected_nonterminal.push(entry.path)
        continue
      }

      if (removalAttempts >= MAX_REMOVALS_PER_SWEEP) {
        report.preserved.push({ path: entry.path, reason: 'removal limit reached' })
        continue
      }
      removalAttempts += 1
      const reason = await removeWorktreePath(opts.run_host, repo, entry.path)
      if (reason === null) report.removed.push(entry.path)
      else report.preserved.push({ path: entry.path, reason })
    }

    try {
      await opts.run_host(['git', '-C', repo, 'worktree', 'prune'], repo)
    } catch {
      // A failed administrative prune must not abort cleanup in another repo.
    }

    // THE BRANCH-REF REAP (#547), last in the repo so it reads the world the worktree
    // pass and the prune just left: a tree that was removed is no longer a holder, and a
    // tree that was PRESERVED still is — by its HEAD (gate 5), which is what makes that
    // true on every later sweep too and not just on the one that detached it. One
    // try/catch for the same reason the prune has one: a ref sweep that throws in one
    // repo must not abandon the next.
    if (!refsReady) {
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: 'awaiting-boot-rescue: the stranded-failure sweep has not settled yet',
      })
      report.refs_stood_down += 1
      continue
    }
    try {
      await reapBranchRefs(opts, repo, processCwds, report, refDeletions, detachedThisSweep)
    } catch (error) {
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: `sweep-failed: ${errText(error)}`,
      })
      report.refs_stood_down += 1
    }
  }

  return report
}

// ── THE BRANCH-REF REAP (#547) ────────────────────────────────────────────────

interface ZHolder {
  path: string
  /** The branch the entry has checked out BY NAME, absent for a detached tree. */
  branch: string | null
  /** The commit the entry's HEAD is at — present even when `branch` is not (gate 5). */
  head: string | null
  bare: boolean
}

/**
 * Parse `git worktree list --porcelain -z`. The NUL form, not the newline form
 * `parseWorktrees` above reads, and the difference is load-bearing HERE in a way it is
 * not there: a worktree path may legally contain a newline, such a path splits its own
 * record, and the branch it holds then reads as UNHELD — which in this half of the
 * module is the answer that reaches a delete. `wrong-base-remedy.ts` reaches for the
 * same form for the same reason. Each attribute is NUL-terminated; an EMPTY attribute
 * (a second NUL) ends the record.
 */
function parseHoldersZ(stdout: string): ZHolder[] {
  const holders: ZHolder[] = []
  let holder: ZHolder | null = null
  const close = (): void => {
    if (holder !== null && holder.path !== '') holders.push(holder)
    holder = null
  }
  for (const field of stdout.split('\0')) {
    if (field === '') {
      close()
      continue
    }
    holder ??= { path: '', branch: null, head: null, bare: false }
    if (field.startsWith('worktree ')) holder.path = field.slice('worktree '.length)
    else if (field.startsWith('branch ')) holder.branch = field.slice('branch '.length)
    else if (field.startsWith('HEAD ')) holder.head = field.slice('HEAD '.length)
    else if (field === 'bare') holder.bare = true
    // `detached` is deliberately NOT read. An entry with no `branch` attribute is asked
    // about its rebase/bisect state whatever else it says, because the SUPERSET is the
    // safe side: a git that stopped printing `detached` for a rebasing worktree would
    // otherwise make that tree's ref read as unheld.
  }
  close()
  return holders
}

/**
 * `<full ref>\0<sha>` per line. A ref name cannot contain an ASCII control character —
 * `git check-ref-format` rejects one — so newline-delimited RECORDS are safe here in a
 * way they are not for worktree paths; the NUL only separates the two fields, so a
 * `%(refname)` is never confused with a sha.
 */
function parseRefLines(stdout: string): { ref: string; sha: string }[] {
  const refs: { ref: string; sha: string }[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') continue
    const nul = line.indexOf('\0')
    if (nul <= 0) continue
    const ref = line.slice(0, nul)
    const sha = line.slice(nul + 1).trim()
    if (ref === '' || sha === '') continue
    refs.push({ ref, sha })
  }
  return refs
}

/**
 * Is a process standing anywhere that belongs to this run (gate 10)? Two independent
 * witnesses, because a terminal row proves only what the STORE believes: a cwd inside
 * the worktree the run recorded, and a cwd under a path bearing the run's launcher
 * generation key — the same `workflow_run_id` basename match `claimedByNonTerminalRun`
 * uses, which is what catches a build whose worktree the row never recorded.
 */
function ownerProcessLive(owner: TridentBranchOwner, processCwds: string[]): boolean {
  if (owner.worktree !== null && owner.worktree !== '' && isLive(owner.worktree, processCwds)) {
    return true
  }
  const generation = owner.workflow_run_id
  if (generation === null || generation === '') return false
  return processCwds.some((cwd) => cwd.includes(generation))
}

/**
 * DID `update-ref <ref> <new> ''` REFUSE BECAUSE THE REF ALREADY EXISTS? That is the one
 * failure of a create-only write which proves something useful: the ref is THERE, so a
 * claimant has made its own and nothing is dangling.
 *
 * Matched on git's own words AND its fatal exit code, both required. Measured on git 2.43:
 * `fatal: update_ref failed for ref '<ref>': cannot lock ref '<ref>': reference already
 * exists`, exit 128. A tighter match than necessary is the safe direction here — a benign
 * case misread as unknown is merely reported loudly, while an unknown failure misread as
 * benign leaves a live claimant's HEAD dangling and says nothing.
 */
function refAlreadyExists(result: { stdout: string; stderr: string; exit_code: number }): boolean {
  return result.exit_code === 128 && /reference already exists/i.test(`${result.stderr}${result.stdout}`)
}

/**
 * IS ANYTHING CLAIMING THIS REF RIGHT NOW? Re-measured from scratch — a fresh worktree
 * listing and a fresh store read — rather than from the snapshots the per-ref gates use.
 *
 * WHY THIS EXISTS (#547 round 3, cross-model gate). The delete is an atomic
 * compare-and-swap on the ref's VALUE, and that is all it is. A new run can claim the
 * slug and `git worktree add` the branch at its UNCHANGED tip after the holder and owner
 * snapshots are taken — so the sha is exactly what was expected, the CAS succeeds, and a
 * branch a live run is standing on is deleted. `update-ref -d` will not refuse a
 * checked-out branch (this suite measures that deliberately), which is what makes the race
 * bite rather than fail closed.
 *
 * Returns a reason when something claims it, null when nothing provably does. A read that
 * FAILS returns a reason too: an unanswered question is not an absence of claimants.
 */
async function refClaimedNow(
  opts: WorktreeReaperOptions,
  repo: string,
  ref: string,
  short: string,
  sha: string,
): Promise<string | null> {
  let listed
  try {
    listed = await opts.run_host(['git', '-C', repo, 'worktree', 'list', '--porcelain', '-z'], repo)
  } catch (error) {
    return `holders-unreadable: ${errText(error)}`
  }
  if (!listed.ok) return `holders-unreadable: ${hostText(listed)}`
  const readRebase = opts.rebase_head ?? readRebaseHead
  const entries = parseHoldersZ(listed.stdout)
  for (const [index, holder] of entries.entries()) {
    if (holder.branch === ref) return `checked out at ${holder.path}`
    // The commit-keyed witness, linked trees only, for the same reasons as gate 5.
    if (index > 0 && !holder.bare && holder.head === sha && existsSync(holder.path)) {
      return `a detached worktree stands on the tip at ${holder.path}`
    }
    if (holder.branch === null) {
      const rebasing = readRebase(holder.path)
      if (rebasing.kind === 'unknown') return `rebase/bisect state unreadable in ${holder.path}`
      if (rebasing.kind === 'branch' && rebasing.ref === ref) {
        return `a ${rebasing.state ?? 'rebase'} holds it at ${holder.path}`
      }
    }
  }
  // And the DB side, re-read: a dispatch's claim is an INSERT of a NON-TERMINAL row.
  let owners
  try {
    owners = opts.store.listBranchOwners(repo)
  } catch (error) {
    return `owners-unreadable: ${errText(error)}`
  }
  const live = owners.find((owner) => owner.branch === short && !isTerminalPhase(owner.phase))
  if (live !== undefined) return `a run in phase '${live.phase}' claims it`
  return null
}

/**
 * Sweep ONE repository's `refs/heads/trident/*` refs. Every gate refuses by RECORDING
 * why and moving on; nothing here throws, and nothing here is reached at all when
 * `/proc` could not be read (gate 1, enforced by the caller).
 */
async function reapBranchRefs(
  opts: WorktreeReaperOptions,
  repo: string,
  processCwds: string[],
  report: WorktreeReapReport,
  deletionBudget: { attempts: number },
  detachedThisSweep: Map<string, string>,
): Promise<void> {
  let listed
  try {
    listed = await opts.run_host(
      ['git', '-C', repo, 'for-each-ref', `--format=%(refname)%00%(objectname)`, TRIDENT_REF_PREFIX],
      repo,
    )
  } catch (error) {
    report.refs_kept.push({ ref: `${TRIDENT_REF_PREFIX}* in ${repo}`, reason: `refs-unenumerable: ${errText(error)}` })
    report.refs_stood_down += 1
    return
  }
  if (!listed.ok) {
    report.refs_kept.push({
      ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
      reason: `refs-unenumerable: ${hostText(listed)}`,
    })
    report.refs_stood_down += 1
    return
  }
  const refs = parseRefLines(listed.stdout)
  if (refs.length === 0) return

  // GATE 3 — a FRESH holder listing, read AFTER the worktree pass above, so a tree that
  // pass removed no longer counts as a holder and a tree it PRESERVED still does.
  let holderList
  try {
    holderList = await opts.run_host(['git', '-C', repo, 'worktree', 'list', '--porcelain', '-z'], repo)
  } catch (error) {
    report.refs_kept.push({
      ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
      reason: `holders-unenumerable: ${errText(error)}`,
    })
    report.refs_stood_down += 1
    return
  }
  if (!holderList.ok) {
    report.refs_kept.push({
      ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
      reason: `holders-unenumerable: ${hostText(holderList)}`,
    })
    report.refs_stood_down += 1
    return
  }

  // GATE 4 — who holds what BY NAME. A detached entry is asked directly, because git
  // prints no `branch` attribute for a worktree mid-rebase or mid-bisect even though it
  // holds one, and `readRebaseHead` reads exactly the four places git itself looks:
  // the HEAD symref, `rebase-merge/head-name`, `rebase-apply/head-name`, `BISECT_START`.
  const readRebase = opts.rebase_head ?? readRebaseHead
  const holders = parseHoldersZ(holderList.stdout)
  const held = new Map<string, string>()
  // GATE 5 — DURABLE HOLDER-BY-HEAD. Keyed on the COMMIT, and it is what makes the
  // preservation of a detached tree outlive the sweep that detached it.
  const heads = new Map<string, string>()
  for (const [index, holder] of holders.entries()) {
    // LINKED TREES ONLY. `index === 0` is the shared checkout (git-worktree(1): "The main
    // worktree is listed first"), and it is excluded for the same reason the worktree pass
    // above excludes it: it is never a disposable build tree, so it can never be the tree
    // this gate exists to protect — the pass only ever detaches LINKED `wf_*` trees.
    //
    // Including it would add nothing but coincidence refusals on the one tree that is
    // never disposable: `merge.ts` legitimately leaves the shared checkout parked on a
    // feature branch, and a freshly-cut `trident/*` ref whose build committed nothing has
    // main's tip, which is exactly where the shared checkout usually stands. Measured
    // while writing this: with the shared checkout included, two existing cases refused a
    // ref whose worktree had genuinely been removed. The by-NAME case is not lost — gate 4
    // does not skip index 0, so a shared checkout holding a `trident/*` branch still keeps
    // its ref.
    //
    // A bare entry has no working tree and no HEAD of its own to stand on.
    //
    // `existsSync` HERE IS DEFENCE WITHOUT AN OBSERVABLE CONSEQUENCE, and it is kept
    // rather than removed. No test can distinguish it, because a listed entry whose
    // directory is gone is refused either way: if it still holds its branch BY NAME gate 4
    // takes it, and if it is detached then `readRebaseHead` cannot read a rebase state out
    // of a missing directory, answers 'unknown', and stands the whole repo down (pinned by
    // "a listed worktree whose DIRECTORY is gone stands the whole repo down"). Mutating it
    // away therefore changes no outcome. It stays because it costs one syscall and it keeps
    // this gate's claim — "a tree still on disk" — true on its own terms rather than by
    // relying on another gate to cover for it.
    if (
      index > 0 &&
      !holder.bare &&
      holder.head !== null &&
      holder.head !== '' &&
      existsSync(holder.path)
    ) {
      if (!heads.has(holder.head)) heads.set(holder.head, holder.path)
    }
    if (holder.branch !== null) {
      held.set(holder.branch, holder.path)
      continue
    }
    const rebasing = readRebase(holder.path)
    if (rebasing.kind === 'unknown') {
      // What could not be read may name ANY of these refs, so none of them is touched.
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: `holder-unprovable: cannot read rebase/bisect state in ${holder.path}`,
      })
      report.refs_stood_down += 1
      return
    }
    if (rebasing.kind === 'branch') held.set(rebasing.ref, holder.path)
  }
  // THE SAME-SWEEP FAST PATH, no longer load-bearing. It records the ref a detach in
  // THIS sweep freed, so the refusal reason can name the detach rather than the HEAD.
  // Gate 4c is what actually holds the line: this map lives for one sweep, and the tree
  // it remembers is still on disk on the next one.
  for (const [ref, path] of detachedThisSweep) {
    if (!held.has(ref) && existsSync(path)) held.set(ref, path)
  }

  // GATES 5-6 — ownership, keyed by the branch SHORT name the store records.
  const owners = new Map<string, TridentBranchOwner[]>()
  for (const owner of opts.store.listBranchOwners(repo)) {
    const list = owners.get(owner.branch)
    if (list === undefined) owners.set(owner.branch, [owner])
    else list.push(owner)
  }

  for (const { ref, sha } of refs) {
    report.refs_examined += 1
    // GATE 2 — belt and braces on the namespace `for-each-ref` was already scoped to.
    if (!ref.startsWith(TRIDENT_REF_PREFIX)) {
      report.refs_kept.push({ ref, reason: 'out-of-namespace' })
      continue
    }
    const short = ref.slice('refs/heads/'.length)

    const holder = held.get(ref)
    if (holder !== undefined) {
      const freedHere = detachedThisSweep.get(ref) === holder
      report.refs_kept.push({
        ref,
        reason: `${freedHere ? 'held-by-preserved-worktree' : 'held-by-worktree'}: ${holder}`,
      })
      continue
    }

    // GATE 5 — A DETACHED WORKTREE STANDING ON THIS EXACT COMMIT HOLDS IT, and this is
    // the gate that survives the sweep boundary.
    //
    // THE DEFECT THIS FIXES (adversarial review of PR #606, escalated and confirmed).
    // `detachedThisSweep` is built inside the per-repo loop, so it is memory for ONE
    // sweep. On the next sweep the tree is already detached, `entry.branch` is null, the
    // detach block never runs, nothing is recorded — and a dirty tree the previous sweep
    // deliberately preserved had its ref deleted anyway. Measured on the repo of record:
    // 16 `wf_*` trees were already detached by earlier sweeps of shipped main and ALL 16
    // were dirty (3-67 changed paths), one of them standing exactly on the tip of a
    // `trident/*` ref whose every other gate passes.
    //
    // Keyed on the COMMIT rather than on a name, which is precisely what makes it
    // durable: `git checkout --detach` in the worktree pass above leaves HEAD at the tip
    // it was on, so the tree still points at the ref's commit however many sweeps later.
    // It deliberately does NOT cover a conflicted rebase — there HEAD is the `onto`
    // commit, not the tip — and it does not need to, because gate 4 reads that state
    // directly from the rebase's own `head-name`.
    //
    // A tip that COINCIDES with some unrelated tree's HEAD is kept too. That is a
    // nuisance, not a bug, and it is small: measured against the 80 refs on the repo of
    // record it refuses exactly one. Refusing on a coincidence costs a sweep; deleting a
    // ref a preserved dirty tree is standing on costs the work in that tree.
    const standingOn = heads.get(sha)
    if (standingOn !== undefined) {
      report.refs_kept.push({ ref, reason: `held-by-detached-worktree: ${standingOn}` })
      continue
    }

    const claimants = owners.get(short)
    if (claimants === undefined || claimants.length === 0) {
      report.refs_kept.push({ ref, reason: 'owner-unknown: no run row names this branch' })
      continue
    }
    const live = claimants.find((owner) => !isTerminalPhase(owner.phase))
    if (live !== undefined) {
      report.refs_kept.push({ ref, reason: `owner-not-terminal: a run is in phase '${live.phase}'` })
      continue
    }
    const standing = claimants.find(
      (owner) => owner.worktree !== null && owner.worktree !== '' && existsSync(owner.worktree),
    )
    if (standing !== undefined) {
      report.refs_kept.push({ ref, reason: `run-worktree-present: ${standing.worktree ?? ''}` })
      continue
    }
    const busy = claimants.find((owner) => ownerProcessLive(owner, processCwds))
    if (busy !== undefined) {
      report.refs_kept.push({
        ref,
        reason: `run-process-live: a process stands in ${busy.worktree ?? busy.workflow_run_id ?? '?'}`,
      })
      continue
    }

    if (deletionBudget.attempts >= MAX_REF_DELETIONS_PER_SWEEP) {
      report.refs_kept.push({ ref, reason: 'deletion limit reached' })
      continue
    }

    // GATE 11 — SALVAGE FIRST, CREATE-ONLY. `refs/trident-reaped/<slug>/<sha>` embeds the
    // sha it carries, so the name is a function of its own value: two sweeps reaping the
    // same slug write the SAME ref when the tip matches and DIFFERENT refs when it does
    // not, and neither can overwrite the other's. The write is still made create-only
    // (`update-ref <ref> <new> ''`, whose empty old-value means "must not exist"; measured
    // on git 2.43: exit 128 "reference already exists") rather than an unconditional set,
    // so the one case the naming cannot rule out — an existing salvage at some OTHER sha —
    // is refused instead of clobbered.
    //
    // A refusal falls through to a read, and that read cannot be harmfully stale: it is
    // reached only because the ref already exists, and all it has to establish is that
    // what already exists is this tip. The CREATE path needs no read at all.
    const salvage = `${SALVAGE_REF_PREFIX}${short.slice('trident/'.length)}/${sha}`
    let saved
    try {
      saved = await opts.run_host(['git', '-C', repo, 'update-ref', salvage, sha, ''], repo)
    } catch (error) {
      report.refs_kept.push({ ref, reason: `salvage-failed: ${errText(error)}` })
      continue
    }
    if (!saved.ok) {
      let confirmed
      try {
        confirmed = await opts.run_host(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', salvage], repo)
      } catch (error) {
        report.refs_kept.push({ ref, reason: `salvage-unverified: ${errText(error)}` })
        continue
      }
      if (!confirmed.ok || confirmed.stdout.trim() !== sha) {
        report.refs_kept.push({
          ref,
          reason: `salvage-unverified: ${salvage} does not carry the tip (${hostText(saved)})`,
        })
        continue
      }
    }

    // GATE 13 — THE DELETE IS ONE ATOMIC COMPARE-AND-SWAP, and that is the whole reason
    // `update-ref -d` is the primitive here rather than `git branch -D`.
    //
    // THE BUG THIS REPLACES (cross-model review of PR #606). This used to be a
    // `rev-parse` re-read followed by a SEPARATE `git branch -D`, described as a
    // compare-and-swap. It was not one: anything could advance the branch in the window
    // between the two commands, and `branch -D` — which has no old-value check at any
    // price — would then delete the commit that had just arrived. 67 of the 79 refs
    // measured on 2026-09-12 carried commits that exist nowhere else, so that window
    // destroyed work, and the salvage written above would have preserved the OLD tip
    // while the new one went with the branch.
    //
    // WHY GIVING UP `branch -D`'s HOLDER REFUSAL COSTS NOTHING. The measurement that put
    // it here was real (git 2.43: `branch -D` exits 1 with "cannot delete branch 'feat'
    // used by worktree at ...", `update-ref -d` deletes without a word) but it answered
    // the wrong question. Holder safety and atomicity are separate axes: holder safety is
    // already established by the worktree listing, the rebase/bisect read and this
    // sweep's own detach memory above, three gates that do not depend on the delete
    // primitive — while atomicity is a thing `branch -D` cannot supply from any of them.
    // `update-ref -d <ref> <expected-sha>` checks the old value and unlinks the ref under
    // ONE ref lock (measured on git 2.43: a stale expected sha exits 1 with "cannot lock
    // ref ... is at X but expected Y" and the ref survives), so there is no window left
    // to lose a commit in.
    //
    // EACH REF IS INDEPENDENTLY SAFE, which is what makes the per-sweep deletion cap and
    // a mid-sweep death harmless. One ref's work is exactly: create its salvage, then CAS
    // away its branch. A process that dies between the two leaves a salvage and an intact
    // branch — the next sweep confirms that salvage and finishes. A process that dies
    // after leaves the intended end state. Nothing spans two refs, so there is no
    // partially-applied state for a crash to leave behind.
    // GATE 12 — NOTHING CLAIMS IT AS OF NOW, re-measured rather than remembered. This
    // is the ordinary case: a dispatch that already committed its claim is seen here and
    // the destructive act is never performed at all.
    const claimedBefore = await refClaimedNow(opts, repo, ref, short, sha)
    if (claimedBefore !== null) {
      report.refs_kept.push({ ref, reason: `claim-appeared: ${claimedBefore}` })
      continue
    }

    deletionBudget.attempts += 1
    let deleted
    try {
      // `--no-deref` IS LOAD-BEARING AND ITS BLAST RADIUS IS THE DEFAULT BRANCH. Without
      // it, `update-ref -d` follows a SYMREF and deletes what it points AT, leaving the
      // symref itself standing. Measured on git 2.43: with `refs/heads/trident/evil` a
      // symref to `refs/heads/main`, every gate here passes on the symref's own name — 9b
      // included, since `holder.branch === ref` never matches — and the delete removed
      // `refs/heads/main`. Nothing in trident creates a symref under `refs/heads/` and
      // there are none on the repo of record, which is exactly why this is one flag rather
      // than a guard: "unreachable in this tree" has been the wrong answer twice in this
      // change already. The CAS is unaffected — the old-value compare still resolves
      // through the symref, so a stale sha still refuses.
      deleted = await opts.run_host(
        ['git', '-C', repo, 'update-ref', '--no-deref', '-d', ref, sha],
        repo,
      )
    } catch (error) {
      report.refs_kept.push({ ref, reason: `delete-refused: ${errText(error)}` })
      continue
    }
    // A TIMEOUT IS NOT A REFUSAL, and collapsing the two skipped the repair. `spawnCapture`
    // kills the child on its watchdog and reports `ok:false` with `timed_out:true` — and a
    // kill that lands AFTER the ref lock committed leaves the ref gone while the result says
    // it failed. Read as a refusal, that `continue`d past gate 14: no restore was attempted
    // even with a claimant standing on the branch, and the report said the ref was kept.
    // Indeterminate means fall through to 9b and let it measure what actually happened.
    const deleteTimedOut = deleted.timed_out === true
    if (!deleted.ok && !deleteTimedOut) {
      // The overwhelmingly likely cause is the CAS losing — the ref moved, so something
      // is alive on it. Reported with git's own words rather than as a diagnosis.
      report.refs_kept.push({ ref, reason: `delete-refused: ${hostText(deleted)}` })
      continue
    }
    // GATE 14 — AND NOTHING CLAIMED IT DURING THE DELETE. This is what makes the
    // OUTCOME correct for every interleaving instead of merely making the bad one rare.
    //
    // Gate 12 and the CAS together still leave one ordering: a dispatch claims the slug
    // and checks the branch out AFTER 11a read and BEFORE `update-ref -d` ran, at the
    // unchanged tip. Nothing git offers can close that from inside one command — there is
    // no primitive that compares a HOLDER and unlinks a ref atomically, and
    // `update-ref --stdin` refuses `verify` + `delete` on one ref — so this repairs it
    // instead of racing it: the same measurement is taken again, and a claim that appeared
    // puts the ref back at exactly the sha it had.
    //
    // THE REPAIR IS LOSSLESS, which is why it is a real answer and not a hedge. The sha is
    // unchanged by construction (the CAS proved it, and the salvage ref above holds it), so
    // the claimant's worktree HEAD symref resolves to the same commit it did before; no
    // commit, working tree or index is touched. The restore is CREATE-ONLY, so if the
    // claimant has meanwhile made its own branch at a different sha, that branch wins and
    // this reports rather than clobbers.
    //
    // The residue is a sub-second window in which the ref does not resolve, which can fail
    // a concurrent `git switch` in the claiming run's first step. That is a retryable error
    // in a run that has just started, against silently deleting a live lane's branch.
    const claimedDuring = await refClaimedNow(opts, repo, ref, short, sha)
    if (claimedDuring !== null) {
      // BOUNDED RETRY, CREATE-ONLY ON EVERY ATTEMPT (#547 round 5). The residue on the
      // FAILED branch is not the sub-second, retryable thing the comment above describes:
      // a claimant whose HEAD symref points at a deleted branch reports "No commits yet",
      // and its next commit is PARENTLESS — its PR becomes a whole-tree diff against
      // unrelated history, which is the silently-wrong-base class this card exists to
      // eliminate. Nothing automated repairs it either, because a ref that does not exist
      // does not enumerate on the next sweep. So a transient lock or a contended ref gets
      // more than one chance here.
      //
      // `''` — create-only — is repeated on every attempt and is not an optimisation to be
      // dropped later: a retry that degraded to a force-create would clobber a claimant
      // that had made its own branch between attempts, which is worse than not retrying.
      // The bound is a fixed count, not a deadline, because this sits inside a sweep that
      // must stay finite.
      //
      // LC_ALL=C is pinned for the ONE decision in this module that reads a git MESSAGE:
      // `refAlreadyExists` matches "reference already exists", and `spawnCapture` merges
      // `process.env`, so a localised environment would translate the string this branch
      // turns on. It fails safe (an unmatched message is treated as unknown and reported
      // loudly) and there are no translations on this host — pinned anyway, because a
      // guard that depends on the operator's locale is a guard with a hidden input.
      let restored: HostCommandResult = { ok: false, stdout: '', stderr: 'not attempted', exit_code: 1 }
      for (let attempt = 1; attempt <= MAX_RESTORE_ATTEMPTS; attempt++) {
        try {
          restored = await opts.run_host(
            ['git', '-C', repo, 'update-ref', ref, sha, ''],
            repo,
            { LC_ALL: 'C' },
          )
        } catch (error) {
          restored = { ok: false, stdout: '', stderr: errText(error), exit_code: 1 }
        }
        // Success, or a refusal that already tells us the ref is there: either way, done.
        if (restored.ok || refAlreadyExists(restored)) break
      }
      if (restored.ok) {
        report.refs_restored.push({ ref, sha })
        report.refs_kept.push({
          ref,
          reason: `raced-a-new-claim: ${claimedDuring} — the ref was put back at ${sha}`,
        })
        log.warn('worktree_reaper_ref_restored', { repo, ref, sha, salvage, claim: claimedDuring })
      } else if (refAlreadyExists(restored)) {
        // THE BENIGN FAILURE, AND THE ONLY ONE. Create-only refused because the ref is
        // already there, so the claimant made its own branch — which is the outcome we
        // want and the reason the write is create-only. Not counted as a restore: we
        // did not put anything back.
        report.refs_kept.push({
          ref,
          reason: `raced-a-new-claim: ${claimedDuring} — the claimant holds its own ref, ours was not forced back over it`,
        })
        log.warn('worktree_reaper_ref_claimant_owns', { repo, ref, sha, salvage, claim: claimedDuring })
      } else {
        // EVERY OTHER FAILURE MEANS THE REF IS ABSENT, and this is the one outcome gate 14
        // exists to prevent — the claimant's symbolic HEAD is dangling right now.
        //
        // THIS BRANCH IS HERE BECAUSE THE FIRST CUT DID NOT HAVE IT (#547 round 4). It read
        // ANY failure as "the claimant recreated the branch, so ours losing is correct", and
        // counted `refs_restored` unconditionally — so a lock failure, a permission error or
        // a transient host fault left the ref gone while the summary said it had been put
        // back. That is the same mistake this file corrects everywhere else: a command that
        // failed establishes that it did not succeed and NOTHING ELSE. Create-only is what
        // makes the benign case precisely checkable, so it is matched on rather than assumed.
        report.refs_restore_failed.push({ ref, sha })
        report.refs_kept.push({
          ref,
          reason:
            `RESTORE FAILED: ${claimedDuring} — the ref is ABSENT and could not be put back ` +
            `(${hostText(restored)}); recover with: git branch ${short} ${sha}`,
        })
        log.error('worktree_reaper_ref_restore_failed', {
          repo,
          ref,
          sha,
          salvage,
          claim: claimedDuring,
          error: hostText(restored),
        })
      }
      continue
    }

    // AN INDETERMINATE DELETE IS MEASURED, NEVER INFERRED (#547 round 6). Making a timeout
    // indeterminate rather than a refusal was right, but the indeterminate path then fell
    // through to here and recorded a DELETION on the strength of gate 14 finding no
    // claimant — which is a different question entirely. "Nobody is standing on this ref"
    // does not say whether the ref still exists. `deleted.ok` was false, and the report
    // said the ref was reaped.
    //
    // So when the delete did not report success, ask git what the ref is now. Absent means
    // the kill landed after the lock committed and the reap is real; present means the kill
    // landed BEFORE it and nothing was deleted, which is a kept ref and is reported as one.
    // A rev-parse that will not answer either leaves the outcome unknown, and an unknown
    // outcome is not a deletion.
    if (!deleted.ok) {
      let after
      try {
        after = await opts.run_host(
          ['git', '-C', repo, 'rev-parse', '--verify', '--quiet', ref],
          repo,
        )
      } catch (error) {
        report.refs_kept.push({
          ref,
          reason: `delete-indeterminate: the delete timed out and the ref could not be re-read (${errText(error)})`,
        })
        report.refs_stood_down += 1
        continue
      }
      const stillThere = after.ok && after.stdout.trim() !== ''
      if (stillThere) {
        report.refs_kept.push({
          ref,
          reason: `delete-timed-out: the ref is STILL PRESENT at ${after.stdout.trim()}, so nothing was deleted`,
        })
        continue
      }
      if (!after.ok && after.stdout.trim() === '' && after.exit_code === 0) {
        // `--verify --quiet` exits 1 for an absent ref, so ok:false with exit 0 is a shape
        // git does not produce; treat an unreadable answer as unknown rather than absent.
        report.refs_kept.push({
          ref,
          reason: 'delete-indeterminate: the delete timed out and the ref did not read as present or absent',
        })
        report.refs_stood_down += 1
        continue
      }
      log.warn('worktree_reaper_ref_deleted_after_timeout', { repo, ref, sha, salvage })
    }

    report.refs_deleted.push({ ref, sha, salvage })
    log.info('worktree_reaper_ref_deleted', { repo, ref, sha, salvage })
  }
}

function logSummaryIfActed(report: WorktreeReapReport): void {
  // A SWEEP THAT STOOD DOWN IS NOT A QUIET SWEEP. Without `refs_stood_down` in this
  // condition, a ref-reap latch that never lifts — or ONE unreadable rebase state file —
  // silences the whole ref half of this loop forever and logs nothing at all,
  // indistinguishable from a repository with nothing to reap. Ordinary per-ref refusals
  // are deliberately NOT here: `owner-unknown` on a hand-made branch is the steady state
  // and would log every fifteen minutes for the life of the process.
  if (
    !report.skipped_no_liveness &&
    report.detached.length === 0 &&
    report.removed.length === 0 &&
    report.refs_deleted.length === 0 &&
    report.refs_stood_down === 0 &&
    report.refs_restored.length === 0 &&
    report.refs_restore_failed.length === 0
  ) {
    return
  }
  log.info('worktree_reaper_sweep', {
    repos_swept: report.repos_swept,
    candidates: report.candidates,
    live_skipped: report.live_skipped,
    detached: report.detached.length,
    removed: report.removed.length,
    preserved: report.preserved.length,
    protected_nonterminal: report.protected_nonterminal.length,
    skipped_no_liveness: report.skipped_no_liveness,
    refs_examined: report.refs_examined,
    refs_deleted: report.refs_deleted.length,
    refs_kept: report.refs_kept.length,
    refs_stood_down: report.refs_stood_down,
    refs_restored: report.refs_restored.length,
    refs_restore_failed: report.refs_restore_failed.length,
  })
}

/** Build the supervised timer; `immediate` provides the required startup sweep. */
export function buildWorktreeReaperLoop(
  opts: WorktreeReaperOptions & { interval_ms?: number },
): SupervisedLoop {
  const timerSeams = opts as WorktreeReaperOptions & TimerSeams
  return new SupervisedLoop({
    name: 'trident-worktree-reaper',
    intervalMs: opts.interval_ms ?? DEFAULT_REAP_INTERVAL_MS,
    immediate: true,
    tick: () => sweepTridentWorktrees(opts).then(logSummaryIfActed),
    ...(timerSeams.setTimer === undefined ? {} : { setTimer: timerSeams.setTimer }),
    ...(timerSeams.clearTimer === undefined ? {} : { clearTimer: timerSeams.clearTimer }),
  })
}
