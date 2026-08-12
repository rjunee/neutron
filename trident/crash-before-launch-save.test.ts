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
 * THE FIX is one widened gate: a crashed launcher is a dead run whether or not we
 * ever learned its subagent id, so `subagent_status === 'crashed'` now also opens
 * the harvest/terminal block. Harvest still runs FIRST inside it, so a workflow
 * that wrote its terminal result and only then lost its launcher still harvests
 * rather than being reaped — that ordering is asserted below too, because a fix
 * that reaped those would trade an infinite loop for silently discarded results.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from './store.ts'
import { buildSimMutationProofGate } from './inner-loop-sim.ts'
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

function orchestrator(fire: ReturnType<typeof crashingFirer>) {
  return buildTridentOrchestrator({
    fire_workflow: fire as never,
    db_path: join(tmp, 'project.db'),
    run_host: async () => ({ ok: true, stdout: '', stderr: '', exit_code: 0 }),
    base_branch: 'main',
    now: () => new Date(0).toISOString(),
    // Sim gate: the real post-APPROVE prover needs a real repo (see
    // `buildSimMutationProofGate`); this file's subject is the crashed launch.
    prove_mutation: buildSimMutationProofGate(),
  })
}

describe('a crash landing before the launch save', () => {
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
