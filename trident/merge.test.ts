import { describe, expect, test } from 'bun:test'
import { cleanupAfterMerge } from './git-mode.ts'
import type { HostCommandResult } from './git-mode.ts'
import {
  buildMergeCleanupDeps,
  detectBaseBranch,
  TridentMergeError,
  type RunHostCommand,
} from './merge.ts'
import type { TridentRun } from './store.ts'

function makeRun(overrides: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'id',
    slug: 's',
    project_slug: 't1',
    phase: 'done',
    round: 1,
    max_rounds: 8,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: 'feat-x',
    pr: 42,
    merge_mode: 'pr',
    subagent_run_id: null,
    subagent_status: null,
    repo_path: '/repo',
    worktree: null,
    task: 't',
    chat_id: null,
    thread_id: null,
    channel_kind: 'telegram',
    failure_reason: null,
    workflow_run_id: null,
    inner_checkpoint: null,
    inner_verdict: null,
    inner_result: null,
    started_at: '2026-01-01T00:00:00.000Z',
    last_advanced_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })
const fail = (stderr = 'boom'): HostCommandResult => ({ ok: false, stdout: '', stderr, exit_code: 1 })

function recordingHost(
  responder: (cmd: string[]) => HostCommandResult = () => ok(),
): { host: RunHostCommand; calls: string[][] } {
  const calls: string[][] = []
  const host: RunHostCommand = async (cmd) => {
    calls.push(cmd)
    return responder(cmd)
  }
  return { host, calls }
}

describe('detectBaseBranch', () => {
  test('parses origin/HEAD symbolic-ref', async () => {
    const { host } = recordingHost((cmd) =>
      cmd.includes('symbolic-ref') ? ok('origin/develop') : ok(),
    )
    expect(await detectBaseBranch(host, '/repo')).toBe('develop')
  })

  test('defaults to main when the probe fails', async () => {
    const { host } = recordingHost(() => fail())
    expect(await detectBaseBranch(host, '/repo')).toBe('main')
  })

  test('a throwing host degrades to main', async () => {
    const host: RunHostCommand = async () => {
      throw new Error('git missing')
    }
    expect(await detectBaseBranch(host, '/repo')).toBe('main')
  })
})

describe('buildMergeCleanupDeps — pr mode', () => {
  test('gh pr merge --squash, then delete remote + local branch (NO worktree remove)', async () => {
    const { host, calls } = recordingHost()
    const deps = buildMergeCleanupDeps(host)
    const res = await cleanupAfterMerge(makeRun({ merge_mode: 'pr', pr: 42, branch: 'feat-x' }), deps)
    expect(res.performed).toBe(true)
    expect(res.mode).toBe('pr')

    const joined = calls.map((c) => c.join(' '))
    expect(joined).toContain('gh pr merge 42 --squash')
    expect(joined).toContain('git -C /repo push origin --delete feat-x')
    expect(joined).toContain('git -C /repo branch -D feat-x')
    // Ryan-locked: never a worktree remove.
    expect(joined.some((c) => c.includes('worktree'))).toBe(false)
  })

  test('a failed gh pr merge throws TridentMergeError (no branch teardown)', async () => {
    const { host, calls } = recordingHost((cmd) =>
      cmd.includes('merge') && cmd.includes('pr') ? fail('merge conflict') : ok(),
    )
    const deps = buildMergeCleanupDeps(host)
    await expect(
      cleanupAfterMerge(makeRun({ merge_mode: 'pr', pr: 42 }), deps),
    ).rejects.toBeInstanceOf(TridentMergeError)
    const joined = calls.map((c) => c.join(' '))
    expect(joined.some((c) => c.includes('branch -D'))).toBe(false)
  })

  test('a null pr throws before any host call', async () => {
    const { host, calls } = recordingHost()
    const deps = buildMergeCleanupDeps(host)
    await expect(cleanupAfterMerge(makeRun({ merge_mode: 'pr', pr: null }), deps)).rejects.toBeInstanceOf(
      TridentMergeError,
    )
    expect(calls).toHaveLength(0)
  })
})

