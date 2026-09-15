import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { HostCommandResult } from './git-mode.ts'
import type { RunHostCommand } from './merge.ts'
import type { TridentRun } from './store.ts'

export type WorktreeDisposition =
  | { kind: 'dirty'; files: number; untracked: number; lines: number; ref: string; warning?: string }
  | { kind: 'stashed'; entries: number }
  | { kind: 'failed'; detail: string }
  | { kind: 'none' }

export function createFailureSalvageCapture(runHost: RunHostCommand): {
  anchoredSnapshotDisposition: (run: TridentRun) => Promise<WorktreeDisposition | null>
  captureWorktreeDisposition: (run: TridentRun, branch: string) => Promise<WorktreeDisposition>
} {
function failedDisposition(
  step: string,
  result?: { stderr: string; stdout: string },
): Extract<WorktreeDisposition, { kind: 'failed' }> {
  const output = result === undefined ? '' : result.stderr || result.stdout
  return {
    kind: 'failed',
    detail: `${step}${output.trim() === '' ? '' : `: ${output.trim().replace(/\s+/g, ' ').slice(0, 120)}`}`,
  }
}

async function measureSnapshot(
  repo: string,
  base: string,
  targets: string[],
): Promise<{ files: number; lines: number } | { detail: string }> {
  // Count both captured versions. Taking the larger per-path delta avoids
  // double-counting ordinary staged-then-edited files while ensuring an
  // index-only path is not reported as zero work.
  const linesByPath = new Map<string, number>()
  for (const target of targets) {
    const numstat = await runHost(
      ['git', '-C', repo, 'diff', '--numstat', base, target],
      repo,
    )
    if (!numstat.ok) {
      return { detail: failedDisposition('snapshot numstat failed', numstat).detail }
    }
    for (const line of numstat.stdout.split(/\r?\n/)) {
      if (line === '') continue
      const [addedText = '', removedText = '', ...pathParts] = line.split('\t')
      const addedLines = Number.parseInt(addedText, 10)
      const removedLines = Number.parseInt(removedText, 10)
      const lineCount =
        (Number.isFinite(addedLines) ? addedLines : 0) +
        (Number.isFinite(removedLines) ? removedLines : 0)
      const path = pathParts.join('\t') || line
      linesByPath.set(path, Math.max(linesByPath.get(path) ?? 0, lineCount))
    }
  }
  return {
    files: linesByPath.size,
    lines: [...linesByPath.values()].reduce((sum, count) => sum + count, 0),
  }
}

async function anchoredSnapshotDisposition(run: TridentRun): Promise<WorktreeDisposition | null> {
  const snapshotRef = `refs/tags/trident-salvage/${run.id}`
  const anchored = await runHost(
    ['git', '-C', run.repo_path, 'rev-parse', '--verify', `${snapshotRef}^{commit}`],
    run.repo_path,
  )
  const oid = anchored.stdout.trim()
  if (!anchored.ok || !/^[0-9a-f]{40}$/.test(oid)) return null

  // The ref is the durable capture receipt. Reconstruct its counts from its
  // own first parent rather than the branch's current HEAD: a retry can happen
  // after the worktree and branch have both moved.
  const parent = await runHost(
    ['git', '-C', run.repo_path, 'rev-parse', '--verify', `${snapshotRef}^1^{commit}`],
    run.repo_path,
  )
  const base = parent.stdout.trim()
  let warning: string | undefined
  let files = 0
  let lines = 0
  if (!parent.ok || !/^[0-9a-f]{40}$/.test(base)) {
    warning = failedDisposition('anchored snapshot parent unreadable', parent).detail
  } else {
    const indexParent = await runHost(
      ['git', '-C', run.repo_path, 'rev-parse', '--verify', `${snapshotRef}^2^{commit}`],
      run.repo_path,
    )
    const indexOid = indexParent.stdout.trim()
    const targets =
      indexParent.ok && /^[0-9a-f]{40}$/.test(indexOid) ? [oid, indexOid] : [oid]
    const measured = await measureSnapshot(run.repo_path, base, targets)
    if ('detail' in measured) warning = measured.detail
    else ({ files, lines } = measured)
  }

  const message = await runHost(
    ['git', '-C', run.repo_path, 'show', '-s', '--format=%B', snapshotRef],
    run.repo_path,
  )
  const untrackedMatch = message.ok
    ? message.stdout.match(/^Trident-Salvage-Untracked:\s*(\d+)$/m)
    : null
  const capturedWarning = message.ok
    ? message.stdout.match(/^Trident-Salvage-Warning:\s*(.+)$/m)?.[1]?.trim()
    : undefined
  if (warning === undefined && capturedWarning !== undefined && capturedWarning !== '') {
    warning = capturedWarning
  }

  return {
    kind: 'dirty',
    files,
    lines,
    untracked: untrackedMatch === null ? 0 : Number.parseInt(untrackedMatch[1] ?? '0', 10),
    ref: snapshotRef,
    ...(warning === undefined ? {} : { warning }),
  }
}

async function snapshotWorktree(
  run: TridentRun,
  worktree: string,
  statusEntries: string[],
): Promise<WorktreeDisposition> {
  const scratch = mkdtempSync(join(tmpdir(), 'trident-salvage-index-'))
  const index = join(scratch, 'index')
  const snapshotRef = `refs/tags/trident-salvage/${run.id}`
  const withSnapshotIndex = (args: string[]): Promise<HostCommandResult> =>
    runHost(['git', '-C', worktree, ...args], worktree, { GIT_INDEX_FILE: index })

  try {
    // `stash create` is the read-only Git primitive that preserves BOTH the
    // live index and the tracked working tree. Its second parent is the index
    // snapshot. Retain that parent on our final commit so staged-only content
    // remains recoverable even when the worktree copy is back at HEAD.
    const hasTrackedChanges = statusEntries.some((entry) => !entry.startsWith('?? '))
    let indexParent: string | null = null
    let warning: string | undefined
    if (hasTrackedChanges) {
      const stashed = await runHost(['git', '-C', worktree, 'stash', 'create'], worktree)
      const stashOid = stashed.stdout.trim()
      if (!stashed.ok || !/^[0-9a-f]{40}$/.test(stashOid)) {
        warning = failedDisposition('snapshot stash-create failed', stashed).detail
      } else {
        const resolvedIndex = await runHost(
          ['git', '-C', worktree, 'rev-parse', '--verify', `${stashOid}^2^{commit}`],
          worktree,
        )
        const resolvedOid = resolvedIndex.stdout.trim()
        if (!resolvedIndex.ok || !/^[0-9a-f]{40}$/.test(resolvedOid)) {
          warning = failedDisposition('snapshot index-parent failed', resolvedIndex).detail
        } else {
          indexParent = resolvedOid
        }
      }
    }

    // Build the worktree-facing tree in a PRIVATE temporary index. This adds
    // untracked files without opening or locking the live index; the optional
    // index parent above preserves the distinct staged version.
    const seeded = await withSnapshotIndex(['read-tree', 'HEAD'])
    if (!seeded.ok) return failedDisposition('snapshot read-tree failed', seeded)

    const added = await withSnapshotIndex(['add', '-A', '--', '.'])
    if (!added.ok) return failedDisposition('snapshot add failed', added)

    const tree = await withSnapshotIndex(['write-tree'])
    const treeOid = tree.stdout.trim()
    if (!tree.ok || !/^[0-9a-f]{40}$/.test(treeOid)) {
      return failedDisposition('snapshot write-tree failed', tree)
    }

    const commitArgs = [
      'git',
      '-C',
      worktree,
      '-c',
      'user.name=Neutron Trident',
      '-c',
      'user.email=trident@neutron.local',
      'commit-tree',
      treeOid,
      '-p',
      'HEAD',
    ]
    if (indexParent !== null) commitArgs.push('-p', indexParent)
    commitArgs.push('-m', `trident salvage snapshot ${run.id}`)
    const untracked = statusEntries.filter((entry) => entry.startsWith('?? ')).length
    commitArgs.push(
      '-m',
      `Trident-Salvage-Untracked: ${untracked}${warning === undefined ? '' : `\nTrident-Salvage-Warning: ${warning}`}`,
    )
    const committed = await runHost(commitArgs, worktree)
    const oid = committed.stdout.trim()
    if (!committed.ok || !/^[0-9a-f]{40}$/.test(oid)) {
      return failedDisposition('snapshot commit-tree failed', committed)
    }

    const measured = await measureSnapshot(
      worktree,
      'HEAD',
      indexParent === null ? [oid] : [oid, indexParent],
    )
    if ('detail' in measured) return { kind: 'failed', detail: measured.detail }

    const anchored = await runHost(
      ['git', '-C', run.repo_path, 'update-ref', snapshotRef, oid, '0000000000000000000000000000000000000000'],
      run.repo_path,
    )
    if (!anchored.ok) {
      // A concurrent/retried capture may have won between the initial probe
      // and this create-only CAS. Its ref is authoritative; never move it.
      return (
        (await anchoredSnapshotDisposition(run)) ??
        failedDisposition('snapshot update-ref failed', anchored)
      )
    }

    return {
      kind: 'dirty',
      files: measured.files,
      untracked,
      lines: measured.lines,
      ref: snapshotRef,
      ...(warning === undefined ? {} : { warning }),
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function branchStashDisposition(run: TridentRun, branch: string): Promise<WorktreeDisposition> {
  const format = '--format=%H%x09%ct%x09%gs'
  // `stash list` and the underlying reflog are intentionally read separately:
  // either view can be unavailable/corrupt while the other still carries the
  // evidence. Entries are deduplicated by object id.
  const [listed, reflogged] = await Promise.all([
    runHost(['git', '-C', run.repo_path, 'stash', 'list', format], run.repo_path),
    runHost(
      ['git', '-C', run.repo_path, 'reflog', 'show', format, 'refs/stash'],
      run.repo_path,
    ),
  ])
  const started = Date.parse(run.started_at) / 1_000
  const ended = Date.parse(run.last_advanced_at) / 1_000
  const entries = new Set<string>()
  for (const result of [listed, reflogged]) {
    if (!result.ok) continue
    for (const line of result.stdout.split(/\r?\n/)) {
      const [oid = '', epochText = '', ...subjectParts] = line.split('\t')
      const epoch = Number.parseInt(epochText, 10)
      const subject = subjectParts.join('\t')
      const belongsToBranch =
        subject.startsWith(`WIP on ${branch}:`) || subject.startsWith(`On ${branch}:`)
      const belongsToRun =
        Number.isFinite(epoch) &&
        (!Number.isFinite(started) || epoch >= Math.floor(started)) &&
        (!Number.isFinite(ended) || epoch <= Math.ceil(ended))
      if (/^[0-9a-f]{40}$/.test(oid) && belongsToBranch && belongsToRun) entries.add(oid)
    }
  }
  return entries.size > 0 ? { kind: 'stashed', entries: entries.size } : { kind: 'none' }
}

async function captureWorktreeDisposition(
  run: TridentRun,
  branch: string,
): Promise<WorktreeDisposition> {
  try {
    const listed = await runHost(
      ['git', '-C', run.repo_path, 'worktree', 'list', '--porcelain'],
      run.repo_path,
    )
    let worktree: string | null = null
    if (listed.ok) {
      const stanzas = listed.stdout
        .split(/\r?\n\r?\n/)
        .map((stanza) => stanza.split(/\r?\n/))
      const primary = stanzas[0]?.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
      const recorded = run.worktree === null ? null : resolve(run.worktree)
      const runStarted = Date.parse(run.started_at)
      const runEnded = Date.parse(run.last_advanced_at)
      const candidates: string[] = []
      for (const stanzaLines of stanzas) {
        if (stanzaLines.includes(`branch refs/heads/${branch}`)) {
          const pathLine = stanzaLines.find((line) => line.startsWith('worktree '))
          if (pathLine === undefined) continue
          const candidate = pathLine.slice('worktree '.length)
          // The first stanza is the operator/shared checkout. It is never a
          // salvage target, even if somebody has checked the build branch out
          // there. Prefer the durable run-owned path when one was recorded.
          if (candidate === primary || resolve(candidate) === resolve(run.repo_path)) continue
          if (recorded !== null && resolve(candidate) !== recorded) continue
          // `worktree list` deliberately retains deleted linked worktrees as
          // prunable admin entries. They are not capture failures and must
          // not prevent the shared stash leg from running.
          if (stanzaLines.some((line) => line.startsWith('prunable'))) continue
          // A linked worktree's `.git` pointer is created with that worktree
          // and is not rewritten by ordinary edits/commits. Its mtime is a
          // second ownership proof: a checkout created after this failed row
          // ended belongs to a later dispatch on the reused branch.
          let createdAt: number
          try {
            createdAt = statSync(join(candidate, '.git')).mtimeMs
          } catch {
            // The checkout may disappear after the porcelain read. Treat it
            // like a prunable entry and continue to stash inspection.
            continue
          }
          const inRunWindow =
            (!Number.isFinite(runStarted) || createdAt >= runStarted - 1_000) &&
            (!Number.isFinite(runEnded) || createdAt <= runEnded + 1_000)
          if (!inRunWindow) continue
          candidates.push(candidate)
        }
      }
      if (candidates.length === 1) worktree = candidates[0] ?? null
    }

    if (worktree !== null) {
      const status = await runHost(
        ['git', '-C', worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
        worktree,
      )
      if (!status.ok) return failedDisposition('worktree status failed', status)
      const statusEntries = status.stdout.split('\0').filter((entry) => entry !== '')
      if (statusEntries.length > 0) return snapshotWorktree(run, worktree, statusEntries)
    }

    return branchStashDisposition(run, branch)
  } catch (err) {
    return failedDisposition(
      'worktree capture threw',
      err instanceof Error ? { stderr: err.message, stdout: '' } : undefined,
    )
  }
}

  return { anchoredSnapshotDisposition, captureWorktreeDisposition }
}
