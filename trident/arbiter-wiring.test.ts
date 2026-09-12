/**
 * #541 — the ARBITER TIER's production wiring.
 *
 * `buildFableArbiter` was built, unit-tested (`arbiter.test.ts`), exported and
 * constructed NOWHERE. These tests pin the seam that gives it a call site, in
 * BOTH directions:
 *
 *   - the ONE hold that qualifies (a bounded resolver ESCALATED a rebase
 *     conflict) reaches the arbiter, and a `retry-resolution` decision is acted
 *     on — the same tree goes back to the resolver carrying the arbiter's
 *     reasoning, and the run lands;
 *   - the holds that do NOT qualify (base drift, the dirty merge worktree)
 *     reach the owner with the arbiter never consulted at all;
 *   - `{kind:'unavailable'}` falls through to the EXISTING owner path — neither
 *     blocked nor silently resolved. This is the property that makes wiring the
 *     arbiter safe, so it is asserted for an unwired arbiter, a spent cap, and
 *     an arbiter that throws;
 *   - the real `buildFableArbiter` cap refuses the (cap+1)th call and NAMES the
 *     cap, and that refusal is an `unavailable` — i.e. it lands on the owner
 *     path rather than wedging the merge.
 *
 * Driven through `cleanupAfterMerge` against a scripted host, so what is under
 * test is the composed merge path, not a hand-called private function.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupAfterMerge } from './git-mode.ts'
import type { HostCommandResult } from './git-mode.ts'
import {
  buildMergeCleanupDeps,
  CONFLICT_ARBITER_RETRY_OPTION,
  CONFLICT_ARBITRATION_OPTIONS,
  type RunHostCommand,
} from './merge.ts'
import {
  assertArbitrableOptions,
  buildFableArbiter,
  DEFAULT_ARBITER_CAP,
  type ArbitrationInput,
  type ArbitrationOutcome,
  type TridentArbiter,
} from './arbiter.ts'
import type { TridentRun } from './store.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })
const fail = (stderr = 'boom'): HostCommandResult => ({ ok: false, stdout: '', stderr, exit_code: 1 })

const localRun = (branch: string, id = branch): TridentRun =>
  makeTridentRun({
    id,
    slug: 's',
    phase: 'done',
    branch,
    pr: null,
    merge_mode: 'local',
    repo_path: '/shared',
    subagent_run_id: null,
    subagent_status: null,
    task: 'add a ring buffer flush()',
  })

/** Mirrors merge.ts `runWorktreePath`. */
const wtOf = (repo: string, run: TridentRun): string =>
  `${repo}/.trident-worktrees/${run.slug}-${run.id.slice(0, 8)}`

/**
 * A host whose ONLY conflict is the build's own rebase inside its own merge
 * worktree — `recoverStaleGitState`'s abort probes against the shared checkout
 * must never be mistaken for one. `conflictRounds` is how many times that rebase
 * (or `rebase --continue`) reports the conflict before going clean.
 */
function conflictingHost(
  wt: string,
  conflictRounds: number,
): { host: RunHostCommand; calls: string[] } {
  const calls: string[] = []
  let reported = 0
  const host: RunHostCommand = async (cmd) => {
    const j = cmd.join(' ')
    calls.push(j)
    const ownRebase =
      cmd.includes(wt) && cmd.includes('rebase') && !cmd.includes('--abort')
    if (ownRebase && reported < conflictRounds) {
      reported++
      return fail('CONFLICT (content): Merge conflict in flush.ts')
    }
    if (cmd.includes('diff') && cmd.includes('--diff-filter=U')) return ok('flush.ts')
    return ok()
  }
  return { host, calls }
}

/** A recording arbiter that answers with a fixed outcome. */
function stubArbiter(outcome: ArbitrationOutcome): {
  arbitrate: TridentArbiter
  seen: ArbitrationInput[]
} {
  const seen: ArbitrationInput[] = []
  return {
    seen,
    arbitrate: async (input) => {
      seen.push(input)
      return outcome
    },
  }
}

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

const RESOLVER_QUESTION =
  'flush.ts: drop-oldest vs block-until-space — which behaviour do you want?'

