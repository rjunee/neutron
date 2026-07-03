import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import type { HostCommandResult } from './git-mode.ts'
import type { FireOutcome, InnerLoopInput } from './inner-loop.ts'
import { buildSimFirer, type SimPlan } from './inner-loop-sim.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore, type MergeMode, type TridentRun } from './store.ts'
import { TridentTickLoop } from './tick.ts'

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
  resolve_conflict?: import('./merge.ts').MergeConflictResolver
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
  }
  if (opts.on_orphaned_session !== undefined) o.on_orphaned_session = opts.on_orphaned_session
  if (opts.mint_run_id !== undefined) o.mint_run_id = opts.mint_run_id
  if (opts.max_inflight_ms !== undefined) o.max_inflight_ms = opts.max_inflight_ms
  if (opts.no_advance_hang_ms !== undefined) o.no_advance_hang_ms = opts.no_advance_hang_ms
  if (opts.codex_home !== undefined) o.codex_home = opts.codex_home
  if (opts.resolve_codex_home !== undefined) o.resolve_codex_home = opts.resolve_codex_home
  if (opts.resolve_conflict !== undefined) o.resolve_conflict = opts.resolve_conflict
  const orch = buildTridentOrchestrator(o)
  const loop = new TridentTickLoop({ store, step: orch.step })
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
