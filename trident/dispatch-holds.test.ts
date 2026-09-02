/**
 * The five acceptance cases for dependency-aware dispatch (0124): overlap held,
 * overlap released on terminal, unmet blocker refused, clean card unaffected,
 * and a stuck claim that cannot wedge the queue.
 *
 * Real `ProjectDb` + real migrations + real `TridentRunStore` + real
 * `DispatchHoldStore` (same in-memory-ish tmpdir harness `store.test.ts` uses);
 * only the BOARD is a stub, because the chokepoint depends on it structurally.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore, type TridentRun } from './store.ts'
import {
  BRANCH_LIVE_HOLD_STALE_MS,
  DispatchHoldStore,
  buildDispatchHoldSweep,
} from './dispatch-holds.ts'
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
    // A COPY PER READ, exactly like the real `WorkBoardStore.get` (which
    // reconstructs the card from its row every call). Handing out the live map
    // entry made every read alias every other one, so a test could not tell a
    // FRESH read from a snapshot taken minutes earlier — which is precisely the
    // distinction the dispatch TOCTOU rule is made of.
    get: (_slug: string, id: string) => {
      const c = map.get(id)
      return c === undefined ? null : { ...c }
    },
    attachRun: async (_slug: string, id: string, run_id: string) => {
      attached.push({ id, run_id })
    },
  }
}

/** The production deps minus the fs/git probes (which have no repo to probe). */
function deps(
  board: StubBoard,
  extra: Partial<BoardBoundBuildDeps> = {},
): BoardBoundBuildDeps & { preflight: NonNullable<BoardBoundBuildDeps['preflight']> } {
  return {
    store,
    board,
    project_slug: SLUG,
    repo_path: '/home/owner',
    resolveBuildRepo: async () => REPO,
    resolveMergeMode: async () => 'local',
    resolveRalph: async () => false,
    holds,
    // An always-alive executor. Present because `buildDispatchHoldSweep` requires
    // it in the type: the sweep re-dispatches UNATTENDED, so it may not be the
    // one entry that skips the liveness gate.
    preflight: async () => ({ ok: true }),
    ...extra,
  }
}

