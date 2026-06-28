import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import type { HostCommandResult } from './git-mode.ts'
import type { InnerLoopInput, InnerLoopResult, TridentInnerLoop } from './inner-loop.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore, type MergeMode, type TridentRun } from './store.ts'
import { TridentTickLoop } from './tick.ts'

/**
 * Trident v2 — the orchestrator step is now INNER-LOOP-driven: it launches one
 * CC Dynamic Workflow per run via an injected `TridentInnerLoop`, then merges on
 * APPROVE / fails on REQUEST_CHANGES (maxRounds) or a crashed dispatch. These
 * tests inject a FAKE `TridentInnerLoop` (no live claude / Workflow tool).
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

const result = (over: Partial<InnerLoopResult> = {}): InnerLoopResult => ({
  status: 'completed',
  verdict: 'APPROVE',
  pr_number: 42,
  branch: 'feat-x',
  round: 1,
  checkpoint: 'argus-approved',
  raw: '',
  ...over,
})

interface Harness {
  loop: TridentTickLoop
  drain: () => Promise<void>
  hostCalls: string[][]
  inputs: InnerLoopInput[]
}

function buildHarness(opts: {
  inner_loop: TridentInnerLoop
  hostResponder?: (cmd: string[]) => HostCommandResult
  on_orphaned_session?: 'redispatch' | 'wait' | 'fail'
  mint_run_id?: () => string
}): Harness {
  const hostCalls: string[][] = []
  const inputs: InnerLoopInput[] = []
  const inner_loop: TridentInnerLoop = (input) => {
    inputs.push(input)
    return opts.inner_loop(input)
  }
  const host = async (cmd: string[]): Promise<HostCommandResult> => {
    hostCalls.push(cmd)
    return opts.hostResponder ? opts.hostResponder(cmd) : ok()
  }
  const o: Parameters<typeof buildTridentOrchestrator>[0] = {
    inner_loop,
    db_path: join(tmp, 'project.db'),
    run_host: host,
    base_branch: 'main',
    now: () => new Date(0).toISOString(),
  }
  if (opts.on_orphaned_session !== undefined) o.on_orphaned_session = opts.on_orphaned_session
  if (opts.mint_run_id !== undefined) o.mint_run_id = opts.mint_run_id
  const orch = buildTridentOrchestrator(o)
  const loop = new TridentTickLoop({ store, step: orch.step })
  return { loop, drain: orch.drain, hostCalls, inputs }
}

async function runToTerminal(h: Harness, run_id: string, max_ticks = 20): Promise<TridentRun> {
  for (let i = 0; i < max_ticks; i++) {
    await h.loop.runOnce()
    await h.drain()
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

describe('orchestrator — APPROVE → done → merge', () => {
  test('pr mode: launches the inner loop, merges PR, persists inner_verdict', async () => {
    const h = buildHarness({ inner_loop: async () => result({ verdict: 'APPROVE', pr_number: 42 }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(final.pr).toBe(42)
    expect(final.branch).toBe('feat-x')
    expect(final.inner_verdict).toBe('APPROVE')
    expect(final.inner_checkpoint).toBe('argus-approved')
    expect(final.workflow_run_id).not.toBeNull()
    expect(h.hostCalls.map((c) => c.join(' '))).toContain('gh pr merge 42 --squash')
    // exactly one inner-loop dispatch.
    expect(h.inputs.length).toBe(1)
  })

  test('local mode: merges branch into base locally, never calls gh merge', async () => {
    const h = buildHarness({ inner_loop: async () => result({ branch: 'feat-x' }) })
    const run = await createRun({ merge_mode: 'local' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    const joined = h.hostCalls.map((c) => c.join(' '))
    expect(joined).toContain('git -C /repo checkout main')
    expect(joined.some((c) => c.startsWith('git -C /repo merge --no-ff feat-x'))).toBe(true)
    expect(joined.some((c) => c.startsWith('gh pr merge'))).toBe(false)
  })
})

describe('orchestrator — REQUEST_CHANGES (maxRounds exhausted) → failed', () => {
  test('a REQUEST_CHANGES inner result fails the run without merging', async () => {
    const h = buildHarness({ inner_loop: async () => result({ verdict: 'REQUEST_CHANGES', round: 3 }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('without Argus APPROVE')
    expect(final.inner_verdict).toBe('REQUEST_CHANGES')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('pr merge'))).toBe(false)
  })
})

describe('orchestrator — crashed / timed-out inner loop → failed', () => {
  test('a crashed inner loop fails the run (no silent success)', async () => {
    const h = buildHarness({ inner_loop: async () => result({ status: 'failed', verdict: null }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.subagent_status).toBe('failed')
    expect(final.failure_reason).toContain('failed')
  })

  test('a timed-out inner loop fails the run', async () => {
    const h = buildHarness({ inner_loop: async () => result({ status: 'timed_out', verdict: null }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('timed_out')
  })

  test('an inner loop that THROWS is caught and fails the run', async () => {
    const h = buildHarness({
      inner_loop: async () => {
        throw new Error('boom in the workflow')
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
  })
})

describe('orchestrator — idempotent crash-resume', () => {
  test('a prior partial run threads resume_checkpoint + reuses the existing PR (no dup)', async () => {
    const h = buildHarness({ inner_loop: async () => result({ verdict: 'APPROVE', pr_number: 7 }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    // Simulate a crash that left a checkpoint + an opened PR on the row.
    await store.update(run.id, { pr: 7, inner_checkpoint: 'argus-request-changes' })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    // The inner loop was launched with the resume checkpoint + the existing PR.
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.resume_checkpoint).toBe('argus-request-changes')
    expect(h.inputs[0]!.run.pr).toBe(7)
  })

  test('when the row has no PR but gh finds one, it is folded in (no duplicate open)', async () => {
    const h = buildHarness({
      inner_loop: async () => result({ verdict: 'APPROVE', pr_number: 99 }),
      hostResponder: (cmd) => (cmd.includes('pr') && cmd.includes('list') ? ok('99') : ok()),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    // gh pr list was consulted and the discovered PR threaded into the dispatch.
    expect(h.hostCalls.some((c) => c.join(' ').includes('gh pr list --head feat-x'))).toBe(true)
    expect(h.inputs[0]!.run.pr).toBe(99)
  })
})

describe('orchestrator — orphan recovery', () => {
  test('redispatch (default) relaunches a lost dispatch exactly once, resuming from the checkpoint', async () => {
    const h = buildHarness({ inner_loop: async () => result({ verdict: 'APPROVE' }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    // A run whose dispatch was lost on restart (stale id, persisted checkpoint).
    await store.update(run.id, {
      subagent_run_id: 'stale-id-from-prior-process',
      subagent_status: 'running',
      pr: 42,
      inner_checkpoint: 'forge-done',
    })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    // Exactly one (re)dispatch, carrying the persisted resume checkpoint.
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.resume_checkpoint).toBe('forge-done')
  })

  test("'wait' policy leaves the orphan untouched (no dispatch, no advance)", async () => {
    const h = buildHarness({
      inner_loop: async () => result(),
      on_orphaned_session: 'wait',
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, { subagent_run_id: 'STALE', subagent_status: 'running' })

    await h.loop.runOnce()
    await h.drain()
    const after = store.get(run.id)
    expect(after?.phase).not.toBe('done')
    expect(after?.subagent_run_id).toBe('STALE')
    expect(h.inputs).toHaveLength(0)
  })

  test("'fail' policy reaps the orphan loudly", async () => {
    const h = buildHarness({
      inner_loop: async () => result(),
      on_orphaned_session: 'fail',
    })
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

describe('orchestrator — resume safety (no double-launch)', () => {
  test('a re-entrant tick while the inner loop is in flight does NOT launch again', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const h = buildHarness({
      inner_loop: async () => {
        calls++
        await gate
        return result({ verdict: 'APPROVE' })
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()
    const afterLaunch = store.get(run.id)
    expect(afterLaunch?.subagent_run_id).not.toBeNull()
    expect(calls).toBe(1)

    // Re-enter twice while the dispatch is still pending — must poll, not relaunch.
    await h.loop.runOnce()
    await h.loop.runOnce()
    expect(calls).toBe(1)

    release()
    await h.drain()
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
  })
})
