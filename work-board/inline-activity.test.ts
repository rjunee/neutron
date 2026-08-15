import { describe, expect, test } from 'bun:test'

import {
  deriveInlineActive,
  INLINE_EVIDENCE_WINDOW_MS,
  isInlineEvidenceEdge,
  makeInlineActivityDeriver,
  withDerivedInlineActive,
  type InlineActivityScanItem,
} from './inline-activity.ts'

const NOW = 1_755_000_000_000

function mk(overrides: Partial<InlineActivityScanItem> = {}): InlineActivityScanItem {
  return {
    status: 'upcoming',
    inline_active: false,
    linked_run_id: null,
    ...overrides,
  }
}

describe('deriveInlineActive', () => {
  test('(a) fresh evidence activates in-progress work without a flag write', () => {
    // Pins the flag-only mutant.
    expect(deriveInlineActive(mk({ status: 'in_progress' }), { now: NOW, last_write_activity_at: NOW - 1_000 })).toBe(true)
  })

  test('a flag hint lights only when corroborated by fresh evidence', () => {
    expect(deriveInlineActive(mk({ inline_active: true }), { now: NOW, last_write_activity_at: NOW - 1_000 })).toBe(true)
  })

  test('(b) absent evidence defeats a stale flag after a crash or restart', () => {
    expect(deriveInlineActive(mk({ status: 'in_progress', inline_active: true }), { now: NOW, last_write_activity_at: 0 })).toBe(false)
  })

  test('(b) evidence exactly at the window is stale; one millisecond fresher is active', () => {
    const item = mk({ status: 'in_progress', inline_active: true })
    expect(deriveInlineActive(item, { now: NOW, last_write_activity_at: NOW - INLINE_EVIDENCE_WINDOW_MS })).toBe(false)
    expect(deriveInlineActive(item, { now: NOW, last_write_activity_at: NOW - INLINE_EVIDENCE_WINDOW_MS + 1 })).toBe(true)
  })

  test('(c) LATCH-PROOF: advancing only now turns a formerly active card off', () => {
    // A derivation that can only turn on is a worse lie than the flag.
    const item = mk({ status: 'in_progress', inline_active: true })
    const lastReal = NOW - 1_000
    expect(deriveInlineActive(item, { now: NOW, last_write_activity_at: lastReal })).toBe(true)
    expect(deriveInlineActive(item, { now: lastReal + INLINE_EVIDENCE_WINDOW_MS, last_write_activity_at: lastReal })).toBe(false)
  })

  test('(c) fresh evidence alone does not make upcoming unflagged work active', () => {
    // Pins the unconditional-true mutant.
    expect(deriveInlineActive(mk(), { now: NOW, last_write_activity_at: NOW - 1_000 })).toBe(false)
  })

  test('(c) a future-dated stamp past one window is a clock step, not work', () => {
    // Without the backwards-clock clamp `now - at` is very negative and every
    // freshness test passes for the whole skew.
    const item = mk({ status: 'in_progress' })
    const skew = INLINE_EVIDENCE_WINDOW_MS * 10
    expect(deriveInlineActive(item, { now: NOW, last_write_activity_at: NOW + skew })).toBe(false)
    // A trivial forward skew (clock jitter between two boxes) still counts.
    expect(deriveInlineActive(item, { now: NOW, last_write_activity_at: NOW + 5 })).toBe(true)
  })

  test('R1: terminal cards never claim inline activity', () => {
    for (const status of ['done', 'failed']) {
      expect(deriveInlineActive(mk({ status, inline_active: true }), { now: NOW, last_write_activity_at: NOW - 1 })).toBe(false)
    }
  })

  test('R2: a card bound to a LIVE run uses the fork lane instead of inline evidence', () => {
    const item = mk({ status: 'in_progress', linked_run_id: 'run-1' })
    expect(deriveInlineActive(item, { now: NOW, last_write_activity_at: NOW - 1 })).toBe(false)
    // …and a caller that cannot tell assumes live, so nothing silently loosens.
    expect(deriveInlineActive(item, { now: NOW, last_write_activity_at: NOW - 1 }, {})).toBe(false)
  })

  test('R2: a card bound to a TERMINAL run reads its inline evidence again', () => {
    // The retry-after-failure case: the run is dead, the owner is fixing the card
    // inline. Matching `isLinkedRunning`, which also treats a terminal bound run
    // as not running — before this, fresh evidence was discarded outright.
    const item = mk({ status: 'in_progress', linked_run_id: 'run-dead' })
    expect(
      deriveInlineActive(item, { now: NOW, last_write_activity_at: NOW - 1_000 }, { linked_run_live: false }),
    ).toBe(true)
  })

  test('R2: an undefined link is no link, not a throw', () => {
    const item = { status: 'in_progress', inline_active: false } as unknown as InlineActivityScanItem
    expect(deriveInlineActive(item, { now: NOW, last_write_activity_at: NOW - 1 })).toBe(true)
  })

  test('R5: status-only derivation is refused for a non-candidate row', () => {
    const item = mk({ status: 'in_progress' })
    const ev = { now: NOW, last_write_activity_at: NOW - 1_000 }
    expect(deriveInlineActive(item, ev, { evidence_candidate: false })).toBe(false)
    // …but an explicit flag on the same non-candidate row still shows.
    expect(deriveInlineActive({ ...item, inline_active: true }, ev, { evidence_candidate: false })).toBe(true)
  })

  test('respects a window_ms override with the same stale boundary', () => {
    const item = mk({ status: 'in_progress' })
    expect(deriveInlineActive(item, { now: NOW, last_write_activity_at: NOW - 5, window_ms: 10 })).toBe(true)
    expect(deriveInlineActive(item, { now: NOW, last_write_activity_at: NOW - 10, window_ms: 10 })).toBe(false)
  })
})

