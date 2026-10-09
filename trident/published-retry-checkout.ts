import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual as equal } from 'node:util'
import type { HostCommandResult } from './git-mode.ts'
import type { BranchReservation } from './branch-reservation.ts'
import type { TridentRunStore } from './store.ts'
import { TRIDENT_SCRIPT_DIR } from './script-dir.ts'
import {
  adoptedPublishedRetryPin, observeOwnedPublication, readPublishedRetryHandoff,
  type PublishedRetryHandoff, type PublishedRetrySettlement,
} from './published-retry-handoff.ts'

/**
 * Fixed labels only: Git output and checkout paths can name private locations,
 * and these labels reach durable state through the worktree-add diagnostic.
 */
export type RetainedCheckoutRefusal =
  | 'authority-changed' | 'reservation-unavailable' | 'base-pin-changed' | 'publication-refused'
  | 'main-worktree-holds-branch' | 'multiple-holders' | 'holder-locked' | 'holder-prunable'
  | 'holder-not-recorded-worktree' | 'holder-not-worktree-root' | 'holder-head-moved'
  | 'branch-moved' | 'base-not-ancestor' | 'holder-dirty' | 'holder-unverifiable'
  | 'observation-changed' | 'cleanup-preserved'
export type RetainedCheckoutUnknown =
  | 'authority-unreadable' | 'worktree-list-unreadable' | 'branch-unreadable' | 'base-ancestry-unknown'
  | 'publication-unknown' | 'cleanup-unconfirmed' | 'post-check-failed'

export type RetainedCheckoutOutcome =
  | { verdict: 'none' }
  | { verdict: 'handed-off'; handoff: PublishedRetryHandoff }
  | { verdict: 'refused'; detail: RetainedCheckoutRefusal }
  | { verdict: 'unknown'; detail: RetainedCheckoutUnknown }

export interface RetainedCheckoutInput {
  store: TridentRunStore
  settled: PublishedRetrySettlement | undefined
  runId: string
  /** The PR target branch: the owned publication is re-observed on it. */
  baseBranch: string
  runHost: (argv: string[], cwd: string) => Promise<HostCommandResult>
}

interface Holder { path: string; locked: boolean; prunable: boolean }
interface Observation { listing: string; holders: Holder[]; mainHolds: boolean; tip: string; holderHead: string; status: string }

/** Parse `git worktree list --porcelain`; null when the shape is not Git's. */
function parseWorktrees(stdout: string, branch: string): { holders: Holder[]; mainHolds: boolean } | null {
  const holders: Holder[] = []
  let mainHolds = false
  let index = -1
  let current: Holder | null = null
  let holds = false
  const flush = () => {
    if (current && holds) { if (index === 0) mainHolds = true; else holders.push(current) }
  }
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      index++
      current = { path: line.slice('worktree '.length), locked: false, prunable: false }
      holds = false
    } else if (line.length === 0) continue
    else if (current === null) return null
    else if (line === `branch refs/heads/${branch}`) holds = true
    else if (line === 'locked' || line.startsWith('locked ')) current.locked = true
    else if (line === 'prunable' || line.startsWith('prunable ')) current.prunable = true
  }
  flush()
  return index < 0 ? null : { holders, mainHolds }
}

const realpath = (path: string): string | null => { try { return realpathSync(path) } catch { return null } }
const failed = (result: HostCommandResult): boolean => !result.ok || result.timed_out === true

/**
 * HAND OFF AN OWNED PUBLISHED RETRY'S RETAINED CHECKOUT (#1476).
 *
 * Actual preparation adds the retry's worktree on the branch its terminal
 * predecessor retained, and Git refuses that while the predecessor's linked
 * checkout still holds the branch. The outer launch authority
 * (`readPublishedRetryHandoff`) is re-established here while this call holds
 * its own durable `salvage`-purpose reservation of the branch (acquired here,
 * released when `body` returns); only then does the EXISTING worktree
 * lifecycle (`worktree-cleanup.sh keep-branch`: a plain `git worktree remove`
 * of a clean tree, never `--force`, never a branch deletion) release the one
 * checkout that is exactly the predecessor's recorded worktree at the settled
 * head. `body` runs while the reservation is still held, so the caller's
 * `git worktree add` of the existing branch happens under the same exclusion.
 *
 * When no checkout holds the branch any more, the same authority, settled-head,
 * base-ancestry and publication checks still run and nothing is released: the
 * outcome is 'handed-off' so the caller re-checks the settled head after its add.
 *
 * 'none' means no owned published retry authority exists and outer launch did
 * not adopt the branch: the caller's path is unchanged and no reservation is
 * taken. When the authority cannot be re-read but the row carries the adopted
 * base pin (`adoptedPublishedRetryPin`), the outcome is UNKNOWN
 * `authority-unreadable` instead, again before any reservation or Git call.
 * Every other shape refuses or is UNKNOWN before any mutation, except a post-cleanup check that cannot confirm
 * the result, which is UNKNOWN. Nothing here writes predecessor rows, events,
 * attempts, budgets or artifacts, and no reservation but this call's own is
 * ever released.
 */
