import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { HostCommandResult } from './git-mode.ts'
import type { FireOutcome, InnerLoopInput } from './inner-loop.ts'
import { buildSimFirer, type SimPlan } from './inner-loop-sim.ts'
import { buildTridentOrchestrator, isTridentHarvestTerminal } from './orchestrator.ts'
import { runWorktreePath } from './merge.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore, type MergeMode, type TridentRun } from './store.ts'
import { TridentTickLoop, type TridentTerminalHook } from './tick.ts'
import { NexusStore } from '@neutronai/gateway/nexus/nexus-store.ts'
import { emitTridentTerminalEvents } from '@neutronai/gateway/nexus/nexus-emit.ts'

/**
 * Trident v2 (Work Board Phase 2a exec-model) — the orchestrator step now FIRES
 * one CC Dynamic Workflow per run (the launching turn settles immediately) and
 * HARVESTS the workflow's TYPED terminal result from `code_trident_runs.
 * inner_result` by runId, server-gating a merge-eligible APPROVE against the
 * recorded `inner_checkpoint='argus-approved'`. These tests inject a FAKE firer
 * (`buildSimFirer`) whose simulated workflow writes its result to the DB on a
 * `complete()` drain — no live `claude` / `Workflow` tool.
 */

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-orch-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

interface Harness {
  loop: TridentTickLoop
  /** Flush queued workflow completions (write their `inner_result` to the DB). */
  complete: () => Promise<void>
  hostCalls: string[][]
  inputs: InnerLoopInput[]
}

function buildHarness(opts: {
  plan: (input: InnerLoopInput) => SimPlan
  hostResponder?: (cmd: string[]) => HostCommandResult
  on_orphaned_session?: 'redispatch' | 'wait' | 'fail'
  mint_run_id?: () => string
  now?: () => string
  max_inflight_ms?: number
  no_advance_hang_ms?: number
  codex_home?: string | null
  resolve_codex_home?: (run: TridentRun) => string | null
  resolve_reflection_context?: (run: TridentRun) => string | null
  resolve_conflict?: import('./merge.ts').MergeConflictResolver
  on_terminal?: TridentTerminalHook
}): Harness {
  const hostCalls: string[][] = []
  const now = opts.now ?? (() => new Date(0).toISOString())
  // Bind the store to the SAME clock as the orchestrator so `last_advanced_at`
  // (re-stamped by store.save) and the orchestrator's stall computation share one
  // time base — production runs both on wall-clock; the tests run both on the
  // fake clock (mismatched clocks would make `elapsedSinceAdvance` meaningless).
  store = new TridentRunStore(db, now)
  const sim = buildSimFirer(store, opts.plan)
  const host = async (cmd: string[]): Promise<HostCommandResult> => {
    hostCalls.push(cmd)
    return opts.hostResponder ? opts.hostResponder(cmd) : ok()
  }
  const o: Parameters<typeof buildTridentOrchestrator>[0] = {
    fire_workflow: sim.fire_workflow,
    db_path: join(tmp, 'project.db'),
    run_host: host,
    base_branch: 'main',
    now,
    // RALPH RE-FIRE (#362) — null the harvested `inner_result` out-of-band so a
    // re-fired run isn't re-harvested (production wires the identical seam).
    clear_inner_result: (id) => store.update(id, { inner_result: null }).then(() => {}),
  }
  if (opts.on_orphaned_session !== undefined) o.on_orphaned_session = opts.on_orphaned_session
  if (opts.mint_run_id !== undefined) o.mint_run_id = opts.mint_run_id
  if (opts.max_inflight_ms !== undefined) o.max_inflight_ms = opts.max_inflight_ms
  if (opts.no_advance_hang_ms !== undefined) o.no_advance_hang_ms = opts.no_advance_hang_ms
  if (opts.codex_home !== undefined) o.codex_home = opts.codex_home
  if (opts.resolve_codex_home !== undefined) o.resolve_codex_home = opts.resolve_codex_home
  if (opts.resolve_reflection_context !== undefined)
    o.resolve_reflection_context = opts.resolve_reflection_context
  if (opts.resolve_conflict !== undefined) o.resolve_conflict = opts.resolve_conflict
  const orch = buildTridentOrchestrator(o)
  const loop = new TridentTickLoop({
    store,
    step: orch.step,
    ...(opts.on_terminal !== undefined ? { on_terminal: opts.on_terminal } : {}),
  })
  return { loop, complete: sim.drain, hostCalls, inputs: sim.inputs }
}

