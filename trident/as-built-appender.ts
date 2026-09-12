/**
 * Promote the durable `.trident/as-built/` queue into the per-change record under `docs/as-built/`.
 *
 * This is deliberately a git-tree operation, not a checkout operation. The outer publisher can
 * be running beside a dirty or stale shared checkout, so it resolves one base tip, reads the queue
 * from that tree, and makes the promotion + queue deletion in one detached scratch-worktree commit.
 *
 * IT NO LONGER WRITES `docs/AS_BUILT.md`. That file is frozen (`docs/AS_BUILT.md:5`): it is the
 * record up to 2026-09-12 and nothing appends to it again. A staged entry becomes its OWN file,
 * `docs/as-built/<slug>.md`, named from the staged file's own basename — which is the branch's
 * slug, and the spec-item slug where the change has one. Everything else about this module is
 * unchanged, and deliberately so: the atomic base-tip resolution, the detached scratch worktree,
 * the single commit, the deletion of the consumed staging file, and the plain (never forced) push
 * are what make a fold safe to lose and safe to retry, and none of that depended on the
 * destination being one file.
 *
 * THE EXPORTED NAMES STILL SAY "FOLD" AND THAT IS DELIBERATE. `foldStagedAsBuiltEntries` and its
 * `folded` count are the seam `trident/tick.ts:170` and `trident/orchestrator.ts:2182` call and
 * report on; what is folded is the QUEUE, and where it folds to is this module's business alone.
 * Renaming the seam would have touched the orchestrator for no behavioural reason.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AS_BUILT_DIR, shardStagedEntries } from './as-built-log.ts'
import type { RunHostCommand } from './merge.ts'
import type { MergeMode } from './store.ts'

export const AS_BUILT_COMMITTER_NAME = 'trident'
export const AS_BUILT_COMMITTER_EMAIL = 'trident@neutron.local'

export type FoldStagedAsBuiltEntriesResult =
  | { ok: true; folded: number }
  | { ok: false; folded: number; reason: string }

type FoldFailure = Extract<FoldStagedAsBuiltEntriesResult, { ok: false }>

interface StagedEntry {
  path: string
  landedAt: number
  text: string
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  exit_code: number
}

function gitFailure(action: string, result: GitResult): FoldFailure {
  // Git's stderr is the diagnosis. In particular, a rejected plain push says whether the race was
  // non-fast-forward, authentication, or transport; replacing it with our own guess is #259's
  // failure mode. The command and remote URL are intentionally absent from the message.
  const detail = result.stderr || result.stdout || `git exited ${result.exit_code} without output`
  return { ok: false, folded: 0, reason: `${action}: ${detail}` }
}

function malformedReason(refused: readonly { path: string; reason: string }[]): string {
  return ['malformed staged as-built entries were left queued:', ...refused.map((item) => `${item.path}: ${item.reason}`)].join(
    '\n',
  )
}

/**
 * Fold every well-formed staged entry present at one resolved base tip.
 *
 * Operational failures are values because a failed fold must never undo an already-landed merge.
 * A malformed sibling is also a failure, but does not block well-formed entries: those land in one
 * commit while the malformed path remains on the base as the durable retry/repair signal.
 */
