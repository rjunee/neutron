/**
 * Phase 2b — terminal board reconcile, and its end-to-end wiring through the
 * durable tick loop's `on_terminal` observer hook.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { WorkBoardStore } from '@neutronai/work-board/store.ts'
import { buildBoardReconcileObserver } from './board-reconcile.ts'
import { dispatchBoardBoundBuild } from './board-dispatch.ts'
import { buildSimFirer, buildSimMutationProofGate } from './inner-loop-sim.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { runProgressForItem } from './run-progress.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore } from './store.ts'
import { TridentTickLoop } from './tick.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore
let board: WorkBoardStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-board-reconcile-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
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

  test('terminal outcomes complete/fail their bound items and KEEP the evidence link', async () => {
    const obs = buildBoardReconcileObserver(board)!
    const a = await board.create('proj-1', { title: 'thing A' })
    const b = await board.create('proj-1', { title: 'thing B' })
    await board.attachRun('proj-1', a.id, 'run-a')
    await board.attachRun('proj-1', b.id, 'run-b')

    await obs({ project_slug: 'proj-1', id: 'run-a', phase: 'done' } as never)
    await obs({ project_slug: 'proj-1', id: 'run-b', phase: 'failed' } as never)

    expect(board.get('proj-1', a.id)?.status).toBe('done')
    // Successful runs retain their link too: completed history may need to show
    // a recovered alert that is not a terminal failure reason.
    expect(board.get('proj-1', a.id)?.linked_run_id).toBe('run-a')
    // #340 — a failed run shows FAILED + keeps its run link (so the client
    // derives the red dot + reason + retry), NOT a revert to upcoming/unlinked.
    expect(board.get('proj-1', b.id)?.status).toBe('failed')
    expect(board.get('proj-1', b.id)?.linked_run_id).toBe('run-b')
  })
})

describe('durable PR provenance — the number is written by the terminal reconcile', () => {
  const WEB = 'https://github.com/acme/widget'

  test('a done run writes pr/pr_url onto the ITEM; the re-read after detach still has it', async () => {
    // NOTE: no `run_progress` anywhere in this test, and nothing hand-builds an
    // item. That is the point — a completed card's number must come off the
    // ITEM, because the detach below removes the only binding it could be
    // derived from. Drop migration 0122's columns (or detachRun's write) and
    // this goes red.
    const repos: string[] = []
    const obs = buildBoardReconcileObserver(board, {
      resolveRepoWebUrl: async (repo_path) => {
        repos.push(repo_path)
        return WEB
      },
    })!
    const a = await board.create('proj-1', { title: 'ship the export button' })
    await board.attachRun('proj-1', a.id, 'run-a')

    await obs({
      project_slug: 'proj-1',
      id: 'run-a',
      phase: 'done',
      pr: 265,
      repo_path: '/srv/repos/widget',
    } as never)

    const reread = board.get('proj-1', a.id)!
    expect(reread.status).toBe('done')
    // Main KEEPS the terminal binding on `done` (completed history still derives
    // recovered run evidence from it). This branch was written when `done` NULLed it.
    expect(reread.linked_run_id).not.toBeNull()
    expect(reread.completed_at).not.toBeNull()
    expect(reread.pr).toBe(265)
    expect(reread.pr_url).toBe('https://github.com/acme/widget/pull/265')
    // The repo came from the RUN's own path — never a hardcoded one.
    expect(repos).toEqual(['/srv/repos/widget'])
  })

  test('a failed run writes pr/pr_url too, and keeps its binding (#340)', async () => {
    const obs = buildBoardReconcileObserver(board, { resolveRepoWebUrl: async () => WEB })!
    const b = await board.create('proj-1', { title: 'the one that broke' })
    await board.attachRun('proj-1', b.id, 'run-b')

    await obs({
      project_slug: 'proj-1',
      id: 'run-b',
      phase: 'failed',
      pr: 261,
      repo_path: '/srv/repos/widget',
    } as never)

    const reread = board.get('proj-1', b.id)!
    expect(reread.status).toBe('failed')
    expect(reread.linked_run_id).toBe('run-b')
    expect(reread.pr).toBe(261)
    expect(reread.pr_url).toBe('https://github.com/acme/widget/pull/261')
  })

  test('a resolver that THROWS still lands the reconcile, with a null url', async () => {
    const obs = buildBoardReconcileObserver(board, {
      resolveRepoWebUrl: async () => {
        throw new Error('git exploded')
      },
    })!
    const a = await board.create('proj-1', { title: 'broken remote' })
    await board.attachRun('proj-1', a.id, 'run-a')

    await obs({
      project_slug: 'proj-1',
      id: 'run-a',
      phase: 'done',
      pr: 12,
      repo_path: '/srv/repos/widget',
    } as never)

    const reread = board.get('proj-1', a.id)!
    expect(reread.status).toBe('done') // the reconcile is NOT gated on the link
    // Main KEEPS the terminal binding on `done` (completed history still derives
    // recovered run evidence from it). This branch was written when `done` NULLed it.
    expect(reread.linked_run_id).not.toBeNull()
    expect(reread.pr).toBe(12)
    expect(reread.pr_url).toBeNull() // plain text, never a guessed link
  })

  test('a non-GitHub repo resolves no url — the number still lands', async () => {
    const obs = buildBoardReconcileObserver(board, { resolveRepoWebUrl: async () => null })!
    const a = await board.create('proj-1', { title: 'gitlab shop' })
    await board.attachRun('proj-1', a.id, 'run-a')
    await obs({
      project_slug: 'proj-1',
      id: 'run-a',
      phase: 'done',
      pr: 9,
      repo_path: '/srv/repos/widget',
    } as never)
    const reread = board.get('proj-1', a.id)!
    expect(reread.pr).toBe(9)
    expect(reread.pr_url).toBeNull()
  })

  test('a PR-less run never touches the resolver and leaves both columns NULL', async () => {
    let shells = 0
    const obs = buildBoardReconcileObserver(board, {
      resolveRepoWebUrl: async () => {
        shells++
        return WEB
      },
    })!
    const a = await board.create('proj-1', { title: 'local merge, no PR' })
    await board.attachRun('proj-1', a.id, 'run-a')
    await obs({
      project_slug: 'proj-1',
      id: 'run-a',
      phase: 'done',
      pr: null,
      repo_path: '/srv/repos/widget',
    } as never)
    const reread = board.get('proj-1', a.id)!
    expect(reread.status).toBe('done')
    // Main KEEPS the terminal binding on `done` (completed history still derives
    // recovered run evidence from it). This branch was written when `done` NULLed it.
    expect(reread.linked_run_id).not.toBeNull()
    expect(reread.pr).toBeNull()
    expect(reread.pr_url).toBeNull()
    expect(shells).toBe(0)
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
        resolveBuildRepo: async (home) => home,
        resolveMergeMode: async () => 'pr',
        resolveRalph: async () => false,
      },
    )
    expect(res.ok).toBe(true)
    const run_id = res.ok ? res.run.id : ''
    // Bound: fork lit immediately.
    expect(board.get('proj-1', item.id)?.linked_run_id).toBe(run_id)
    expect(board.get('proj-1', item.id)?.status).toBe('in_progress')

    const alert = 'CODEX_BUILD_BRIEF_PART_CORRUPT: recovered after one bridge retry. DEFERRED.'
    db.raw().run('UPDATE code_trident_runs SET brief_alert = ? WHERE id = ?', [alert, run_id])

    // 2. Drive the durable loop with a sim firer + the reconcile observer wired
    //    into on_terminal (exactly as build-core-modules composes it).
    const sim = buildSimFirer(db, store, () => ({
      result: { verdict: 'APPROVE', prNumber: 7, branch: `trident/${run_id}` },
    }))
    const orch = buildTridentOrchestrator({
    // The real gate needs a git worktree at a path this test does not have.
    prove_mutation: buildSimMutationProofGate(),
      fire_workflow: sim.fire_workflow,
      db_path: join(tmp, 'project.db'),
      // #542 — a host that answers `rev-parse` with '' is a repo the drift gate
      // cannot assess, and pr mode holds on that. Answer as a healthy repo whose
      // base has not moved, so this test exercises the board reconcile it is about.
      run_host: async (cmd) => ({
        ok: true,
        stdout:
          (cmd.includes('rev-parse') && cmd.includes('--verify')) || cmd.includes('merge-base')
            ? '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f'
            : // …and the head is in THIS repo, not a fork, on the base it names:
              // pr mode holds a fork head and a base GitHub will not name, and
              // an empty answer here reads as both.
              cmd.includes('headRefName,baseRefName,isCrossRepository')
              ? 'feat-x\nmain\nfalse'
              : '',
        stderr: '',
        exit_code: 0,
      }),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
    })
    const reconcile = buildBoardReconcileObserver(board, {
      resolveRepoWebUrl: async () => 'https://github.com/acme/widget',
    })!
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
    // 3. The board item is reconciled as completed, but its terminal binding and
    // recovered alert remain derivable in completed history.
    const reconciled = board.get('proj-1', item.id)!
    expect(reconciled.status).toBe('done')
    expect(reconciled.linked_run_id).toBe(run_id)
    expect(reconciled.completed_at).not.toBeNull()
    // Main's assertion: the recovered alert still derives from the RETAINED binding.
    expect(runProgressForItem(reconciled, (id) => store.get(id), Date.now())?.brief_alert).toBe(alert)
    // ...and this branch's: the run's PR number is DURABLE on the item, written by the
    // same reconcile. Both hold now — the binding is kept on `done` AND the number is
    // copied onto the card, so neither assertion is the other's precondition.
    expect(reconciled.pr).toBe(7)
    expect(reconciled.pr_url).toBe('https://github.com/acme/widget/pull/7')
  })
})
