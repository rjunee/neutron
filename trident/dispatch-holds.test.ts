/**
 * The five acceptance cases for dependency-aware dispatch (0124): overlap held,
 * overlap released on terminal, unmet blocker refused, clean card unaffected,
 * and a stuck claim that cannot wedge the queue.
 *
 * Real `ProjectDb` + real migrations + real `TridentRunStore` + real
 * `DispatchHoldStore` (same in-memory-ish tmpdir harness `store.test.ts` uses);
 * only the BOARD is a stub, because the chokepoint depends on it structurally.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from './store.ts'
import { DispatchHoldStore, buildDispatchHoldSweep } from './dispatch-holds.ts'
import {
  dispatchBoardBoundBuild,
  type BoardBoundBuildDeps,
  type TridentBoardBinder,
} from './board-dispatch.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore
let holds: DispatchHoldStore

const SLUG = 'acme'
const REPO = '/build/acme/code'

interface StubCard {
  id: string
  title: string
  design_doc_ref: string | null
  status: string
  blockers?: string[]
  linked_run_id?: string | null
}

interface StubBoard extends TridentBoardBinder {
  cards: Map<string, StubCard>
  attached: Array<{ id: string; run_id: string }>
}

function stubBoard(cards: StubCard[]): StubBoard {
  const map = new Map(cards.map((c) => [c.id, c]))
  const attached: Array<{ id: string; run_id: string }> = []
  return {
    cards: map,
    attached,
    get: (_slug: string, id: string) => map.get(id) ?? null,
    attachRun: async (_slug: string, id: string, run_id: string) => {
      attached.push({ id, run_id })
    },
  }
}

/** The production deps minus the fs/git probes (which have no repo to probe). */
function deps(
  board: StubBoard,
  extra: Partial<BoardBoundBuildDeps> = {},
): BoardBoundBuildDeps {
  return {
    store,
    board,
    project_slug: SLUG,
    repo_path: '/home/owner',
    resolveBuildRepo: async () => REPO,
    resolveMergeMode: async () => 'local',
    resolveRalph: async () => false,
    holds,
    ...extra,
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-dispatch-holds-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
  holds = new DispatchHoldStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function runCount(): number {
  return (
    db.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM code_trident_runs`).get()?.n ?? 0
  )
}

describe('OVERLAP HELD — two cards naming the same file cannot both be in flight', () => {
  test('concurrent dispatches atomically admit only one overlapping run', async () => {
    const board = stubBoard([
      { id: 'A', title: 'first concurrent card with a detailed implementation', design_doc_ref: 'neutron-docs:a', status: 'upcoming' },
      { id: 'B', title: 'second concurrent card with a detailed implementation', design_doc_ref: 'neutron-docs:b', status: 'upcoming' },
    ])
    let arrivals = 0
    let release!: () => void
    const rendezvous = new Promise<void>((resolve) => { release = resolve })
    const readPlanDoc = async (): Promise<string> => {
      arrivals += 1
      if (arrivals === 2) release()
      await rendezvous
      return 'Edit trident/race.ts.'
    }
    const [a, b] = await Promise.all([
      dispatchBoardBoundBuild({ task: 'Implement A', board_item_id: 'A' }, deps(board, { readPlanDoc })),
      dispatchBoardBoundBuild({ task: 'Implement B', board_item_id: 'B' }, deps(board, { readPlanDoc })),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect(runCount()).toBe(1)
    expect(holds.list()).toHaveLength(1)
  })

  test('the second dispatch is held, names the path + the holding run, and writes NO run row', async () => {
    const board = stubBoard([
      { id: 'A', title: 'rework the claim gate inside the dispatcher module', design_doc_ref: null, status: 'upcoming' },
      { id: 'B', title: 'a second card whose plan doc names the same file', design_doc_ref: 'neutron-docs:plans/b.md', status: 'upcoming' },
    ])
    const a = await dispatchBoardBoundBuild(
      { task: 'Rewrite trident/foo.ts so the gate is measured, not inferred.', board_item_id: 'A' },
      deps(board),
    )
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.run.claimed_paths).toEqual(['trident/foo.ts'])
    expect(runCount()).toBe(1)

    const b = await dispatchBoardBoundBuild(
      { task: 'Follow the plan doc for card B.', board_item_id: 'B' },
      deps(board, { readPlanDoc: async () => 'Touch `trident/foo.ts` and nothing else.' }),
    )
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(b.code).toBe('held')
    expect(b.message).toContain('trident/foo.ts')
    expect(b.message).toContain(a.run.id.slice(0, 8))

    // The chokepoint invariant: a non-ok dispatch writes ZERO run state.
    expect(runCount()).toBe(1)
    const hold = holds.getByItem(SLUG, 'B')
    expect(hold?.hold_kind).toBe('path')
    expect(hold?.held_on_run_id).toBe(a.run.id)
    expect(hold?.claimed_paths).toEqual(['trident/foo.ts'])
  })

  test('holding is REPORTED, never thrown', async () => {
    const board = stubBoard([
      { id: 'A', title: 'the first card to claim the contended path here', design_doc_ref: null, status: 'upcoming' },
      { id: 'B', title: 'the second card to claim the contended path here', design_doc_ref: null, status: 'upcoming' },
    ])
    await dispatchBoardBoundBuild({ task: 'edit trident/foo.ts', board_item_id: 'A' }, deps(board))
    // Also proves the gate never throws when NO hold store is wired.
    const holdless = deps(board)
    delete holdless.holds
    const b = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts', board_item_id: 'B' },
      holdless,
    )
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.code).toBe('held')
    expect(holds.list()).toEqual([])
  })
})

describe('OVERLAP RELEASED ON TERMINAL — the sweep dispatches the held card', () => {
  test('with no human action: run row created, hold deleted, attachRun called', async () => {
    const board = stubBoard([
      { id: 'A', title: 'the first card, which claims the contended dispatcher file', design_doc_ref: null, status: 'upcoming' },
      { id: 'B', title: 'the second card, which claims that same contended file too', design_doc_ref: null, status: 'upcoming' },
    ])
    const a = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts', board_item_id: 'A' },
      deps(board),
    )
    expect(a.ok).toBe(true)
    if (!a.ok) return
    const b = await dispatchBoardBoundBuild(
      { task: 'also edit trident/foo.ts', board_item_id: 'B' },
      deps(board),
    )
    expect(b.ok).toBe(false)
    expect(runCount()).toBe(1)

    // A's run goes terminal — the claim is released BY THE LIVENESS PREDICATE.
    await store.terminalTransition(a.run.id, { phase: 'done' })

    const sweep = buildDispatchHoldSweep({
      holds,
      board,
      makeDispatchDeps: () => deps(board),
    })
    await sweep(store.get(a.run.id)!)

    expect(runCount()).toBe(2)
    expect(holds.getByItem(SLUG, 'B')).toBeNull()
    expect(board.attached.map((x) => x.id)).toEqual(['A', 'B'])
  })

  test('the hold replays the originating chat payload onto the auto-fired run', async () => {
    const board = stubBoard([
      { id: 'A', title: 'the first card, which claims the contended dispatcher file', design_doc_ref: null, status: 'upcoming' },
      { id: 'B', title: 'the second card, which claims that same contended file too', design_doc_ref: null, status: 'upcoming' },
    ])
    const a = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts', board_item_id: 'A' },
      deps(board),
    )
    if (!a.ok) throw new Error('setup failed')
    await dispatchBoardBoundBuild(
      { task: 'also edit trident/foo.ts', board_item_id: 'B' },
      deps(board, { chat_id: 'chat-7', thread_id: 'thread-9', channel_kind: 'app_socket' }),
    )
    const hold = holds.getByItem(SLUG, 'B')
    expect(hold?.payload).toEqual({
      chat_id: 'chat-7',
      thread_id: 'thread-9',
      channel_kind: 'app_socket',
    })

    await store.terminalTransition(a.run.id, { phase: 'done' })
    const sweep = buildDispatchHoldSweep({
      holds,
      board,
      makeDispatchDeps: (h) =>
        deps(board, {
          ...(h.payload?.chat_id !== undefined ? { chat_id: h.payload.chat_id } : {}),
          ...(h.payload?.thread_id !== undefined ? { thread_id: h.payload.thread_id } : {}),
          ...(h.payload?.channel_kind !== undefined ? { channel_kind: h.payload.channel_kind } : {}),
        }),
    })
    await sweep(store.get(a.run.id)!)
    const fired = store.listNonTerminalByRepo(REPO)[0]
    expect(fired?.chat_id).toBe('chat-7')
    expect(fired?.channel_kind).toBe('app_socket')
  })
})

describe('UNMET BLOCKER REFUSED — a declared dependency holds the card', () => {
  test('held with a message naming the blocker; dispatches once the blocker is done', async () => {
    const board = stubBoard([
      { id: 'A', title: 'the blocking card that must finish before B runs', design_doc_ref: null, status: 'upcoming' },
      {
        id: 'B',
        title: 'the dependent card that waits for A to be marked done',
        design_doc_ref: null,
        status: 'upcoming',
        blockers: ['A'],
      },
    ])
    const b = await dispatchBoardBoundBuild(
      { task: 'build the dependent piece', board_item_id: 'B' },
      deps(board),
    )
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(b.code).toBe('held')
    expect(b.message).toContain('"A"')
    expect(runCount()).toBe(0)
    const hold = holds.getByItem(SLUG, 'B')
    expect(hold?.hold_kind).toBe('blocker')
    expect(hold?.held_on_blocker_id).toBe('A')

    board.cards.get('A')!.status = 'done'
    const sweep = buildDispatchHoldSweep({ holds, board, makeDispatchDeps: () => deps(board) })
    await sweep({ id: 'unrelated' } as never)

    expect(runCount()).toBe(1)
    expect(holds.getByItem(SLUG, 'B')).toBeNull()
    expect(board.attached.map((x) => x.id)).toEqual(['B'])
  })

  test('a FAILED blocker says so, so the owner knows release waits on a retry', async () => {
    const board = stubBoard([
      { id: 'A', title: 'the blocking card whose build failed a moment ago', design_doc_ref: null, status: 'failed' },
      {
        id: 'B',
        title: 'the dependent card that waits for A to be marked done',
        design_doc_ref: null,
        status: 'upcoming',
        blockers: ['A'],
      },
    ])
    const b = await dispatchBoardBoundBuild({ task: 'build B', board_item_id: 'B' }, deps(board))
    if (b.ok) throw new Error('expected a hold')
    expect(b.message).toContain('FAILED')
  })

  test('a blocker id resolving to NO card is CLEARED, not waited on forever', async () => {
    const board = stubBoard([
      {
        id: 'B',
        title: 'a card naming a blocker that was hard-deleted off the board',
        design_doc_ref: null,
        status: 'upcoming',
        blockers: ['ghost'],
      },
    ])
    const b = await dispatchBoardBoundBuild({ task: 'build B', board_item_id: 'B' }, deps(board))
    expect(b.ok).toBe(true)
    expect(holds.list()).toEqual([])
  })
})

describe('CLEAN CARD UNAFFECTED — no regression to the normal path', () => {
  test('dispatches ok with claimed_paths recorded, despite live runs elsewhere', async () => {
    // Same repo, DISJOINT claims — must not block.
    await store.create({
      slug: 'sibling',
      project_slug: SLUG,
      repo_path: REPO,
      task: 'edit work-board/store.ts',
      claimed_paths: ['work-board/store.ts'],
    })
    // DIFFERENT repo, OVERLAPPING claims — must not block (repo scoping).
    await store.create({
      slug: 'other-project',
      project_slug: 'other',
      repo_path: '/build/other/code',
      task: 'edit trident/foo.ts',
      claimed_paths: ['trident/foo.ts'],
    })

    const board = stubBoard([
      { id: 'C', title: 'a clean card with no blockers and a disjoint file set', design_doc_ref: null, status: 'upcoming' },
    ])
    const c = await dispatchBoardBoundBuild(
      { task: 'Edit trident/foo.ts to add the gate.', board_item_id: 'C' },
      deps(board),
    )
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(c.merge_mode).toBe('local')
    expect(c.ralph).toBe(false)
    expect(c.run.claimed_paths).toEqual(['trident/foo.ts'])
    expect(store.get(c.run.id)?.claimed_paths).toEqual(['trident/foo.ts'])
    expect(board.attached).toEqual([{ id: 'C', run_id: c.run.id }])
    expect(holds.list()).toEqual([])
  })

  test('a card whose text names no path claims nothing and can never be held', async () => {
    await store.create({
      slug: 'live-claimer',
      project_slug: SLUG,
      repo_path: REPO,
      task: 'edit trident/foo.ts',
      claimed_paths: ['trident/foo.ts'],
    })
    const board = stubBoard([
      { id: 'D', title: 'a card described entirely in prose with no file names', design_doc_ref: null, status: 'upcoming' },
    ])
    const d = await dispatchBoardBoundBuild(
      { task: 'Make the onboarding copy friendlier and shorter.', board_item_id: 'D' },
      deps(board),
    )
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.run.claimed_paths).toEqual([])
  })
})

describe('STUCK CLAIM CANNOT WEDGE THE QUEUE', () => {
  test('a stale hold cannot dispatch a second run for a card already linked to a live run', async () => {
    const live = await store.create({ slug: 'live', project_slug: SLUG, repo_path: REPO, task: 'build', claimed_paths: [] })
    const board = stubBoard([
      { id: 'B', title: 'a card already attached to its running build', design_doc_ref: null, status: 'in_progress', linked_run_id: live.id },
    ])
    await holds.upsert({ project_slug: SLUG, board_item_id: 'B', task: 'Edit trident/other.ts', hold_kind: 'path', hold_reason: 'stale' })
    await buildDispatchHoldSweep({ holds, board, makeDispatchDeps: () => deps(board) })({ id: 'terminal' } as never)
    expect(runCount()).toBe(1)
    expect(holds.list()).toEqual([])
  })

  test('a terminal run that still carries its claims blocks nothing', async () => {
    const dead = await store.create({
      slug: 'dead-run',
      project_slug: SLUG,
      repo_path: REPO,
      task: 'edit trident/foo.ts',
      claimed_paths: ['trident/foo.ts'],
    })
    // Driven terminal with NO explicit claim release anywhere.
    await store.terminalTransition(dead.id, { phase: 'failed' })
    expect(store.get(dead.id)?.claimed_paths).toEqual(['trident/foo.ts'])
    // Plus a legacy row with NULL claims that happens to be live.
    const legacy = await store.create({
      slug: 'legacy-live',
      project_slug: SLUG,
      repo_path: REPO,
      task: 'edit trident/foo.ts',
    })
    await db.run(`UPDATE code_trident_runs SET claimed_paths = NULL WHERE id = ?`, [legacy.id])

    const board = stubBoard([
      { id: 'E', title: 'a card contending with a dead claim and a legacy row', design_doc_ref: null, status: 'upcoming' },
    ])
    const e = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts once more', board_item_id: 'E' },
      deps(board),
    )
    expect(e.ok).toBe(true)
  })

  test('a hold whose card was deleted is DROPPED by the sweep, not retried forever', async () => {
    await holds.upsert({
      project_slug: SLUG,
      board_item_id: 'gone',
      task: 'build the deleted card',
      hold_kind: 'path',
      hold_reason: 'held on something',
      held_on_run_id: 'run-x',
    })
    // ... and one whose card was completed by hand.
    await holds.upsert({
      project_slug: SLUG,
      board_item_id: 'finished',
      task: 'build the hand-completed card',
      hold_kind: 'blocker',
      hold_reason: 'held on something',
      held_on_blocker_id: 'Z',
    })
    const board = stubBoard([
      { id: 'finished', title: 'a card the owner marked done by hand already', design_doc_ref: null, status: 'done' },
    ])
    const sweep = buildDispatchHoldSweep({ holds, board, makeDispatchDeps: () => deps(board) })
    await sweep({ id: 'any' } as never)
    expect(holds.list()).toEqual([])
    expect(runCount()).toBe(0)
  })

  test('a non-held REJECTION drops the hold instead of retrying it forever', async () => {
    await holds.upsert({
      project_slug: SLUG,
      board_item_id: 'thin',
      task: 'x',
      hold_kind: 'blocker',
      hold_reason: 'held earlier',
      held_on_blocker_id: 'Z',
    })
    // The card exists but is UNDERSPECIFIED — a rejection that will not clear itself.
    const board = stubBoard([{ id: 'thin', title: 'auth', design_doc_ref: null, status: 'upcoming' }])
    const sweep = buildDispatchHoldSweep({ holds, board, makeDispatchDeps: () => deps(board) })
    await sweep({ id: 'any' } as never)
    expect(holds.list()).toEqual([])
    expect(runCount()).toBe(0)
  })

  test('a still-held card REFRESHES its row rather than queueing twice', async () => {
    const board = stubBoard([
      { id: 'A', title: 'the blocking card that must finish before B runs', design_doc_ref: null, status: 'upcoming' },
      {
        id: 'B',
        title: 'the dependent card that waits for A to be marked done',
        design_doc_ref: null,
        status: 'upcoming',
        blockers: ['A'],
      },
    ])
    await dispatchBoardBoundBuild({ task: 'build B', board_item_id: 'B' }, deps(board))
    await dispatchBoardBoundBuild({ task: 'build B again', board_item_id: 'B' }, deps(board))
    expect(holds.list()).toHaveLength(1)
    expect(holds.getByItem(SLUG, 'B')?.task).toBe('build B again')
  })
})

// ---------------------------------------------------------------------------
// T2 — the READ side. `listByProject` is the one query the board surfaces
// (`work_board_list`, the `<work_board>` fragment) join against so a held card
// is legible after the dispatch-time chat message has scrolled away.
// ---------------------------------------------------------------------------
describe('listByProject — the board surfaces read holds per project', () => {
  async function hold(project_slug: string, board_item_id: string, hold_reason: string): Promise<void> {
    await holds.upsert({
      project_slug,
      board_item_id,
      task: `build ${board_item_id}`,
      hold_kind: 'blocker',
      hold_reason,
    })
  }

  test('returns ONLY the given project’s holds', async () => {
    await hold(SLUG, 'A', 'blocked by card Z')
    await hold(SLUG, 'B', 'run-7 already claims trident/foo.ts')
    await hold('some-other-project', 'A', 'a different board entirely')

    const mine = holds.listByProject(SLUG)
    expect(mine.map((h) => h.board_item_id).sort()).toEqual(['A', 'B'])
    expect(mine.every((h) => h.project_slug === SLUG)).toBe(true)
    expect(holds.listByProject('some-other-project')).toHaveLength(1)
    expect(holds.listByProject('no-such-project')).toEqual([])
  })

  test('carries the stored reason VERBATIM (the surfaces re-render, never re-derive)', async () => {
    const reason = 'held: card B waits on blocker A (in_progress)'
    await hold(SLUG, 'B', reason)
    expect(holds.listByProject(SLUG)[0]?.hold_reason).toBe(reason)
  })

  test('a real dispatch hold is visible through listByProject with no extra wiring', async () => {
    const board = stubBoard([
      { id: 'A', title: 'the blocking card that must finish before B runs', design_doc_ref: null, status: 'upcoming' },
      {
        id: 'B',
        title: 'the dependent card that waits for A to be marked done',
        design_doc_ref: null,
        status: 'upcoming',
        blockers: ['A'],
      },
    ])
    const res = await dispatchBoardBoundBuild({ task: 'build B', board_item_id: 'B' }, deps(board))
    expect(res.ok).toBe(false)
    if (res.ok) return
    const [row] = holds.listByProject(SLUG)
    expect(row?.board_item_id).toBe('B')
    // The exact text the chat message carried is the text the board will show.
    expect(row?.hold_reason).toBe(res.message)
  })
})