describe('withDerivedInlineActive — the composer read-boundary adapter', () => {
  test('an unset reader heals a stale flag fail-soft', () => {
    expect(withDerivedInlineActive([mk({ status: 'in_progress', inline_active: true })], {}, 'p1', NOW)[0]?.inline_active).toBe(false)
  })

  test('fresh evidence activates runless in-progress work without a flag write', () => {
    const reader = { lastWriteActivityAt: (): number => NOW - 1_000 }
    expect(withDerivedInlineActive([mk({ status: 'in_progress' })], reader, 'p1', NOW)[0]?.inline_active).toBe(true)
  })

  test('evidence exactly at the window is stale', () => {
    const reader = { lastWriteActivityAt: (): number => NOW - INLINE_EVIDENCE_WINDOW_MS }
    expect(withDerivedInlineActive([mk({ inline_active: true })], reader, 'p1', NOW)[0]?.inline_active).toBe(false)
  })

  test('reads evidence once per board, however many rows', () => {
    let reads = 0
    const reader = { lastWriteActivityAt: (): number => (reads++, NOW - 1_000) }
    withDerivedInlineActive(Array.from({ length: 5 }, () => mk()), reader, 'p1', NOW)
    expect(reads).toBe(1)
  })

  test('ONE project write cannot light up every runless in-progress card', () => {
    // The board-wide false positive: a project-scoped clock with no per-row
    // rationing marked all three active and suppressed ▶ across the board.
    const reader = { lastWriteActivityAt: (): number => NOW - 1_000 }
    const items = [
      mk({ status: 'in_progress', updated_at: '2026-08-14T10:00:00.000Z' }),
      mk({ status: 'in_progress', updated_at: '2026-08-14T12:00:00.000Z' }),
      mk({ status: 'in_progress', updated_at: '2026-08-14T11:00:00.000Z' }),
    ]
    const out = withDerivedInlineActive(items, reader, 'p1', NOW)
    expect(out.map((it) => it.inline_active)).toEqual([false, true, false])
  })

  test('the single candidate is the most recently touched eligible card', () => {
    const reader = { lastWriteActivityAt: (): number => NOW - 1_000 }
    const out = withDerivedInlineActive(
      [
        mk({ status: 'in_progress', updated_at: '2026-08-14T09:00:00.000Z' }),
        // Flagged rows activate on their own and never consume the candidacy.
        mk({ status: 'in_progress', inline_active: true, updated_at: '2026-08-14T23:00:00.000Z' }),
        // A live bound run owns its card, so it cannot consume it either.
        mk({ status: 'in_progress', linked_run_id: 'run-1', updated_at: '2026-08-14T22:00:00.000Z' }),
        mk({ status: 'in_progress', updated_at: '2026-08-14T10:00:00.000Z' }),
      ],
      reader,
      'p1',
      NOW,
    )
    expect(out.map((it) => it.inline_active)).toEqual([false, true, false, true])
  })

  test('a terminal bound run releases the card to its inline evidence', () => {
    const reader = { lastWriteActivityAt: (): number => NOW - 1_000 }
    const items = [mk({ status: 'in_progress', linked_run_id: 'run-dead' })]
    expect(withDerivedInlineActive(items, reader, 'p1', NOW)[0]?.inline_active).toBe(false)
    expect(withDerivedInlineActive(items, reader, 'p1', NOW, () => false)[0]?.inline_active).toBe(true)
  })

  test('a throwing run store degrades to "live", never to invented activity', () => {
    const reader = { lastWriteActivityAt: (): number => NOW - 1_000 }
    const items = [mk({ status: 'in_progress', linked_run_id: 'run-x' })]
    expect(
      withDerivedInlineActive(items, reader, 'p1', NOW, () => {
        throw new Error('run store down')
      })[0]?.inline_active,
    ).toBe(false)
  })

  test('preserves non-activity fields without mutating the input', () => {
    const item = { ...mk({ status: 'in_progress' }), title: 'Keep me' }
    const input = [item]
    const output = withDerivedInlineActive(input, { lastWriteActivityAt: () => NOW - 1 }, 'p1', NOW)
    expect(output[0]?.title).toBe('Keep me')
    expect(input[0]).toBe(item)
    expect(input[0]?.inline_active).toBe(false)
    expect(output[0]?.inline_active).toBe(true)
  })
})