describe('#541 — the arbiter tier is CONSULTED on a resolver escalation', () => {
  test('a `retry-resolution` decision is ACTED ON: the same tree goes back to the resolver with the arbiter reasoning, and the merge lands', async () => {
    const run = localRun('feat-retry')
    const wt = wtOf('/shared', run)
    // ONE conflicting pass: the initial `rebase`. The arbiter-directed retry
    // resolves it, and `rebase --continue` is then clean, so the merge lands.
    const { host, calls } = conflictingHost(wt, 1)
    const seenGuidance: (string | undefined)[] = []
    let attempt = 0
    const { arbitrate, seen } = stubArbiter({
      kind: 'decision',
      option_id: CONFLICT_ARBITER_RETRY_OPTION,
      reasoning: 'Both sides add an independent guard; keeping both is correct.',
    })
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async (input) => {
        attempt++
        seenGuidance.push(input.guidance)
        // Escalates the FIRST time; the arbiter-directed retry succeeds.
        return attempt === 1 ? { resolved: false, question: RESOLVER_QUESTION } : { resolved: true }
      },
      arbitrate,
    })

    await cleanupAfterMerge(run, deps)

    // The arbiter was asked exactly once, rooted at the CONFLICTED worktree (the
    // tree holding the markers) — never the shared checkout other lanes build in.
    expect(seen.length).toBe(1)
    expect(seen[0]?.repo_path).toBe(wt)
    expect(seen[0]?.run.id).toBe(run.id)
    // A non-empty option set containing the retry option and no forbidden id.
    expect(seen[0]?.options.length).toBeGreaterThan(0)
    expect(seen[0]?.options.map((o) => o.id)).toContain(CONFLICT_ARBITER_RETRY_OPTION)
    // The evidence names what the arbiter can go and verify for itself.
    expect(seen[0]?.evidence).toContain('flush.ts')
    expect(seen[0]?.evidence).toContain(RESOLVER_QUESTION)
    // The retry happened, and it carried the arbiter's reasoning as guidance —
    // the first attempt carried none.
    expect(attempt).toBe(2)
    expect(seenGuidance[0]).toBeUndefined()
    expect(seenGuidance[1]).toBe('Both sides add an independent guard; keeping both is correct.')
    // ACTED ON means the run LANDED: the rebase was never aborted and base moved.
    expect(calls.some((c) => c === `git -C ${wt} rebase --abort`)).toBe(false)
    expect(calls.some((c) => c.startsWith('git -C /shared merge --no-ff feat-retry'))).toBe(true)
  })

  test('guidance is SCOPED TO THE COMMIT it was given for: the next commit\'s conflict starts clean', async () => {
    // Round 1 escalates → the arbiter asks for a retry → round 2 resolves → the
    // rebase advances onto the NEXT branch commit, which conflicts too. The
    // arbiter said nothing about THAT commit's two sides, so carrying its
    // reasoning forward would describe the wrong conflict to the resolver.
    const run = localRun('feat-scope')
    const wt = wtOf('/shared', run)
    const { host } = conflictingHost(wt, 2)
    const seenGuidance: (string | undefined)[] = []
    let attempt = 0
    const { arbitrate, seen } = stubArbiter({
      kind: 'decision',
      option_id: CONFLICT_ARBITER_RETRY_OPTION,
      reasoning: 'ARBITER REASONING FOR COMMIT ONE',
    })
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async (input) => {
        attempt++
        seenGuidance.push(input.guidance)
        return attempt === 1 ? { resolved: false, question: RESOLVER_QUESTION } : { resolved: true }
      },
      arbitrate,
    })

    await cleanupAfterMerge(run, deps)

    // Three resolver rounds: commit one (escalated), commit one again (the
    // arbiter's retry), then commit two.
    expect(attempt).toBe(3)
    expect(seen.length).toBe(1)
    expect(seenGuidance[0]).toBeUndefined()
    expect(seenGuidance[1]).toBe('ARBITER REASONING FOR COMMIT ONE')
    // THE ASSERTION: the next commit's FIRST attempt carries no stale guidance.
    expect(seenGuidance[2]).toBeUndefined()
  })

  test('a `stop` decision leaves the escalation exactly as it was: rebase aborted, the resolver question reaches the owner, nothing merged', async () => {
    const run = localRun('feat-stop')
    const wt = wtOf('/shared', run)
    const { host, calls } = conflictingHost(wt, 1)
    let attempts = 0
    const { arbitrate, seen } = stubArbiter({
      kind: 'decision',
      option_id: 'stop',
      reasoning: 'Both sides redefine flush() incompatibly.',
    })
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => {
        attempts++
        return { resolved: false, question: RESOLVER_QUESTION }
      },
      arbitrate,
    })

    await expect(cleanupAfterMerge(run, deps)).rejects.toMatchObject({
      name: 'TridentMergeConflictEscalation',
      question: RESOLVER_QUESTION,
    })
    expect(seen.length).toBe(1)
    // No retry, and the pre-#541 behaviour is intact.
    expect(attempts).toBe(1)
    expect(calls.some((c) => c === `git -C ${wt} rebase --abort`)).toBe(true)
    expect(calls.some((c) => c.includes('merge --no-ff'))).toBe(false)
  })

  test('an `owner-only` verdict reaches the owner too — never converted into a retry', async () => {
    const run = localRun('feat-owner')
    const wt = wtOf('/shared', run)
    const { host, calls } = conflictingHost(wt, 1)
    let attempts = 0
    const { arbitrate } = stubArbiter({
      kind: 'owner-only',
      question: 'which backpressure behaviour do you want shipped?',
    })
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => {
        attempts++
        return { resolved: false, question: RESOLVER_QUESTION }
      },
      arbitrate,
    })

    await expect(cleanupAfterMerge(run, deps)).rejects.toMatchObject({
      name: 'TridentMergeConflictEscalation',
      question: RESOLVER_QUESTION,
    })
    expect(attempts).toBe(1)
    expect(calls.some((c) => c === `git -C ${wt} rebase --abort`)).toBe(true)
  })
})

