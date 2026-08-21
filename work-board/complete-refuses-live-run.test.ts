/**
 * NOTHING MAY MARK AN ITEM DONE WHILE ITS BUILD IS STILL RUNNING.
 *
 * THE INCIDENT (2026-08-11). The owner's board recorded P1 as `done` while its
 * trident run was still in `forge-init` and the branch was 0 commits ahead of
 * `main` — nothing committed, let alone merged. He had clicked the row's pulsing
 * dot, whose handler advances status and therefore calls `complete()` on an
 * in-progress item. His words: "horribly bad and confusing UX that should never
 * have existed."
 *
 * TWO paths could do it and neither checked anything — that dot, and the
 * `work_board_complete` AGENT TOOL. The guard lives in the STORE for exactly that
 * reason: two call sites already existed, and a third would have inherited the bug.
 *
 * "Done" is a claim that work shipped. It is reconciled from the run reaching a
 * terminal phase; it cannot be asserted by hand or by a model while the build runs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { runDrivingVerdict, WAKEUP_STAND_DOWN_MS } from '@neutronai/trident/run-driving.ts'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'
import { WorkBoardStore, WorkBoardRunStillLiveError } from './store.ts'

const SCOPE = 'proj'
let dir: string
let db: ProjectDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neutron-wb-live-run-'))
  seedMigratedDb(join(dir, 'project.db'))
  db = ProjectDb.open(join(dir, 'project.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A store whose bound runs are live iff their id is in `live`. */
const storeWith = (live: Set<string>): WorkBoardStore =>
  new WorkBoardStore(db, { isRunLive: (id) => live.has(id) })

describe('complete() refuses while the bound run is live', () => {
  test('REFUSES, names the run, and leaves the item UNCHANGED', async () => {
    const store = storeWith(new Set(['run-1']))
    const item = await store.create(SCOPE, { title: 'P1 — email pipeline' })
    await store.attachRun(SCOPE, item.id, 'run-1')

    let caught: unknown = null
    try {
      await store.complete(SCOPE, item.id)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WorkBoardRunStillLiveError)
    expect((caught as WorkBoardRunStillLiveError).run_id).toBe('run-1')
    // A refusal must not half-apply.
    expect(store.get(SCOPE, item.id)?.status).not.toBe('done')
    expect(store.get(SCOPE, item.id)?.completed_at).toBeNull()
  })

  test('ALLOWS once the run is terminal — the real reconcile path still works', async () => {
    const live = new Set(['run-1'])
    const store = storeWith(live)
    const item = await store.create(SCOPE, { title: 'P1' })
    await store.attachRun(SCOPE, item.id, 'run-1')
    live.delete('run-1') // the run reached a terminal phase
    expect((await store.complete(SCOPE, item.id))?.status).toBe('done')
  })

  test('ALLOWS an item with NO bound run — a hand-written checklist item still completes', async () => {
    // The board is not only build-bound. An item the owner typed must stay
    // completable, or this guard breaks ordinary use of the board.
    const store = storeWith(new Set(['run-1']))
    const item = await store.create(SCOPE, { title: 'call the accountant' })
    expect((await store.complete(SCOPE, item.id))?.status).toBe('done')
  })

  test('a VANISHED run does not strand the card forever', async () => {
    // An unknown run is not live: it can never be reconciled either, so refusing
    // permanently would leave the card uncompletable by ANY path.
    const store = storeWith(new Set())
    const item = await store.create(SCOPE, { title: 'P1' })
    await store.attachRun(SCOPE, item.id, 'run-gone')
    expect((await store.complete(SCOPE, item.id))?.status).toBe('done')
  })

  test('with NO isRunLive supplied the store is unguarded — board-less boots keep working', async () => {
    const store = new WorkBoardStore(db)
    const item = await store.create(SCOPE, { title: 'P1' })
    await store.attachRun(SCOPE, item.id, 'run-1')
    expect((await store.complete(SCOPE, item.id))?.status).toBe('done')
  })
})

/**
 * `complete()` WAS NEVER THE ONLY DOOR, AND THE GUARD ON IT WAS A LOCK ON THE
 * DOOR NOBODY HAS TO USE.
 *
 * A review of the stalled-driver change reproduced the 2026-08-11 incident on a
 * store that already had the guard: `update()` takes the full status enum, and
 * `work_board_update` (`work-board/agent-tool.ts`) hands a model's `status`
 * straight to it. Patching `{status:'done'}` walked past the check and stamped
 * `completed_at` mid-build — the same false claim, through the other door.
 *
 * That matters more now, not less: the wakeup prompt this change ships steers a
 * woken agent at the board, so the population of agents holding that tool is
 * exactly the population the guard exists to restrain.
 *
 * The guard therefore lives on `update()`, the single write path, and these tests
 * pin every door to the same answer.
 */