describe('buildMergeCleanupDeps — local mode', () => {
  test('checkout base, merge --no-ff feature, delete local branch (NO remote, NO worktree)', async () => {
    const { host, calls } = recordingHost()
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const res = await cleanupAfterMerge(makeRun({ merge_mode: 'local', branch: 'feat-x', pr: null }), deps)
    expect(res.performed).toBe(true)
    expect(res.mode).toBe('local')

    const joined = calls.map((c) => c.join(' '))
    expect(joined).toContain('git -C /repo checkout main')
    expect(joined.some((c) => c.startsWith('git -C /repo merge --no-ff feat-x'))).toBe(true)
    expect(joined).toContain('git -C /repo branch -D feat-x')
    // local mode never touches the remote or a worktree.
    expect(joined.some((c) => c.includes('push origin'))).toBe(false)
    expect(joined.some((c) => c.includes('worktree'))).toBe(false)
    // never invokes gh at all.
    expect(joined.some((c) => c.startsWith('gh '))).toBe(false)
  })

  test('a failed local merge throws TridentMergeError (no branch delete)', async () => {
    const { host, calls } = recordingHost((cmd) => (cmd.includes('merge') ? fail('conflict') : ok()))
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await expect(
      cleanupAfterMerge(makeRun({ merge_mode: 'local', branch: 'feat-x', pr: null }), deps),
    ).rejects.toBeInstanceOf(TridentMergeError)
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('branch -D'))).toBe(false)
  })

  test('a null branch throws before any host call', async () => {
    const { host, calls } = recordingHost()
    const deps = buildMergeCleanupDeps(host)
    await expect(
      cleanupAfterMerge(makeRun({ merge_mode: 'local', branch: null }), deps),
    ).rejects.toBeInstanceOf(TridentMergeError)
    expect(calls).toHaveLength(0)
  })
})

describe('buildMergeCleanupDeps — local mode per-workspace serialization (Bug 1)', () => {
  // A `deferred` gate + a host that blocks the FIRST merge lets us observe
  // whether a SECOND concurrent merge on the same working tree interleaves.
  function gate(): { promise: Promise<void>; release: () => void } {
    let release!: () => void
    const promise = new Promise<void>((r) => {
      release = r
    })
    return { promise, release }
  }

  test('two concurrent local merges on the SAME repo_path serialize (second waits for the first)', async () => {
    const calls: string[] = []
    const firstMerge = gate()
    let merges = 0
    const host: RunHostCommand = async (cmd) => {
      calls.push(cmd.join(' '))
      if (cmd.includes('merge') && cmd.includes('--no-ff')) {
        merges += 1
        if (merges === 1) await firstMerge.promise // hold build A mid-merge
      }
      return ok()
    }
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const a = makeRun({ merge_mode: 'local', branch: 'feat-a', pr: null, repo_path: '/shared' })
    const b = makeRun({ merge_mode: 'local', branch: 'feat-b', pr: null, repo_path: '/shared' })

    const pA = cleanupAfterMerge(a, deps)
    const pB = cleanupAfterMerge(b, deps)
    // Let microtasks flush: A is now blocked mid-merge (having rebased feat-a onto
    // main first). B must NOT have begun ANY command — the lock serializes the
    // whole rebase+merge body, so no `feat-b` command appears yet.
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.some((c) => c.includes('feat-b'))).toBe(false)
    expect(calls.filter((c) => c.includes('merge --no-ff')).length).toBe(1)
    // A rebased its branch onto the latest base before merging (#342).
    expect(calls).toContain('git -C /shared checkout feat-a')
    expect(calls).toContain('git -C /shared rebase main')

    // Release A; B may now rebase feat-b onto the (now-updated) base + merge.
    firstMerge.release()
    await Promise.all([pA, pB])
    expect(calls.filter((c) => c.includes('merge --no-ff')).length).toBe(2)
    expect(calls).toContain('git -C /shared rebase main') // B rebased too
    expect(calls.some((c) => c.startsWith('git -C /shared merge --no-ff feat-b'))).toBe(true)
  })

  test('a failed first merge does NOT wedge the queue — the second still runs', async () => {
    const calls: string[] = []
    let merges = 0
    const host: RunHostCommand = async (cmd) => {
      calls.push(cmd.join(' '))
      if (cmd.includes('merge') && cmd.includes('--no-ff')) {
        merges += 1
        if (merges === 1) return fail('conflict') // A's merge fails
      }
      return ok()
    }
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const a = makeRun({ merge_mode: 'local', branch: 'feat-a', pr: null, repo_path: '/shared2' })
    const b = makeRun({ merge_mode: 'local', branch: 'feat-b', pr: null, repo_path: '/shared2' })

    const pA = cleanupAfterMerge(a, deps)
    const pB = cleanupAfterMerge(b, deps)
    await expect(pA).rejects.toBeInstanceOf(TridentMergeError)
    await pB // B is not blocked by A's failure
    expect(calls.some((c) => c.startsWith('git -C /shared2 merge --no-ff feat-b'))).toBe(true)
  })

  test('local merges on DIFFERENT repo_paths run in parallel (lock is per working tree)', async () => {
    const bothMerging = gate()
    let inMerge = 0
    const host: RunHostCommand = async (cmd) => {
      if (cmd.includes('merge') && cmd.includes('--no-ff')) {
        inMerge += 1
        await bothMerging.promise // both stay parked in-merge together
      }
      return ok()
    }
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const pA = cleanupAfterMerge(
      makeRun({ merge_mode: 'local', branch: 'feat-a', pr: null, repo_path: '/repoA' }),
      deps,
    )
    const pB = cleanupAfterMerge(
      makeRun({ merge_mode: 'local', branch: 'feat-b', pr: null, repo_path: '/repoB' }),
      deps,
    )
    await new Promise((r) => setTimeout(r, 10))
    // Distinct working trees → BOTH merges are in flight at once (no serialization).
    expect(inMerge).toBe(2)
    bothMerging.release()
    await Promise.all([pA, pB])
  })
})

