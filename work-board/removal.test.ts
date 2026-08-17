import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  WorkBoardRemovalService,
  type RemovalDocStore,
  type RemovalRunAccess,
  type WorkBoardRemovalDeps,
  type WorkBoardRemovalReason,
} from './removal.ts'
import { WorkBoardStore, type WorkBoardItem } from './store.ts'

const SCOPE = 'proj1'
const DOCS_PROJECT = 'proj1'

function fakeItem(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'item-1',
    project_slug: SCOPE,
    title: 'a card',
    status: 'in_progress',
    sort_order: 1,
    design_doc_ref: null,
    task_type: 'build',
    blocked_by: [],
    declared_surfaces: null,
    inline_active: false,
    linked_run_id: null,
    created_at: '2026-08-14T00:00:00Z',
    updated_at: '2026-08-14T00:00:00Z',
    completed_at: null,
    ...over,
  }
}

/**
 * ONE shared event array across every stub — the ordering pin. `store.get` is
 * not recorded (it is a read); every side effect is.
 */
interface Harness {
  deps: WorkBoardRemovalDeps
  events: string[]
  moves: Array<{ project_id: string; from: string; to: string }>
  deletedDocs: Array<{ project_id: string; path: string }>
  warns: string[]
}

function harness(
  item: WorkBoardItem | null,
  over: {
    run?: { phase: string } | null
    terminate?: (id: string) => Promise<{ won: boolean }>
    withTerminate?: boolean
    terminal?: boolean
    dispatch?: boolean
    docs?: Partial<RemovalDocStore>
    withDocs?: boolean
  } = {},
): Harness {
  const events: string[] = []
  const moves: Array<{ project_id: string; from: string; to: string }> = []
  const deletedDocs: Array<{ project_id: string; path: string }> = []
  const warns: string[] = []

  const runs: RemovalRunAccess = {
    get: (id) => {
      events.push(`run.get:${id}`)
      return over.run === undefined ? { phase: 'forge' } : over.run
    },
    update: async (id) => {
      events.push(`update:${id}`)
      return null
    },
    ...(over.withTerminate === false
      ? {}
      : {
          terminate: async (id: string): Promise<{ won: boolean }> => {
            events.push('terminate')
            return over.terminate !== undefined ? await over.terminate(id) : { won: true }
          },
        }),
  }

  const docs: RemovalDocStore = {
    moveDoc: async (project_id, from, to) => {
      events.push('moveDoc')
      moves.push({ project_id, from, to })
      if (over.docs?.moveDoc !== undefined) return await over.docs.moveDoc(project_id, from, to)
      return null
    },
    deleteDoc: async (project_id, path) => {
      events.push('deleteDoc')
      deletedDocs.push({ project_id, path })
      if (over.docs?.deleteDoc !== undefined) return await over.docs.deleteDoc(project_id, path)
      return null
    },
  }

  const deps: WorkBoardRemovalDeps = {
    store: {
      get: () => item,
      delete: async () => {
        events.push('delete')
      },
    },
    trident_runs: runs,
    is_terminal_phase: () => over.terminal === true,
    ...(over.dispatch === true
      ? {
          cancel_dispatch: async (run_id: string) => {
            events.push(`cancel_dispatch:${run_id}`)
          },
        }
      : {}),
    ...(over.withDocs === false ? {} : { docs }),
    log: {
      warn: (m) => {
        warns.push(m)
      },
    },
  }
  return { deps, events, moves, deletedDocs, warns }
}

/** Events minus the read-only run lookup — the side-effect sequence. */
function effects(events: string[]): string[] {
  return events.filter((e) => !e.startsWith('run.get:'))
}

