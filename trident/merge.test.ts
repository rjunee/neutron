import { describe, expect, test } from 'bun:test'
import { cleanupAfterMerge } from './git-mode.ts'
import type { HostCommandResult } from './git-mode.ts'
import {
  assessBaseDrift,
  baseDriftHoldMessage,
  buildMergeCleanupDeps,
  detectBaseBranch,
  reviewedHeadOid,
  shouldHoldForBaseDrift,
  TridentBaseDriftHold,
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
    harvested_at: null,
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

/**
 * A healthy, DRIFT-FREE repo as far as the #542 gate is concerned: every ref
 * resolves and the fork point IS the base tip. Tests about OTHER behaviour need
 * this because pr mode now holds when it cannot assess drift at all, and a host
 * that answers `rev-parse` with an empty string is exactly that case.
 */
const NO_DRIFT_SHA = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f'
const noDrift = (cmd: string[]): HostCommandResult | null =>
  (cmd.includes('rev-parse') && cmd.includes('--verify')) || cmd.includes('merge-base')
    ? ok(NO_DRIFT_SHA)
    : null

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
    const { host, calls } = recordingHost((cmd) => noDrift(cmd) ?? ok())
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
    const { host, calls } = recordingHost(
      (cmd) => noDrift(cmd) ?? (cmd.includes('merge') && cmd.includes('pr') ? fail('merge conflict') : ok()),
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
    const { host, calls } = recordingHost(
      (cmd) =>
        noDrift(cmd) ??
        (cmd[0] === 'gh'
          ? fail('failed to merge pull request: Head branch was modified. Review and try the merge again.')
          : ok()),
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
    expect(joined.some((c) => c.includes(`worktree remove --force ${wt}`))).toBe(true)
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
    expect(joined.some((c) => c.includes(`worktree remove --force ${wt}`))).toBe(true)
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
        return ok(`worktree ${stray}\nHEAD abc\nbranch refs/heads/feat-x\n`)
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
    const freeIdx = joined.findIndex((c) => c.includes(`worktree remove --force ${stray}`))
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
    expect(joined.some((c) => c.includes(`worktree remove --force ${wt}`))).toBe(true)
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

// ---------------------------------------------------------------------------
// BASE-DRIFT HOLD (ISSUES #542)
// ---------------------------------------------------------------------------

/**
 * A host that answers the drift probes with a scripted repo shape and behaves
 * like a clean repo for everything else (the `--abort` probes fail, as on a
 * repo with nothing in progress).
 */
function driftHost(shape: {
  base: string
  branch: string
  /** The fork point — what the reviewed diff was computed against. */
  review_base: string
  /** Where the base tip is NOW. Equal to `review_base` ⇒ no drift. */
  current_base: string
  branch_head?: string
  /** Files the base changed since `review_base`. */
  base_touched?: string[]
  /** Files the reviewed diff changes. */
  reviewed_files?: string[]
  /** Files the rebase raises a textual conflict on, ONE ENTRY PER ROUND. A
   *  single-element list is the common "conflicts once, then clean" shape. */
  rebase_conflicts?: string[]
  /** Multi-round form of `rebase_conflicts`: round N conflicts on rounds[N]. */
  conflict_rounds?: string[][]
  /** How many branch commits touch each path (`git log <base>..<head> -- path`).
   *  Defaults to 1 — a path the branch touched in exactly one commit. The shas
   *  reported are `commitSha(0…n-1)`, the same identities `REBASE_HEAD` reports. */
  commits_touching?: Record<string, number>
  /** Which branch commit each rebase round is REPLAYING, as an index into
   *  `commitSha`. Defaults to round N replaying commit N-1 (git's normal
   *  one-commit-per-round march). Repeating an index models the round that
   *  re-offers the SAME commit — e.g. a resolver that edited but never staged,
   *  so `--continue` refused and git re-reported the identical conflict. `null`
   *  models a `REBASE_HEAD` that will not resolve. */
  rebase_head_rounds?: (number | null)[]
  /** The tip of `origin/<branch>` — the head GitHub would actually merge. Left
   *  unset it equals the local branch head; setting it models a checkout whose
   *  local copy of the branch is stale (or absent, via `unresolvable`). */
  remote_branch_head?: string
  /** Refs that fail to resolve. Independent of `break_merge_base`, so each
   *  fail-open cause can be exercised on its own. */
  unresolvable?: string[]
  /** Make `git merge-base` fail (fork point unknown) WITHOUT breaking any ref. */
  break_merge_base?: boolean
  /** Make `git log … -- <path>` fail (commit count unknown). */
  break_log?: boolean
  /** Make `git diff --name-only <a> <b>` fail (materiality unassessable). */
  break_diff?: boolean
  /** Make `git fetch origin <base>` fail (the base tip cannot be refreshed). */
  break_fetch?: boolean
  /** `gh pr view … headRefName` answer; null makes it fail. */
  pr_head_branch?: string | null
  /** Refuse to move the branch ref back (the restore-verification failure). */
  break_branch_restore?: boolean
}): { host: RunHostCommand; calls: string[] } {
  const calls: string[] = []
  const branchHead = shape.branch_head ?? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const remoteBranchHead = shape.remote_branch_head ?? branchHead
  const rounds = shape.conflict_rounds ?? (shape.rebase_conflicts ? [shape.rebase_conflicts] : [])
  // The branch ref as the fake repo holds it: the rebase MOVES it to the base
  // tip, and a restore moves it back — so a test can see whether the hold left
  // the branch where the review found it.
  let branchRef = branchHead
  let round = 0
  const host: RunHostCommand = async (cmd) => {
    calls.push(cmd.join(' '))
    if (cmd.includes('rev-parse') && cmd.includes('--verify')) {
      const ref = (cmd[cmd.length - 1] ?? '').replace('^{commit}', '')
      if ((shape.unresolvable ?? []).includes(ref)) return fail('unknown revision')
      // `REBASE_HEAD` names the ORIGINAL branch commit git is replaying right
      // now — the identity the #542 coverage check matches `git log` against.
      if (ref === 'REBASE_HEAD') {
        // `??` cannot be used to default here: an EXPLICIT `null` entry (the
        // unresolvable-REBASE_HEAD case) is itself nullish, and would silently
        // fall through to the round-index default — turning the test that pins
        // the unattributable round into a test of the happy path.
        const spec = shape.rebase_head_rounds
        const idx = spec === undefined ? round - 1 : (spec[round - 1] ?? -1)
        return idx < 0 ? fail('unknown revision') : ok(commitSha(idx))
      }
      if (ref === shape.base || ref === `origin/${shape.base}`) return ok(shape.current_base)
      if (ref === `origin/${shape.branch}`) return ok(remoteBranchHead)
      if (ref === shape.branch) return ok(branchRef)
      return fail('unknown revision')
    }
    if (cmd.includes('merge-base')) {
      if (shape.break_merge_base === true) return fail('no merge base')
      return ok(shape.review_base)
    }
    if (cmd[0] === 'gh' && cmd.includes('pr') && cmd.includes('view')) {
      const head = shape.pr_head_branch
      return head === null || head === undefined ? fail('no such PR') : ok(head)
    }
    if (cmd.includes('fetch')) return shape.break_fetch === true ? fail('could not read from remote') : ok()
    if (cmd.includes('log')) {
      if (shape.break_log === true) return fail('bad revision')
      const path = cmd[cmd.length - 1] ?? ''
      const n = shape.commits_touching?.[path] ?? 1
      return ok(Array.from({ length: n }, (_, i) => commitSha(i)).join('\n'))
    }
    if (cmd.includes('diff') && cmd.includes('--name-only') && !cmd.includes('--diff-filter=U')) {
      if (shape.break_diff === true) return fail('bad revision')
      const b = cmd[cmd.length - 1]
      if (b === shape.current_base) return ok((shape.base_touched ?? []).join('\n'))
      if (b === branchHead || b === remoteBranchHead) return ok((shape.reviewed_files ?? []).join('\n'))
      return ok('')
    }
    // `--diff-filter=U` lists only the CURRENT round's conflicts, exactly as git
    // does — an earlier round's file is gone from it by the next round.
    if (cmd.includes('diff') && cmd.includes('--diff-filter=U')) return ok((rounds[round - 1] ?? []).join('\n'))
    if (cmd.includes('reset') && cmd.includes('--hard')) {
      if (shape.break_branch_restore !== true) branchRef = cmd[cmd.length - 1] ?? branchRef
      return ok()
    }
    if (cmd.includes('rebase') && !cmd.includes('--abort')) {
      if (round < rounds.length) {
        round++
        return fail('CONFLICT (content): Merge conflict')
      }
      // A completed rebase leaves the branch ref on the base tip — the state
      // that erases the drift a later run would have to re-measure.
      branchRef = shape.current_base
    }
    if (cmd.includes('--abort')) return fail('nothing in progress')
    return ok()
  }
  return { host, calls }
}

/** A distinct, sha-shaped identity for branch commit #`i`. Deliberately far from
 *  `SHA_A/B/C` so a test can never confuse a commit with a branch or base tip. */
function commitSha(i: number): string {
  return `${'d'.repeat(39)}${i.toString(16)}`
}

const SHA_A = '1111111111111111111111111111111111111111'
const SHA_B = '2222222222222222222222222222222222222222'
const SHA_C = '3333333333333333333333333333333333333333'

describe('assessBaseDrift (#542)', () => {
  test('no movement: the fork point IS the base tip', async () => {
    const { host } = driftHost({ base: 'main', branch: 'feat-x', review_base: SHA_A, current_base: SHA_A })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(a.moved).toBe(false)
    expect(a.assessable).toBe(true)
    expect(a.review_base_sha).toBe(SHA_A)
    expect(shouldHoldForBaseDrift(a)).toBe(false)
  })

  test('drift that does NOT touch the reviewed diff is IMMATERIAL', async () => {
    const { host } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['docs/README.md', 'other/a.ts'],
      reviewed_files: ['trident/merge.ts'],
    })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(a.moved).toBe(true)
    expect(a.overlap).toEqual([])
    expect(shouldHoldForBaseDrift(a)).toBe(false)
  })

  test('drift that touches a reviewed file IS material', async () => {
    const { host } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['trident/merge.ts', 'docs/README.md'],
      reviewed_files: ['trident/merge.ts', 'trident/store.ts'],
    })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(a.overlap).toEqual(['trident/merge.ts'])
    expect(shouldHoldForBaseDrift(a)).toBe(true)
  })

  test('a file the rebase CONFLICTED on is subtracted — the resolver already saw both sides', async () => {
    const { host } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['trident/merge.ts'],
      reviewed_files: ['trident/merge.ts'],
    })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(shouldHoldForBaseDrift(a, new Set(['trident/merge.ts']))).toBe(false)
    // ...but an UNCONFLICTED overlapping file in the same rebase still holds.
    expect(shouldHoldForBaseDrift({ ...a, overlap: ['a.ts', 'b.ts'] }, new Set(['a.ts']))).toBe(true)
  })

  test('an unresolvable BRANCH ref alone fails OPEN in local mode, CLOSED in pr mode', async () => {
    const { host } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      unresolvable: ['feat-x'],
    })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(a.moved).toBe(false)
    expect(a.assessable).toBe(false)
    expect(a.branch_head_sha).toBeNull()
    // Local mode: the rebase + merge that follow fail loudly on this same repo.
    expect(shouldHoldForBaseDrift(a)).toBe(false)
    // PR mode: `gh pr merge` runs on GitHub and could not care less that the
    // local checkout is broken, so there is no loud failure to fall back on.
    expect(shouldHoldForBaseDrift(a, new Set(), { hold_when_unassessable: true })).toBe(true)
  })

  test('an unresolvable BASE ref alone (branch fine, merge-base fine) fails OPEN', async () => {
    const { host } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      unresolvable: ['main'],
    })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(a.current_base_sha).toBeNull()
    expect(a.review_base_sha).toBe(SHA_A)
    expect(a.branch_head_sha).not.toBeNull()
    expect(a.moved).toBe(false)
    expect(a.assessable).toBe(false)
    // The NORMATIVE half of this test's name. Asserting the assessment fields
    // alone left "fails OPEN" as a claim nothing checked — the hold decision is
    // a separate function and it is the one that lands or holds the merge.
    expect(shouldHoldForBaseDrift(a)).toBe(false)
    expect(shouldHoldForBaseDrift(a, new Set(), { hold_when_unassessable: true })).toBe(true)
  })

  test('a sha-shaped-but-too-short rev-parse answer does NOT count as resolved', async () => {
    // `rev-parse --verify --quiet` is expected to print a full object name. A
    // short/garbled answer is a probe that resolved nothing useful, and treating
    // it as a sha would feed a bogus identity into merge-base + diff and score
    // drift against a tree that does not exist. The lower bound is what makes
    // that a null instead.
    const host: RunHostCommand = async (cmd) => {
      if (cmd.includes('rev-parse')) return ok('abc')
      return ok('')
    }
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(a.current_base_sha).toBeNull()
    expect(a.branch_head_sha).toBeNull()
    expect(a.assessable).toBe(false)
  })

  test('a failed merge-base alone (both refs resolve) fails CLOSED in BOTH modes', async () => {
    const { host } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      break_merge_base: true,
    })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(a.review_base_sha).toBeNull()
    expect(a.current_base_sha).toBe(SHA_B)
    expect(a.branch_head_sha).not.toBeNull()
    expect(a.assessable).toBe(false)
    // Local mode's fail-open rests on "the same broken repo still has to survive
    // a rebase + merge". Nothing is broken here — both refs resolved fine — so
    // the histories are simply unrelated, and a rebase of unrelated history
    // replays happily while nothing ever established the reviewed premise.
    expect(shouldHoldForBaseDrift(a)).toBe(true)
    expect(shouldHoldForBaseDrift(a, new Set(), { hold_when_unassessable: true })).toBe(true)
  })

  test('the branch tip AS REVIEWED is captured, so a hold can put the ref back', async () => {
    const { host } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      branch_head: SHA_C,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
    })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(a.branch_head_sha).toBe(SHA_C)
  })

  test('rename detection is OFF, so a base rename cannot hide the old path', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['mod.ts', 'renamed.ts'],
      reviewed_files: ['mod.ts'],
    })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    // With git's default rename detection the base side would report only
    // `renamed.ts`, the sets would not intersect, and this would land.
    expect(a.overlap).toEqual(['mod.ts'])
    expect(calls.every((c) => !c.includes('diff --name-only') || c.includes('--no-renames'))).toBe(true)
  })

  test('drift established but materiality UNASSESSABLE fails CLOSED', async () => {
    const { host } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      break_diff: true,
    })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(a.moved).toBe(true)
    expect(a.assessable).toBe(false)
    expect(shouldHoldForBaseDrift(a)).toBe(true)
  })
})