/** A branch holder that is unambiguously alive — the refusal's own trigger. */
const liveHolder = async (): Promise<{
  worktree_basename: string
  lock_reason: string
  pid: number
  pid_live: boolean
  mtime_ms: number
}> => ({
  worktree_basename: 'wf_live',
  lock_reason: 'claude agent wf_live (pid 4242 start 99)',
  pid: 4242,
  pid_live: true,
  mtime_ms: 0,
})

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
    // task text differs from A's so the branch_live liveness refusal cannot preempt the PATH hold this test pins; same-slug double dispatch is board-dispatch.test.ts territory.
    const b = await dispatchBoardBoundBuild(
      { task: 'update trident/foo.ts', board_item_id: 'B' },
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

// MAJOR (round 1): the sweep DELETES the hold for every refusal code except
// `held`, and `branch_live` is transient by construction — it says "a live lane
// is on this branch right now", which ends when that lane finishes. Deleting the
// hold there silently drops a queued card that nothing re-dispatches.
describe('BRANCH LIVE IS TRANSIENT — the sweep keeps the hold queued', () => {
  test('a branch_live refusal leaves the hold in place and writes no run', async () => {
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
    expect(holds.getByItem(SLUG, 'B')).not.toBeNull()

    // The path claim is released, so the sweep gets past the overlap gate — and
    // straight into the liveness refusal: something live holds B's branch.
    await store.terminalTransition(a.run.id, { phase: 'done' })
    const sweep = buildDispatchHoldSweep({
      holds,
      board,
      makeDispatchDeps: () =>
        deps(board, {
          branchHolderProbe: async () => ({
            worktree_basename: 'wf_live',
            lock_reason: 'claude agent wf_live (pid 4242 start 99)',
            pid: 4242,
            pid_live: true,
            mtime_ms: 0,
          }),
        }),
    })
    await sweep(store.get(a.run.id)!)

    // NOTHING dispatched, and — the point — the card is STILL QUEUED.
    expect(runCount()).toBe(1)
    expect(holds.getByItem(SLUG, 'B')).not.toBeNull()

    // Once the holder is gone, the very next sweep dispatches it. No human acted.
    const sweepAgain = buildDispatchHoldSweep({
      holds,
      board,
      makeDispatchDeps: () => deps(board, { branchHolderProbe: async () => null }),
    })
    await sweepAgain(store.get(a.run.id)!)
    expect(runCount()).toBe(2)
    expect(holds.getByItem(SLUG, 'B')).toBeNull()
  })

  // MAJOR (round 2): the sweep only KEEPS a hold it already has. On the FIRST
  // dispatch the liveness gate refused and queued nothing at all, so a card that
  // had never been held was dropped on the floor — no run, no row, no log — and
  // only a human re-dispatching it ever revived it. The path-claim gate twenty
  // lines further down, refusing on the same fact ("a live run owns this"), has
  // always queued.
  test('a FIRST-EVER dispatch refused on branch liveness is QUEUED, and the sweep fires it later', async () => {
    const board = stubBoard([
      { id: 'A', title: 'the only card, whose branch a live worktree already holds', design_doc_ref: null, status: 'upcoming' },
    ])
    const first = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts', board_item_id: 'A' },
      deps(board, { branchHolderProbe: liveHolder }),
    )
    expect(first.ok).toBe(false)
    if (first.ok) return
    expect(first.code).toBe('branch_live')
    // NO run — the chokepoint's "a refusal writes zero run state" invariant.
    expect(runCount()).toBe(0)
    // But the card is QUEUED, with the refusal's own words as the reason.
    const hold = holds.getByItem(SLUG, 'A')
    expect(hold).not.toBeNull()
    expect(hold?.hold_reason).toContain('wf_live')

    // Nothing terminalized the holder yet: the sweep re-refuses and REFRESHES.
    const stuck = buildDispatchHoldSweep({
      holds,
      board,
      makeDispatchDeps: () => deps(board, { branchHolderProbe: liveHolder }),
    })
    await stuck({ id: 'unrelated' } as never)
    expect(runCount()).toBe(0)
    expect(holds.getByItem(SLUG, 'A')).not.toBeNull()

    // The holder goes away; the next sweep dispatches. No human acted.
    const sweep = buildDispatchHoldSweep({
      holds,
      board,
      makeDispatchDeps: () => deps(board, { branchHolderProbe: async () => null }),
    })
    await sweep({ id: 'unrelated' } as never)
    expect(runCount()).toBe(1)
    expect(holds.getByItem(SLUG, 'A')).toBeNull()
  })

  // ARGUS r3 (minor): a `bound_pr` dispatch is a REVIEW of a published head — it
  // never builds. The hold carried no `bound_pr`, so the sweep re-fired it as a
  // full BUILD, which opens a second PR for work that is already published; and
  // the terminal-build wake now steers operators to exactly this dispatch.
  test('a held REVIEW round comes back as a review — the hold replays bound_pr', async () => {
    const board = stubBoard([
      { id: 'A', title: 'the card whose published head needs another review round', design_doc_ref: null, status: 'upcoming' },
    ])
    const first = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts', board_item_id: 'A', bound_pr: 498 },
      deps(board, { branchHolderProbe: liveHolder }),
    )
    expect(first.ok).toBe(false)
    expect(holds.getByItem(SLUG, 'A')?.payload?.bound_pr).toBe(498)

    await buildDispatchHoldSweep({
      holds,
      board,
      makeDispatchDeps: () => deps(board, { branchHolderProbe: async () => null }),
    })()
    expect(runCount()).toBe(1)
    const fired = store.get(board.attached[0]!.run_id)
    expect(fired?.bound_pr).toBe(498)
  })

  // MUST-PASS SIBLING: an ordinary BUILD hold still fires as a build, with no
  // bound_pr invented for it.
  test('an ordinary held build still fires with no bound_pr', async () => {
    const board = stubBoard([
      { id: 'A', title: 'the ordinary card whose branch a live worktree holds', design_doc_ref: null, status: 'upcoming' },
    ])
    const first = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts', board_item_id: 'A' },
      deps(board, { branchHolderProbe: liveHolder }),
    )
    expect(first.ok).toBe(false)
    expect(holds.getByItem(SLUG, 'A')?.payload?.bound_pr).toBeUndefined()

    await buildDispatchHoldSweep({
      holds,
      board,
      makeDispatchDeps: () => deps(board, { branchHolderProbe: async () => null }),
    })()
    expect(runCount()).toBe(1)
    expect(store.get(board.attached[0]!.run_id)?.bound_pr).toBeNull()
  })

  // ARGUS r4 (major): the WORKTREE-ONLY holder (held_on_run_id null) has no run
  // whose terminalization could fire the observer, so on a quiet instance the
  // card queued indefinitely. `TridentTickLoop.drain_dispatch_holds` calls this
  // same sweep with NO run at all — this pins that the call shape works and that
  // it is a real drain, not a decoration.
  test('the sweep drains with NO run argument at all — the tick-cadence trigger', async () => {
    const board = stubBoard([
      { id: 'A', title: 'the only card, whose branch a bare live pid already holds', design_doc_ref: null, status: 'upcoming' },
    ])
    const first = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts', board_item_id: 'A' },
      deps(board, {
        branchHolderProbe: async () => ({
          worktree_basename: 'wf_live',
          lock_reason: 'claude agent wf_live (pid 4242 start 99)',
          pid: 4242,
          pid_live: true,
          mtime_ms: 0,
        }),
      }),
    )
    expect(first.ok).toBe(false)
    if (first.ok) return
    // ASSERT the code BEFORE narrowing on it: a bare `if (code !== 'branch_live')
    // return` lets a refusal-code regression skip the rest of this test and pass.
    expect(first.code).toBe('branch_live')
    if (first.code !== 'branch_live') return
    // NOTHING owns this hold — the holder is a pid, not a run.
    expect(holds.getByItem(SLUG, 'A')?.held_on_run_id ?? null).toBeNull()
    expect(runCount()).toBe(0)

    // The pid exits. No run terminalized; the ONLY trigger left is the cadence.
    const sweep = buildDispatchHoldSweep({
      holds,
      board,
      makeDispatchDeps: () => deps(board, { branchHolderProbe: async () => null }),
    })
    await sweep()

    expect(runCount()).toBe(1)
    expect(holds.getByItem(SLUG, 'A')).toBeNull()
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

  // ARGUS r4 (VETO): the SAME hazard the branch_live refusal closes, one gate
  // EARLIER. The blocker gate ran ahead of the branch-liveness block and upserted
  // its row unconditionally, so a card that already had a live run of its own got
  // a `blocker` hold anyway — and `buildDispatchHoldSweep` drops a hold only
  // while the linked run is live AT SWEEP TIME. Stop that run on purpose, let the
  // declared blocker finish, and the surviving row dispatched a brand-new lane
  // onto a card someone had deliberately stopped. Pinned END TO END, over the
  // real store and the real sweep.
  test('a blocker refusal behind the card’s own live run queues NOTHING and cannot auto-restart it', async () => {
    const live = await store.create({ slug: 'live', project_slug: SLUG, repo_path: REPO, task: 'build', claimed_paths: [] })
    const board = stubBoard([
      { id: 'A', title: 'the blocking card that must finish before B runs', design_doc_ref: null, status: 'upcoming' },
      {
        id: 'B',
        title: 'the dependent card whose own build is already running against it',
        design_doc_ref: null,
        status: 'in_progress',
        blockers: ['A'],
        linked_run_id: live.id,
      },
    ])
    // Seeded EARLIER, while the card was free — skipping the upsert alone would
    // leave THIS row behind to do the same damage.
    await holds.upsert({
      project_slug: SLUG,
      board_item_id: 'B',
      task: 'build B',
      hold_kind: 'blocker',
      hold_reason: 'queued before this card had a run of its own',
      held_on_blocker_id: 'A',
    })

    const refusal = await dispatchBoardBoundBuild({ task: 'build B', board_item_id: 'B' }, deps(board))
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.code).toBe('held')
    // The prose no longer promises a dispatch that cannot come…
    expect(refusal.message).not.toContain('it will dispatch automatically')
    expect(refusal.message).toContain('nothing stays queued')
    // …and the shape no longer claims a queue entry that does not exist.
    expect('hold' in refusal).toBe(false)
    expect(holds.getByItem(SLUG, 'B')).toBeNull()

    // The card is STOPPED on purpose and the blocker then completes — the exact
    // sequence that used to restart it.
    await store.terminalTransition(live.id, { phase: 'stopped' })
    board.cards.get('A')!.status = 'done'
    await buildDispatchHoldSweep({ holds, board, makeDispatchDeps: () => deps(board) })(
      store.get(live.id)!,
    )
    expect(runCount()).toBe(1)
    expect(board.attached).toEqual([])
  })

  // The must-pass sibling: with no live run of its own the card is queued exactly
  // as before, so the fix above cannot have been "never queue a blocked card".
  test('a blocker refusal for a card with NO live run still queues and still carries its hold', async () => {
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
    const refusal = await dispatchBoardBoundBuild({ task: 'build B', board_item_id: 'B' }, deps(board))
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.message).toContain('it will dispatch automatically')
    expect('hold' in refusal).toBe(true)
    if (!('hold' in refusal)) return
    expect(refusal.hold).toEqual({ kind: 'blocker', blocker_id: 'A' })
    expect(holds.getByItem(SLUG, 'B')?.hold_kind).toBe('blocker')
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

  // ARGUS r3 (BLOCKER, state-based half): the refusal behind a card's own live
  // run promises "nothing stays queued". Pinned END TO END here, over the real
  // store and the real sweep rather than a call counter: a hold that already
  // existed is GONE after the refusal, so terminalizing that run — as `stopped`,
  // i.e. someone stopped this card on purpose — re-fires nothing.
  test('the branch_live refusal behind the card’s own live run leaves NOTHING for the sweep to re-fire', async () => {
    const live = await store.create({ slug: 'live', project_slug: SLUG, repo_path: REPO, task: 'build', claimed_paths: [] })
    const board = stubBoard([
      { id: 'B', title: 'the card whose own build is already running against it', design_doc_ref: null, status: 'in_progress', linked_run_id: live.id },
    ])
    // Seeded EARLIER, while the card was free — the shape the skip alone missed.
    await holds.upsert({
      project_slug: SLUG,
      board_item_id: 'B',
      task: 'edit trident/foo.ts',
      hold_kind: 'blocker',
      hold_reason: 'queued before this card had a run of its own',
      held_on_blocker_id: 'A',
    })

    const refusal = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts', board_item_id: 'B' },
      deps(board, { branchHolderProbe: liveHolder }),
    )
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.code).toBe('branch_live')
    expect(refusal.message).toContain('nothing stays queued')
    expect(holds.getByItem(SLUG, 'B')).toBeNull()

    // The run is STOPPED on purpose, and the sweep — which drops a hold only
    // while the linked run is live AT SWEEP TIME — finds no row to act on.
    await store.terminalTransition(live.id, { phase: 'stopped' })
    await buildDispatchHoldSweep({
      holds,
      board,
      makeDispatchDeps: () => deps(board, { branchHolderProbe: async () => null }),
    })(store.get(live.id)!)
    expect(runCount()).toBe(1)
    expect(board.attached).toEqual([])
  })

  // The THIRD hold-producing gate, same rule (Argus r4 VETO, generalised): a
  // path-contention hold written while the card's own run is live outlives that
  // run exactly like the blocker one did.
  test('the path-contention refusal behind the card’s own live run queues nothing either', async () => {
    const live = await store.create({
      slug: 'live',
      project_slug: SLUG,
      repo_path: REPO,
      task: 'edit trident/foo.ts',
      claimed_paths: ['trident/foo.ts'],
    })
    const board = stubBoard([
      { id: 'B', title: 'the card whose own build already claims the file', design_doc_ref: null, status: 'in_progress', linked_run_id: live.id },
    ])
    const refusal = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts again', board_item_id: 'B' },
      deps(board),
    )
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.code).toBe('held')
    expect(refusal.message).not.toContain('will start automatically')
    expect('hold' in refusal).toBe(false)
    expect(holds.getByItem(SLUG, 'B')).toBeNull()

    await store.terminalTransition(live.id, { phase: 'stopped' })
    await buildDispatchHoldSweep({ holds, board, makeDispatchDeps: () => deps(board) })(
      store.get(live.id)!,
    )
    expect(runCount()).toBe(1)
    expect(board.attached).toEqual([])
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
// ARGUS r6 (BLOCKER) — DISPATCH TOCTOU. "May this refusal queue the card?" used
// to be answered ONCE, from the card read at the top of `dispatchBoardBoundBuild`,
// and then acted on by gates that run after `resolveBuildRepo`, the merge-mode
// probe, the landed-PR probe and the worktree holder probe. A competing dispatch
// that BOUND the card inside that seconds-wide window — the very run this
// dispatch then observes and refuses on — left this one still holding "the card
// is free", so it wrote the hold anyway. `buildDispatchHoldSweep` drops a hold
// only while the linked run is live AT SWEEP TIME, so stopping that run on
// purpose released the survivor onto a card someone had deliberately stopped.
//
// The window is closed by RE-READING at the write, synchronously: no `await`
// between the board/store read and the upsert-or-delete that acts on it.
// ---------------------------------------------------------------------------
describe('DISPATCH TOCTOU — a card bound DURING the async gates is not queued behind its own run', () => {
  /** The run a competing dispatch binds the card to, mid-flight. */
  function competingRun(): Promise<TridentRun> {
    return store.create({
      slug: 'competing-lane',
      project_slug: SLUG,
      repo_path: REPO,
      task: 'the competing dispatch that won the race for this card',
      claimed_paths: [],
    })
  }

  /** What the competitor does to the board the instant it wins the race. */
  function bindCard(board: StubBoard, id: string, run: TridentRun): void {
    board.cards.get(id)!.linked_run_id = run.id
    board.cards.get(id)!.status = 'in_progress'
  }

  test('a dispatch refused on branch liveness AFTER a competitor bound the card queues NOTHING', async () => {
    const board = stubBoard([
      { id: 'B', title: 'the card two dispatches raced for, one microtask apart', design_doc_ref: null, status: 'upcoming' },
    ])
    const competitor = await competingRun()
    // Seeded while the card was genuinely free — the row the stale snapshot
    // would have left behind even if this refusal wrote nothing itself.
    await holds.upsert({
      project_slug: SLUG,
      board_item_id: 'B',
      task: 'edit trident/foo.ts',
      hold_kind: 'path',
      hold_reason: 'queued before the competitor bound the card',
    })

    // THE INTERLEAVE. The holder probe is the last await before the hold write,
    // so binding the card inside it reproduces the race exactly: free at the
    // opening read, owned by the time the refusal is composed.
    let probed = 0
    const refusal = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts', board_item_id: 'B' },
      deps(board, {
        branchHolderProbe: async () => {
          probed += 1
          bindCard(board, 'B', competitor)
          return await liveHolder()
        },
      }),
    )
    expect(probed).toBe(1)
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.code).toBe('branch_live')
    // The prose names the competitor as the card's owner…
    expect(refusal.message).toContain('nothing stays queued')
    expect(refusal.message).toContain(competitor.id.slice(0, 8))
    // …the shape claims no queue entry…
    expect('hold' in refusal).toBe(false)
    // …and the row seeded before the race is gone with it.
    expect(holds.getByItem(SLUG, 'B')).toBeNull()

    // The competitor is STOPPED on purpose. Nothing re-fires the card.
    await store.terminalTransition(competitor.id, { phase: 'stopped' })
    await buildDispatchHoldSweep({
      holds,
      board,
      makeDispatchDeps: () => deps(board, { branchHolderProbe: async () => null }),
    })(store.get(competitor.id)!)
    expect(runCount()).toBe(1)
    expect(board.attached).toEqual([])
  })

  test('the same interleave at the PATH-CONTENTION gate queues nothing either', async () => {
    const board = stubBoard([
      { id: 'B', title: 'the card two dispatches raced for over one claimed file', design_doc_ref: null, status: 'upcoming' },
    ])
    // A live run elsewhere already claims the file this dispatch wants, so the
    // path gate is the one that refuses.
    const claimer = await store.create({
      slug: 'claimer',
      project_slug: SLUG,
      repo_path: REPO,
      task: 'edit trident/foo.ts',
      claimed_paths: ['trident/foo.ts'],
    })
    const competitor = await competingRun()
    // The interleave rides on `resolveMergeMode` this time — any await ahead of
    // the gate will do; the rule may not depend on WHICH one.
    const refusal = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts as well', board_item_id: 'B' },
      deps(board, {
        resolveMergeMode: async () => {
          bindCard(board, 'B', competitor)
          return 'local'
        },
      }),
    )
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.code).toBe('held')
    expect(refusal.message).toContain('nothing stays queued')
    expect(refusal.message).not.toContain('will start automatically')
    expect('hold' in refusal).toBe(false)
    expect(holds.getByItem(SLUG, 'B')).toBeNull()

    await store.terminalTransition(claimer.id, { phase: 'done' })
    await store.terminalTransition(competitor.id, { phase: 'stopped' })
    await buildDispatchHoldSweep({ holds, board, makeDispatchDeps: () => deps(board) })(
      store.get(competitor.id)!,
    )
    // Two runs existed before the sweep (the claimer and the competitor); a
    // third would be the auto-restart this test exists to forbid.
    expect(runCount()).toBe(2)
    expect(board.attached).toEqual([])
  })

  // THE MUST-PASS SIBLING. The fix must not be "never queue a card refused after
  // an await": with NOBODY binding the card during the same window, the refusal
  // still queues and the sweep still fires it once the branch frees.
  test('with no competitor the same late refusal DOES queue, and the sweep fires it', async () => {
    const board = stubBoard([
      { id: 'B', title: 'the card nobody raced for while its branch was held', design_doc_ref: null, status: 'upcoming' },
    ])
    const refusal = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts', board_item_id: 'B' },
      deps(board, { branchHolderProbe: liveHolder }),
    )
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.code).toBe('branch_live')
    expect(refusal.message).toContain('QUEUED')
    expect('hold' in refusal).toBe(true)
    expect(holds.getByItem(SLUG, 'B')).not.toBeNull()

    await buildDispatchHoldSweep({
      holds,
      board,
      makeDispatchDeps: () => deps(board, { branchHolderProbe: async () => null }),
    })({ id: 'unrelated' } as never)
    expect(runCount()).toBe(1)
    expect(holds.getByItem(SLUG, 'B')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ARGUS r6 (minor) — a `branch_live` hold is never dropped, which is right, but
// it also said the SAME warn line forever. A lock nothing will ever release
// (third-party/legacy, no ` start <n>` in its reason, so the recycled-pid
// refinement cannot fire) then wedged a card silently. The hold still survives;
// the LOG gets louder once the age stops looking transient.
// ---------------------------------------------------------------------------
describe('A BRANCH-LIVE HOLD THAT STOPS LOOKING TRANSIENT IS SAID OUT LOUD', () => {
  const card = (): StubBoard =>
    stubBoard([
      { id: 'A', title: 'the card whose branch a lock nobody releases still holds', design_doc_ref: null, status: 'upcoming' },
    ])

  async function queueBranchLiveHold(board: StubBoard): Promise<number> {
    const refusal = await dispatchBoardBoundBuild(
      { task: 'edit trident/foo.ts', board_item_id: 'A' },
      deps(board, { branchHolderProbe: liveHolder }),
    )
    expect(refusal.ok).toBe(false)
    const hold = holds.getByItem(SLUG, 'A')
    expect(hold).not.toBeNull()
    return Date.parse(hold!.created_at)
  }

  test('a FRESH branch_live hold re-refuses at warn, not at error', async () => {
    const board = card()
    const created = await queueBranchLiveHold(board)
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const warns = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await buildDispatchHoldSweep({
        holds,
        board,
        makeDispatchDeps: () => deps(board, { branchHolderProbe: liveHolder }),
        now: () => created + 60_000,
      })({ id: 'unrelated' } as never)
      expect(errors.mock.calls.flat().join(' ')).not.toContain('dispatch_hold_branch_live_stale')
      expect(warns.mock.calls.flat().join(' ')).toContain('dispatch_hold_branch_live')
    } finally {
      errors.mockRestore()
      warns.mockRestore()
    }
    // Still queued — the age changes the LOG LEVEL, never the row.
    expect(holds.getByItem(SLUG, 'A')).not.toBeNull()
  })

  test('past the stale budget the same refusal is an ERROR naming the age — and the hold survives', async () => {
    const board = card()
    const created = await queueBranchLiveHold(board)
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await buildDispatchHoldSweep({
        holds,
        board,
        makeDispatchDeps: () => deps(board, { branchHolderProbe: liveHolder }),
        now: () => created + BRANCH_LIVE_HOLD_STALE_MS,
      })({ id: 'unrelated' } as never)
      const emitted = errors.mock.calls.flat().join(' ')
      expect(emitted).toContain('dispatch_hold_branch_live_stale')
      expect(emitted).toContain(String(BRANCH_LIVE_HOLD_STALE_MS))
    } finally {
      errors.mockRestore()
    }
    // A LOUD line, not a TTL: dropping the row would delete a queued card that
    // nothing else ever re-dispatches.
    expect(holds.getByItem(SLUG, 'A')).not.toBeNull()
    expect(runCount()).toBe(0)
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