describe('WorkBoardRemovalService', () => {
  test('cancels a LIVE bound run BEFORE deleting the row (order is the invariant)', async () => {
    // The card's guard-against-a-fake-test: a card that HAS a live run, and the
    // assertion is the ORDERED event sequence. Two mutants go RED here:
    //   - skipping cancellation entirely → ['delete']
    //   - deleting before cancelling     → ['delete', 'terminate']
    const h = harness(fakeItem({ task_type: 'build', linked_run_id: 'run-1' }))
    const svc = new WorkBoardRemovalService(h.deps)

    const res = await svc.remove(SCOPE, DOCS_PROJECT, 'item-1', { reason: 'cancelled' })

    expect(effects(h.events)).toEqual(['terminate', 'delete'])
    expect(res.removed).toBe(true)
    expect(res.cancelled_run).toBe('run-1')
    expect(h.deletedDocs).toEqual([])
  })

  test('a LOST terminate race reports no cancelled_run but still deletes the row', async () => {
    const h = harness(fakeItem({ linked_run_id: 'run-1' }), {
      terminate: async () => ({ won: false }),
    })
    const svc = new WorkBoardRemovalService(h.deps)

    const res = await svc.remove(SCOPE, DOCS_PROJECT, 'item-1', { reason: 'cancelled' })

    expect(effects(h.events)).toEqual(['terminate', 'delete'])
    expect(res.cancelled_run).toBeUndefined()
    expect(res.removed).toBe(true)
    expect(h.deletedDocs).toEqual([])
  })

  test('no terminate wired → bare update fallback, still before the delete', async () => {
    const h = harness(fakeItem({ linked_run_id: 'run-1' }), { withTerminate: false })
    const svc = new WorkBoardRemovalService(h.deps)

    const res = await svc.remove(SCOPE, DOCS_PROJECT, 'item-1', { reason: 'cancelled' })

    expect(effects(h.events)).toEqual(['update:run-1', 'delete'])
    expect(res.cancelled_run).toBe('run-1')
  })

  test('a RESEARCH card cancels via dispatch stop — never terminate — then deletes', async () => {
    const h = harness(fakeItem({ task_type: 'research', linked_run_id: 'atlas-1' }), {
      dispatch: true,
    })
    const svc = new WorkBoardRemovalService(h.deps)

    const res = await svc.remove(SCOPE, DOCS_PROJECT, 'item-1', { reason: 'cancelled' })

    expect(effects(h.events)).toEqual(['cancel_dispatch:atlas-1', 'delete'])
    expect(res.cancelled_run).toBe('atlas-1')
    expect(h.deletedDocs).toEqual([])
  })

  test('a TERMINAL bound run is not cancelled; the row is still deleted', async () => {
    const h = harness(fakeItem({ linked_run_id: 'run-1' }), {
      run: { phase: 'done' },
      terminal: true,
    })
    const svc = new WorkBoardRemovalService(h.deps)

    const res = await svc.remove(SCOPE, DOCS_PROJECT, 'item-1', { reason: 'shipped' })

    expect(effects(h.events)).toEqual(['delete'])
    expect(res.cancelled_run).toBeUndefined()
    expect(res.removed).toBe(true)
    expect(h.deletedDocs).toEqual([])
  })

  test('an unknown item removes nothing', async () => {
    const h = harness(null)
    const svc = new WorkBoardRemovalService(h.deps)

    const res = await svc.remove(SCOPE, DOCS_PROJECT, 'nope', { reason: 'cancelled' })

    expect(res.removed).toBe(false)
    expect(effects(h.events)).toEqual([])
  })

  test('the plan doc MOVES to a folder named for the removal reason', async () => {
    for (const reason of ['shipped', 'cancelled', 'moved'] as WorkBoardRemovalReason[]) {
      const h = harness(
        fakeItem({ design_doc_ref: 'neutron-docs:plans/foo-abc123.md' }),
      )
      const svc = new WorkBoardRemovalService(h.deps)

      const res = await svc.remove(SCOPE, DOCS_PROJECT, 'item-1', { reason })

      expect(h.moves).toEqual([
        { project_id: DOCS_PROJECT, from: 'plans/foo-abc123.md', to: `plans/${reason}/foo-abc123.md` },
      ])
      expect(res.plan_doc).toEqual({
        path: 'plans/foo-abc123.md',
        disposition: 'moved',
        to: `plans/${reason}/foo-abc123.md`,
      })
      // The doc disposition happens before the row goes, and NEVER destroys.
      expect(effects(h.events)).toEqual(['moveDoc', 'delete'])
      expect(h.deletedDocs).toEqual([])
    }
  })

  test('a doc already filed under the disposition folder is not re-moved', async () => {
    const h = harness(fakeItem({ design_doc_ref: 'neutron-docs:plans/cancelled/foo.md' }))
    const svc = new WorkBoardRemovalService(h.deps)

    const res = await svc.remove(SCOPE, DOCS_PROJECT, 'item-1', { reason: 'cancelled' })

    expect(h.moves).toEqual([])
    expect(res.plan_doc?.disposition).toBe('moved')
    expect(res.plan_doc?.to).toBe('plans/cancelled/foo.md')
  })

  test('NO SILENT DESTRUCTION: a failed move leaves the doc in place and never deletes it', async () => {
    const h = harness(fakeItem({ design_doc_ref: 'neutron-docs:plans/foo-abc123.md' }), {
      docs: {
        moveDoc: async () => {
          throw new Error('doc_destination_exists: to_path=plans/cancelled/foo-abc123.md already exists')
        },
      },
    })
    const svc = new WorkBoardRemovalService(h.deps)

    const res = await svc.remove(SCOPE, DOCS_PROJECT, 'item-1', { reason: 'cancelled' })

    expect(res.plan_doc).toEqual({ path: 'plans/foo-abc123.md', disposition: 'left_in_place' })
    // The row still goes (a doc failure never blocks the removal)…
    expect(res.removed).toBe(true)
    expect(effects(h.events)).toEqual(['moveDoc', 'delete'])
    // …and the failure NEVER falls through to a delete.
    expect(h.deletedDocs).toEqual([])
    expect(h.warns.length).toBe(1)
    expect(h.warns[0]).toContain('event=plan_doc_disposition_failed')
  })

  test('an explicit plan_doc=delete is the ONLY path that destroys the doc', async () => {
    const h = harness(fakeItem({ design_doc_ref: 'neutron-docs:plans/foo-abc123.md' }))
    const svc = new WorkBoardRemovalService(h.deps)

    const res = await svc.remove(SCOPE, DOCS_PROJECT, 'item-1', {
      reason: 'cancelled',
      plan_doc: 'delete',
    })

    expect(h.deletedDocs).toEqual([{ project_id: DOCS_PROJECT, path: 'plans/foo-abc123.md' }])
    expect(h.moves).toEqual([])
    expect(res.plan_doc).toEqual({ path: 'plans/foo-abc123.md', disposition: 'deleted' })
    expect(effects(h.events)).toEqual(['deleteDoc', 'delete'])
  })

  test('a failed explicit delete leaves the doc in place', async () => {
    const h = harness(fakeItem({ design_doc_ref: 'neutron-docs:plans/foo-abc123.md' }), {
      docs: {
        deleteDoc: async () => {
          throw new Error('no doc at path')
        },
      },
    })
    const svc = new WorkBoardRemovalService(h.deps)

    const res = await svc.remove(SCOPE, DOCS_PROJECT, 'item-1', {
      reason: 'cancelled',
      plan_doc: 'delete',
    })

    expect(res.plan_doc).toEqual({ path: 'plans/foo-abc123.md', disposition: 'left_in_place' })
    expect(res.removed).toBe(true)
    expect(h.warns[0]).toContain('event=plan_doc_delete_failed')
  })

  test('a non-plans ref is never touched (https, a doc outside plans/, or none)', async () => {
    for (const ref of ['https://example.com/spec', 'neutron-docs:notes/owner-note.md', null]) {
      const h = harness(fakeItem({ design_doc_ref: ref }))
      const svc = new WorkBoardRemovalService(h.deps)

      const res = await svc.remove(SCOPE, DOCS_PROJECT, 'item-1', { reason: 'moved' })

      expect(h.moves).toEqual([])
      expect(h.deletedDocs).toEqual([])
      expect(res.plan_doc).toBeUndefined()
      expect(effects(h.events)).toEqual(['delete'])
    }
  })

  test('no docs store wired → the doc is left in place, never destroyed', async () => {
    const h = harness(fakeItem({ design_doc_ref: 'neutron-docs:plans/foo-abc123.md' }), {
      withDocs: false,
    })
    const svc = new WorkBoardRemovalService(h.deps)

    const res = await svc.remove(SCOPE, DOCS_PROJECT, 'item-1', { reason: 'shipped' })

    expect(res.plan_doc).toEqual({ path: 'plans/foo-abc123.md', disposition: 'left_in_place' })
    expect(effects(h.events)).toEqual(['delete'])
  })
})

describe('WorkBoardRemovalService against a real store', () => {
  let tmp: string
  let db: ProjectDb

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-work-board-removal-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('the removed card is REALLY gone — from get() AND list() (acceptance d)', async () => {
    const store = new WorkBoardStore(db)
    const doomed = await store.create(SCOPE, { title: 'remove me' })
    const survivor = await store.create(SCOPE, { title: 'keep me' })
    const svc = new WorkBoardRemovalService({ store })

    const res = await svc.remove(SCOPE, DOCS_PROJECT, doomed.id, { reason: 'cancelled' })

    expect(res.removed).toBe(true)
    expect(store.get(SCOPE, doomed.id)).toBeNull()
    // No filter-resurrection: the hard row delete leaves ONLY the survivor.
    expect(store.list(SCOPE).map((i) => i.id)).toEqual([survivor.id])
  })
})