/** Tick, then simulate the in-flight workflow finishing (write its result), so a
 *  fired run reaches its harvest on the next tick. */
async function runToTerminal(h: Harness, run_id: string, max_ticks = 20): Promise<TridentRun> {
  for (let i = 0; i < max_ticks; i++) {
    await h.loop.runOnce()
    await h.complete()
    const r = store.get(run_id)
    if (r !== null && isTerminalPhase(r.phase)) return r
  }
  const r = store.get(run_id)
  throw new Error(`run did not terminate (last phase: ${r?.phase})`)
}

async function createRun(over: Partial<Parameters<TridentRunStore['create']>[0]> = {}) {
  return store.create({
    slug: 'add-thing',
    project_slug: 't1',
    repo_path: '/repo',
    task: 'Add a thing',
    branch: 'feat-x',
    ...over,
  })
}

describe('orchestrator — APPROVE → done → merge (server-gated)', () => {
  test('pr mode: fires, harvests inner_result, merges PR, persists inner_verdict', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(final.pr).toBe(42)
    expect(final.branch).toBe('feat-x')
    expect(final.inner_verdict).toBe('APPROVE')
    expect(final.inner_checkpoint).toBe('argus-approved')
    expect(final.workflow_run_id).not.toBeNull()
    expect(h.hostCalls.map((c) => c.join(' '))).toContain('gh pr merge 42 --squash')
    // exactly one fire.
    expect(h.inputs.length).toBe(1)
  })

  test('local mode: merges branch into base locally, never calls gh merge', async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }) })
    const run = await createRun({ merge_mode: 'local' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    const joined = h.hostCalls.map((c) => c.join(' '))
    expect(joined).toContain('git -C /repo checkout main')
    expect(joined.some((c) => c.startsWith('git -C /repo merge --no-ff feat-x'))).toBe(true)
    expect(joined.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    // #351 — the run row now RECORDS its dedicated merge worktree (was always
    // empty), and the rebase ran inside it (isolation), not the shared checkout.
    expect(final.worktree).toBe(runWorktreePath('/repo', final))
    expect(joined.some((c) => c.includes(`worktree add --detach --force ${final.worktree}`))).toBe(true)
    expect(joined.some((c) => c === `git -C ${final.worktree} rebase main`)).toBe(true)
  })
})

describe('orchestrator — merge conflict (#342): resolve vs escalate to chat', () => {
  // A host whose initial rebase conflicts (then succeeds after --continue).
  const conflictingHost = (): ((cmd: string[]) => HostCommandResult) => {
    let rebased = false
    return (cmd) => {
      if (cmd.includes('rebase') && !cmd.includes('--continue') && !cmd.includes('--abort')) {
        if (!rebased) {
          rebased = true
          return { ok: false, stdout: '', stderr: 'CONFLICT (content): Merge conflict in shared.ts', exit_code: 1 }
        }
      }
      if (cmd.includes('diff') && cmd.includes('--diff-filter=U')) {
        return { ok: true, stdout: 'shared.ts', stderr: '', exit_code: 0 }
      }
      return ok()
    }
  }

  test('the Forge resolver fixes the conflict → the build still lands (done)', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: conflictingHost(),
      resolve_conflict: async () => ({ resolved: true }),
    })
    const run = await createRun({ merge_mode: 'local' as MergeMode })
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('rebase --continue'))).toBe(true)
  })

  test('an ambiguous conflict → failed with the SPECIFIC question as the reason (not "merge failed")', async () => {
    const question = 'shared.ts: which flush() behaviour do you want?'
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: conflictingHost(),
      resolve_conflict: async () => ({ resolved: false, question }),
    })
    const run = await createRun({ merge_mode: 'local' as MergeMode })
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    // The failure reason IS the specific question (the terminal delivery posts it
    // verbatim to chat) — never a raw "merge failed".
    expect(final.failure_reason).toBe(question)
    expect(final.failure_reason).not.toContain('merge failed')
  })
})

