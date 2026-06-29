/**
 * Restart-resume — the control-plane-restart recovery contract (Trident v2).
 *
 * A CC Dynamic Workflow is session-bound, so a gateway restart loses the
 * in-flight inner-loop dispatch — but `code_trident_runs` still holds the run
 * with its persisted `subagent_run_id` + `inner_checkpoint`. A FRESH
 * orchestrator (empty in-process dispatch map, like a fresh boot) must RESUME
 * that run: relaunch a fresh workflow exactly once, threading the persisted
 * checkpoint so the workflow skips finished phases + reuses the PR — never a
 * double-launch.
 *
 * These tests simulate a restart by persisting a run mid-flight with a STALE
 * `subagent_run_id`, then building a BRAND-NEW orchestrator over the same store
 * and ticking. The stale id is never in the new instance's map, so the orphan
 * recovery path fires.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import type { HostCommandResult } from './git-mode.ts'
import type { InnerLoopInput, InnerLoopResult } from './inner-loop.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore, type MergeMode, type TridentRun } from './store.ts'
import { TridentTickLoop } from './tick.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-resume-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

interface Spy {
  inner_loop: (input: InnerLoopInput) => Promise<InnerLoopResult>
  inputs: InnerLoopInput[]
}

function spy(verdict: 'APPROVE' | 'REQUEST_CHANGES' = 'APPROVE'): Spy {
  const inputs: InnerLoopInput[] = []
  return {
    inputs,
    inner_loop: async (input) => {
      inputs.push(input)
      return { status: 'completed', verdict, pr_number: 42, branch: 'feat-x', round: 1, checkpoint: verdict === 'APPROVE' ? 'argus-approved' : 'argus-request-changes', raw: '' }
    },
  }
}

function freshBoot(
  s: Spy,
  opts: { on_orphaned_session?: 'redispatch' | 'wait' | 'fail' } = {},
): { loop: TridentTickLoop; drain: () => Promise<void> } {
  const o: Parameters<typeof buildTridentOrchestrator>[0] = {
    inner_loop: s.inner_loop,
    db_path: join(tmp, 'project.db'),
    run_host: async () => ok(),
    base_branch: 'main',
    now: () => new Date(0).toISOString(),
  }
  if (opts.on_orphaned_session !== undefined) o.on_orphaned_session = opts.on_orphaned_session
  const orch = buildTridentOrchestrator(o)
  return { loop: new TridentTickLoop({ store, step: orch.step }), drain: orch.drain }
}

async function runToTerminal(
  boot: { loop: TridentTickLoop; drain: () => Promise<void> },
  run_id: string,
  max_ticks = 20,
): Promise<TridentRun> {
  for (let i = 0; i < max_ticks; i++) {
    await boot.loop.runOnce()
    await boot.drain()
    const r = store.get(run_id)
    if (r !== null && isTerminalPhase(r.phase)) return r
  }
  const r = store.get(run_id)
  throw new Error(`run did not terminate (last phase: ${r?.phase})`)
}

describe('restart-resume — a lost inner-loop dispatch resumes on a fresh boot', () => {
  test('fresh boot relaunches the lost workflow exactly once → APPROVE → merge → done', async () => {
    const run = await store.create({
      slug: 'mid-flight',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'thing',
      branch: 'feat-x',
      merge_mode: 'pr' as MergeMode,
    })
    await store.update(run.id, {
      subagent_run_id: 'stale-id-from-prior-process',
      subagent_status: 'running',
      pr: 42,
      inner_checkpoint: 'forge-done',
    })

    const s = spy('APPROVE')
    const boot = freshBoot(s)
    const final = await runToTerminal(boot, run.id)

    expect(final.phase).toBe('done')
    // Relaunched exactly once, threading the persisted resume checkpoint + PR.
    expect(s.inputs).toHaveLength(1)
    expect(s.inputs[0]!.resume_checkpoint).toBe('forge-done')
    expect(s.inputs[0]!.run.pr).toBe(42)
  })

  test('the relaunch replaces the stale id with a fresh tracked dispatch', async () => {
    const run = await store.create({
      slug: 'mid-flight-2',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'thing',
      branch: 'feat-x',
      merge_mode: 'pr' as MergeMode,
    })
    await store.update(run.id, { subagent_run_id: 'STALE', subagent_status: 'running' })

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const inputs: InnerLoopInput[] = []
    const orch = buildTridentOrchestrator({
      inner_loop: async (input) => {
        inputs.push(input)
        await gate
        return { status: 'completed', verdict: 'APPROVE', pr_number: 7, branch: 'feat-x', round: 1, checkpoint: 'argus-approved', raw: '' }
      },
      db_path: join(tmp, 'project.db'),
      run_host: async () => ok(),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
    })
    const loop = new TridentTickLoop({ store, step: orch.step })

    await loop.runOnce()
    const mid = store.get(run.id)
    expect(mid?.subagent_run_id).not.toBe('STALE')
    expect(mid?.subagent_run_id).not.toBeNull()
    expect(inputs).toHaveLength(1)

    release()
    await orch.drain()
    const final = await runToTerminal({ loop, drain: orch.drain }, run.id)
    expect(final.phase).toBe('done')
  })
})

describe('restart-resume — alternate orphan policies', () => {
  test("'wait' leaves the orphan untouched (no dispatch, no advance)", async () => {
    const run = await store.create({ slug: 'orphan-wait', project_slug: 't1', repo_path: '/repo', task: 'thing', branch: 'feat-x', merge_mode: 'pr' as MergeMode })
    await store.update(run.id, { subagent_run_id: 'STALE', subagent_status: 'running' })
    const s = spy()
    const boot = freshBoot(s, { on_orphaned_session: 'wait' })

    await boot.loop.runOnce()
    await boot.drain()
    const after = store.get(run.id)
    expect(after?.subagent_run_id).toBe('STALE')
    expect(s.inputs).toHaveLength(0)
  })

  test("'fail' reaps the orphan loudly", async () => {
    const run = await store.create({ slug: 'orphan-fail', project_slug: 't1', repo_path: '/repo', task: 'thing', branch: 'feat-x', merge_mode: 'pr' as MergeMode })
    await store.update(run.id, { subagent_run_id: 'STALE', subagent_status: 'running' })
    const s = spy()
    const boot = freshBoot(s, { on_orphaned_session: 'fail' })

    await boot.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.subagent_status).toBe('crashed')
    expect(after?.failure_reason).toContain('orphaned')
    expect(s.inputs).toHaveLength(0)
  })
})