export async function withRetainedCheckoutHandoff<T>(
  input: RetainedCheckoutInput, body: (outcome: RetainedCheckoutOutcome) => Promise<T>,
): Promise<T> {
  const { store, settled, runId, runHost } = input
  const read = () => {
    const run = store.get(runId)
    return run === null ? null : readPublishedRetryHandoff(store, settled, run)
  }
  const first = read()
  if (first === null) {
    // No authority now. If outer launch nevertheless ADOPTED this branch (the row
    // carries the predecessor's base pin), the branch it bypassed the wrong-base
    // guard for must not be attached unchecked: that is UNKNOWN, before any
    // reservation, cleanup or add. Otherwise the caller's path is unchanged.
    let adopted = true
    try {
      const run = store.get(runId)
      adopted = run !== null && adoptedPublishedRetryPin(store, run)
    } catch { adopted = true }
    return body(adopted ? { verdict: 'unknown', detail: 'authority-unreadable' } : { verdict: 'none' })
  }
  const run = store.get(runId)!
  const repo = run.repo_path
  const branch = run.branch!
  let reservation: BranchReservation | null = null
  try {
    try { reservation = await store.reserveBranch({ repo_path: repo, branch, run_id: runId, purpose: 'salvage' }) }
    catch { reservation = null }
    if (reservation === null) return await body({ verdict: 'refused', detail: 'reservation-unavailable' })
    return await body(await handOff(first))
  } finally {
    if (reservation !== null) await store.releaseBranch(reservation)
  }

  async function handOff(handoff: PublishedRetryHandoff): Promise<RetainedCheckoutOutcome> {
    // Re-established under the reservation: anything that moved since refuses.
    const held = read()
    if (held === null || !equal(held, handoff)) return { verdict: 'refused', detail: 'authority-changed' }
    if (store.get(runId)?.base_sha !== handoff.priorBase) return { verdict: 'refused', detail: 'base-pin-changed' }
    const git = (args: string[], cwd = repo) => runHost(['git', '-C', cwd, ...args], cwd)

    const observe = async (): Promise<Observation | RetainedCheckoutOutcome> => {
      const listed = await git(['worktree', 'list', '--porcelain'])
      if (failed(listed)) return { verdict: 'unknown', detail: 'worktree-list-unreadable' }
      const parsed = parseWorktrees(listed.stdout, branch)
      if (parsed === null) return { verdict: 'unknown', detail: 'worktree-list-unreadable' }
      const tipRead = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
      if (failed(tipRead)) return { verdict: 'unknown', detail: 'branch-unreadable' }
      const tip = tipRead.stdout.trim()
      if (parsed.mainHolds) return { verdict: 'refused', detail: 'main-worktree-holds-branch' }
      if (parsed.holders.length > 1) return { verdict: 'refused', detail: 'multiple-holders' }
      const holder = parsed.holders[0] ?? null
      const real = holder === null ? null : realpath(holder.path)
      if (holder !== null) {
        if (holder.locked) return { verdict: 'refused', detail: 'holder-locked' }
        if (holder.prunable) return { verdict: 'refused', detail: 'holder-prunable' }
        if (real === null || real !== realpath(handoff.holderWorktree)) return { verdict: 'refused', detail: 'holder-not-recorded-worktree' }
      }
      // The branch itself must still be the settled head, whether or not a
      // checkout still holds it: with no holder the caller attaches the branch
      // as it stands, so a moved tip would build on an unapproved head.
      if (tip !== handoff.settledHead) return { verdict: 'refused', detail: 'branch-moved' }
      const descends = await git(['merge-base', '--is-ancestor', handoff.priorBase, tip])
      if (descends.timed_out === true || (!descends.ok && descends.exit_code !== 1)) return { verdict: 'unknown', detail: 'base-ancestry-unknown' }
      if (!descends.ok) return { verdict: 'refused', detail: 'base-not-ancestor' }
      if (holder === null) return { listing: listed.stdout, holders: [], mainHolds: false, tip, holderHead: '', status: '' }
      const top = await git(['rev-parse', '--show-toplevel'], holder.path)
      if (failed(top) || realpath(top.stdout.trim()) !== real) return { verdict: 'refused', detail: 'holder-not-worktree-root' }
      const head = await git(['rev-parse', '--verify', 'HEAD^{commit}'], holder.path)
      if (failed(head) || head.stdout.trim() !== handoff.settledHead) return { verdict: 'refused', detail: 'holder-head-moved' }
      const status = await git(['status', '--porcelain', '--untracked-files=all'], holder.path)
      if (failed(status)) return { verdict: 'refused', detail: 'holder-unverifiable' }
      if (status.stdout.trim().length > 0) return { verdict: 'refused', detail: 'holder-dirty' }
      return { listing: listed.stdout, holders: parsed.holders, mainHolds: false, tip, holderHead: head.stdout.trim(), status: status.stdout }
    }
    const isOutcome = (value: Observation | RetainedCheckoutOutcome): value is RetainedCheckoutOutcome => 'verdict' in value

    const before = await observe()
    if (isOutcome(before)) return before
    // The owned publication is re-observed: still OPEN on this branch and base,
    // and its head is contained in the retained branch.
    const pr = await observeOwnedPublication(run, input.baseBranch, runHost)
    if (pr.verdict === 'unknown') return { verdict: 'unknown', detail: 'publication-unknown' }
    if (pr.verdict !== 'ok') return { verdict: 'refused', detail: 'publication-refused' }
    const contained = await git(['merge-base', '--is-ancestor', pr.head, before.tip])
    if (contained.timed_out === true || (!contained.ok && contained.exit_code !== 1)) return { verdict: 'unknown', detail: 'publication-unknown' }
    if (!contained.ok) return { verdict: 'refused', detail: 'publication-refused' }

    // Second read of authority and Git, as outer launch does: any change refuses.
    const again = await observe()
    if (isOutcome(again)) return again.verdict === 'unknown' ? again : { verdict: 'refused', detail: 'observation-changed' }
    const reread = read()
    if (!equal(again, before) || reread === null || !equal(reread, handoff)) return { verdict: 'refused', detail: 'observation-changed' }

    // No checkout holds the branch (the predecessor's was already released): there
    // is nothing for the lifecycle to remove, and the branch was proven above to be
    // the settled head carrying the owned PR head. The caller's attach of the
    // existing branch then re-checks the settled head, as for a released holder.
    if (before.holders.length === 0) return { verdict: 'handed-off', handoff }

    const holder = before.holders[0]!.path
    const cleanup = await runHost(['bash', join(TRIDENT_SCRIPT_DIR, 'worktree-cleanup.sh'), repo, branch, 'keep-branch'], repo)
    const lines = cleanup.stdout.split('\n').filter(line => line.length > 0)
    if (cleanup.timed_out !== true && !cleanup.ok && cleanup.exit_code === 3 && lines.some(line => line.startsWith('PRESERVED '))) {
      return { verdict: 'refused', detail: 'cleanup-preserved' }
    }
    if (failed(cleanup) || cleanup.exit_code !== 0 || !lines.includes(`REMOVED ${holder}`)
      || !lines.includes('RESULT preserved=0 removed=1')) return { verdict: 'unknown', detail: 'cleanup-unconfirmed' }

    // The branch and every commit are kept; the holder is gone.
    const listed = await git(['worktree', 'list', '--porcelain'])
    const parsed = failed(listed) ? null : parseWorktrees(listed.stdout, branch)
    const tip = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
    const keepsPr = await git(['merge-base', '--is-ancestor', pr.head, handoff.settledHead])
    if (parsed === null || parsed.holders.length > 0 || parsed.mainHolds || failed(tip)
      || tip.stdout.trim() !== handoff.settledHead || failed(keepsPr)) return { verdict: 'unknown', detail: 'post-check-failed' }
    return { verdict: 'handed-off', handoff }
  }
}