describe('orchestrator — server-gated verdict provenance', () => {
  test('a self-asserted APPROVE with no recorded argus-approved checkpoint is REJECTED → failed (no merge)', async () => {
    // The workflow's result claims APPROVE, but the recorded provenance checkpoint
    // is argus-request-changes — the merge gate must NOT trust the result line.
    const h = buildHarness({
      plan: () => ({
        result: { verdict: 'APPROVE', prNumber: 7, branch: 'feat-x' },
        argusCheckpoint: 'argus-request-changes',
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('provenance gate')
    expect(final.inner_verdict).toBe('REQUEST_CHANGES')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('pr merge'))).toBe(false)
  })
})

describe('orchestrator — REQUEST_CHANGES (maxRounds exhausted) → failed', () => {
  test('a REQUEST_CHANGES inner result fails the run without merging', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', round: 3, prNumber: 7, branch: 'feat-x' } }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('without Argus APPROVE')
    expect(final.inner_verdict).toBe('REQUEST_CHANGES')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('pr merge'))).toBe(false)
  })
})

describe('orchestrator — RALPH RE-FIRE (#362): multi-task build re-fires per task, merges once at 0', () => {
  // The bug: a multi-task Ralph build shipped after ONLY task 1 (the inner loop
  // built plan.topTask, then the outer merged with no remaining-tasks check). The
  // fix: the inner iteration emits `remainingTasks`; the outer RE-FIRES a fresh
  // iteration per remaining task and merges only when it reaches 0.
  //
  // This drives the REAL orchestrator + store + tick + migrations end-to-end with
  // a simulated inner workflow that returns remaining=2 → 1 → 0 (APPROVE) across
  // successive fires — the production harvest/re-fire/merge path, not a unit test
  // on the dead state-machine.
  test('a 3-task plan re-fires twice (fresh context each) and merges only at remaining=0', async () => {
    // Per-fire script: each fire is a SEPARATE inner iteration (fresh context). The
    // firer records every InnerLoopInput so we can assert re-fires + resume folding.
    let fireCount = 0
    const branch = 'trident/multi-task'
    const h = buildHarness({
      plan: (): SimPlan => {
        fireCount += 1
        if (fireCount === 1) {
          // Task 1 built, 2 remain → intermediate re-fire result (NOT reviewed).
          return {
            result: { verdict: 'REQUEST_CHANGES', prNumber: 55, branch, remainingTasks: 2, checkpoint: 'ralph-task-built' },
            argusCheckpoint: 'ralph-task-built',
          }
        }
        if (fireCount === 2) {
          // Task 2 built, 1 remains → another re-fire.
          return {
            result: { verdict: 'REQUEST_CHANGES', prNumber: 55, branch, remainingTasks: 1, checkpoint: 'ralph-task-built' },
            argusCheckpoint: 'ralph-task-built',
          }
        }
        // Task 3 (final) built, 0 remain → reviewed + APPROVED → the merge path.
        return {
          result: { verdict: 'APPROVE', prNumber: 55, branch, remainingTasks: 0, checkpoint: 'argus-approved' },
          argusCheckpoint: 'argus-approved',
        }
      },
    })
    const run = await createRun({ ralph: true, branch, merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)

    // Only the FINAL task's APPROVE merged — and it merged exactly once.
    expect(final.phase).toBe('done')
    expect(final.inner_verdict).toBe('APPROVE')
    expect(final.inner_checkpoint).toBe('argus-approved')
    const mergeCalls = h.hostCalls.map((c) => c.join(' ')).filter((c) => c.includes('gh pr merge'))
    expect(mergeCalls).toEqual(['gh pr merge 55 --squash'])

    // THREE inner iterations fired — one per task (the bug shipped after ONE).
    expect(h.inputs.length).toBe(3)
    // Each re-fire is a FRESH context (a brand-new Workflow launch), and fires 2 & 3
    // RESUME onto the same branch via the workflow-written 'ralph-task-built'
    // checkpoint (re-plan the next task; never accumulate one context).
    expect(h.inputs[0]!.resume_checkpoint ?? null).toBeNull()
    expect(h.inputs[1]!.resume_checkpoint).toBe('ralph-task-built')
    expect(h.inputs[2]!.resume_checkpoint).toBe('ralph-task-built')
    // The branch/PR is reused across every iteration — never a duplicate build.
    expect(h.inputs.every((i) => i.run.branch === branch)).toBe(true)

    // The ralph-round counter advanced once per re-fire (bounds the loop).
    expect(final.ralph_round).toBe(2)
    // harvested_at is stamped only on the TERMINAL harvest (the merge), not the
    // intermediate re-fires.
    expect(final.harvested_at).not.toBeNull()
  })

  test('a Ralph build that never converges fails at max_ralph_rounds (no infinite re-fire)', async () => {
    // A planner that ALWAYS reports a task still remaining — the fix must fail
    // loudly at the cap rather than re-fire forever.
    const h = buildHarness({
      plan: (): SimPlan => ({
        result: { verdict: 'REQUEST_CHANGES', prNumber: 9, branch: 'trident/loops', remainingTasks: 5, checkpoint: 'ralph-task-built' },
        argusCheckpoint: 'ralph-task-built',
      }),
    })
    const run = await createRun({
      ralph: true,
      branch: 'trident/loops',
      merge_mode: 'pr' as MergeMode,
      max_ralph_rounds: 3,
    })

    const final = await runToTerminal(h, run.id, 40)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('max_ralph_rounds')
    // Never merged.
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('pr merge'))).toBe(false)
    // Bounded: re-fired exactly max_ralph_rounds times before failing (fire 1 +
    // 3 re-fires = the run stops climbing at the cap).
    expect(final.ralph_round).toBe(3)
  })

  test('the intermediate re-fire never leaves a harvestable inner_result behind (no re-harvest loop)', async () => {
    // Regression guard for the wiring trap: saveIfActive never writes inner_result,
    // so a re-fire that failed to null it out-of-band would re-harvest the SAME
    // intermediate result every tick and spin forever. Assert the column is cleared
    // after the re-fire tick.
    let fireCount = 0
    const h = buildHarness({
      plan: (): SimPlan => {
        fireCount += 1
        return fireCount === 1
          ? {
              result: { verdict: 'REQUEST_CHANGES', prNumber: 3, branch: 'trident/clr', remainingTasks: 1, checkpoint: 'ralph-task-built' },
              argusCheckpoint: 'ralph-task-built',
            }
          : {
              result: { verdict: 'APPROVE', prNumber: 3, branch: 'trident/clr', remainingTasks: 0, checkpoint: 'argus-approved' },
              argusCheckpoint: 'argus-approved',
            }
      },
    })
    const run = await createRun({ ralph: true, branch: 'trident/clr', merge_mode: 'pr' as MergeMode })

    // Tick 1: fire iteration 1. Drain writes the intermediate result.
    await h.loop.runOnce()
    await h.complete()
    // Tick 2: harvest the intermediate → re-fire. The row must be reset launchable
    // with inner_result CLEARED and the sub-agent slot released.
    await h.loop.runOnce()
    const afterRefire = store.get(run.id)!
    expect(afterRefire.inner_result).toBeNull()
    expect(afterRefire.subagent_run_id).toBeNull()
    expect(afterRefire.ralph_round).toBe(1)
    expect(isTerminalPhase(afterRefire.phase)).toBe(false)

    // The loop still converges to a merge.
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(h.inputs.length).toBe(2)
  })
})

