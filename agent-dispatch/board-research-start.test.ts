/**
 * #379 — the ▶ RESEARCH starter lifecycle (`board-research-start.ts`). Drives the
 * REAL ▶-research completion wiring the composer uses, for success AND failure:
 *   - ROUTE: dispatches `kind: 'research'` bound to the card (never Trident), with
 *     a per-card `spawn_key` + coalesce (double-▶ guard).
 *   - DELIVER: the Atlas result is posted back to the originating chat.
 *   - TERMINAL: `finished` → card `done`; a non-success (`crashed`/`cancelled`/…) →
 *     card `failed` — so the pane auto-closes and the card is never stranded.
 *   - ASK-BEFORE-ACTING: an underspecified card posts a clarifying question and is
 *     NOT dispatched.
 */

import { describe, expect, test } from 'bun:test'

import {
  createBoardResearchStarter,
  type BoardResearchItem,
} from './board-research-start.ts'
import { DispatchValidationError } from './service.ts'
import type { DispatchHandle, DispatchRequest } from './service.ts'

const ITEM: BoardResearchItem = { id: 'card-1', title: 'Research the market', design_doc_ref: null }
const SCOPE = 'proj1'

interface Harness {
  start: ReturnType<typeof createBoardResearchStarter>
  dispatched: DispatchRequest[]
  terminalStatuses: Array<{ id: string; status: 'done' | 'failed' }>
  delivered: Array<{ chatId: string; text: string }>
  settle: () => Promise<void>
}

/** Build the starter with fakes + a completion the test resolves on demand. */
function harness(opts: {
  outcome?: { status: string; result: string }
  dispatchThrows?: unknown
}): Harness {
  const dispatched: DispatchRequest[] = []
  const terminalStatuses: Array<{ id: string; status: 'done' | 'failed' }> = []
  const delivered: Array<{ chatId: string; text: string }> = []
  const scheduled: Array<Promise<unknown>> = []

  let resolveCompletion: (o: { status: string; result: string }) => void = () => {}
  const completion = new Promise<{ status: string; result: string }>((r) => {
    resolveCompletion = r
  })

  const start = createBoardResearchStarter({
    dispatch: async (req: DispatchRequest): Promise<DispatchHandle> => {
      dispatched.push(req)
      if (opts.dispatchThrows !== undefined) throw opts.dispatchThrows
      return {
        run_id: 'atlas-run-1',
        // `record` is unused by the starter; a minimal cast keeps the fake small.
        record: {} as DispatchHandle['record'],
        completion: completion as unknown as DispatchHandle['completion'],
      }
    },
    resolveTask: async (_scope, item) => `TASK for ${item.title}`,
    markCardTerminal: async (_scope, id, status) => {
      terminalStatuses.push({ id, status })
    },
    deliver: (chatId, text) => {
      delivered.push({ chatId, text })
    },
    chatIdForScope: (scope) => `app:owner:${scope}`,
    schedule: (work) => {
      scheduled.push(work)
    },
  })

  return {
    start,
    dispatched,
    terminalStatuses,
    delivered,
    settle: async () => {
      if (opts.outcome !== undefined) resolveCompletion(opts.outcome)
      await Promise.all(scheduled)
    },
  }
}

describe('#379 ▶ research starter — routing', () => {
  test('dispatches kind=research bound to the card, with a coalescing spawn_key', async () => {
    const h = harness({ outcome: { status: 'finished', result: 'done' } })
    const res = await h.start(SCOPE, ITEM)
    expect(res).toEqual({ ok: true, run_id: 'atlas-run-1' })
    expect(h.dispatched).toHaveLength(1)
    const req = h.dispatched[0]!
    expect(req.kind).toBe('research') // NOT a Trident build
    expect(req.board_item_id).toBe('card-1')
    expect(req.board_scope).toBe(SCOPE)
    expect(req.spawn_key).toBe('wb-research:proj1:card-1')
    expect(req.on_duplicate).toBe('coalesce')
    expect(req.delivery_target).toEqual({ channel: 'app_socket', binding_id: 'app:owner:proj1' })
  })
})

describe('#379 ▶ research starter — terminal lifecycle', () => {
  test('SUCCESS → card marked done + Atlas result delivered to chat', async () => {
    const h = harness({ outcome: { status: 'finished', result: 'The market is large.' } })
    await h.start(SCOPE, ITEM)
    await h.settle()
    expect(h.terminalStatuses).toEqual([{ id: 'card-1', status: 'done' }])
    expect(h.delivered).toEqual([{ chatId: 'app:owner:proj1', text: 'The market is large.' }])
  })

  test('FAILURE (crashed) → card marked FAILED (not stranded) + a failure note delivered', async () => {
    const h = harness({ outcome: { status: 'crashed', result: '' } })
    await h.start(SCOPE, ITEM)
    await h.settle()
    expect(h.terminalStatuses).toEqual([{ id: 'card-1', status: 'failed' }])
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]!.text).toContain("didn't finish")
    expect(h.delivered[0]!.text).toContain('crashed')
  })

  test('TIMEOUT (timed_out) → card marked FAILED so the pane auto-closes', async () => {
    const h = harness({ outcome: { status: 'timed_out', result: '' } })
    await h.start(SCOPE, ITEM)
    await h.settle()
    expect(h.terminalStatuses).toEqual([{ id: 'card-1', status: 'failed' }])
  })
})

describe('#379 ▶ research starter — ask-before-acting', () => {
  test('an underspecified card is NOT dispatched — a clarifying question is posted', async () => {
    const h = harness({
      dispatchThrows: new DispatchValidationError('underspecified', 'internal guard reasoning'),
    })
    const res = await h.start(SCOPE, ITEM)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('underspecified')
    // A clarifying question landed in the chat; the raw guard text did NOT.
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]!.text).toContain('needs a bit more detail')
    expect(h.delivered[0]!.text).not.toContain('internal guard reasoning')
    // No terminal reconcile fired (nothing was dispatched).
    expect(h.terminalStatuses).toEqual([])
  })

  test('a missing/unknown board item maps to the right rejection code', async () => {
    const h = harness({
      dispatchThrows: new DispatchValidationError('unknown_board_item', 'no such item'),
    })
    const res = await h.start(SCOPE, ITEM)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('unknown_board_item')
    expect(h.delivered).toEqual([]) // no chat noise for a plumbing error
  })
})