describe('#541 — `unavailable` FALLS THROUGH to the owner path (neither blocked nor silently resolved)', () => {
  /**
   * THE MOST IMPORTANT ASSERTION IN THIS CHANGE. Each case below must settle in
   * bounded time (not block), reject with the resolver's OWN specific question
   * (not a guess, not a raw git error), abort the rebase, and land nothing.
   */
  const cases: { name: string; arbitrate: TridentArbiter | undefined }[] = [
    { name: 'no arbiter wired at all', arbitrate: undefined },
    {
      name: 'an arbiter that reports unavailable',
      arbitrate: async () => ({ kind: 'unavailable', reason: 'the arbiter timed out' }),
    },
    {
      name: 'an arbiter that THROWS',
      arbitrate: async () => {
        throw new Error('substrate exploded')
      },
    },
  ]

  for (const c of cases) {
    test(`${c.name} → the run is NOT blocked and NOT resolved; the owner gets the resolver question`, async () => {
      const run = localRun('feat-unavail')
      const wt = wtOf('/shared', run)
      const { host, calls } = conflictingHost(wt, 1)
      let attempts = 0
      const deps = buildMergeCleanupDeps(host, {
        base_branch: 'main',
        resolve_conflict: async () => {
          attempts++
          return { resolved: false, question: RESOLVER_QUESTION }
        },
        ...(c.arbitrate !== undefined ? { arbitrate: c.arbitrate } : {}),
      })

      // NOT BLOCKED: it settles, and it settles by rejecting.
      await expect(cleanupAfterMerge(run, deps)).rejects.toMatchObject({
        name: 'TridentMergeConflictEscalation',
        question: RESOLVER_QUESTION,
      })
      // NOT SILENTLY RESOLVED: no second resolver round, nothing merged, no
      // branch deleted — and the rebase was aborted, so no half-rebased tree.
      expect(attempts).toBe(1)
      expect(calls.some((c2) => c2.includes('merge --no-ff'))).toBe(false)
      expect(calls.some((c2) => c2.includes('branch -D'))).toBe(false)
      expect(calls.some((c2) => c2 === `git -C ${wt} rebase --abort`)).toBe(true)
      expect(calls.some((c2) => c2.includes(`worktree remove ${wt}`))).toBe(true)
    })
  }

  test('a decision naming an option that was NEVER OFFERED is not acted on', async () => {
    // `buildFableArbiter` already refuses to emit one, but the seam must not
    // trust that: an injected arbiter selecting `approve` must change nothing.
    const run = localRun('feat-bogus')
    const wt = wtOf('/shared', run)
    const { host, calls } = conflictingHost(wt, 1)
    let attempts = 0
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => {
        attempts++
        return { resolved: false, question: RESOLVER_QUESTION }
      },
      arbitrate: async () => ({ kind: 'decision', option_id: 'approve', reasoning: 'ship it' }),
    })

    await expect(cleanupAfterMerge(run, deps)).rejects.toMatchObject({
      name: 'TridentMergeConflictEscalation',
      question: RESOLVER_QUESTION,
    })
    expect(attempts).toBe(1)
    expect(calls.some((c) => c.includes('merge --no-ff'))).toBe(false)
  })
})

