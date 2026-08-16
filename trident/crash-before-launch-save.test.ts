/**
 * A crash that lands BEFORE the launch save must not re-fire a build every tick.
 *
 * THE DEFECT, reproduced live by a reviewer on this branch (their probe, their
 * numbers): create a run; make the firer record its crash tombstone BEFORE it
 * returns `{ status: 'fired', launcher_session_key }` — the exact window
 * `trident/store.test.ts` already tests — then tick. Result was `fires=3` after
 * three ticks, `phase='forge-init'`, `subagent_status='crashed'`,
 * `subagent_run_id=null`. Three real detached builds, and no ceiling: the loop
 * fires one more every tick, forever, burning credentials and able to open
 * duplicate PRs.
 *
 * THE CHAIN. `saveIfActive` is vetoed by the crash tombstone, so the dispatch id
 * the firer returned is never written and `subagent_run_id` stays NULL. Every
 * branch that could have reaped the run — harvest, the terminal-status guard, the
 * hang watchdog, orphan recovery — was gated on `subagent_run_id !== null`, so
 * nothing ever observed the `crashed` status. Control then reached
 * `if (run.subagent_run_id === null) return launch(run)`, which is unconditional.
 *
 * THE FIX is one widened gate: `subagent_status === 'crashed'` also opens the
 * harvest/terminal block, whether or not we ever learned the subagent id. Harvest
 * still runs FIRST inside it, so a workflow that wrote its terminal result and only
 * then lost its launcher still harvests rather than being reaped — that ordering is
 * asserted below too, because a fix that reaped those would trade an infinite loop
 * for silently discarded results.
 *
 * WHAT THE REAL INVARIANT IS. This file used to pin the REAP as the fix. The reap is
 * not the invariant; BOUNDEDNESS is. Since "a gateway restart must not kill an
 * in-flight build", a crashed launcher with recovery wired is RELAUNCHED as a
 * continuation instead — so the cases below are split: the first describe pins the
 * UNWIRED behaviour (no `begin_crash_recovery` → the original reap, byte-stable), and
 * the second pins the wired one, where an always-crashing launcher still TERMINATES
 * after a BOUNDED number of fires. Both still go red on the runaway this file exists
 * to stop; neither is weakened.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from './store.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { TridentTickLoop } from './tick.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'crash-before-save-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * A firer that CRASHES ITS OWN GENERATION before reporting success — the race the
 * defect lives in. Counts how many real fires it was asked for.
 */
function crashingFirer(counter: { fires: number }) {
  return async () => {
    counter.fires += 1
    const generation = `generation-${counter.fires}`
    await store.crashRunningByLauncher(generation, 'pooled child exited before the launch save')
    return { status: 'fired' as const, launcher_session_key: generation }
  }
}

function orchestrator(
  fire: ReturnType<typeof crashingFirer>,
  over: Partial<Parameters<typeof buildTridentOrchestrator>[0]> = {},
) {
  return buildTridentOrchestrator({
    fire_workflow: fire as never,
    db_path: join(tmp, 'project.db'),
    run_host: async () => ({ ok: true, stdout: '', stderr: '', exit_code: 0 }),
    base_branch: 'main',
    now: () => new Date(0).toISOString(),
    ...over,
  })
}

describe('a crash landing before the launch save (recovery UNWIRED — the reap)', () => {
  test('does NOT fire a fresh build on every tick', async () => {
    const counter = { fires: 0 }
    const orch = orchestrator(crashingFirer(counter))
    const loop = new TridentTickLoop({ store, step: orch.step })
    const run = await store.create({
      id: 'crash-before-save', slug: 'cbs', project_slug: 'p', repo_path: '/repo', task: 'build',
    })

    await loop.runOnce()
    await loop.runOnce()
    await loop.runOnce()

    // The reviewer measured 3 here. One is the legitimate first attempt; the
    // second and third are the runaway.
    expect(counter.fires).toBe(1)
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
  })

  test('the run reaches a TERMINAL phase, so nothing keeps re-reading it', async () => {
    // Terminality is what actually stops the loop: `listNonTerminal` is the tick's
    // input, so a run stuck at a non-terminal phase comes back every tick no matter
    // how many other guards are added.
    //
    // TWO ticks, not one, and that is the real behaviour rather than a concession:
    // the crash tombstone lands DURING tick 1's fire, and the row is stamped
    // `crashed` by that tick's vetoed save — but the phase is classified at the TOP
    // of a tick, so the reap happens on the next one. The guarantee is that the loop
    // is BOUNDED (one extra tick), not that it is instant. Asserting one tick here
    // would have been asserting something the fix does not claim.
    const counter = { fires: 0 }
    const orch = orchestrator(crashingFirer(counter))
    const loop = new TridentTickLoop({ store, step: orch.step })
    const run = await store.create({
      id: 'terminal-after-crash', slug: 'tac', project_slug: 'p', repo_path: '/repo', task: 'build',
    })

    await loop.runOnce()
    await loop.runOnce()

    const after = store.get(run.id)!
    expect(after.phase).toBe('failed')
    expect(store.listNonTerminal().map((r) => r.id)).not.toContain(run.id)
  })

  test('the recorded reason survives — the operator is told it was the launcher', async () => {
    // A reap that overwrote the reason with something generic would hide WHY, and
    // the crash reason is the only evidence pointing at the pooled child.
    const counter = { fires: 0 }
    const orch = orchestrator(crashingFirer(counter))
    const loop = new TridentTickLoop({ store, step: orch.step })
    const run = await store.create({
      id: 'reason-survives', slug: 'rs', project_slug: 'p', repo_path: '/repo', task: 'build',
    })

    await loop.runOnce()
    await loop.runOnce()

    expect(store.get(run.id)?.failure_reason ?? '').not.toBe('')
  })
})

