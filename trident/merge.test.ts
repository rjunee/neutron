import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    : // …and the head lives in THIS repository, on the base every trident PR
      // targets. pr mode holds a fork head (it cannot be scored against
      // `origin`) and holds a PR whose base GitHub will not name, and a host
      // that answers this probe with an empty string is indistinguishable from
      // both. `feat-x` is `makeRun`'s default branch, so the two agree for a
      // test that leaves `branch` unset.
      cmd.includes('headRefName,baseRefName,isCrossRepository')
      ? ok('feat-x\nmain\nfalse')
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
    // Exactly ONE merge attempt: the refusal is terminal, never retried unpinned.
    // Pinned as the EXACT `gh` SEQUENCE rather than a count of merges, so a
    // future extra `gh` call on the refusal path — a retry, a comment, a
    // `pr edit` — fails here instead of slipping past a merge-only filter. The
    // drift gate's read-only `gh pr view` probe is the only other one allowed,
    // and it must come FIRST: the gate that runs after the merge guards nothing.
    expect(calls.filter((c) => c[0] === 'gh').map((c) => c.slice(0, 4).join(' '))).toEqual([
      'gh pr view 42',
      'gh pr merge 42',
    ])
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
  /** What `git rev-parse --is-shallow-repository` prints. Unset ⇒ the flag is
   *  not answered at all (an old git / a failed probe), which must NOT deepen. */
  shallow?: boolean
  /** A shallow repo whose `fetch --unshallow` fails (offline, no origin). The
   *  fork point stays unknown, so the hold must survive. */
  break_unshallow?: boolean
  /** Make `git log … -- <path>` fail (commit count unknown). */
  break_log?: boolean
  /** Make `git diff --name-only <a> <b>` fail (materiality unassessable). */
  break_diff?: boolean
  /** Make `git fetch origin <base>` fail (the base tip cannot be refreshed). */
  break_fetch?: boolean
  /** `gh pr view … headRefName` answer. Unset ⇒ the run's own `branch`; `null`
   *  models a PR that names no head at all (the field comes back empty). */
  pr_head_branch?: string | null
  /** `gh pr view … baseRefName` answer — the branch GitHub will land the PR on.
   *  Unset ⇒ `shape.base`; `null` models a base GitHub would not name. */
  pr_base_branch?: string | null
  /** `isCrossRepository`. Unset ⇒ `false` (same repo, the trident-built shape);
   *  `true` is a fork head; `null` prints a value the parser must not believe. */
  pr_cross_repo?: boolean | null
  /** Make `gh pr view` itself fail (GitHub unreachable / no such PR). */
  break_pr_view?: boolean
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
  // A SHALLOW repo's history stops above the fork point, so `merge-base` answers
  // nothing until the missing commits are fetched — after which it answers
  // normally. That before/after is the whole behaviour under test.
  let deepened = false
  const host: RunHostCommand = async (cmd) => {
    calls.push(cmd.join(' '))
    if (cmd.includes('--is-shallow-repository')) {
      if (shape.shallow === undefined) return fail('unknown option')
      return ok(shape.shallow && !deepened ? 'true' : 'false')
    }
    if (cmd.includes('fetch') && cmd.includes('--unshallow')) {
      if (shape.break_unshallow === true) return fail('could not read from remote')
      deepened = true
      return ok()
    }
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
      // Shallow: the fork point is below the graft boundary until deepened.
      if (shape.shallow === true && !deepened) return fail('no merge base')
      return ok(shape.review_base)
    }
    if (cmd[0] === 'gh' && cmd.includes('pr') && cmd.includes('view')) {
      if (shape.break_pr_view === true) return fail('no such PR')
      // The real probe asks for ALL THREE fields in one call and reads three
      // lines — head name, base name, fork flag, in that order.
      const name = shape.pr_head_branch === undefined ? shape.branch : (shape.pr_head_branch ?? '')
      const prBase = shape.pr_base_branch === undefined ? shape.base : (shape.pr_base_branch ?? '')
      const cross = shape.pr_cross_repo === undefined ? 'false' : String(shape.pr_cross_repo)
      return ok(`${name}\n${prBase}\n${cross}`)
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

describe('assessBaseDrift on a SHALLOW clone (#542)', () => {
  /** The shallow shape: both refs resolve, and `merge-base` answers nothing
   *  because the fork point is below the graft boundary. Untreated that is
   *  `assessable:false` on EVERY merge in the checkout, in both modes. */
  const shallowShape = {
    base: 'main',
    branch: 'feat-x',
    review_base: SHA_A,
    current_base: SHA_B,
    base_touched: ['docs/README.md'],
    reviewed_files: ['trident/merge.ts'],
    shallow: true,
  }

  test('the missing history is fetched and the fork point found — no permanent hold', async () => {
    const { host, calls } = driftHost(shallowShape)
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    // The DEEPEN really happened (not "the fake answered anyway").
    expect(calls.some((c) => c === 'git -C /repo fetch --unshallow origin')).toBe(true)
    // …and the answer is a real assessment, so nothing holds on this immaterial drift.
    expect(a.review_base_sha).toBe(SHA_A)
    expect(a.assessable).toBe(true)
    expect(a.moved).toBe(true)
    expect(shouldHoldForBaseDrift(a)).toBe(false)
    expect(shouldHoldForBaseDrift(a, new Set(), { hold_when_unassessable: true })).toBe(false)
  })

  test('deepening does not weaken the gate: material drift found afterwards still HOLDS', async () => {
    const { host } = driftHost({
      ...shallowShape,
      base_touched: ['trident/merge.ts'],
      reviewed_files: ['trident/merge.ts'],
    })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(a.overlap).toEqual(['trident/merge.ts'])
    expect(shouldHoldForBaseDrift(a)).toBe(true)
  })

  test('a COMPLETE repo is never deepened — a missing fork point there still fails CLOSED', async () => {
    // The probe is a precondition, not an optimisation: `--unshallow` on a
    // complete repository is an ERROR, and two genuinely unrelated histories
    // must keep holding rather than be papered over by a fetch.
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      break_merge_base: true,
      shallow: false,
    })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(calls.some((c) => c.includes('--unshallow'))).toBe(false)
    expect(a.review_base_sha).toBeNull()
    expect(a.assessable).toBe(false)
    expect(shouldHoldForBaseDrift(a)).toBe(true)
    expect(shouldHoldForBaseDrift(a, new Set(), { hold_when_unassessable: true })).toBe(true)
  })

  test('a git that will not answer the shallow probe is left alone, and still HOLDS', async () => {
    // `shallow` unset ⇒ the probe itself fails (an old git, a broken checkout).
    // Anything that is not the literal `true` must not trigger a fetch.
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      break_merge_base: true,
    })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(calls.some((c) => c.includes('--unshallow'))).toBe(false)
    expect(a.assessable).toBe(false)
    expect(shouldHoldForBaseDrift(a)).toBe(true)
  })

  test('a deepen that FAILS keeps the hold — it never reports an unmeasured base as clean', async () => {
    const { host, calls } = driftHost({ ...shallowShape, break_unshallow: true })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(calls.some((c) => c.includes('--unshallow'))).toBe(true)
    expect(a.review_base_sha).toBeNull()
    expect(a.assessable).toBe(false)
    expect(a.moved).toBe(false)
    expect(shouldHoldForBaseDrift(a)).toBe(true)
    expect(shouldHoldForBaseDrift(a, new Set(), { hold_when_unassessable: true })).toBe(true)
  })

  test('an unresolvable REF is not a shallow history — nothing is fetched for it', async () => {
    // Deepening adds commits; it cannot conjure a ref that does not exist. The
    // retry is gated on BOTH tips having resolved so a broken-ref hold does not
    // pay for a full history fetch it can never use.
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      unresolvable: ['feat-x'],
      shallow: true,
    })
    const a = await assessBaseDrift(host, '/repo', 'main', 'feat-x')
    expect(a.branch_head_sha).toBeNull()
    expect(calls.some((c) => c.includes('--unshallow'))).toBe(false)
    expect(a.assessable).toBe(false)
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

  test('does NOT prescribe a re-run for a fork point that no re-run can find', () => {
    // Both refs resolved and git still found no common ancestor: on a shallow
    // checkout that is the checkout's SHAPE, not a transient failure, so every
    // re-run lands back here. A fail-closed hold whose only instruction cannot
    // clear it reads as a broken tool, which is how a correct hold gets waved
    // through by hand.
    const msg = baseDriftHoldMessage('feat-x', 'main', { ...assessed, moved: false, assessable: false }, [])
    expect(msg).not.toContain('re-run the build')
    expect(msg).toContain('by hand')
    // And it does not prescribe the deepen either: the gate ALREADY ran it
    // (`deepenShallowHistory`) before any reader can see this text. Telling
    // someone to go do a fetch that just happened sends them round the same
    // loop the paragraph above exists to stop.
    expect(msg).toContain('already tried fetching')
    expect(msg).not.toContain('deepen it with')
  })

  test('DOES prescribe a re-run for a ref that merely would not resolve', () => {
    // The counterweight: a missing ref is exactly what a re-run's fetch fixes,
    // so that advice must survive.
    const msg = baseDriftHoldMessage(
      'feat-x',
      'main',
      { ...assessed, branch_head_sha: null, moved: false, assessable: false },
      [],
    )
    expect(msg).toContain('re-run the build')
    expect(msg).not.toContain('--unshallow')
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
    // The throwaway worktree is still torn down (the `finally`) — and, since
    // #541, WITHOUT `--force`, so a resolver's half-finished work in there is
    // preserved rather than destroyed by the hold.
    expect(calls).toContain(`git -C /drift worktree remove ${wtOf('/drift', run)}`)
    expect(calls.some((c) => c.includes('worktree remove --force'))).toBe(false)
  })

  test('a DIRTY throwaway worktree does not swallow the HOLD (#541 + #542)', async () => {
    // The two guards meet in `mergeLocal`'s `finally`. The resolver writes logs
    // and test output INTO the merge worktree, so by the time the drift hold
    // fires that tree is routinely dirty — and since #541 a dirty tree is
    // PRESERVED rather than force-removed. If the teardown reported that as a
    // failure, the owner would get "refusing to reuse the merge worktree"
    // instead of the hold, and the reason the merge stopped would be lost.
    const wt = mkdtempSync(join(tmpdir(), 'trident-drift-wt-'))
    try {
      // Clean while provisioning, dirty once the rebase has run: the tree only
      // acquires the resolver's scratch DURING the merge, which is the only
      // ordering in which provisioning lets us reach the hold at all.
      let rebased = false
      const inner = driftHost({
        base: 'main',
        branch: 'feat-x',
        review_base: SHA_A,
        current_base: SHA_B,
        base_touched: ['shared.ts'],
        reviewed_files: ['shared.ts'],
      })
      const calls: string[] = []
      const host: RunHostCommand = async (cmd, cwd) => {
        calls.push(cmd.join(' '))
        if (cmd.includes('--show-toplevel') && cmd.includes(wt)) return ok(`${wt}\n`)
        if (cmd.includes('status') && cmd.includes(wt))
          return ok(rebased ? '?? resolver-scratch.log\n' : '')
        if (cmd.includes('rebase') && !cmd.includes('--abort')) rebased = true
        return inner.host(cmd, cwd)
      }
      const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
      const err = await cleanupAfterMerge(
        makeRun({ id: 'dddddddd', merge_mode: 'local', branch: 'feat-x', pr: null, repo_path: '/drift', worktree: wt }),
        deps,
      ).catch((e: unknown) => e)
      // BEHAVIOUR: the owner gets the HOLD, with the file that drifted named…
      expect(err).toBeInstanceOf(TridentBaseDriftHold)
      expect((err as TridentBaseDriftHold).detail.silent_overlap).toEqual(['shared.ts'])
      // …nothing landed…
      expect(calls.some((c) => c.includes('merge --no-ff'))).toBe(false)
      // …and the teardown PRESERVED the resolver's scratch: the only removal of
      // this path is the provisioning one, issued before the rebase while the
      // tree was still clean. Nothing removes it once it holds work.
      expect(calls).toContain(`git -C ${wt} status --porcelain --untracked-files=all`)
      const rebaseAt = calls.findIndex((c) => c.includes('rebase') && !c.includes('--abort'))
      expect(rebaseAt).toBeGreaterThan(-1)
      const removals = calls.flatMap((c, i) => (c.includes(`worktree remove ${wt}`) ? [i] : []))
      expect(removals.every((i) => i < rebaseAt)).toBe(true)
      expect(calls.some((c) => c.includes('--force') && c.includes('worktree remove'))).toBe(false)
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
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

  // A FORK head is not in `origin`, and the gate scores `origin/<name>`. The
  // dangerous shape is the ordinary one: a drive-by contribution from a fork's
  // `main` into `main`. Both refspecs then name `origin/main`, the assessment
  // compares the base tip with ITSELF, and it reports `moved: false` about a head
  // it never looked at — the exact silent all-clear this gate exists to prevent.
  test('a FORK head whose branch is named like the base HOLDS — it is never scored against origin', async () => {
    const forkRun = makeRun({
      merge_mode: 'pr',
      pr: 42,
      branch: 'main',
      repo_path: '/drift-pr',
      inner_result: innerResult(REVIEWED_HEAD),
    })
    const { host, calls } = driftHost({
      // Scored against origin this looks perfectly clean: base and "branch" are
      // the same ref, so nothing moved. That is precisely the illusion.
      base: 'main',
      branch: 'main',
      review_base: SHA_A,
      current_base: SHA_A,
      pr_head_branch: 'main',
      pr_cross_repo: true,
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const err = await cleanupAfterMerge(forkRun, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TridentBaseDriftHold)
    expect((err as TridentBaseDriftHold).message).toContain('fork')
    // BEHAVIOUR: it did not merge, and it did not even pretend to measure —
    // no ref was fetched or scored against the wrong repository's refs.
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    expect(calls.some((c) => c.includes('fetch'))).toBe(false)
    expect(calls.some((c) => c.includes('merge-base'))).toBe(false)
  })

  test('a PR whose head location GitHub will not name HOLDS — unknown is not same-repo', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_A,
      break_pr_view: true,
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await expect(cleanupAfterMerge(prRun, deps)).rejects.toBeInstanceOf(TridentBaseDriftHold)
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
  })

  test('a value that is neither `true` nor `false` HOLDS — the parser believes only those two', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_A,
      pr_cross_repo: null,
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await expect(cleanupAfterMerge(prRun, deps)).rejects.toBeInstanceOf(TridentBaseDriftHold)
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
  })

  // The counterweight, and the reason the three holds above are safe to add: the
  // ORDINARY same-repo PR — every PR trident builds — still lands. A gate that
  // held every merge would be indistinguishable from one that is broken.
  test('a SAME-REPO head still lands — the fork guard does not hold everything', async () => {
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_A,
      pr_cross_repo: false,
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await cleanupAfterMerge(prRun, deps)
    expect(calls).toContain(`gh pr merge 42 --squash --match-head-commit ${REVIEWED_HEAD}`)
  })

  // `run.branch` is a LOCAL record; `gh pr merge` merges the PR's head. When the
  // two disagree — an adopted run, a row re-pointed at another PR — scoring the
  // row's branch measures a ref the merge will not touch, and the worst case is
  // silent: `run.branch: 'main'` compares `origin/main` with ITSELF and reports
  // all clear, then merges `feat-x` against a base nobody looked at.
  test('a STALE run.branch does not decide what gets scored — GitHub names the head', async () => {
    const staleRow = makeRun({
      merge_mode: 'pr',
      pr: 42,
      branch: 'main', // wrong, and wrong in the direction that scores clean
      repo_path: '/drift-pr',
      inner_result: innerResult(REVIEWED_HEAD),
    })
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x', // what the PR ACTUALLY merges, and where the drift is
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
      pr_head_branch: 'feat-x',
      pr_cross_repo: false,
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const err = await cleanupAfterMerge(staleRow, deps).catch((e: unknown) => e)
    // BEHAVIOUR: the drift in `feat-x` was found and the merge was REFUSED …
    expect(err).toBeInstanceOf(TridentBaseDriftHold)
    expect((err as TridentBaseDriftHold).detail.silent_overlap).toEqual(['shared.ts'])
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    // … because the gate scored the PR's head against the base. Pinned on the
    // merge-base PAIR, which names both sides at once: preferring the row's
    // branch made this `merge-base origin/main origin/main` — a ref compared
    // with itself, which is why that bug reported "clean" instead of failing.
    expect(calls).toContain('git -C /drift-pr merge-base origin/main origin/feat-x')
    expect(calls).toContain('git -C /drift-pr rev-parse --verify --quiet origin/feat-x^{commit}')
    expect(calls).toContain(
      'git -C /drift-pr fetch origin +refs/heads/main:refs/remotes/origin/main +refs/heads/feat-x:refs/remotes/origin/feat-x',
    )
  })

  test('a head GitHub will not name does NOT fall back to `run.branch`', async () => {
    // The other half of the same principle. `run.branch` was still trusted as a
    // FALLBACK, so a row carrying `main` (the adopted shape) whose PR named no
    // head scored `origin/main` against `origin/main` — a ref compared with
    // itself, which is the silent all-clear, reached by the exact rows least
    // likely to be right. An unnamed head is now a refusal.
    const staleRow = makeRun({
      merge_mode: 'pr',
      pr: 42,
      branch: 'main',
      repo_path: '/drift-pr',
      inner_result: innerResult(REVIEWED_HEAD),
    })
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_A,
      pr_head_branch: null,
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await expect(cleanupAfterMerge(staleRow, deps)).rejects.toBeInstanceOf(TridentMergeError)
    // BEHAVIOUR: nothing merged, and nothing was scored against the row's name —
    // no `origin/main` vs `origin/main` comparison was even attempted.
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    expect(calls.some((c) => c.includes('merge-base'))).toBe(false)
    expect(calls.some((c) => c.includes('fetch'))).toBe(false)
  })
})

// The gate scored `detectBaseBranch` — the REPOSITORY's default branch, with a
// hardcoded `main` fallback — while `gh pr merge` lands the PR on the PR's OWN
// base. For every PR trident opens those agree, which is what made the gap
// invisible: it only opens for a PR opened against, or retargeted onto, some
// other branch. Both directions are wrong and one is silent.
describe('buildMergeCleanupDeps — the gate scores the PR\'s OWN base (#542)', () => {
  const prRun = makeRun({
    merge_mode: 'pr',
    pr: 42,
    branch: 'feat-x',
    repo_path: '/drift-pr',
    inner_result: innerResult(REVIEWED_HEAD),
  })

  test('drift in the PR\'s real base HOLDS, even though config says `main`', async () => {
    // `release/1.x` is where this PR lands and where the drift is. `main` is
    // what the old code would have measured — and this host cannot even resolve
    // `origin/main`, so scoring it could only have produced an answer about a
    // ref that has nothing to do with this merge.
    const { host, calls } = driftHost({
      base: 'release/1.x',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_B,
      base_touched: ['shared.ts'],
      reviewed_files: ['shared.ts'],
    })
    // Deliberately WRONG for this PR, and deliberately the value the old code
    // preferred above all others.
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const err = await cleanupAfterMerge(prRun, deps).catch((e: unknown) => e)
    // BEHAVIOUR: the real base's drift was found and the merge was REFUSED.
    expect(err).toBeInstanceOf(TridentBaseDriftHold)
    expect((err as TridentBaseDriftHold).detail.silent_overlap).toEqual(['shared.ts'])
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    // …measured against `release/1.x` on BOTH the fetch and the comparison …
    expect(calls).toContain(
      'git -C /drift-pr fetch origin +refs/heads/release/1.x:refs/remotes/origin/release/1.x ' +
        '+refs/heads/feat-x:refs/remotes/origin/feat-x',
    )
    expect(calls).toContain('git -C /drift-pr merge-base origin/release/1.x origin/feat-x')
    // … and `main` was never named at all: not fetched, not rev-parsed, and not
    // even looked up via `origin/HEAD`.
    expect(calls.some((c) => c.includes('main'))).toBe(false)
    expect(calls.some((c) => c.includes('symbolic-ref'))).toBe(false)
    // The hold text names the branch the owner would actually go look at.
    expect((err as TridentBaseDriftHold).message).toContain('`release/1.x`')
  })

  test('a PR on a release base still LANDS — `main` moving is not its problem', async () => {
    // The silent direction, and the counterweight. Here `release/1.x` has not
    // moved, so the merge must go through: a gate that scored `main` would
    // either hold on movement irrelevant to this PR, or — with `main` sitting
    // unresolvable in this checkout — hold forever on a PR no re-run can clear.
    const { host, calls } = driftHost({
      base: 'release/1.x',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_A,
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await cleanupAfterMerge(prRun, deps)
    expect(calls).toContain(`gh pr merge 42 --squash --match-head-commit ${REVIEWED_HEAD}`)
    expect(calls).toContain('git -C /drift-pr merge-base origin/release/1.x origin/feat-x')
    expect(calls.some((c) => c.includes('main'))).toBe(false)
  })

  test('a base GitHub will not name HOLDS — it is not assumed to be `main`', async () => {
    // The field being ABSENT must not read as "the default branch, then". A base
    // nobody can name cannot be measured, and the merge it guards runs on
    // GitHub's side where nothing downstream would catch a wrong answer.
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_A,
      pr_base_branch: null,
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    const err = await cleanupAfterMerge(prRun, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TridentBaseDriftHold)
    expect((err as TridentBaseDriftHold).message).toContain('would not name the branch')
    // BEHAVIOUR: it did not merge, and it did not pretend to measure anything.
    expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    expect(calls.some((c) => c.includes('fetch'))).toBe(false)
    expect(calls.some((c) => c.includes('merge-base'))).toBe(false)
  })

  test('the probe reads three lines in order — a base is never read as a fork flag', async () => {
    // `prHead` splits on newlines by position, so the ORDER of the three fields
    // is load-bearing. If the base's slot were ever read as the fork flag the
    // parser would see a branch name where it expects `true`/`false`, refuse to
    // believe it, and hold every same-repo PR forever. Pinned by asking for a
    // shape where all three answers are distinguishable.
    const { host, calls } = driftHost({
      base: 'release/1.x',
      branch: 'feat-x',
      review_base: SHA_A,
      current_base: SHA_A,
      pr_head_branch: 'feat-x',
      pr_base_branch: 'release/1.x',
      pr_cross_repo: false,
    })
    const deps = buildMergeCleanupDeps(host)
    await cleanupAfterMerge(prRun, deps)
    // All three fields are asked for in ONE call, in the order the reader
    // assumes — and the same-repo PR landed, which is only possible if the fork
    // flag was read from the third line.
    expect(
      calls.some(
        (c) =>
          c.startsWith('gh pr view 42') && c.includes('--json headRefName,baseRefName,isCrossRepository'),
      ),
    ).toBe(true)
    expect(calls).toContain(`gh pr merge 42 --squash --match-head-commit ${REVIEWED_HEAD}`)
  })
})

// The teardown deletes a branch, which is the one irreversible thing this file
// does — and it was reading the very column the gate above proves can be stale.
// A row carrying `main` (the adopted shape) aimed `push origin --delete` at the
// default branch, saved only by whatever protection the remote happened to have.
describe('buildMergeCleanupDeps — teardown deletes the branch GitHub named (#542)', () => {
  test('a STALE `run.branch` does not decide what gets DELETED', async () => {
    const staleRow = makeRun({
      merge_mode: 'pr',
      pr: 42,
      branch: 'main', // stale, and stale in the direction that deletes the base
      repo_path: '/drift-pr',
      inner_result: innerResult(REVIEWED_HEAD),
    })
    const { host, calls } = driftHost({
      base: 'main',
      branch: 'feat-x', // what the PR actually merges, and what may be deleted
      review_base: SHA_A,
      current_base: SHA_A,
      pr_head_branch: 'feat-x',
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await cleanupAfterMerge(staleRow, deps)
    // BEHAVIOUR: the merge landed, the PR's head branch was torn down …
    expect(calls).toContain(`gh pr merge 42 --squash --match-head-commit ${REVIEWED_HEAD}`)
    expect(calls).toContain('git -C /drift-pr push origin --delete feat-x')
    expect(calls).toContain('git -C /drift-pr branch -D feat-x')
    // … and NOTHING aimed a delete at the base branch the stale row named.
    expect(calls).not.toContain('git -C /drift-pr push origin --delete main')
    expect(calls).not.toContain('git -C /drift-pr branch -D main')
  })

  test('a run that never claimed a branch still deletes NOTHING', async () => {
    // The teardown is not widened by knowing the head's name: an adopted PR
    // someone else opened gets its drift assessed and its branch left alone.
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
      current_base: SHA_A,
      pr_head_branch: 'feat-x',
    })
    const deps = buildMergeCleanupDeps(host, { base_branch: 'main' })
    await cleanupAfterMerge(nullBranch, deps)
    expect(calls).toContain(`gh pr merge 42 --squash --match-head-commit ${REVIEWED_HEAD}`)
    expect(calls.some((c) => c.includes('push origin --delete'))).toBe(false)
    expect(calls.some((c) => c.includes('branch -D'))).toBe(false)
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
            : (noDrift(cmd) ?? ok()),
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
          : (noDrift(cmd) ?? ok()),
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
      cmd.includes('--show-toplevel') && cmd.includes(wt)
        ? fail('not a git repository')
        : (noDrift(cmd) ?? ok()),
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
      cmd.includes('--show-toplevel') || cmd.includes('status')
        ? fail('not a git repository')
        : (noDrift(cmd) ?? ok()),
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