describe('makeInlineActivityDeriver — the ONE seam every read boundary shares', () => {
  // These are the two mistakes a per-site call could make invisibly (a wrong
  // scope key, a `now` captured at composition). Behavioural, not source-text.
  test('maps the project id through the injected scope key', () => {
    const seen: Array<string> = []
    const derive = makeInlineActivityDeriver({
      reader: { lastWriteActivityAt: (scope) => (seen.push(scope), scope === 'p1' ? NOW - 1 : 0) },
      scopeKey: (project_id) => project_id ?? 'general',
      now: () => NOW,
    })
    expect(derive([mk({ status: 'in_progress' })], 'p1')[0]?.inline_active).toBe(true)
    // A DIFFERENT project's board must not read p1's evidence.
    expect(derive([mk({ status: 'in_progress' })], 'p2')[0]?.inline_active).toBe(false)
    // …and the General board maps through the same seam, never a raw null.
    expect(derive([mk({ status: 'in_progress' })], null)[0]?.inline_active).toBe(false)
    expect(seen).toEqual(['p1', 'p2', 'general'])
  })

  test('reads the clock PER CALL, so a card cannot latch on a captured now', () => {
    const t = { v: NOW }
    const derive = makeInlineActivityDeriver({
      reader: { lastWriteActivityAt: () => NOW - 1_000 },
      scopeKey: (project_id) => project_id ?? 'general',
      now: () => t.v,
    })
    const item = mk({ status: 'in_progress', inline_active: true })
    expect(derive([item], 'p1')[0]?.inline_active).toBe(true)
    t.v = NOW + INLINE_EVIDENCE_WINDOW_MS
    expect(derive([item], 'p1')[0]?.inline_active).toBe(false)
  })

  test('threads the run-liveness predicate through to R2', () => {
    const derive = makeInlineActivityDeriver({
      reader: { lastWriteActivityAt: () => NOW - 1_000 },
      scopeKey: (project_id) => project_id ?? 'general',
      now: () => NOW,
      isRunLive: (run_id) => run_id === 'run-live',
    })
    const rows = derive(
      [
        mk({ status: 'in_progress', linked_run_id: 'run-live', updated_at: 'b' }),
        mk({ status: 'in_progress', linked_run_id: 'run-dead', updated_at: 'a' }),
      ],
      'p1',
    )
    expect(rows.map((it) => it.inline_active)).toEqual([false, true])
  })

  test('an unbound reader derives not-active rather than throwing', () => {
    const derive = makeInlineActivityDeriver({
      reader: {},
      scopeKey: (project_id) => project_id ?? 'general',
      now: () => NOW,
    })
    expect(derive([mk({ status: 'in_progress', inline_active: true })], 'p1')[0]?.inline_active).toBe(
      false,
    )
  })
})

describe('isInlineEvidenceEdge — when the tap must push a board frame', () => {
  const W = INLINE_EVIDENCE_WINDOW_MS

  test('the first write ever seen for a scope is an edge', () => {
    expect(isInlineEvidenceEdge(0, NOW)).toBe(true)
  })

  test('a write inside an already-active window is NOT an edge', () => {
    // Delete this clause and every tool call fans a full board snapshot.
    expect(isInlineEvidenceEdge(NOW, NOW + 1_000)).toBe(false)
    expect(isInlineEvidenceEdge(NOW, NOW + W - 1)).toBe(false)
  })

  test('a write after the signal expired is an edge again', () => {
    expect(isInlineEvidenceEdge(NOW, NOW + W)).toBe(true)
  })

  test('a row that did not advance the clock is never an edge', () => {
    // Reads, thinking, keepalives: the clock is unchanged, so nothing happened.
    expect(isInlineEvidenceEdge(NOW, NOW)).toBe(false)
    expect(isInlineEvidenceEdge(0, 0)).toBe(false)
  })
})