describe('a crash landing before the launch save (recovery WIRED — the production shape)', () => {
  test('the runaway is still bounded: fires stop at 1 + the recovery budget, and the run TERMINATES', async () => {
    // THE ORIGINAL CONCERN, UNCHANGED IN SUBSTANCE: a launcher that dies every time
    // must not fire a fresh detached build forever. Recovery re-supervises the build
    // instead of reaping it, but the budget is what keeps the loop finite — this is
    // the reviewer's `fires=1..6, forever` probe, re-pointed at the new routing.
    // RED-mutation: remove the `crash_recoveries >= max` check → fires run away and
    // the run never reaches a terminal phase.
    const counter = { fires: 0 }
    const orch = orchestrator(crashingFirer(counter), {
      begin_crash_recovery: (id) => store.beginCrashRecovery(id),
      max_crash_recoveries: 2,
    })
    const loop = new TridentTickLoop({ store, step: orch.step })
    const run = await store.create({
      id: 'bounded-after-crash', slug: 'bac', project_slug: 'p', repo_path: '/repo', task: 'build',
    })

    for (let i = 0; i < 6; i++) await loop.runOnce()

    expect(counter.fires).toBe(3)
    const after = store.get(run.id)!
    expect(after.phase).toBe('failed')
    expect(store.listNonTerminal().map((r) => r.id)).not.toContain(run.id)
    // The operator is still told it was the LAUNCHER (the reason is never genericised).
    expect(after.failure_reason ?? '').toContain('pooled child exited')
  })

  test('HARVEST STILL WINS — a crashed row with a written result is never relaunched', async () => {
    // (c) The ordering guarantee, asserted against the RECOVERY path this time: a
    // workflow that wrote its terminal result and only then lost its launcher must be
    // harvested, not re-supervised. RED-mutation: put the crash branch above the
    // `parseInnerResult` harvest → this fires a build for a finished workflow and
    // spends budget doing it.
    const counter = { fires: 0 }
    const orch = orchestrator(crashingFirer(counter), {
      begin_crash_recovery: (id) => store.beginCrashRecovery(id),
    })
    const loop = new TridentTickLoop({ store, step: orch.step })
    const run = await store.create({
      id: 'harvest-beats-recovery', slug: 'hbr', project_slug: 'p', repo_path: '/repo', task: 'build',
    })
    await store.update(run.id, {
      subagent_status: 'running', subagent_run_id: 'wf-1', workflow_run_id: 'gen-dead',
    })
    await store.crashRunningByLauncher('gen-dead', 'pooled child exited')
    await store.update(run.id, {
      inner_result: JSON.stringify({ ok: false, verdict: 'REQUEST_CHANGES', round: 3 }),
    })

    await loop.runOnce()

    expect(counter.fires).toBe(0)
    expect(store.get(run.id)?.crash_recoveries).toBe(0)
    // The harvest DECIDED the run (the terminal commit of a crash-latched row is
    // separately gated by `saveIfActive`'s crash veto — pre-existing, untouched here).
    const outcome = await orch.step(store.get(run.id)!)
    expect(outcome.run.phase).toBe('failed')
    expect(outcome.run.failure_reason ?? '').toContain('inner workflow ended at round 3')
    expect(counter.fires).toBe(0)
  })
})

describe('a HEALTHY launch is untouched by the widened gate', () => {
  test('a normal fire still records its dispatch and keeps running', async () => {
    // The guard against over-reaping: widening the gate must not make an ordinary
    // in-flight run look crashed. If this reds, the fix ate the happy path.
    const counter = { fires: 0 }
    const fire = async () => {
      counter.fires += 1
      return { status: 'fired' as const, launcher_session_key: `healthy-${counter.fires}` }
    }
    const orch = orchestrator(fire as never)
    const loop = new TridentTickLoop({ store, step: orch.step })
    const run = await store.create({
      id: 'healthy-run', slug: 'ok', project_slug: 'p', repo_path: '/repo', task: 'build',
    })

    await loop.runOnce()
    const afterFirst = store.get(run.id)!
    expect(afterFirst.phase).not.toBe('failed')

    // A second tick must NOT fire again either — it is in flight, not idle.
    await loop.runOnce()
    expect(counter.fires).toBe(1)
  })
})