describe('#541 — the invocation cap refuses the (cap+1)th call and NAMES the cap', () => {
  test('the real buildFableArbiter refuses past its cap, and that refusal is an `unavailable` the merge falls through on', async () => {
    // The REAL arbiter over a substrate whose turn always asks for a retry, so
    // the only thing that can stop it is its own cap.
    const arbitrate = buildFableArbiter({
      max_invocations_per_run: 2,
      build_substrate: () => ({
        start: () => ({
          events: (async function* () {
            yield {
              kind: 'token' as const,
              text: `DECISION: ${CONFLICT_ARBITER_RETRY_OPTION}\nREASONING: keep both guards.`,
            }
            yield {
              kind: 'completion' as const,
              usage: { input_tokens: 1, output_tokens: 1 },
              substrate_instance_id: 'mock',
            }
          })(),
          async respondToTool(): Promise<void> {
            throw new Error('tools resolve internally')
          },
          async cancel(): Promise<void> {},
          tool_resolution: 'internal' as const,
        }),
      }),
    })

    const run = localRun('feat-cap')
    const outcomes: ArbitrationOutcome[] = []
    const ask = (): Promise<ArbitrationOutcome> =>
      arbitrate({
        run,
        repo_path: '/shared/wt',
        question: 'Does a correct resolution exist for the flush() conflict?',
        evidence: 'flush.ts still carries markers',
        options: [...CONFLICT_ARBITRATION_OPTIONS],
      })
    outcomes.push(await ask(), await ask(), await ask())

    // The first two are real decisions; the THIRD — the (cap+1)th — is refused.
    expect(outcomes[0]?.kind).toBe('decision')
    expect(outcomes[1]?.kind).toBe('decision')
    expect(outcomes[2]).toEqual({
      kind: 'unavailable',
      reason: 'arbiter invocation cap (2) reached for this run',
    })
    // NAMES THE CAP, not a generic "too many".
    expect(outcomes[2]?.kind === 'unavailable' ? outcomes[2].reason : '').toContain('(2)')

    // And a refusal is `unavailable`, which the merge seam falls through on —
    // so a spent cap escalates to the owner instead of retrying forever.
    const run2 = localRun('feat-cap2')
    const wt = wtOf('/shared', run2)
    const { host, calls } = conflictingHost(wt, 1)
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => ({ resolved: false, question: RESOLVER_QUESTION }),
      arbitrate: async () => ({
        kind: 'unavailable',
        reason: `arbiter invocation cap (${DEFAULT_ARBITER_CAP}) reached for this run`,
      }),
    })
    await expect(cleanupAfterMerge(run2, deps)).rejects.toMatchObject({
      name: 'TridentMergeConflictEscalation',
      question: RESOLVER_QUESTION,
    })
    expect(calls.some((c) => c === `git -C ${wt} rebase --abort`)).toBe(true)
  })
})