describe('baseDriftHoldMessage (#542)', () => {
  const assessed = {
    review_base_sha: SHA_A,
    current_base_sha: SHA_B,
    branch_head_sha: SHA_C,
    moved: true,
    overlap: ['a.ts'],
    assessable: true,
  }

  test('names both shas, the branch, the base and the overlapping files — no raw git stderr', () => {
    const msg = baseDriftHoldMessage('feat-x', 'main', assessed, ['a.ts'])
    expect(msg).toContain('feat-x')
    expect(msg).toContain('main')
    // EXACTLY 7 chars, asserted as the whole backticked token: `toContain` on a
    // prefix is satisfied by any longer rendering, so it cannot tell a 7-char
    // sha from a 12-char one.
    expect(msg).toContain(`\`${SHA_A.slice(0, 7)}\``)
    expect(msg).toContain(`\`${SHA_B.slice(0, 7)}\``)
    expect(msg).not.toContain(SHA_A.slice(0, 8))
    expect(msg).not.toContain(SHA_B.slice(0, 8))
    expect(msg).toContain('a.ts')
    expect(msg.toLowerCase()).not.toContain('error:')
    expect(msg.toLowerCase()).not.toContain('fatal:')
  })

  test('caps a huge overlap instead of pasting every path', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((f) => `${f}.ts`)
    const msg = baseDriftHoldMessage('feat-x', 'main', { ...assessed, overlap: many }, many)
    expect(msg).toContain('and 2 more')
    expect(msg).not.toContain('g.ts')
  })

  test('exactly AT the cap lists every path with no "and N more" tail', () => {
    // The boundary the cap is actually written on. Only the over-cap case was
    // covered, so an off-by-one that truncated the 5th path (or appended a
    // nonsense "and 0 more") read as green.
    const five = ['a', 'b', 'c', 'd', 'e'].map((f) => `${f}.ts`)
    const msg = baseDriftHoldMessage('feat-x', 'main', { ...assessed, overlap: five }, five)
    for (const p of five) expect(msg).toContain(p)
    expect(msg).not.toContain('more')
  })

  test('one path OVER the cap says "and 1 more" — singular, not "1 mores"', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((f) => `${f}.ts`)
    const msg = baseDriftHoldMessage('feat-x', 'main', { ...assessed, overlap: six }, six)
    expect(msg).toContain('and 1 more')
    expect(msg).not.toContain('f.ts')
  })

  test('names the BRANCH when the branch is the ref that would not resolve', () => {
    const msg = baseDriftHoldMessage(
      'feat-x',
      'main',
      { ...assessed, branch_head_sha: null, moved: false, assessable: false },
      [],
    )
    expect(msg).toContain('could not establish where `feat-x` is')
    expect(msg).not.toContain('where `main` is')
  })

  test('names BOTH refs when neither resolved', () => {
    const msg = baseDriftHoldMessage(
      'feat-x',
      'main',
      { ...assessed, current_base_sha: null, branch_head_sha: null, moved: false, assessable: false },
      [],
    )
    expect(msg).toContain('`main`')
    expect(msg).toContain('`feat-x`')
    expect(msg).toContain('are right now')
  })

  test('blames the FORK POINT, not a ref, when both refs resolved but merge-base did not', () => {
    const msg = baseDriftHoldMessage(
      'feat-x',
      'main',
      { ...assessed, moved: false, assessable: false },
      [],
    )
    expect(msg).toContain('have in common')
    expect(msg).not.toContain('could not establish where')
  })

  test('says so plainly when materiality could not be assessed', () => {
    const msg = baseDriftHoldMessage('feat-x', 'main', { ...assessed, assessable: false }, [])
    expect(msg).toContain('could not determine which files it changed')
  })
})