describe('update() refuses the same transition complete() refuses', () => {
  test('REPRO: update({status:"done"}) is REFUSED while the run is live', async () => {
    const store = storeWith(new Set(['run-1']))
    const item = await store.create(SCOPE, { title: 'P1 — email pipeline' })
    await store.attachRun(SCOPE, item.id, 'run-1')

    let caught: unknown = null
    try {
      await store.update(SCOPE, item.id, { status: 'done' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WorkBoardRunStillLiveError)
    expect((caught as WorkBoardRunStillLiveError).run_id).toBe('run-1')
    // The write must not half-apply: no status flip, no datestamp.
    expect(store.get(SCOPE, item.id)?.status).not.toBe('done')
    expect(store.get(SCOPE, item.id)?.completed_at).toBeNull()
  })

  test('a NON-done patch is untouched by the guard — titles still edit mid-build', async () => {
    // The guard is about one claim ("this shipped"), not about freezing the row.
    const store = storeWith(new Set(['run-1']))
    const item = await store.create(SCOPE, { title: 'P1' })
    await store.attachRun(SCOPE, item.id, 'run-1')
    const updated = await store.update(SCOPE, item.id, { title: 'P1 — renamed' })
    expect(updated?.title).toBe('P1 — renamed')
  })

  test('moving to in_progress mid-build is still allowed', async () => {
    const store = storeWith(new Set(['run-1']))
    const item = await store.create(SCOPE, { title: 'P1' })
    await store.attachRun(SCOPE, item.id, 'run-1')
    expect((await store.update(SCOPE, item.id, { status: 'in_progress' }))?.status).toBe(
      'in_progress',
    )
  })

  test('an ALREADY-done item is not re-refused — the guard keys on the TRANSITION', async () => {
    // Re-patching done→done asserts nothing new, so it must not throw; otherwise
    // an idempotent write becomes an error once a run is later re-attached.
    const live = new Set<string>()
    const store = storeWith(live)
    const item = await store.create(SCOPE, { title: 'P1' })
    await store.attachRun(SCOPE, item.id, 'run-1')
    await store.update(SCOPE, item.id, { status: 'done' })
    live.add('run-1')
    expect((await store.update(SCOPE, item.id, { status: 'done' }))?.status).toBe('done')
  })

  test('update() still completes when the run is NOT live', async () => {
    const store = storeWith(new Set())
    const item = await store.create(SCOPE, { title: 'P1' })
    await store.attachRun(SCOPE, item.id, 'run-1')
    expect((await store.update(SCOPE, item.id, { status: 'done' }))?.status).toBe('done')
  })
})

/**
 * THE GUARD DELIBERATELY DISAGREES WITH THE WAKEUP SELECTOR.
 *
 * A round of the stalled-driver change moved `isRunLive` onto the wakeup's
 * `runDrivingVerdict`, so that items the wakeup newly takes could also be closed.
 * A cross-model review refused it, and was right: the two questions fail in
 * opposite directions. A stale `last_advanced_at` is weak evidence that nobody is
 * driving — good enough to risk a duplicate turn — and NO evidence that the build
 * finished. `complete()` writes the board row and does not stop the build
 * (`WorkBoardStore.complete`, `work-board/store.ts`), so completing on that signal
 * asserts something false.
 *
 * These tests pin the disagreement so it cannot be "fixed" back into agreement.
 */
describe('completion legality is NOT wakeability', () => {
  const T0 = Date.parse('2026-08-14T21:35:47Z')
  /** A run parked at `forge-init`, well past the wakeup's stand-down threshold. */
  const stalled = (): TridentRun =>
    ({
      id: 'run-1',
      slug: 'demo',
      project_slug: SCOPE,
      phase: 'forge-init',
      subagent_run_id: null,
      subagent_status: null,
      last_advanced_at: '2026-08-14T21:35:47Z',
    }) as unknown as TridentRun

  test('the wakeup WOULD take this item — the run reads as not driving', () => {
    // Establishes the premise of the test below: this is exactly the row shape
    // the selector releases.
    const v = runDrivingVerdict(stalled(), T0 + WAKEUP_STAND_DOWN_MS + 1)
    expect(v.driving).toBe(false)
  })

  test('and the store STILL refuses to call it done, because the build never ended', async () => {
    const run = stalled()
    const store = new WorkBoardStore(db, { isRunLive: () => !isTerminalPhase(run.phase) })
    const item = await store.create(SCOPE, { title: 'P1' })
    await store.attachRun(SCOPE, item.id, 'run-1')
    let caught: unknown = null
    try {
      await store.complete(SCOPE, item.id)
    } catch (e) {
      caught = e
    }
    // Loud, not silent — the refusal is recoverable by reaping the run.
    expect(caught).toBeInstanceOf(WorkBoardRunStillLiveError)
  })

  test('a terminal run completes normally — the refusal is not permanent', async () => {
    const run = { ...stalled(), phase: 'failed' } as TridentRun
    const store = new WorkBoardStore(db, { isRunLive: () => !isTerminalPhase(run.phase) })
    const item = await store.create(SCOPE, { title: 'P1' })
    await store.attachRun(SCOPE, item.id, 'run-1')
    expect((await store.complete(SCOPE, item.id))?.status).toBe('done')
  })
})