describe('orchestrator — fire did not settle → failed', () => {
  test('a fire that fails to settle fails the run (no silent success)', async () => {
    const fail: FireOutcome = { status: 'failed', error: 'fire turn closed without a completion event' }
    const h = buildHarness({ plan: () => ({ fire: fail }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason).toContain('fire failed')
  })

  test('a failed fire outcome fails the run', async () => {
    const h = buildHarness({ plan: () => ({ fire: { status: 'failed', error: 'boom' } }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).toBe('failed')
  })
})

describe('orchestrator — idempotent crash-resume', () => {
  test('a prior partial run threads resume_checkpoint + reuses the existing PR (no dup)', async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE', prNumber: 7, branch: 'feat-x' } }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    // Simulate a crash that left a checkpoint + an opened PR on the row.
    await store.update(run.id, { pr: 7, inner_checkpoint: 'argus-request-changes' })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    // The workflow was fired with the resume checkpoint + the existing PR.
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.resume_checkpoint).toBe('argus-request-changes')
    expect(h.inputs[0]!.run.pr).toBe(7)
  })

  test('when the row has no PR but gh finds one, it is folded in (no duplicate open)', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 99, branch: 'feat-x' } }),
      hostResponder: (cmd) => (cmd.includes('pr') && cmd.includes('list') ? ok('99') : ok()),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(h.hostCalls.some((c) => c.join(' ').includes('gh pr list --head feat-x'))).toBe(true)
    expect(h.inputs[0]!.run.pr).toBe(99)
  })
})