describe('#541 — the holds that do NOT qualify still go STRAIGHT to the owner', () => {
  test('a BASE-DRIFT hold never consults the arbiter (its only alternative to holding is waiving review, which no arbiter may select)', async () => {
    // Base moved, and the moved commits touched a file the reviewed diff also
    // touches, with no conflict for the resolver to see: `shouldHoldForBaseDrift`
    // holds. The arbiter must not be asked.
    const run = localRun('feat-drift')
    const REVIEW_BASE = 'a'.repeat(40)
    const BASE_TIP = 'b'.repeat(40)
    const BRANCH_HEAD = 'c'.repeat(40)
    const host: RunHostCommand = async (cmd) => {
      if (cmd.includes('merge-base')) return ok(REVIEW_BASE)
      if (cmd.includes('rev-parse') && cmd.includes('--verify')) {
        // `main` → the moved tip; the branch → its own head.
        return ok(cmd.some((a) => a.includes('feat-drift')) ? BRANCH_HEAD : BASE_TIP)
      }
      // Both "what did the base add" and "what did the branch change" name the
      // SAME file → a silent overlap nothing reviewed.
      if (cmd.includes('diff') && cmd.includes('--name-only')) return ok('flush.ts')
      if (cmd.includes('rev-list')) return ok(BASE_TIP)
      return ok()
    }
    let arbiterCalls = 0
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      arbitrate: async () => {
        arbiterCalls++
        return { kind: 'decision', option_id: CONFLICT_ARBITER_RETRY_OPTION, reasoning: 'x' }
      },
    })

    await expect(cleanupAfterMerge(run, deps)).rejects.toMatchObject({
      name: 'TridentBaseDriftHold',
    })
    expect(arbiterCalls).toBe(0)
  })

  test('the DIRTY merge-worktree refusal never consults the arbiter (its only alternative is destroying uncommitted work, and the arbiter is read-only)', async () => {
    // A REAL directory: `worktreeDirt` gates on `existsSync` before it probes.
    const wt = mkdtempSync(join(tmpdir(), 'trident-arbiter-wt-'))
    tmpDirs.push(wt)
    const run = makeTridentRun({
      id: 'feat-dirty',
      slug: 's',
      phase: 'done',
      branch: 'feat-dirty',
      pr: null,
      merge_mode: 'local',
      repo_path: '/shared',
      worktree: wt,
      subagent_run_id: null,
      subagent_status: null,
    })
    const host: RunHostCommand = async (cmd) => {
      // `wt` IS a worktree root of ours, and it has uncommitted work.
      if (cmd.includes('--show-toplevel') && cmd.includes(wt)) return ok(`${wt}\n`)
      if (cmd.includes('status') && cmd.includes(wt)) return ok(' M flush.ts\n')
      return ok()
    }
    let arbiterCalls = 0
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      arbitrate: async () => {
        arbiterCalls++
        return { kind: 'decision', option_id: CONFLICT_ARBITER_RETRY_OPTION, reasoning: 'x' }
      },
    })

    await expect(cleanupAfterMerge(run, deps)).rejects.toThrow(
      /uncommitted changes that exist nowhere else/,
    )
    expect(arbiterCalls).toBe(0)
  })

  test('a clean rebase consults neither the resolver nor the arbiter', async () => {
    const run = localRun('feat-clean')
    const { host } = conflictingHost(wtOf('/shared', run), 0)
    let resolverCalls = 0
    let arbiterCalls = 0
    const deps = buildMergeCleanupDeps(host, {
      base_branch: 'main',
      resolve_conflict: async () => {
        resolverCalls++
        return { resolved: true }
      },
      arbitrate: async () => {
        arbiterCalls++
        return { kind: 'unavailable', reason: 'x' }
      },
    })
    await cleanupAfterMerge(run, deps)
    expect(resolverCalls).toBe(0)
    expect(arbiterCalls).toBe(0)
  })
})

describe('#541 — the option set the seam hands the arbiter', () => {
  test('is non-empty and contains no forbidden id (the arbiter must never be handed an empty list)', () => {
    expect(CONFLICT_ARBITRATION_OPTIONS.length).toBeGreaterThan(0)
    // The arbiter's OWN structural guard accepts it — so this set can never be
    // the miswired-caller case that degrades to `unavailable`.
    expect(() => assertArbitrableOptions([...CONFLICT_ARBITRATION_OPTIONS])).not.toThrow()
    // More than one real choice: a one-option list is a leading question.
    expect(new Set(CONFLICT_ARBITRATION_OPTIONS.map((o) => o.id)).size).toBeGreaterThan(1)
    expect(CONFLICT_ARBITRATION_OPTIONS.map((o) => o.id)).toContain(CONFLICT_ARBITER_RETRY_OPTION)
    for (const option of CONFLICT_ARBITRATION_OPTIONS) {
      expect(option.description.length).toBeGreaterThan(0)
    }
  })
})
