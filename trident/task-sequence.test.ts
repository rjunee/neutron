/**
 * @neutronai/trident — task-sequence strategy threading tests.
 *
 * Strategy selection belongs to the initial planner. The orchestrator threads the
 * persisted selection into the inner workflow without consulting repository files.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { HostCommandResult } from './git-mode.ts'
import { buildSimFirer, buildSimMutationProofGate } from './inner-loop-sim.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore } from './store.ts'
import { TridentTickLoop } from './tick.ts'
import { honourDiffOutput } from './testing/diff-output-host.ts'

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })
/** #542 — the base-drift gate has to be able to READ the repo. A host that
 *  answers `rev-parse` with an empty string is not a neutral stub: it is a repo
 *  the gate cannot assess, and pr mode HOLDS on that (`gh pr merge` runs on
 *  GitHub, so there is no loud local failure behind it). This is a healthy repo
 *  whose base has NOT moved. */
const NO_DRIFT_SHA = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f'
const driftFreeHost = (cmd: string[]): HostCommandResult =>
  (cmd.includes('rev-parse') && cmd.includes('--verify')) || cmd.includes('merge-base')
    ? ok(NO_DRIFT_SHA)
    : // …and the PR's head lives in THIS repository, not a fork, on the base it
      // says it targets. pr mode cannot score a fork head against `origin` (so
      // it holds one) and will not guess a base GitHub declines to name — a stub
      // that answers this probe with an empty string reads as both.
      cmd.includes('headRefName,baseRefName,isCrossRepository')
      ? ok('feat-x\nmain\nfalse')
      : ok()


describe('task-sequence strategy threads through to the inner loop', () => {
  let tmp: string
  let db: ProjectDb
  let store: TridentRunStore

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-task-sequence-'))
    seedMigratedDb(join(tmp, 'project.db'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    store = new TridentRunStore(db)
  })
  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('a selected task-sequence run reaches the inner workflow unchanged', async () => {
    const sim = buildSimFirer(db, store, () => ({
      result: { verdict: 'APPROVE', prNumber: 5, branch: 'feat-governed' },
    }))
    const inputs = sim.inputs
    const orch = buildTridentOrchestrator({
    // The real gate needs a git worktree at a path this test does not have.
    prove_mutation: buildSimMutationProofGate(),
      fire_workflow: sim.fire_workflow,
      db_path: join(tmp, 'project.db'),
      run_host: honourDiffOutput(async (cmd) => driftFreeHost(cmd)),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
    })
    const loop = new TridentTickLoop({ store, step: orch.step })
    const run = await store.create({
      slug: 'govern-it',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'Make the code match SPEC.md',
      branch: 'feat-governed',
      execution_strategy: 'task_sequence',
      merge_mode: 'pr',
    })

    for (let i = 0; i < 10; i++) {
      await loop.runOnce()
      await sim.drain() // simulate the detached workflow finishing
      const r = store.get(run.id)
      if (r !== null && isTerminalPhase(r.phase)) break
    }

    expect(store.get(run.id)?.phase).toBe('done')
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.run.execution_strategy).toBe('task_sequence')
  })

})