describe('orchestrator — crash-safe harvest (result survives a restart)', () => {
  test('a run whose workflow wrote inner_result before a restart HARVESTS (never re-fires)', async () => {
    // A run dispatched by a PRIOR process (subagent_run_id set, NOT in this
    // process's `fired` set) that already wrote a terminal result must harvest,
    // not orphan-redispatch — the durable result, not the lost dispatch, wins.
    const h = buildHarness({ plan: () => ({ result: { verdict: 'REQUEST_CHANGES' } }) /* unused */ })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, {
      subagent_run_id: 'lost-dispatch-from-prior-process',
      subagent_status: 'running',
      pr: 5,
      inner_checkpoint: 'argus-approved',
      inner_verdict: 'APPROVE',
      inner_result: JSON.stringify({
        ok: true,
        prNumber: 5,
        branch: 'feat-x',
        verdict: 'APPROVE',
        round: 1,
        checkpoint: 'argus-approved',
      }),
    })

    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('done')
    expect(after?.pr).toBe(5)
    // No fire happened — the result was harvested straight from the DB.
    expect(h.inputs).toHaveLength(0)
  })
})

describe('orchestrator — stalled workflow guard', () => {
  test('a fired workflow that never writes a result past max_inflight_ms is reaped', async () => {
    let t = 0
    const h = buildHarness({
      // Fire settles, but the workflow NEVER writes a result (result null).
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      max_inflight_ms: 1_000,
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce() // launch + fire (last_advanced_at = t=0)
    expect(store.get(run.id)?.subagent_run_id).not.toBeNull()
    expect(store.get(run.id)?.phase).not.toBe('failed')

    t = 5_000 // advance past max_inflight_ms with no checkpoint/result
    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason).toContain('stalled')
  })
})

describe('orchestrator — per-agent hang watchdog (item 2)', () => {
  test('a fired run that makes no progress past no_advance_hang_ms is reaped as a suspected hang', async () => {
    let t = 0
    const h = buildHarness({
      // Fire settles, but the workflow hangs — never checkpoints, never writes a result.
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: 60_000,
      max_inflight_ms: 2 * 60 * 60_000, // the 2h ceiling stays far away — the hang guard fires first
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce() // launch + fire (last_advanced_at = t=0)
    expect(store.get(run.id)?.phase).not.toBe('failed')

    // Just under the hang threshold — still waiting, not reaped.
    t = 30_000
    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).not.toBe('failed')

    // Past the hang threshold with no advance → reaped to failed with the hang reason.
    t = 90_000
    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason).toContain('suspected agent hang')
  })

  test('a stale orphan past the hang threshold is reaped, not redispatched', async () => {
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: 60_000,
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    // An orphan (dispatch id from a prior process) that has not advanced for a while.
    await store.update(run.id, { subagent_run_id: 'STALE', subagent_status: 'running' })

    t = 120_000 // well past the hang threshold
    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason).toContain('suspected agent hang')
    // Reaped, NOT redispatched.
    expect(h.inputs).toHaveLength(0)
  })
})

