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
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { WorkBoardStore, WorkBoardRunStillLiveError } from './store.ts'

const SCOPE = 'proj'
let dir: string
let db: ProjectDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neutron-wb-live-run-'))
  db = ProjectDb.open(join(dir, 'project.db'))
  applyMigrations(db.raw())
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
