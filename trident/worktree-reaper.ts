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
 * ── THE EVIDENCE GUARD, AND WHY IT IS STRICTLY SAFER THAN THE 2026-09-01 INCIDENT ─
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
 *   4. No worktree holds the ref. `worktree list` alone is not enough: git reports a
 *      worktree mid-rebase or mid-bisect as DETACHED and prints no `branch`
 *      attribute, so every detached entry is asked directly (`readRebaseHead`, the
 *      prior art this reuses rather than re-derives). That read answering 'unknown'
 *      refuses every ref in the repo, because what it could not read may name any of
 *      them.
 *   5. At least one run row in this repo names the branch. NO row is not evidence the
 *      ref is disposable — it is the absence of an owner, so it is kept. That single
 *      rule is what protects a hand-made branch and, measured against the 79, it is
 *      what keeps 6 of them.
 *   6. EVERY run row naming it is in a terminal phase. One non-terminal owner keeps
 *      the ref (`listBranchOwners` is unbounded for exactly this reason — see there).
 *   7. No owning run's recorded worktree still EXISTS on disk. A surviving worktree
 *      is where uncommitted and untracked work lives, and its history is the ref
 *      underneath it; `worktree-cleanup.sh`'s preservation of a dirty tree is
 *      therefore also a preservation of its ref.
 *   8. No live process is standing in an owning run's worktree path, and none is
 *      standing in a path bearing its `workflow_run_id`. This is the gate for the
 *      real race the DB cannot see: the row went terminal (hang watchdog, cancel,
 *      crash latch) while the detached workflow is still running.
 *   9. A salvage ref was CREATED first — create-only, never a blind set. 67 of the 79
 *      measured refs carry commits origin does not have, so the delete would otherwise
 *      be the only copy's last reference. `refs/trident-reaped/<slug>/<sha>` keeps them
 *      reachable — outside `refs/heads` so it can never re-enter a launch, and outside
 *      `refs/tags` so it neither clutters `git tag` nor rides a `--follow-tags` push.
 *      Recovery is `git branch <name> <sha>`. Salvage failing REFUSES the delete.
 *  10. THE DELETE IS ONE ATOMIC COMPARE-AND-SWAP: `git update-ref -d <ref>
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
 *      the wrong question: holder safety is gates 4 and 4b, which do not depend on the
 *      delete primitive, whereas atomicity can only come FROM the primitive.
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

/** Where a reaped tip is kept so its commits stay reachable (gate 10). */
export const SALVAGE_REF_PREFIX = 'refs/trident-reaped/'

/**
 * Deletions attempted per sweep, bounded for the same reason as
 * `MAX_REMOVALS_PER_SWEEP`: one sweep's work stays finite on a repo that has
 * accumulated hundreds. The measured backlog (79) therefore drains over two sweeps.
 */
export const MAX_REF_DELETIONS_PER_SWEEP = 50

/**
 * REF RETENTION IS DELIBERATELY ZERO, unlike the 24 h a worktree gets. A worktree can
 * hold work that exists nowhere else and no probe can read intent out of it, so age is
 * a stand-in for "somebody may still want this". A ref holds commits, which gate 10
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
    } catch {
      continue
    }
    if (!listed.ok) continue

    const entries = parseWorktrees(listed.stdout)
    if (entries.length === 0) continue
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
        // the history its uncommitted work sits on top of. Recorded so the ref reap can
        // refuse it for as long as the tree it belongs to is still on disk; the sweep
        // that finally removes the tree is the sweep that may take the ref.
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
    // pass and the prune just left: a tree that was removed is no longer a holder, and
    // a tree that was PRESERVED still is. One try/catch for the same reason the prune
    // has one — a ref sweep that throws in one repo must not abandon the next.
    if (!refsReady) {
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: 'awaiting-boot-rescue: the stranded-failure sweep has not settled yet',
      })
      continue
    }
    try {
      await reapBranchRefs(opts, repo, processCwds, report, refDeletions, detachedThisSweep)
    } catch (error) {
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: `sweep-failed: ${errText(error)}`,
      })
    }
  }

  return report
}

// ── THE BRANCH-REF REAP (#547) ────────────────────────────────────────────────

interface ZHolder {
  path: string
  branch: string | null
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
    holder ??= { path: '', branch: null }
    if (field.startsWith('worktree ')) holder.path = field.slice('worktree '.length)
    else if (field.startsWith('branch ')) holder.branch = field.slice('branch '.length)
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
 * Is a process standing anywhere that belongs to this run (gate 8)? Two independent
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
    return
  }
  if (!listed.ok) {
    report.refs_kept.push({
      ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
      reason: `refs-unenumerable: ${hostText(listed)}`,
    })
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
    return
  }
  if (!holderList.ok) {
    report.refs_kept.push({
      ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
      reason: `holders-unenumerable: ${hostText(holderList)}`,
    })
    return
  }

  // GATE 4 — who holds what. A detached entry is asked directly, because git prints no
  // `branch` attribute for a worktree mid-rebase or mid-bisect even though it holds one.
  const readRebase = opts.rebase_head ?? readRebaseHead
  const held = new Map<string, string>()
  for (const holder of parseHoldersZ(holderList.stdout)) {
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
      return
    }
    if (rebasing.kind === 'branch') held.set(rebasing.ref, holder.path)
  }
  // A ref THIS sweep freed by detaching its worktree is held for as long as that
  // worktree survives — see the detach site. The tree is asked for again rather than
  // assumed, so the refs of trees the pass went on to remove are genuinely free.
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

    // GATE 9 — SALVAGE FIRST, CREATE-ONLY. `refs/trident-reaped/<slug>/<sha>` embeds the
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

    // GATE 10 — THE DELETE IS ONE ATOMIC COMPARE-AND-SWAP, and that is the whole reason
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
    deletionBudget.attempts += 1
    let deleted
    try {
      deleted = await opts.run_host(['git', '-C', repo, 'update-ref', '-d', ref, sha], repo)
    } catch (error) {
      report.refs_kept.push({ ref, reason: `delete-refused: ${errText(error)}` })
      continue
    }
    if (!deleted.ok) {
      // The overwhelmingly likely cause is the CAS losing — the ref moved, so something
      // is alive on it. Reported with git's own words rather than as a diagnosis.
      report.refs_kept.push({ ref, reason: `delete-refused: ${hostText(deleted)}` })
      continue
    }
    report.refs_deleted.push({ ref, sha, salvage })
    log.info('worktree_reaper_ref_deleted', { repo, ref, sha, salvage })
  }
}

function logSummaryIfActed(report: WorktreeReapReport): void {
  if (
    !report.skipped_no_liveness &&
    report.detached.length === 0 &&
    report.removed.length === 0 &&
    report.refs_deleted.length === 0
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