describe('orchestrator — orphan recovery', () => {
  test('redispatch (default) re-fires a lost dispatch exactly once, resuming from the checkpoint', async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    // A run whose dispatch was lost on restart (stale id, persisted checkpoint, no result).
    await store.update(run.id, {
      subagent_run_id: 'stale-id-from-prior-process',
      subagent_status: 'running',
      pr: 42,
      inner_checkpoint: 'forge-done',
    })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.resume_checkpoint).toBe('forge-done')
  })

  test("'wait' policy leaves the orphan untouched (no fire, no advance)", async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE' } }), on_orphaned_session: 'wait' })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, { subagent_run_id: 'STALE', subagent_status: 'running' })

    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).not.toBe('done')
    expect(after?.subagent_run_id).toBe('STALE')
    expect(h.inputs).toHaveLength(0)
  })

  test("'fail' policy reaps the orphan loudly", async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE' } }), on_orphaned_session: 'fail' })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, { subagent_run_id: 'STALE', subagent_status: 'running' })

    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.subagent_status).toBe('crashed')
    expect(after?.failure_reason).toContain('orphaned')
    expect(h.inputs).toHaveLength(0)
  })
})

describe('orchestrator — resume safety (no double-fire)', () => {
  test('a re-entrant tick while the workflow is in flight does NOT fire again', async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE', prNumber: 7, branch: 'feat-x' } }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    // Launch tick fires once; do NOT complete the workflow yet.
    await h.loop.runOnce()
    const afterLaunch = store.get(run.id)
    expect(afterLaunch?.subagent_run_id).not.toBeNull()
    expect(h.inputs).toHaveLength(1)

    // Re-enter twice while the workflow is still in flight — must wait, not re-fire.
    await h.loop.runOnce()
    await h.loop.runOnce()
    expect(h.inputs).toHaveLength(1)

    // Now let the workflow finish and harvest.
    await h.complete()
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(h.inputs).toHaveLength(1)
  })
})

describe('orchestrator — CODEX_HOME resolution', () => {
  test('prefers the per-run resolver over the static codex_home', async () => {
    const seen: string[] = []
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
      codex_home: '/static/global',
      resolve_codex_home: (run) => {
        seen.push(run.project_slug)
        return `/resolved/${run.project_slug}`
      },
    })
    const run = await createRun({ project_slug: 't1' })
    await runToTerminal(h, run.id)
    // The resolver was called with the launching run and its output threaded to
    // the inner workflow — NOT the static dir.
    expect(seen).toContain('t1')
    expect(h.inputs[0]?.codex_home).toBe('/resolved/t1')
  })

  test('falls back to the static codex_home when no resolver is supplied', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
      codex_home: '/static/global',
    })
    const run = await createRun({ project_slug: 't1' })
    await runToTerminal(h, run.id)
    expect(h.inputs[0]?.codex_home).toBe('/static/global')
  })

  test('a resolver returning null → codex not connected (null threaded)', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
      codex_home: '/static/global',
      resolve_codex_home: () => null,
    })
    const run = await createRun({ project_slug: 't1' })
    await runToTerminal(h, run.id)
    expect(h.inputs[0]?.codex_home).toBeNull()
  })
})

describe('orchestrator — RB2 (b) reflection-context threading to build agents', () => {
  test('threads the resolved reflection block into the launching run input', async () => {
    const seen: string[] = []
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
      resolve_reflection_context: (run) => {
        seen.push(run.project_slug)
        return '<learned_corrections>\n- never force-push to main\n</learned_corrections>'
      },
    })
    const run = await createRun({ project_slug: 't1' })
    await runToTerminal(h, run.id)
    // The resolver was called with the launching run, and its block was threaded to
    // the inner workflow so the Forge builder (not the argus review gate) re-grounds
    // on owner corrections.
    expect(seen).toContain('t1')
    expect(h.inputs[0]?.reflection_context).toContain('never force-push to main')
  })

  test('threads null when no reflection resolver is wired (clean no-op)', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
    })
    const run = await createRun({ project_slug: 't1' })
    await runToTerminal(h, run.id)
    expect(h.inputs[0]?.reflection_context ?? null).toBeNull()
  })

  test('a THROWING reflection resolver degrades to null and still launches (Codex r4 [P1])', async () => {
    // A reflection-store read failure must NEVER strand a build: the resolver is
    // best-effort, so a throw degrades to no corrections context and the workflow
    // still fires (the run is NOT left stuck non-terminal, retrying every tick).
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
      resolve_reflection_context: () => {
        throw new Error('reflection store read boom')
      },
    })
    const run = await createRun({ project_slug: 't1' })
    await runToTerminal(h, run.id)
    // The workflow was fired (an input was captured) with a null reflection context.
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]?.reflection_context ?? null).toBeNull()
  })
})

