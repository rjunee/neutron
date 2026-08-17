import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupAfterMerge } from './git-mode.ts'
import type { HostCommandResult } from './git-mode.ts'
import {
  buildMergeCleanupDeps,
  detectBaseBranch,
  reviewedHeadOid,
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
    inner_checkpoint_head: null,
    inner_checkpoint_findings: null,
    inner_verdict: null,
    inner_result: null,
    started_at: '2026-01-01T00:00:00.000Z',
    last_advanced_at: '2026-01-01T00:00:00.000Z',
    harvested_at: null,
    crash_recoveries: 0,
    infra_retries: 0,
    reviewed_head: null,
    bound_pr: null,
    fenced_paths: null,
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

/** A full (40-hex) OID — the only shape `--match-head-commit` accepts. */
const REVIEWED_HEAD = '0123456789abcdef0123456789abcdef01234567'

/** The typed terminal result the inner workflow writes into `inner_result`,
 *  carrying the head OID the reviewers judged (#545). */
function innerResult(reviewedHead: string | null): string {
  return JSON.stringify({
    ok: true,
    prNumber: 42,
    branch: 'feat-x',
    verdict: 'APPROVE',
    round: 1,
    checkpoint: 'argus-approved',
    ...(reviewedHead === null ? {} : { reviewedHead }),
  })
}

describe('buildMergeCleanupDeps — pr mode', () => {
  test('gh pr merge --squash pinned to the reviewed head, then delete remote + local branch (NO worktree remove)', async () => {
    const { host, calls } = recordingHost()
    const deps = buildMergeCleanupDeps(host)
    const res = await cleanupAfterMerge(
      makeRun({ merge_mode: 'pr', pr: 42, branch: 'feat-x', inner_result: innerResult(REVIEWED_HEAD) }),
      deps,
    )
    expect(res.performed).toBe(true)
    expect(res.mode).toBe('pr')

    const joined = calls.map((c) => c.join(' '))
    expect(joined).toContain(`gh pr merge 42 --squash --match-head-commit ${REVIEWED_HEAD}`)
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
      cleanupAfterMerge(makeRun({ merge_mode: 'pr', pr: 42, inner_result: innerResult(REVIEWED_HEAD) }), deps),
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

describe('#545 — the pr merge is PINNED to the reviewed commit', () => {
  // The observed failure (PR #171): the head moves between the APPROVE and the
  // merge. GitHub rejects a `--match-head-commit` that no longer matches, so the
  // merge must FAIL — never fall back to merging whatever is on the branch now.
  test('a head that MOVED after the review refuses to merge (no branch teardown)', async () => {
    const { host, calls } = recordingHost((cmd) =>
      cmd[0] === 'gh'
        ? fail('failed to merge pull request: Head branch was modified. Review and try the merge again.')
        : ok(),
    )
    const deps = buildMergeCleanupDeps(host)
    await expect(
      cleanupAfterMerge(
        makeRun({ merge_mode: 'pr', pr: 42, branch: 'feat-x', inner_result: innerResult(REVIEWED_HEAD) }),
        deps,
      ),
    ).rejects.toThrow(/Head branch was modified/)
    const joined = calls.map((c) => c.join(' '))
    // The merge was attempted PINNED (that is what made GitHub refuse) …
    expect(joined).toContain(`gh pr merge 42 --squash --match-head-commit ${REVIEWED_HEAD}`)
    // … and nothing was torn down / retried unpinned after the refusal.
    expect(joined.some((c) => c.includes('branch -D') || c.includes('--delete'))).toBe(false)
    expect(calls.filter((c) => c[0] === 'gh')).toHaveLength(1)
  })

  test('no recorded reviewed head → refuses to merge before any host call (fail-closed)', async () => {
    for (const inner_result of [null, innerResult(null), '{"ok":true,"verdict":"APPRO', 'null']) {
      const { host, calls } = recordingHost()
      const deps = buildMergeCleanupDeps(host)
      await expect(
        cleanupAfterMerge(makeRun({ merge_mode: 'pr', pr: 42, branch: 'feat-x', inner_result }), deps),
      ).rejects.toBeInstanceOf(TridentMergeError)
      expect(calls).toHaveLength(0)
    }
  })

  test('an ABBREVIATED sha is not a pin — refuses rather than merging unpinned', async () => {
    const { host, calls } = recordingHost()
    const deps = buildMergeCleanupDeps(host)
    await expect(
      cleanupAfterMerge(
        makeRun({ merge_mode: 'pr', pr: 42, inner_result: innerResult(REVIEWED_HEAD.slice(0, 12)) }),
        deps,
      ),
    ).rejects.toBeInstanceOf(TridentMergeError)
    expect(calls).toHaveLength(0)
  })

  test('reviewedHeadOid decodes the carried OID (and only a real one)', () => {
    const run = makeRun({ inner_result: innerResult(REVIEWED_HEAD.toUpperCase()) })
    // Case-normalised — git prints lowercase, but a carried uppercase OID is the
    // same commit and must still pin.
    expect(reviewedHeadOid(run)).toBe(REVIEWED_HEAD)
    expect(reviewedHeadOid(makeRun({ inner_result: innerResult('') }))).toBeNull()
    expect(reviewedHeadOid(makeRun({ inner_result: JSON.stringify({ reviewedHead: 42 }) }))).toBeNull()
    expect(reviewedHeadOid(makeRun({ inner_result: '   ' }))).toBeNull()
  })
})

// The dedicated per-run merge worktree path (mirrors merge.ts `runWorktreePath`).
const wtOf = (repo: string, run: TridentRun): string =>
  `${repo}/.trident-worktrees/${run.slug}-${run.id.slice(0, 8)}`

describe('buildMergeCleanupDeps — local mode', () => {
  test('rebases in an ISOLATED worktree, lands on base in the shared repo, tears the worktree down', async () => {
    const { host, calls } = recordingHost((cmd) =>
      // `merge --abort` / `rebase --abort` are the recoverStaleGitState probes: a
      // CLEAN repo fails them (nothing in progress), so return non-ok for those.
      cmd.includes('--abort') ? fail('no operation in progress') : ok(),
    )
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const run = makeRun({ merge_mode: 'local', branch: 'feat-x', pr: null, repo_path: '/repo' })
    const wt = wtOf('/repo', run)
    const res = await cleanupAfterMerge(run, deps)
    expect(res.performed).toBe(true)
    expect(res.mode).toBe('local')

    const joined = calls.map((c) => c.join(' '))
    // The branch is checked out + rebased INSIDE the dedicated worktree (NOT the
    // shared checkout) — a failed rebase there can never poison the shared repo.
    expect(joined).toContain(`git -C /repo worktree add --detach --force ${wt} main`)
    expect(joined).toContain(`git -C ${wt} checkout feat-x`)
    expect(joined).toContain(`git -C ${wt} rebase main`)
    // The LAND (checkout base + no-ff merge) happens in the shared repo.
    expect(joined).toContain('git -C /repo checkout main')
    expect(joined.some((c) => c.startsWith('git -C /repo merge --no-ff feat-x'))).toBe(true)
    expect(joined).toContain('git -C /repo branch -D feat-x')
    // The worktree is torn down + never touches the remote / gh.
    expect(joined.some((c) => c.includes(`worktree remove ${wt}`))).toBe(true)
    expect(joined.some((c) => c.includes('push origin'))).toBe(false)
    expect(joined.some((c) => c.startsWith('gh '))).toBe(false)
  })

  test('DEFENSIVE stale-state recovery runs BEFORE the merge starts (FIX 2)', async () => {
    // A poisoned repo: `merge --abort` SUCCEEDS (a merge WAS in progress) → the
    // recovery hard-resets before any rebase/land touches the tree.
    const { host, calls } = recordingHost((cmd) =>
      cmd.includes('rebase') && cmd.includes('--abort') ? fail('no rebase') : ok(),
    )
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const run = makeRun({ merge_mode: 'local', branch: 'feat-x', pr: null, repo_path: '/repo' })
    await cleanupAfterMerge(run, deps)
    const joined = calls.map((c) => c.join(' '))
    const abortIdx = joined.indexOf('git -C /repo merge --abort')
    const resetIdx = joined.indexOf('git -C /repo reset --hard')
    const mergeIdx = joined.findIndex((c) => c.startsWith('git -C /repo merge --no-ff'))
    expect(abortIdx).toBeGreaterThanOrEqual(0)
    expect(resetIdx).toBeGreaterThan(abortIdx) // aborted → hard-reset
    expect(resetIdx).toBeLessThan(mergeIdx) // recovery precedes the land
  })

  test('a failed local merge throws TridentMergeError (no branch delete) + tears the worktree down', async () => {
    const { host, calls } = recordingHost((cmd) =>
      // Fail ONLY the final no-ff land; the abort probes fail (clean repo).
      cmd.includes('merge') && cmd.includes('--no-ff')
        ? fail('conflict')
        : cmd.includes('--abort')
          ? fail('nothing to abort')
          : ok(),
    )
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const run = makeRun({ merge_mode: 'local', branch: 'feat-x', pr: null, repo_path: '/repo' })
    const wt = wtOf('/repo', run)
    await expect(cleanupAfterMerge(run, deps)).rejects.toBeInstanceOf(TridentMergeError)
    const joined = calls.map((c) => c.join(' '))
    expect(joined.some((c) => c.includes('branch -D'))).toBe(false)
    // Even on failure the worktree is cleaned up (the `finally`).
    expect(joined.some((c) => c.includes(`worktree remove ${wt}`))).toBe(true)
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
    // Distinct ids → DISTINCT isolated worktree paths (the isolation invariant).
    const a = makeRun({ id: 'aaaaaaaa', merge_mode: 'local', branch: 'feat-a', pr: null, repo_path: '/shared' })
    const b = makeRun({ id: 'bbbbbbbb', merge_mode: 'local', branch: 'feat-b', pr: null, repo_path: '/shared' })

    const pA = cleanupAfterMerge(a, deps)
    const pB = cleanupAfterMerge(b, deps)
    // Let microtasks flush: A is now blocked mid-merge (having rebased feat-a onto
    // main first). B must NOT have begun ANY command — the lock serializes the
    // whole recover+provision+rebase+land body, so no `feat-b` command appears yet.
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.some((c) => c.includes('feat-b'))).toBe(false)
    expect(calls.filter((c) => c.includes('merge --no-ff')).length).toBe(1)
    // A rebased its branch onto the latest base IN ITS OWN worktree before merging.
    expect(calls).toContain(`git -C ${wtOf('/shared', a)} checkout feat-a`)
    expect(calls).toContain(`git -C ${wtOf('/shared', a)} rebase main`)

    // Release A; B may now rebase feat-b onto the (now-updated) base + merge.
    firstMerge.release()
    await Promise.all([pA, pB])
    expect(calls.filter((c) => c.includes('merge --no-ff')).length).toBe(2)
    expect(calls).toContain(`git -C ${wtOf('/shared', b)} rebase main`) // B rebased in its OWN worktree
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
    const a = makeRun({ id: 'aaaaaaaa', merge_mode: 'local', branch: 'feat-a', pr: null, repo_path: '/shared2' })
    const b = makeRun({ id: 'bbbbbbbb', merge_mode: 'local', branch: 'feat-b', pr: null, repo_path: '/shared2' })

    const pA = cleanupAfterMerge(a, deps)
    const pB = cleanupAfterMerge(b, deps)
    await expect(pA).rejects.toBeInstanceOf(TridentMergeError)
    await pB // B is not blocked by A's failure
    expect(calls.some((c) => c.startsWith('git -C /shared2 merge --no-ff feat-b'))).toBe(true)
  })

  test('local merges on DIFFERENT repo_paths run in parallel (lock is per base repo)', async () => {
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
      makeRun({ id: 'aaaaaaaa', merge_mode: 'local', branch: 'feat-a', pr: null, repo_path: '/repoA' }),
      deps,
    )
    const pB = cleanupAfterMerge(
      makeRun({ id: 'bbbbbbbb', merge_mode: 'local', branch: 'feat-b', pr: null, repo_path: '/repoB' }),
      deps,
    )
    await new Promise((r) => setTimeout(r, 10))
    // Distinct base repos → BOTH merges are in flight at once (no serialization).
    expect(inMerge).toBe(2)
    bothMerging.release()
    await Promise.all([pA, pB])
  })
})

describe('buildMergeCleanupDeps — local mode rebase-onto-latest + conflict resolution (#342)', () => {
  const localRun = (branch: string, repo = '/shared', id = branch): TridentRun =>
    makeRun({ id, merge_mode: 'local', branch, pr: null, repo_path: repo })

  test('rebases the branch onto the base IN ITS WORKTREE before merging (clean case, no resolver call)', async () => {
    const { host, calls } = recordingHost()
    let resolverCalls = 0
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => {
        resolverCalls++
        return { resolved: true }
      },
    })
    const run = localRun('feat-x')
    const wt = wtOf('/shared', run)
    await cleanupAfterMerge(run, deps)
    const joined = calls.map((c) => c.join(' '))
    // checkout+rebase in the isolated worktree → checkout base + merge in shared repo.
    expect(joined).toContain(`git -C ${wt} checkout feat-x`)
    expect(joined).toContain(`git -C ${wt} rebase main`)
    expect(joined).toContain('git -C /shared checkout main')
    expect(joined.some((c) => c.startsWith('git -C /shared merge --no-ff feat-x'))).toBe(true)
    // A clean rebase never invokes the resolver.
    expect(resolverCalls).toBe(0)
  })

  test('FREES a lingering build worktree holding the branch BEFORE the merge worktree checks it out', async () => {
    // A lingering build worktree (inner cleanup missed it) still has feat-x checked
    // out; the merge worktree's `git checkout feat-x` would fail "already checked
    // out" unless we free it first. `worktree list --porcelain` surfaces it.
    const stray = '/shared/.wt/stray-feat-x'
    const host: RunHostCommand = async (cmd) => {
      if (cmd.includes('worktree') && cmd.includes('list')) {
        return ok(`worktree /shared\nHEAD main0\nbranch refs/heads/main\n\nworktree ${stray}\nHEAD abc\nbranch refs/heads/feat-x\n`)
      }
      return ok()
    }
    const calls: string[] = []
    const recording: RunHostCommand = async (cmd) => {
      calls.push(cmd.join(' '))
      return host(cmd)
    }
    const deps = buildMergeCleanupDeps(recording, { base_branch: 'main' })
    const run = localRun('feat-x')
    const wt = wtOf('/shared', run)
    await cleanupAfterMerge(run, deps)
    const joined = calls
    const freeIdx = joined.findIndex((c) => c.includes(`worktree remove ${stray}`))
    const checkoutIdx = joined.findIndex((c) => c === `git -C ${wt} checkout feat-x`)
    expect(freeIdx).toBeGreaterThanOrEqual(0)
    expect(checkoutIdx).toBeGreaterThanOrEqual(0)
    // The stray worktree is freed strictly BEFORE the merge worktree's checkout.
    expect(freeIdx).toBeLessThan(checkoutIdx)
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
    await cleanupAfterMerge(localRun('feat-2'), deps)
    // The resolver was handed the exact conflicted files.
    expect(seen).toEqual([['flush.ts']])
    const joined = calls
    expect(joined.some((c) => c.includes('rebase --continue'))).toBe(true)
    expect(joined.some((c) => c.startsWith('git -C /shared merge --no-ff feat-2'))).toBe(true)
    // It did NOT abort the ACTUAL rebase — the conflict was resolved, not escalated.
    // (recoverStaleGitState's own `rebase --abort` probe is separate + expected.)
    const wt = wtOf('/shared', localRun('feat-2'))
    expect(joined.some((c) => c === `git -C ${wt} rebase --abort`)).toBe(false)
  })

  test('an AMBIGUOUS conflict → resolver escalates → TridentMergeConflictEscalation (rebase aborted, no merge)', async () => {
    const run = localRun('feat-3')
    const wt = wtOf('/shared', run)
    const calls: string[] = []
    const host: RunHostCommand = async (cmd) => {
      calls.push(cmd.join(' '))
      // The build's own rebase (in its worktree) conflicts; recoverStaleGitState's
      // abort probes (in the shared repo) must stay out of this branch.
      if (
        cmd.includes(wt) &&
        cmd.includes('rebase') &&
        !cmd.includes('--continue') &&
        !cmd.includes('--abort')
      ) {
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
    await expect(cleanupAfterMerge(run, deps)).rejects.toMatchObject({
      name: 'TridentMergeConflictEscalation',
      question,
    })
    const joined = calls
    // The build's rebase was aborted in its own worktree.
    expect(joined.some((c) => c === `git -C ${wt} rebase --abort`)).toBe(true)
    // Escalated → never merged, never deleted the branch. The worktree is torn down.
    expect(joined.some((c) => c.includes('merge --no-ff'))).toBe(false)
    expect(joined.some((c) => c.includes('branch -D'))).toBe(false)
    expect(joined.some((c) => c.includes(`worktree remove ${wt}`))).toBe(true)
  })

  test('a conflict with NO resolver configured escalates to chat (never a silent hard-fail)', async () => {
    const run = localRun('feat-4')
    const wt = wtOf('/shared', run)
    const host: RunHostCommand = async (cmd) => {
      if (cmd.includes(wt) && cmd.includes('rebase') && !cmd.includes('--abort')) {
        return fail('CONFLICT (content): Merge conflict in x.ts')
      }
      if (cmd.includes('diff') && cmd.includes('--diff-filter=U')) return ok('x.ts')
      return ok()
    }
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' }) // no resolver
    await expect(cleanupAfterMerge(run, deps)).rejects.toMatchObject({
      name: 'TridentMergeConflictEscalation',
    })
  })

  test('THREE concurrent same-project builds each land in serialized order, 2nd/3rd rebase+resolve', async () => {
    // Simulate the #342 acceptance gate at the merge layer: 3 builds on ONE repo.
    // The first merges clean; the 2nd + 3rd hit a conflict when they replay onto
    // the prior merge, which the resolver fixes — all three must land. Each build
    // rebases in its OWN worktree (distinct ids → distinct worktree paths).
    const calls: string[] = []
    const mergedBranches: string[] = []
    let mergeCount = 0
    const host: RunHostCommand = async (cmd) => {
      const j = cmd.join(' ')
      calls.push(j)
      // Only the build's OWN rebase (in a .trident-worktrees/ worktree) may conflict;
      // the recoverStaleGitState abort probes (shared repo) are never conflicts.
      if (
        cmd.some((a) => a.includes('.trident-worktrees')) &&
        cmd.includes('rebase') &&
        !cmd.includes('--continue') &&
        !cmd.includes('--abort')
      ) {
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
    const runs = [
      ['feat-a', 'aaaaaaaa'],
      ['feat-b', 'bbbbbbbb'],
      ['feat-c', 'cccccccc'],
    ].map(([b, id]) => cleanupAfterMerge(localRun(b!, '/proj', id!), deps))
    await Promise.all(runs)
    // ALL THREE landed (none failed on a conflict), in serialized order.
    expect(mergeCount).toBe(3)
    expect(mergedBranches).toEqual(['feat-a', 'feat-b', 'feat-c'])
    // The 2nd + 3rd each needed the resolver (the 1st was a clean rebase).
    expect(resolverCalls).toBe(2)
    // Each build used its OWN distinct worktree (the isolation invariant): 3
    // distinct `worktree add` commands, one per run id.
    const adds = calls.filter((c) => c.includes('worktree add --detach --force'))
    const addedPaths = new Set(adds.map((c) => c.match(/--force (\S+) main$/)?.[1])) // the <path> arg
    expect(addedPaths.size).toBe(3)
    for (const id of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']) {
      expect(adds.some((c) => c.includes(`/proj/.trident-worktrees/s-${id} main`))).toBe(true)
    }
  })
})

// ISSUES #541 — the OUTER twin of the inner workflow's force-removing cleanup.
// `git worktree remove --force` from a cleanup path destroyed 197 insertions
// across 7 files on PR #171, so every removal in merge.ts is now gated on the
// tree being PROVABLY clean (untracked files included) and none of them may pass
// `--force`. These tests use a REAL temp directory as the worktree path, because
// the dirty probe is skipped for a path that does not exist (nothing to preserve).
describe('merge.ts — a DIRTY worktree is preserved, never force-removed (#541)', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })
  const realDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'trident-merge-wt-'))
    dirs.push(d)
    return d
  }
  /** A host whose `status --porcelain` reports `dirt` for `wt` (empty = clean),
   *  and whose `rev-parse --show-toplevel` confirms `wt` IS a worktree root —
   *  the guard that stops a plain directory inheriting the enclosing repo's dirt.
   *  Pass a different `toplevel` to play the plain-directory case. */
  const hostWithDirt = (wt: string, dirt: string, toplevel: string = wt) =>
    recordingHost((cmd) =>
      cmd.includes('--show-toplevel') && cmd.includes(wt)
        ? ok(`${toplevel}\n`)
        : cmd.includes('status') && cmd.includes(wt)
          ? ok(dirt)
          : cmd.includes('--abort')
            ? fail()
            : ok(),
    )

  test('post-merge cleanup PRESERVES a dirty run.worktree (untracked files count)', async () => {
    const wt = realDir()
    // Untracked-only: the exact shape #541 lost, and the shape a bare
    // `git status --porcelain` (no -uall) would have called clean.
    const { host, calls } = hostWithDirt(wt, '?? brand-new.ts\n')
    const deps = buildMergeCleanupDeps(host)
    await cleanupAfterMerge(
      makeRun({
        merge_mode: 'pr',
        pr: 42,
        branch: 'feat-x',
        worktree: wt,
        inner_result: innerResult(REVIEWED_HEAD),
      }),
      deps,
    )
    const joined = calls.map((c) => c.join(' '))
    // The merge still happened; the worktree simply survived it.
    expect(joined).toContain(`gh pr merge 42 --squash --match-head-commit ${REVIEWED_HEAD}`)
    expect(joined).toContain(`git -C ${wt} status --porcelain --untracked-files=all`)
    expect(joined.some((c) => c.includes('worktree remove'))).toBe(false)
    expect(joined.some((c) => c.includes('worktree prune'))).toBe(false)
  })

  test('post-merge cleanup still removes a CLEAN run.worktree — WITHOUT --force', async () => {
    const wt = realDir()
    const { host, calls } = hostWithDirt(wt, '')
    const deps = buildMergeCleanupDeps(host)
    await cleanupAfterMerge(
      makeRun({
        merge_mode: 'pr',
        pr: 42,
        branch: 'feat-x',
        worktree: wt,
        inner_result: innerResult(REVIEWED_HEAD),
      }),
      deps,
    )
    const joined = calls.map((c) => c.join(' '))
    expect(joined).toContain(`git -C /repo worktree remove ${wt}`)
    expect(joined).toContain('git -C /repo worktree prune')
    expect(joined.some((c) => c.includes('--force'))).toBe(false)
  })

  test('a worktree whose status probe FAILS counts as dirty (unverifiable → preserve)', async () => {
    const wt = realDir()
    const { host, calls } = recordingHost((cmd) =>
      cmd.includes('--show-toplevel') && cmd.includes(wt)
        ? ok(`${wt}\n`)
        : cmd.includes('status') && cmd.includes(wt)
          ? fail('not a git repository')
          : ok(),
    )
    const deps = buildMergeCleanupDeps(host)
    await cleanupAfterMerge(
      makeRun({
        merge_mode: 'pr',
        pr: 42,
        branch: 'feat-x',
        worktree: wt,
        inner_result: innerResult(REVIEWED_HEAD),
      }),
      deps,
    )
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('worktree remove'))).toBe(false)
  })

  test('a directory git cannot CLASSIFY at all counts as dirty (rev-parse silence ≠ "not ours")', async () => {
    // The other half of the worktree-root guard. "git says this directory belongs
    // to some other repo" is evidence; "git could not tell me anything" is not,
    // and the difference decides whether an existing directory is removable. Only
    // the `existsSync` gate above it may answer null — a path that is GONE has no
    // working tree to preserve, only a stale admin entry for `prune`.
    const wt = realDir()
    const { host, calls } = recordingHost((cmd) =>
      cmd.includes('--show-toplevel') && cmd.includes(wt) ? fail('not a git repository') : ok(),
    )
    const deps = buildMergeCleanupDeps(host)
    await cleanupAfterMerge(
      makeRun({
        merge_mode: 'pr',
        pr: 42,
        branch: 'feat-x',
        worktree: wt,
        inner_result: innerResult(REVIEWED_HEAD),
      }),
      deps,
    )
    const joined = calls.map((c) => c.join(' '))
    expect(joined.some((c) => c.includes('worktree remove'))).toBe(false)
    // …and it never fell through to a status probe it had no right to trust.
    expect(joined.some((c) => c.includes(`git -C ${wt} status`))).toBe(false)
  })

  test('a worktree path that does NOT EXIST is not "unverifiable" — it is simply gone', async () => {
    // Pinned because it is the only thing making the `existsSync` gate load-bearing
    // now that rev-parse silence preserves: without it, a pruned/never-created path
    // would report as precious work and wedge the merge on nothing at all.
    const gone = join(tmpdir(), `trident-merge-absent-${Math.random().toString(36).slice(2)}`)
    const { host, calls } = recordingHost((cmd) =>
      cmd.includes('--show-toplevel') || cmd.includes('status') ? fail('not a git repository') : ok(),
    )
    const deps = buildMergeCleanupDeps(host)
    await cleanupAfterMerge(
      makeRun({
        merge_mode: 'pr',
        pr: 42,
        branch: 'feat-x',
        worktree: gone,
        inner_result: innerResult(REVIEWED_HEAD),
      }),
      deps,
    )
    const joined = calls.map((c) => c.join(' '))
    // Treated as removable: the removal was ATTEMPTED (and its failure swallowed),
    // which is the "nothing to preserve" path, not the preserve path.
    expect(joined).toContain(`git -C /repo worktree remove ${gone}`)
    expect(joined.some((c) => c.includes('--show-toplevel'))).toBe(false)
  })

  test('a PLAIN DIRECTORY at the worktree path is NOT precious — it inherits nothing', async () => {
    // `git -C <dir> status` WALKS UP to the enclosing repo, so a leftover plain
    // directory inside the checkout (a crashed `worktree add`) reports the SHARED
    // checkout's dirt as its own. Without the `--show-toplevel === wt` guard an
    // EMPTY directory looks like precious work and fails every merge from then on.
    const wt = realDir()
    const run = makeRun({ merge_mode: 'local', branch: 'feat-x', pr: null, repo_path: '/repo', worktree: wt })
    // toplevel is the PARENT repo, not `wt` → not a worktree root.
    const { host, calls } = hostWithDirt(wt, '?? someone-elses-work.ts\n', '/repo')
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await cleanupAfterMerge(run, deps)
    const joined = calls.map((c) => c.join(' '))
    // Provisioning proceeded: no bogus "refusing to reuse" throw, and the merge landed.
    expect(joined.some((c) => c.includes(`worktree add --detach --force ${wt}`))).toBe(true)
    expect(joined.some((c) => c.includes('merge --no-ff'))).toBe(true)
    // The parent repo's status was never even consulted for the verdict.
    expect(joined.some((c) => c.includes(`git -C ${wt} status`))).toBe(false)
  })

  test('a DIRTY stale merge worktree FAILS the merge loudly instead of being force-removed', async () => {
    // Provisioning reuses a deterministic per-run path. A dirty tree there may hold
    // a half-finished conflict resolution; the merge must stop, naming the path.
    const wt = realDir()
    const run = makeRun({
      merge_mode: 'local',
      branch: 'feat-x',
      pr: null,
      repo_path: '/repo',
      worktree: wt,
    })
    const { host, calls } = hostWithDirt(wt, ' M resolved.ts\n')
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await expect(cleanupAfterMerge(run, deps)).rejects.toThrow(/uncommitted changes that exist nowhere else/)
    const joined = calls.map((c) => c.join(' '))
    expect(joined.some((c) => c.includes('worktree remove'))).toBe(false)
    // It never got as far as merging or deleting the branch.
    expect(joined.some((c) => c.includes('merge --no-ff'))).toBe(false)
    expect(joined.some((c) => c.includes('branch -D'))).toBe(false)
  })

  test('a DIRTY lingering BUILD worktree on the branch is left alone by freeBranchFromWorktrees', async () => {
    const stray = realDir()
    const run = makeRun({ merge_mode: 'local', branch: 'feat-x', pr: null, repo_path: '/shared' })
    const { host, calls } = recordingHost((cmd) => {
      if (cmd.includes('worktree') && cmd.includes('list')) {
        return ok(`worktree /shared\nHEAD main0\nbranch refs/heads/main\n\nworktree ${stray}\nHEAD abc\nbranch refs/heads/feat-x\n`)
      }
      if (cmd.includes('--show-toplevel') && cmd.includes(stray)) return ok(`${stray}\n`)
      if (cmd.includes('status') && cmd.includes(stray)) return ok('?? forge-was-mid-edit.ts\n')
      if (cmd.includes('--abort')) return fail()
      return ok()
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    // The failure NAMES the preservation, in the operator's words. Previously this
    // came out three calls later as git's own "already checked out at <path>" —
    // which reads like a trident bug, not "your work is safe, and it is HERE".
    await expect(cleanupAfterMerge(run, deps)).rejects.toThrow(
      /trident PRESERVED uncommitted work/,
    )
    await expect(cleanupAfterMerge(run, deps)).rejects.toThrow(new RegExp(stray))
    const joined = calls.map((c) => c.join(' '))
    // The stray build worktree — the one the inner cleanup preserved — survives.
    expect(joined.some((c) => c.includes(`worktree remove ${stray}`))).toBe(false)
    expect(joined.some((c) => c.includes('--force') && c.includes(stray))).toBe(false)
    // …and the merge stopped there rather than blundering into `git checkout`.
    expect(joined.some((c) => c.includes('merge --no-ff'))).toBe(false)
    expect(joined.some((c) => c.includes('branch -D'))).toBe(false)
  })

  test('a CLEAN lingering build worktree is freed and the merge proceeds (no false alarm)', async () => {
    const stray = realDir()
    const run = makeRun({ merge_mode: 'local', branch: 'feat-x', pr: null, repo_path: '/shared' })
    let removed = false
    const { host, calls } = recordingHost((cmd) => {
      if (cmd.includes('worktree') && cmd.includes('list')) {
        return removed
          ? ok(`worktree /shared\nHEAD main0\nbranch refs/heads/main\n`)
          : ok(`worktree /shared\nHEAD main0\nbranch refs/heads/main\n\nworktree ${stray}\nHEAD abc\nbranch refs/heads/feat-x\n`)
      }
      if (cmd.includes('--show-toplevel') && cmd.includes(stray)) return ok(`${stray}\n`)
      if (cmd.includes('status') && cmd.includes(stray)) return ok('')
      if (cmd.includes('worktree') && cmd.includes('remove') && cmd.includes(stray)) {
        removed = true
        return ok()
      }
      if (cmd.includes('--abort')) return fail()
      return ok()
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await cleanupAfterMerge(run, deps)
    const joined = calls.map((c) => c.join(' '))
    expect(joined.some((c) => c === `git -C /shared worktree remove ${stray}`)).toBe(true)
    expect(joined.some((c) => c.includes('merge --no-ff'))).toBe(true)
  })

  test('a host that THROWS on the removal preserves the tree — a throw is not a removal either', async () => {
    // Sibling of "a refused removal is not a removal". `removeWorktreePath` caught
    // EVERY exception and returned null, which means "removed/absent" to
    // provisioning — so a host that threw on `git worktree remove` sent the merge
    // straight on to `worktree add --force` over a tree still sitting on disk, and
    // the preservation error this function promises never fired.
    const stray = realDir() // exists on disk: the tree survived the throw
    const run = makeRun({ merge_mode: 'local', branch: 'feat-x', pr: null, repo_path: '/shared' })
    const calls: string[] = []
    const host: RunHostCommand = async (cmd) => {
      calls.push(cmd.join(' '))
      if (cmd.includes('worktree') && cmd.includes('list')) {
        return ok(`worktree /shared\nHEAD m0\nbranch refs/heads/main\n\nworktree ${stray}\nHEAD abc\nbranch refs/heads/feat-x\n`)
      }
      if (cmd.includes('--show-toplevel') && cmd.includes(stray)) return ok(`${stray}\n`)
      if (cmd.includes('status') && cmd.includes(stray)) return ok('') // provably CLEAN
      if (cmd.includes('worktree') && cmd.includes('remove')) throw new Error('spawn EAGAIN')
      if (cmd.includes('--abort')) return fail()
      return ok()
    }
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    // The merge is REFUSED, naming the path — not silently carried past it.
    await expect(cleanupAfterMerge(run, deps)).rejects.toThrow(/PRESERVED uncommitted work/)
    await expect(cleanupAfterMerge(run, deps)).rejects.toThrow(new RegExp(stray))
    // BEHAVIOUR: it never blundered on into provisioning or the merge itself.
    expect(calls.some((c) => c.includes('worktree add'))).toBe(false)
    expect(calls.some((c) => c.includes('merge --no-ff'))).toBe(false)
    expect(existsSync(stray)).toBe(true)
  })

  test('the SHARED CHECKOUT parked on the branch is SKIPPED, not scored as preserved work', async () => {
    // The shell twin skips the main working tree (`n > 1`); merge.ts did not. git
    // refuses `worktree remove` on a main working tree ("is a main working tree")
    // and that path IS its own `--show-toplevel`, so the refusal used to read as a
    // PRESERVED worktree and threw — failing the merge over a shared checkout with
    // no uncommitted work in it at all. That is the "cry wolf" direction: the gate
    // fires on a run that preserved nothing, and it does so on EVERY retry.
    const run = makeRun({ merge_mode: 'local', branch: 'feat-x', pr: null, repo_path: '/shared' })
    const { host, calls } = recordingHost((cmd) => {
      if (cmd.includes('worktree') && cmd.includes('list')) {
        // Realistic porcelain: the main worktree is FIRST, and it is on feat-x.
        return ok(`worktree /shared\nHEAD abc\nbranch refs/heads/feat-x\n`)
      }
      // Were it ever probed/removed, git would answer exactly this.
      if (cmd.includes('--show-toplevel') && cmd.includes('/shared')) return ok('/shared\n')
      if (cmd.includes('worktree') && cmd.includes('remove')) {
        return fail("fatal: '/shared' is a main working tree")
      }
      if (cmd.includes('--abort')) return fail()
      return ok()
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    // BEHAVIOUR, not bookkeeping: the merge actually completes…
    await cleanupAfterMerge(run, deps)
    const joined = calls.map((c) => c.join(' '))
    expect(joined.some((c) => c.includes('merge --no-ff'))).toBe(true)
    // …and the shared checkout was never even offered to `worktree remove`.
    // Not removed — forced or otherwise. (The `worktree remove`/`add --force` calls
    // that DO appear target the run's own merge worktree, a different path.)
    expect(joined.some((c) => /worktree remove (--force )?\/shared$/.test(c))).toBe(false)
    // It was SKIPPED, not probed-and-spared: `worktreeDirt` never even ran on it.
    expect(joined.some((c) => c === 'git -C /shared rev-parse --show-toplevel')).toBe(false)
  })
})