export async function foldStagedAsBuiltEntries(
  run_host: RunHostCommand,
  repo_path: string,
  merge_mode: MergeMode,
  base: string,
): Promise<FoldStagedAsBuiltEntriesResult> {
  try {
    if (merge_mode === 'pr') {
      const fetched = await run_host(['git', '-C', repo_path, 'fetch', '--no-tags', 'origin', base], repo_path)
      if (!fetched.ok) return gitFailure(`could not fetch base '${base}'`, fetched)
    }

    const baseRef = merge_mode === 'pr' ? `refs/remotes/origin/${base}` : `refs/heads/${base}`
    const resolved = await run_host(
      ['git', '-C', repo_path, 'rev-parse', '--verify', `${baseRef}^{commit}`],
      repo_path,
    )
    if (!resolved.ok) return gitFailure(`could not resolve base '${base}'`, resolved)
    const expectedTip = resolved.stdout.trim()

    const listed = await run_host(
      ['git', '-C', repo_path, 'ls-tree', '-r', '--name-only', expectedTip, '--', '.trident/as-built/'],
      repo_path,
    )
    if (!listed.ok) return gitFailure(`could not enumerate staged as-built entries on '${base}'`, listed)
    const paths = listed.stdout
      .split('\n')
      .filter((path) => path.startsWith('.trident/as-built/') && path.endsWith('.md'))
    if (paths.length === 0) return { ok: true, folded: 0 }

    const landed: { path: string; landedAt: number }[] = []
    for (const path of paths) {
      const logged = await run_host(
        ['git', '-C', repo_path, 'log', '-1', '--format=%ct', expectedTip, '--', path],
        repo_path,
      )
      if (!logged.ok) return gitFailure(`could not read landing time for '${path}'`, logged)
      const landedAt = Number.parseInt(logged.stdout.trim(), 10)
      if (!Number.isFinite(landedAt)) {
        return {
          ok: false,
          folded: 0,
          reason: `could not read landing time for '${path}': git returned '${logged.stdout}'`,
        }
      }
      landed.push({ path, landedAt })
    }
    landed.sort((a, b) => a.landedAt - b.landedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

    const parent = mkdtempSync(join(tmpdir(), 'trident-as-built-fold-'))
    const scratch = join(parent, 'worktree')
    let result: FoldStagedAsBuiltEntriesResult = { ok: false, folded: 0, reason: 'fold did not run' }
    const cleanupFailures: string[] = []

    try {
      const added = await run_host(
        ['git', '-C', repo_path, 'worktree', 'add', '--detach', scratch, expectedTip],
        repo_path,
      )
      if (!added.ok) {
        result = gitFailure(`could not create the as-built scratch worktree`, added)
      } else {
        result = await promoteInScratch(run_host, repo_path, scratch, merge_mode, base, expectedTip, landed)
      }
    } finally {
      const removed = await run_host(['git', '-C', repo_path, 'worktree', 'remove', '--force', scratch], repo_path)
      if (!removed.ok && !/not a working tree|is not a working tree/i.test(removed.stderr)) {
        cleanupFailures.push(`could not remove the as-built scratch worktree: ${removed.stderr || removed.stdout}`)
      }
      const pruned = await run_host(['git', '-C', repo_path, 'worktree', 'prune'], repo_path)
      if (!pruned.ok) cleanupFailures.push(`could not prune scratch worktrees: ${pruned.stderr || pruned.stdout}`)
      rmSync(parent, { recursive: true, force: true })
    }

    if (cleanupFailures.length > 0) {
      return {
        ok: false,
        folded: result.folded,
        reason: [result.ok ? '' : result.reason, ...cleanupFailures].filter(Boolean).join('\n'),
      }
    }
    return result
  } catch (error) {
    return { ok: false, folded: 0, reason: `could not fold staged as-built entries: ${String(error)}` }
  }
}

async function promoteInScratch(
  run_host: RunHostCommand,
  repo_path: string,
  scratch: string,
  merge_mode: MergeMode,
  base: string,
  expectedTip: string,
  landed: readonly { path: string; landedAt: number }[],
): Promise<FoldStagedAsBuiltEntriesResult> {
  const entries: StagedEntry[] = landed.map(({ path, landedAt }) => ({
    path,
    landedAt,
    text: readFileSync(join(scratch, path), 'utf8'),
  }))
  const recordDir = join(scratch, AS_BUILT_DIR)
  mkdirSync(recordDir, { recursive: true })
  // The names already on the base tip. Read from the scratch worktree, which IS the resolved tip —
  // the same tree every other read in this function comes from — so a record added by a concurrent
  // pass that this one has not fetched cannot be silently overwritten: it is not in this tree, this
  // push is plain, and a moved base rejects it.
  const existing = new Set(readdirSync(recordDir).filter((name) => name.endsWith('.md')))
  const promoted = shardStagedEntries(entries, existing)
  const refusedIndexes = new Set(promoted.refused.map((item) => item.index))
  const consumed = entries.filter((_, index) => !refusedIndexes.has(index))
  const refused = promoted.refused.map((item) => ({ path: entries[item.index]!.path, reason: item.reason }))

  if (consumed.length === 0) {
    return { ok: false, folded: 0, reason: malformedReason(refused) }
  }

  for (const shard of promoted.shards) writeFileSync(join(recordDir, shard.name), shard.text)
  const removed = await run_host(
    ['git', '-C', scratch, 'rm', '--', ...consumed.map((entry) => entry.path)],
    scratch,
  )
  if (!removed.ok) return gitFailure('could not remove consumed staged as-built entries', removed)
  const added = await run_host(
    ['git', '-C', scratch, 'add', '--', ...promoted.shards.map((shard) => `${AS_BUILT_DIR}/${shard.name}`)],
    scratch,
  )
  if (!added.ok) return gitFailure('could not stage the promoted as-built records', added)

  const committed = await run_host(
    [
      'git',
      '-C',
      scratch,
      '-c',
      `user.name=${AS_BUILT_COMMITTER_NAME}`,
      '-c',
      `user.email=${AS_BUILT_COMMITTER_EMAIL}`,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      `docs(as-built): record ${consumed.length} staged ${consumed.length === 1 ? 'entry' : 'entries'}`,
    ],
    scratch,
  )
  if (!committed.ok) return gitFailure('could not commit the promoted as-built records', committed)

  const head = await run_host(['git', '-C', scratch, 'rev-parse', 'HEAD'], scratch)
  if (!head.ok) return gitFailure('could not resolve the promoted as-built commit', head)
  const newTip = head.stdout.trim()

  if (merge_mode === 'pr') {
    // Deliberately plain: a moved base rejects this push and leaves the queue on the remote for a
    // fresh pass. No force option belongs in this module.
    const pushed = await run_host(
      ['git', '-C', scratch, 'push', 'origin', `HEAD:refs/heads/${base}`],
      scratch,
    )
    if (!pushed.ok) {
      const failed = gitFailure(`could not land promoted as-built records on '${base}'`, pushed)
      return { ...failed, folded: 0 }
    }
  } else {
    const advanced = await run_host(
      ['git', '-C', repo_path, 'update-ref', `refs/heads/${base}`, newTip, expectedTip],
      repo_path,
    )
    if (!advanced.ok) {
      const failed = gitFailure(`could not advance local base '${base}'`, advanced)
      return { ...failed, folded: 0 }
    }
  }

  if (refused.length > 0) {
    return { ok: false, folded: consumed.length, reason: malformedReason(refused) }
  }
  return { ok: true, folded: consumed.length }
}
