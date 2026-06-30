/**
 * Phase 2b — terminal board reconcile, and its end-to-end wiring through the
 * durable tick loop's `on_terminal` observer hook.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import { WorkBoardStore } from '../work-board/store.ts'
import { buildBoardReconcileObserver } from './board-reconcile.ts'
import { dispatchBoardBoundBuild } from './board-dispatch.ts'
import { buildSimFirer } from './inner-loop-sim.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore } from './store.ts'
import { TridentTickLoop } from './tick.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore
let board: WorkBoardStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-board-reconcile-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
  board = new WorkBoardStore(db)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('buildBoardReconcileObserver', () => {
  test('returns null when no board is wired', () => {
    expect(buildBoardReconcileObserver(undefined)).toBeNull()
  })

  test('a done run completes its bound item; a failed run returns it to upcoming', async () => {
    const obs = buildBoardReconcileObserver(board)!
    const a = await board.create('proj-1', { title: 'thing A' })
    const b = await board.create('proj-1', { title: 'thing B' })
    await board.attachRun('proj-1', a.id, 'run-a')
    await board.attachRun('proj-1', b.id, 'run-b')

    await obs({ project_slug: 'proj-1', id: 'run-a', phase: 'done' } as never)
    await obs({ project_slug: 'proj-1', id: 'run-b', phase: 'failed' } as never)

    expect(board.get('proj-1', a.id)?.status).toBe('done')
    expect(board.get('proj-1', a.id)?.linked_run_id).toBeNull()
    expect(board.get('proj-1', b.id)?.status).toBe('upcoming')
    expect(board.get('proj-1', b.id)?.linked_run_id).toBeNull()
  })
})

describe('end-to-end — the tick loop reconciles the board on a terminal run', () => {
  test('a board-bound /code build drives to done AND completes its Plan item', async () => {
    // 1. Create a ready Plan item + a board-bound run (the dispatch chokepoint).
    const item = await board.create('proj-1', {
      title: 'wire the export button to the new CSV endpoint with tests',
    })
    const res = await dispatchBoardBoundBuild(
      { board_item_id: item.id, task: 'wire the widget' },
      {
        store,
        board,
        project_slug: 'proj-1',
        repo_path: '/repo',
        resolveMergeMode: async () => 'pr',
        resolveRalph: async () => false,
      },
    )
    expect(res.ok).toBe(true)
    const run_id = res.ok ? res.run.id : ''
    // Bound: fork lit immediately.
    expect(board.get('proj-1', item.id)?.linked_run_id).toBe(run_id)
    expect(board.get('proj-1', item.id)?.status).toBe('in_progress')

    // 2. Drive the durable loop with a sim firer + the reconcile observer wired
    //    into on_terminal (exactly as build-core-modules composes it).
    const sim = buildSimFirer(store, () => ({
      result: { verdict: 'APPROVE', prNumber: 7, branch: `trident/${run_id}` },
    }))
    const orch = buildTridentOrchestrator({
      fire_workflow: sim.fire_workflow,
      db_path: join(tmp, 'project.db'),
      run_host: async () => ({ ok: true, stdout: '', stderr: '', exit_code: 0 }),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
    })
    const reconcile = buildBoardReconcileObserver(board)!
    const loop = new TridentTickLoop({
      store,
      step: orch.step,
      on_terminal: { onTerminal: reconcile },
    })

    let final = store.get(run_id)!
    for (let i = 0; i < 40 && !isTerminalPhase(final.phase); i++) {
      await loop.runOnce()
      await sim.drain()
      final = store.get(run_id)!
    }

    expect(final.phase).toBe('done')
    // 3. The board item is reconciled: completed + binding cleared.
    const reconciled = board.get('proj-1', item.id)!
    expect(reconciled.status).toBe('done')
    expect(reconciled.linked_run_id).toBeNull()
    expect(reconciled.completed_at).not.toBeNull()
  })
})