describe('buildMergeCleanupDeps — base-drift hold, local mode (#542)', () => {
  const run = makeRun({ id: 'dddddddd', merge_mode: 'local', branch: 'feat-x', pr: null, repo_path: '/drift' })

  test('HOLDS (never lands) when the moved base silently touched a reviewed file', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const err = await cleanupAfterMerge(run, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TridentBaseDriftHold)
    expect((err as TridentBaseDriftHold).detail.silent_overlap).toEqual(['shared.ts'])
    // NOTHING landed on the shared checkout, and the branch survives for a re-run.
    expect(calls.some((c) => c.includes('merge --no-ff'))).toBe(false)
    expect(calls.some((c) => c.includes('branch -D'))).toBe(false)
    // The throwaway worktree is still torn down (the `finally`).
    expect(calls.some((c) => c.includes('worktree remove --force'))).toBe(true)
  })

  test('LANDS when the base moved without touching any reviewed file', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['docs/CHANGELOG.md'],
      reviewed_files: ['shared.ts'],
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await cleanupAfterMerge(run, deps)
    expect(calls.some((c) => c.startsWith('git -C /drift merge --no-ff feat-x'))).toBe(true)
  })

  test('LANDS when the overlapping file textually CONFLICTED (the resolver handled it)', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
      rebase_conflicts: ['shared.ts'],
    })
    let resolverCalls = 0
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => {
        resolverCalls++
        return { resolved: true }
      },
    })
    await cleanupAfterMerge(run, deps)
    expect(resolverCalls).toBe(1)
    expect(calls.some((c) => c.startsWith('git -C /drift merge --no-ff feat-x'))).toBe(true)
  })

  test('a HOLD puts the branch ref BACK, so a retry still sees the drift', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      branch_head: SHA_C,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await expect(cleanupAfterMerge(run, deps)).rejects.toBeInstanceOf(TridentBaseDriftHold)
    // The rebase moved `refs/heads/feat-x` (a SHARED ref) onto the base tip; the
    // hold must move it back, or the next attempt forks from the tip, measures
    // no drift at all, and lands the very combination this hold refused.
    expect(calls.some((c) => c.includes(`reset --hard ${SHA_C}`))).toBe(true)
    const second = await cleanupAfterMerge(run, deps).catch((e: unknown) => e)
    expect(second).toBeInstanceOf(TridentBaseDriftHold)
    expect(calls.some((c) => c.includes('merge --no-ff'))).toBe(false)
  })

  test('a hold whose branch ref will NOT go back says so instead of staying quiet', async () => {
    const { host } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      branch_head: SHA_C,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
      break_branch_restore: true,
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const err = (await cleanupAfterMerge(run, deps).catch((e: unknown) => e)) as TridentBaseDriftHold
    expect(err).toBeInstanceOf(TridentBaseDriftHold)
    expect(err.message).toContain('could not put')
    expect(err.message).toContain('re-review it from scratch')
  })

  test('HOLDS when a conflicted file has a LATER branch commit that replayed silently', async () => {
    // C1 and C2 both touch shared.ts; only C1 conflicted against the drifted
    // base, so the resolver saw base-vs-C1 and nobody ever saw base-vs-(C1+C2).
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
      rebase_conflicts: ['shared.ts'],
      commits_touching: { 'shared.ts': 2 },
    })
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => ({ resolved: true }),
    })
    const err = (await cleanupAfterMerge(run, deps).catch((e: unknown) => e)) as TridentBaseDriftHold
    expect(err).toBeInstanceOf(TridentBaseDriftHold)
    expect(err.detail.silent_overlap).toEqual(['shared.ts'])
    expect(calls.some((c) => c.includes('merge --no-ff'))).toBe(false)
  })

  test('HOLDS when TWO ROUNDS re-offered the SAME commit — coverage is per commit, not per round', async () => {
    // The inflation this pins. A resolver that edits the file but forgets to
    // `git add` leaves `rebase --continue` refusing, git re-reports the
    // IDENTICAL conflict, and the loop comes round again on the SAME commit
    // (`REBASE_HEAD` unchanged). Counting rounds scored that as 2 — enough to
    // "cover" a file that 2 branch commits touch — so C1's resolution vouched
    // for a C2 nobody had ever looked at, and the un-reviewed combination
    // landed. Matching commit IDENTITY sees one commit, and holds.
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
      conflict_rounds: [['shared.ts'], ['shared.ts']],
      rebase_head_rounds: [0, 0],
      commits_touching: { 'shared.ts': 2 },
    })
    let resolverCalls = 0
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => {
        resolverCalls++
        return { resolved: true }
      },
    })
    const err = (await cleanupAfterMerge(run, deps).catch((e: unknown) => e)) as TridentBaseDriftHold
    expect(resolverCalls).toBe(2)
    expect(err).toBeInstanceOf(TridentBaseDriftHold)
    expect(err.detail.silent_overlap).toEqual(['shared.ts'])
    expect(calls.some((c) => c.includes('merge --no-ff'))).toBe(false)
  })

  test('LANDS when two rounds covered two DISTINCT commits touching the file', async () => {
    // The other side of the same line: two rounds that really did replay two
    // different commits DO cover a file that two commits touch. Without this
    // the fix above could be "hold always" and still read as green.
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
      conflict_rounds: [['shared.ts'], ['shared.ts']],
      rebase_head_rounds: [0, 1],
      commits_touching: { 'shared.ts': 2 },
    })
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => ({ resolved: true }),
    })
    await cleanupAfterMerge(run, deps)
    expect(calls.some((c) => c.startsWith('git -C /drift merge --no-ff feat-x'))).toBe(true)
  })

  test('coverage means THESE commits, not this MANY — enough rounds on the WRONG commits still holds', async () => {
    // Counting is not matching. Here two rounds conflicted on shared.ts, so any
    // count-based rule ("as many rounds as commits") calls the file covered —
    // but the commits git replayed are NOT the commits that touch shared.ts in
    // the reviewed range, so the resolver never saw either of the edits the
    // hold is about. The two vocabularies really can disagree: git reports a
    // conflict under the path as the REPLAYED COMMIT spells it, while the drift
    // side deliberately runs `--no-renames`, so a path can accumulate conflicts
    // from commits that `git log -- <path>` does not attribute to it.
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
      conflict_rounds: [['shared.ts'], ['shared.ts']],
      rebase_head_rounds: [5, 6],
      commits_touching: { 'shared.ts': 2 },
    })
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => ({ resolved: true }),
    })
    const err = (await cleanupAfterMerge(run, deps).catch((e: unknown) => e)) as TridentBaseDriftHold
    expect(err).toBeInstanceOf(TridentBaseDriftHold)
    expect(err.detail.silent_overlap).toEqual(['shared.ts'])
    expect(calls.some((c) => c.includes('merge --no-ff'))).toBe(false)
  })

  test('a round whose REBASE_HEAD will not resolve is attributed to NOTHING, so the path holds', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
      conflict_rounds: [['shared.ts']],
      rebase_head_rounds: [null],
      commits_touching: { 'shared.ts': 1 },
    })
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => ({ resolved: true }),
    })
    await expect(cleanupAfterMerge(run, deps)).rejects.toBeInstanceOf(TridentBaseDriftHold)
    expect(calls.some((c) => c.includes('merge --no-ff'))).toBe(false)
  })

  test('the held message reports ONLY the uncovered files, not the whole overlap', async () => {
    // Two overlapping files; the resolver fully covered `handled.ts` and never
    // saw `silent.ts`. Reporting the whole overlap would send the owner to
    // re-review a file that WAS reviewed against this base, and would make the
    // subtraction that decides the hold indistinguishable from no subtraction.
    const { host } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['handled.ts', 'silent.ts'],
      reviewed_files: ['handled.ts', 'silent.ts'],
      rebase_conflicts: ['handled.ts'],
      commits_touching: { 'handled.ts': 1, 'silent.ts': 1 },
    })
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => ({ resolved: true }),
    })
    const err = (await cleanupAfterMerge(run, deps).catch((e: unknown) => e)) as TridentBaseDriftHold
    expect(err).toBeInstanceOf(TridentBaseDriftHold)
    expect(err.detail.silent_overlap).toEqual(['silent.ts'])
    expect(err.message).toContain('silent.ts')
    expect(err.message).not.toContain('handled.ts')
    expect(err.message).toContain('changed 1 file(s)')
  })

  test('an UNCOUNTABLE conflicted file is not exempted (a failed `git log` holds)', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
      rebase_conflicts: ['shared.ts'],
      break_log: true,
    })
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => ({ resolved: true }),
    })
    await expect(cleanupAfterMerge(run, deps)).rejects.toBeInstanceOf(TridentBaseDriftHold)
    expect(calls.some((c) => c.includes('merge --no-ff'))).toBe(false)
  })

  test('conflicts are accumulated ACROSS rounds, not just the last round', async () => {
    // Round 1 conflicts on the overlapping file, round 2 on an unrelated one.
    // Keeping only the last round's conflicts would forget shared.ts and HOLD.
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
      conflict_rounds: [['shared.ts'], ['other.ts']],
    })
    let resolverCalls = 0
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => {
        resolverCalls++
        return { resolved: true }
      },
    })
    await cleanupAfterMerge(run, deps)
    expect(resolverCalls).toBe(2)
    expect(calls.some((c) => c.startsWith('git -C /drift merge --no-ff feat-x'))).toBe(true)
  })

  test('the drift snapshot is taken BEFORE the rebase (which would erase the drift)', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['docs/x.md'],
      reviewed_files: ['shared.ts'],
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await cleanupAfterMerge(run, deps)
    const mergeBaseIdx = calls.findIndex((c) => c.includes('merge-base'))
    const rebaseIdx = calls.findIndex((c) => c.includes('rebase main'))
    expect(mergeBaseIdx).toBeGreaterThanOrEqual(0)
    expect(rebaseIdx).toBeGreaterThan(mergeBaseIdx)
  })
})