describe('orchestrator — terminal-but-garbled harvest guard (Bug 2)', () => {
  test('subagent_status=completed with a NULL inner_result → failed (not stuck at forge-init)', async () => {
    // The inner workflow marked completed but its inner_result is null (the
    // readfile() yielded nothing at UPDATE time). parseInnerResult is null so the
    // normal harvest can't fire; the hang watchdog is DEFEATED because the
    // completed-write re-stamped last_advanced_at (fresh here). The gate must
    // still drive the run terminal.
    let t = 0
    const h = buildHarness({ plan: () => ({ result: null }), now: () => new Date(t).toISOString() })
    const run = await createRun({ merge_mode: 'local' as MergeMode })
    // Simulate the inner workflow's terminal write, but with a null result.
    await store.update(run.id, { subagent_run_id: 'wf-done', subagent_status: 'completed', inner_result: null })
    t = 1_000 // move the clock forward, but NOT past any hang threshold

    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason).toContain('terminal result missing/garbled')
    // Never re-fired, never merged.
    expect(h.inputs).toHaveLength(0)
    expect(h.hostCalls.some((c) => c.join(' ').startsWith('git -C /repo merge'))).toBe(false)
  })

  test('subagent_status=completed with a GARBLED inner_result → failed', async () => {
    let t = 0
    const h = buildHarness({ plan: () => ({ result: null }), now: () => new Date(t).toISOString() })
    const run = await createRun({ merge_mode: 'local' as MergeMode })
    await store.update(run.id, {
      subagent_run_id: 'wf-done',
      subagent_status: 'completed',
      inner_result: '{"ok":true,"verdict":"APPRO', // truncated → unparseable
    })
    t = 1_000

    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason).toContain('terminal result missing/garbled')
  })

  test('a still-running inflight (subagent_status=running, null result) is NOT reaped by the gate', async () => {
    // Guard: the gate only fires on a TERMINAL subagent_status. A healthy in-flight
    // run (running, no result yet, fresh timestamp) must stay waiting.
    let t = 0
    const h = buildHarness({ plan: () => ({ result: null }), now: () => new Date(t).toISOString() })
    const run = await createRun({ merge_mode: 'local' as MergeMode })
    await store.update(run.id, { subagent_run_id: 'wf-live', subagent_status: 'running', inner_result: null })
    t = 1_000

    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).not.toBe('failed')
  })
})

describe('orchestrator — RC2 nexus producer over the REAL post-commit on_terminal seam', () => {
  // Drives a committed terminal transition through the tick loop's `on_terminal`
  // hook (the SAME seam build-core-modules wires the composer's `on_run_terminal`
  // into), with the RC2 producer wired exactly as the composer wires it. Proves
  // the post-commit path actually persists project-scoped events — and would fail
  // if the producer were unwired from `on_terminal`.
  let nexusHome: string
  let nexus: NexusStore
  beforeEach(() => {
    nexusHome = mkdtempSync(join(tmpdir(), 'neutron-orch-nexus-'))
    nexus = new NexusStore({ owner_home: nexusHome })
  })
  afterEach(() => {
    nexus.closeAll()
    rmSync(nexusHome, { recursive: true, force: true })
  })

  const nexusOnTerminal = (store: NexusStore): TridentTerminalHook => ({
    onTerminal: async (run): Promise<void> => {
      await emitTridentTerminalEvents(store, run, {
        harvested: isTridentHarvestTerminal(run),
      })
    },
  })

  async function waitForEvents(project_id: string, atLeast: number) {
    for (let i = 0; i < 200; i++) {
      const rows = await nexus.readRecent(project_id, { limit: 100 })
      if (rows.length >= atLeast) return rows
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error(`timed out waiting for ${atLeast} nexus event(s)`)
  }

  test('a committed APPROVE harvest fires the post-commit hook → handoff + argus decision persist, scoped to the project', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }),
      on_terminal: nexusOnTerminal(nexus),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')

    const rows = await waitForEvents('t1', 2)
    const byKind = new Map(rows.map((e) => [e.kind, e]))
    expect(byKind.get('handoff')?.actor_kind).toBe('orchestrator')
    expect(byKind.get('decision')?.actor_kind).toBe('argus')
    expect(byKind.get('decision')?.body).toContain('APPROVE')
    expect(byKind.get('decision')?.refs_json).toContain('#42')
    // Scoped: another project sees nothing.
    expect(await nexus.readRecent('other', { limit: 100 })).toEqual([])
  })

  test('flag-off analog: no producer wired → the run still terminates, nothing persisted', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }),
      // No on_terminal — mirrors the composer passing no nexus observer (flag off).
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    expect((await runToTerminal(h, run.id)).phase).toBe('done')
    expect(await nexus.readRecent('t1', { limit: 100 })).toEqual([])
  })

  test('a hang-reaped run (no harvest) fires the hook but persists NOTHING (no false handoff/decision)', async () => {
    // A run that never harvests (stalls) → reaped to failed with inner_verdict
    // null. The post-commit hook fires, but the producer emits nothing.
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: 1_000,
      on_terminal: nexusOnTerminal(nexus),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce() // launch (fires the workflow, no result)
    await h.complete()
    t = 10_000 // advance past the hang threshold
    await h.loop.runOnce() // reaped → failed → on_terminal fires
    const final = store.get(run.id)
    expect(final?.phase).toBe('failed')
    expect(final?.inner_verdict).toBeNull()
    await new Promise((r) => setTimeout(r, 20))
    expect(await nexus.readRecent('t1', { limit: 100 })).toEqual([])
  })
})