describe('buildMergeCleanupDeps — local mode rebase-onto-latest + conflict resolution (#342)', () => {
  const localRun = (branch: string, repo = '/shared'): TridentRun =>
    makeRun({ merge_mode: 'local', branch, pr: null, repo_path: repo })

  test('rebases the branch onto the base BEFORE merging (clean case, no resolver call)', async () => {
    const { host, calls } = recordingHost()
    let resolverCalls = 0
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => {
        resolverCalls++
        return { resolved: true }
      },
    })
    await cleanupAfterMerge(localRun('feat-x'), deps)
    const joined = calls.map((c) => c.join(' '))
    // checkout the branch → rebase onto base → checkout base → merge.
    expect(joined).toContain('git -C /shared checkout feat-x')
    expect(joined).toContain('git -C /shared rebase main')
    expect(joined).toContain('git -C /shared checkout main')
    expect(joined.some((c) => c.startsWith('git -C /shared merge --no-ff feat-x'))).toBe(true)
    // A clean rebase never invokes the resolver.
    expect(resolverCalls).toBe(0)
  })

  test('FREES a lingering build worktree BEFORE checking the branch out (#342 regression)', async () => {
    const { host, calls } = recordingHost()
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    // The run row still carries its build worktree (inner cleanup missed it): the
    // branch is checked out there, so the rebase's `git checkout feat-x` in the
    // shared tree would fail "already checked out" unless we free it first.
    const run = makeRun({ merge_mode: 'local', branch: 'feat-x', pr: null, repo_path: '/shared', worktree: '/shared/.wt/feat-x' })
    await cleanupAfterMerge(run, deps)
    const joined = calls.map((c) => c.join(' '))
    const removeIdx = joined.findIndex((c) => c.includes('worktree remove --force /shared/.wt/feat-x'))
    const checkoutIdx = joined.findIndex((c) => c === 'git -C /shared checkout feat-x')
    expect(removeIdx).toBeGreaterThanOrEqual(0)
    expect(checkoutIdx).toBeGreaterThanOrEqual(0)
    // The worktree is freed strictly BEFORE the branch checkout.
    expect(removeIdx).toBeLessThan(checkoutIdx)
  })

  test('a rebase CONFLICT → the Forge resolver resolves it → rebase --continue → merge lands', async () => {
    const calls: string[] = []
    let rebasedOnce = false
    const host: RunHostCommand = async (cmd) => {
      const j = cmd.join(' ')
      calls.push(j)
      if (cmd.includes('rebase') && !cmd.includes('--continue') && !cmd.includes('--abort')) {
        if (!rebasedOnce) {
          rebasedOnce = true
          return fail('CONFLICT (content): Merge conflict in flush.ts')
        }
      }
      if (cmd.includes('diff') && cmd.includes('--diff-filter=U')) return ok('flush.ts')
      return ok()
    }
    const seen: string[][] = []
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async (input) => {
        seen.push(input.conflicted_files)
        return { resolved: true }
      },
    })
    await cleanupAfterMerge(localRun("feat-2"), deps)
    // The resolver was handed the exact conflicted files.
    expect(seen).toEqual([["flush.ts"]])
    const joined = calls
    expect(joined.some((c) => c.includes('rebase --continue'))).toBe(true)
    expect(joined.some((c) => c.startsWith('git -C /shared merge --no-ff feat-2'))).toBe(true)
    // It did NOT abort — the conflict was resolved, not escalated.
    expect(joined.some((c) => c.includes('rebase --abort'))).toBe(false)
  })

  test('an AMBIGUOUS conflict → resolver escalates → TridentMergeConflictEscalation (rebase aborted, no merge)', async () => {
    const calls: string[] = []
    const host: RunHostCommand = async (cmd) => {
      calls.push(cmd.join(' '))
      if (cmd.includes('rebase') && !cmd.includes('--continue') && !cmd.includes('--abort')) {
        return fail('CONFLICT (content): Merge conflict in flush.ts')
      }
      if (cmd.includes('diff') && cmd.includes('--diff-filter=U')) return ok('flush.ts')
      return ok()
    }
    const question = 'flush.ts: drop-oldest vs block-until-space — which behaviour do you want?'
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => ({ resolved: false, question }),
    })
    await expect(cleanupAfterMerge(localRun('feat-3'), deps)).rejects.toMatchObject({
      name: 'TridentMergeConflictEscalation',
      question,
    })
    const joined = calls
    expect(joined.some((c) => c.includes('rebase --abort'))).toBe(true)
    // Escalated → never merged, never deleted the branch.
    expect(joined.some((c) => c.includes('merge --no-ff'))).toBe(false)
    expect(joined.some((c) => c.includes('branch -D'))).toBe(false)
  })

  test('a conflict with NO resolver configured escalates to chat (never a silent hard-fail)', async () => {
    const host: RunHostCommand = async (cmd) => {
      if (cmd.includes('rebase') && !cmd.includes('--abort')) {
        return fail('CONFLICT (content): Merge conflict in x.ts')
      }
      if (cmd.includes('diff') && cmd.includes('--diff-filter=U')) return ok('x.ts')
      return ok()
    }
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' }) // no resolver
    await expect(cleanupAfterMerge(localRun('feat-4'), deps)).rejects.toMatchObject({
      name: 'TridentMergeConflictEscalation',
    })
  })

  test('THREE concurrent same-project builds each land in serialized order, 2nd/3rd rebase+resolve', async () => {
    // Simulate the #342 acceptance gate at the merge layer: 3 builds on ONE repo.
    // The first merges clean; the 2nd + 3rd hit a conflict when they replay onto
    // the prior merge, which the resolver fixes — all three must land.
    const calls: string[] = []
    const mergedBranches: string[] = []
    let mergeCount = 0
    const host: RunHostCommand = async (cmd) => {
      const j = cmd.join(' ')
      calls.push(j)
      if (cmd.includes('rebase') && !cmd.includes('--continue') && !cmd.includes('--abort')) {
        // The 2nd and 3rd builds conflict on their initial rebase (they replay
        // onto a prior merge); the 1st is a clean rebase.
        if (mergeCount >= 1) return fail('CONFLICT (content): Merge conflict in shared.ts')
      }
      if (cmd.includes('diff') && cmd.includes('--diff-filter=U')) return ok('shared.ts')
      if (cmd.includes('merge') && cmd.includes('--no-ff')) {
        mergeCount++
        mergedBranches.push(cmd[cmd.indexOf('--no-ff') + 1] ?? '?')
      }
      return ok()
    }
    let resolverCalls = 0
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => {
        resolverCalls++
        return { resolved: true }
      },
    })
    const runs = ['feat-a', 'feat-b', 'feat-c'].map((b) =>
      cleanupAfterMerge(localRun(b, '/proj'), deps),
    )
    await Promise.all(runs)
    // ALL THREE landed (none failed on a conflict), in serialized order.
    expect(mergeCount).toBe(3)
    expect(mergedBranches).toEqual(['feat-a', 'feat-b', 'feat-c'])
    // The 2nd + 3rd each needed the resolver (the 1st was a clean rebase).
    expect(resolverCalls).toBe(2)
  })
})