describe('buildMergeCleanupDeps — base-drift hold, pr mode (#542)', () => {
  // Every pr-mode run carries the reviewed head OID (#545) — without one
  // `mergePr` refuses before the drift gate ever runs, which would make these
  // tests pass for the wrong reason.
  const prRun = makeRun({
    merge_mode: 'pr',
    pr: 42,
    branch: 'feat-x',
    repo_path: '/drift-pr',
    inner_result: innerResult(REVIEWED_HEAD),
  })

  test('HOLDS before `gh pr merge` when origin/base drifted into a reviewed file', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await expect(cleanupAfterMerge(prRun, deps)).rejects.toBeInstanceOf(TridentBaseDriftHold)
    // The PR was NEVER merged and the branch was NEVER deleted.
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    expect(calls.some((c) => c.includes('push origin --delete'))).toBe(false)
    // BOTH remote-tracking refs were refreshed first, with EXPLICIT refspecs —
    // a stale one under-reports drift, and the bare `git fetch origin <base>`
    // form only promises FETCH_HEAD, not `refs/remotes/origin/<base>`.
    expect(calls).toContain(
      'git -C /drift-pr fetch origin +refs/heads/main:refs/remotes/origin/main ' +
        '+refs/heads/feat-x:refs/remotes/origin/feat-x',
    )
    // …and the assessment read the REMOTE refs on BOTH sides, never the local
    // `refs/heads/*` copies that `gh pr merge` has no opinion about.
    expect(calls).toContain('git -C /drift-pr merge-base origin/main origin/feat-x')
  })

  test('MERGES when origin/base drifted only outside the reviewed diff', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['docs/x.md'],
      reviewed_files: ['shared.ts'],
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await cleanupAfterMerge(prRun, deps)
    expect(calls).toContain(`gh pr merge 42 --squash --match-head-commit ${REVIEWED_HEAD}`)
  })

  test('a FAILED fetch holds — a stale origin/base reports no drift, confidently', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      // The remote really moved into a reviewed file, but the fetch failed, so
      // the local `origin/main` still sits at the fork point and every probe
      // downstream would agree there is nothing to worry about.
      review_base: SHA_A,
      current_base: SHA_A,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
      break_fetch: true,
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const err = (await cleanupAfterMerge(prRun, deps).catch((e: unknown) => e)) as TridentBaseDriftHold
    expect(err).toBeInstanceOf(TridentBaseDriftHold)
    expect(err.message).toContain('could not establish where')
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
  })

  test('unresolvable refs HOLD in pr mode — `gh pr merge` is not a local operation', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      unresolvable: ['origin/feat-x'],
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const err = (await cleanupAfterMerge(prRun, deps).catch((e: unknown) => e)) as TridentBaseDriftHold
    expect(err).toBeInstanceOf(TridentBaseDriftHold)
    // Local mode may fail open here because its own rebase/merge would blow up
    // on the same broken repo; GitHub's server-side merge would not.
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    // The hold NAMES THE REF THAT FAILED. Blaming `main` for an unresolvable
    // branch sends the reader to the wrong place and prescribes a re-run that
    // cannot fix it.
    expect(err.message).toContain('could not establish where `feat-x` is')
    expect(err.message).not.toContain('could not establish where `main` is')
  })

  test('a STALE LOCAL copy of the head branch cannot stand in for the PR head', async () => {
    // The failure this pins: `git rev-parse feat-x` searches `refs/heads/`
    // BEFORE `refs/remotes/`, so a bare branch name scored this checkout's own
    // stale copy of the branch — which forked before the base moved and reports
    // a clean `moved:false` — while `gh pr merge` squashed the REAL remote head
    // onto the drifted base. Local `feat-x` here still touches nothing; the
    // remote head is the one that overlaps.
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      branch_head: SHA_C,
      remote_branch_head: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const err = (await cleanupAfterMerge(prRun, deps).catch((e: unknown) => e)) as TridentBaseDriftHold
    expect(err).toBeInstanceOf(TridentBaseDriftHold)
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    // The head side was rev-parsed as the REMOTE ref, and the local one never was.
    expect(calls).toContain('git -C /drift-pr rev-parse --verify --quiet origin/feat-x^{commit}')
    expect(calls).not.toContain('git -C /drift-pr rev-parse --verify --quiet feat-x^{commit}')
  })

  test('a head branch this checkout has NEVER seen locally still assesses (no deadlock)', async () => {
    // The other half of the same bug: the merge host does not check out every
    // PR, so `refs/heads/<branch>` is routinely ABSENT. Resolving the bare name
    // returned null there → unassessable → `hold_when_unassessable` → a
    // permanently unmergeable PR that no re-run could ever clear. Reading
    // `origin/<branch>` (which the fetch guarantees) assesses it for real, and
    // a base that moved outside the reviewed diff MERGES.
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      unresolvable: ['feat-x'],
      base_touched: ['docs/x.md'],
      reviewed_files: ['shared.ts'],
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await cleanupAfterMerge(prRun, deps)
    expect(calls).toContain(`gh pr merge 42 --squash --match-head-commit ${REVIEWED_HEAD}`)
  })

  test('a null branch does NOT skip the gate — the head branch comes from the PR', async () => {
    const nullBranch = makeRun({
      merge_mode: 'pr',
      pr: 42,
      branch: null,
      repo_path: '/drift-pr',
      inner_result: innerResult(REVIEWED_HEAD),
    })
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
      pr_head_branch: 'feat-x',
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await expect(cleanupAfterMerge(nullBranch, deps)).rejects.toBeInstanceOf(TridentBaseDriftHold)
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    // …and the merge's own teardown is NOT widened: nothing deletes a branch the
    // run row never claimed.
    expect(calls.some((c) => c.includes('push origin --delete'))).toBe(false)
  })

  test('a null branch the PR cannot name FAILS — it never merges ungated', async () => {
    const nullBranch = makeRun({
      merge_mode: 'pr',
      pr: 42,
      branch: null,
      repo_path: '/drift-pr',
      inner_result: innerResult(REVIEWED_HEAD),
    })
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      pr_head_branch: null,
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await expect(cleanupAfterMerge(nullBranch, deps)).rejects.toBeInstanceOf(TridentMergeError)
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
  })
})