describe('isTridentHarvestTerminal — the durable outer-harvest marker (harvested_at)', () => {
  const valid = JSON.stringify({
    ok: true,
    verdict: 'APPROVE',
    pr_number: 1,
    branch: 'feat-x',
    round: 1,
    checkpoint: 'argus-approved',
  })

  test('harvested_at set → true (a genuine outer-loop harvest)', async () => {
    const base = await createRun()
    expect(isTridentHarvestTerminal({ ...base, phase: 'done', harvested_at: 123 })).toBe(true)
    expect(isTridentHarvestTerminal({ ...base, phase: 'failed', harvested_at: 456 })).toBe(true)
  })

  test('harvested_at NULL → false — even with a parseable inner_result + an inner-written verdict', async () => {
    // The force-terminate / cancel / stopped case: the DETACHED inner workflow
    // wrote a result + verdict, the outer loop never harvested (harvested_at
    // stays null), and `terminalTransition` flipped the phase.
    const base = await createRun()
    expect(
      isTridentHarvestTerminal({
        ...base,
        phase: 'failed',
        inner_result: valid,
        inner_verdict: 'APPROVE',
        inner_checkpoint: 'argus-approved',
        harvested_at: null,
      }),
    ).toBe(false)
    expect(
      isTridentHarvestTerminal({ ...base, phase: 'stopped', inner_result: valid, harvested_at: null }),
    ).toBe(false)
  })
})

describe('applyResult stamps harvested_at (the outer loop is the ONLY writer)', () => {
  test('a genuine APPROVE harvest commits harvested_at; a force-terminate leaves it null', async () => {
    // APPROVE→done through the real orchestrator: harvested_at is stamped.
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    const done = await runToTerminal(h, run.id)
    expect(done.phase).toBe('done')
    expect(done.harvested_at).not.toBeNull()
    expect(isTridentHarvestTerminal(done)).toBe(true)

    // A LIVE run force-terminated out-of-band (a board X-cancel / stop) — inner
    // wrote a stale result + verdict, but the outer loop never harvested.
    const live = await createRun({ slug: 'other-thing', merge_mode: 'pr' as MergeMode })
    await store.update(live.id, {
      subagent_run_id: 'wf-live',
      subagent_status: 'running',
      inner_result: JSON.stringify({ ok: true, verdict: 'APPROVE', round: 1, checkpoint: 'argus-approved' }),
      inner_verdict: 'APPROVE',
      inner_checkpoint: 'argus-approved',
    })
    const { run: terminated, won } = await store.terminalTransition(live.id, {
      phase: 'failed',
      failure_reason: 'cancelled by owner',
    })
    expect(won).toBe(true)
    expect(terminated?.phase).toBe('failed')
    expect(terminated?.harvested_at).toBeNull() // terminalTransition never sets it
    expect(isTridentHarvestTerminal(terminated!)).toBe(false)
  })
})
