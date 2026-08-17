/**
 * Proactive backstop for Trident worktrees leaked by runs that never reached
 * merge. It NEVER deletes a branch, NEVER forces removal, NEVER kills a process,
 * and skips the entire sweep when liveness cannot be proven because `/proc` is
 * absent. This mirrors `codex-build.sh`'s `holder_is_live` prior art: unreadable
 * entries owned by other uids are skipped per pid, because every lane in one
 * instance shares the gateway's uid.
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
import type { TridentRun } from './store.ts'

export const DEFAULT_WORKTREE_RETENTION_MS = 24 * 60 * 60 * 1000
export const DEFAULT_REAP_INTERVAL_MS = 15 * 60 * 1000
export const MAX_REMOVALS_PER_SWEEP = 50

export interface WorktreeReaperStore {
  listRepoPaths(): string[]
  listNonTerminal(
    limit?: number,
  ): Pick<TridentRun, 'worktree' | 'branch' | 'repo_path' | 'workflow_run_id'>[]
}

export interface WorktreeReaperOptions {
  store: WorktreeReaperStore
  run_host: RunHostCommand
  now?: () => number
  retention_ms?: number
  proc_root?: string
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
  }

  return report
}

function logSummaryIfActed(report: WorktreeReapReport): void {
  if (
    !report.skipped_no_liveness &&
    report.detached.length === 0 &&
    report.removed.length === 0
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
