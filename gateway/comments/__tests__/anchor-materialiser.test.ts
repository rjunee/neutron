/**
 * P7.2 S1 — anchor-materialiser unit tests.
 *
 * The materialiser is a pure function so these tests hand-author event
 * sequences and assert the resulting `AnchorRow[]` shape. No I/O, no
 * SQLite — these are fast.
 *
 * Covers per brief § 10.1:
 *   - thread root → seeds an anchor with status='live'
 *   - replies → bump reply_count + last_reply_at without moving the anchor
 *   - anchor_relocated → updates current_start/current_end + status
 *   - anchor_drifted → clears current_*, sets drift_hint_*
 *   - anchor_dead → clears current_*, sets status='dead'
 *   - multi-thread same doc → independent rows
 *   - escalate_to_chat / agent_reply_skipped → no anchor mutation
 *   - wipe-and-rebuild idempotency: same input → same output
 *   - sort discipline: (created_at, event_id) regardless of input order
 */

import { describe, expect, it } from 'bun:test'

import {
  materialiseAnchors,
  type AnchorRow,
  type DocCommentEvent,
} from '../anchor-materialiser.ts'

function ev(overrides: Partial<DocCommentEvent>): DocCommentEvent {
  return {
    event_id: overrides.event_id ?? '01HW0000000000000000000001',
    event_kind: overrides.event_kind ?? 'comment_posted',
    doc_path: overrides.doc_path ?? 'notes/foo.md',
    thread_root_id: overrides.thread_root_id ?? null,
    parent_event_id: overrides.parent_event_id ?? null,
    anchor_start: overrides.anchor_start ?? null,
    anchor_end: overrides.anchor_end ?? null,
    anchor_text_excerpt: overrides.anchor_text_excerpt ?? null,
    anchor_ctx_before: overrides.anchor_ctx_before ?? null,
    anchor_ctx_after: overrides.anchor_ctx_after ?? null,
    based_on_modified_at: overrides.based_on_modified_at ?? null,
    author_kind: overrides.author_kind ?? 'user',
    author_id: overrides.author_id ?? 'user_sam',
    body: overrides.body ?? null,
    metadata_json: overrides.metadata_json ?? null,
    created_at: overrides.created_at ?? 1_700_000_000_000,
  }
}

const FIXED_NOW = 1_700_000_999_999

describe('materialiseAnchors — thread root seeding', () => {
  it('seeds a single root anchor with status="live"', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        event_kind: 'comment_posted',
        thread_root_id: null,
        anchor_start: 100,
        anchor_end: 120,
        anchor_text_excerpt: 'highlighted excerpt',
        body: 'is this still accurate?',
        created_at: 1_700_000_000_000,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result.length).toBe(1)
    const row = result[0]!
    expect(row.thread_root_id).toBe('01HW0000000000000000000001')
    expect(row.doc_path).toBe('notes/foo.md')
    expect(row.current_start).toBe(100)
    expect(row.current_end).toBe(120)
    expect(row.status).toBe('live')
    expect(row.drift_hint_start).toBe(null)
    expect(row.drift_hint_end).toBe(null)
    expect(row.last_rebuilt_from).toBe('01HW0000000000000000000001')
    expect(row.last_rebuilt_at).toBe(FIXED_NOW)
    expect(row.reply_count).toBe(0)
    expect(row.last_reply_at).toBe(1_700_000_000_000)
  })

  it('seeds multiple independent roots on the same doc', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        thread_root_id: null,
        anchor_start: 10,
        anchor_end: 20,
        anchor_text_excerpt: 'first',
      }),
      ev({
        event_id: '01HW0000000000000000000002',
        thread_root_id: null,
        anchor_start: 30,
        anchor_end: 40,
        anchor_text_excerpt: 'second',
        created_at: 1_700_000_000_010,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result.length).toBe(2)
    expect(result.map((r) => r.thread_root_id).sort()).toEqual([
      '01HW0000000000000000000001',
      '01HW0000000000000000000002',
    ])
  })
})

describe('materialiseAnchors — replies', () => {
  it('bumps reply_count + last_reply_at without moving the anchor', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        thread_root_id: null,
        anchor_start: 100,
        anchor_end: 120,
        anchor_text_excerpt: 'highlighted',
        body: 'root body',
        created_at: 1_700_000_000_000,
      }),
      ev({
        event_id: '01HW0000000000000000000002',
        thread_root_id: '01HW0000000000000000000001',
        parent_event_id: '01HW0000000000000000000001',
        body: 'first reply',
        created_at: 1_700_000_000_010,
      }),
      ev({
        event_id: '01HW0000000000000000000003',
        thread_root_id: '01HW0000000000000000000001',
        parent_event_id: '01HW0000000000000000000002',
        body: 'reply to the reply',
        created_at: 1_700_000_000_020,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result.length).toBe(1)
    const row = result[0]!
    expect(row.reply_count).toBe(2)
    expect(row.last_reply_at).toBe(1_700_000_000_020)
    expect(row.current_start).toBe(100)
    expect(row.current_end).toBe(120)
    expect(row.status).toBe('live')
    expect(row.last_rebuilt_from).toBe('01HW0000000000000000000003')
  })

  it('drops orphaned replies (root absent from stream)', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000002',
        thread_root_id: '01HW0000000000000000000099',
        parent_event_id: '01HW0000000000000000000099',
        body: 'orphan',
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result).toEqual([])
  })
})

describe('materialiseAnchors — walker events', () => {
  it('anchor_relocated updates current_start/current_end + status="live"', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        thread_root_id: null,
        anchor_start: 100,
        anchor_end: 120,
      }),
      ev({
        event_id: '01HW0000000000000000000005',
        event_kind: 'anchor_relocated',
        thread_root_id: '01HW0000000000000000000001',
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({
          from_start: 100,
          from_end: 120,
          to_start: 200,
          to_end: 220,
          lev_distance: 0,
        }),
        created_at: 1_700_000_000_100,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result.length).toBe(1)
    const row = result[0]!
    expect(row.current_start).toBe(200)
    expect(row.current_end).toBe(220)
    expect(row.status).toBe('live')
    expect(row.drift_hint_start).toBe(null)
    expect(row.last_rebuilt_from).toBe('01HW0000000000000000000005')
  })

  it('anchor_drifted clears current_* and sets drift_hint_*', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        thread_root_id: null,
        anchor_start: 100,
        anchor_end: 120,
      }),
      ev({
        event_id: '01HW0000000000000000000006',
        event_kind: 'anchor_drifted',
        thread_root_id: '01HW0000000000000000000001',
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({
          hint_start: 180,
          hint_end: 200,
          confidence: 0.82,
        }),
        created_at: 1_700_000_000_200,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    const row = result[0]!
    expect(row.status).toBe('drifted')
    expect(row.current_start).toBe(null)
    expect(row.current_end).toBe(null)
    expect(row.drift_hint_start).toBe(180)
    expect(row.drift_hint_end).toBe(200)
  })

  it('anchor_dead clears current_* and sets status="dead"', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        thread_root_id: null,
        anchor_start: 100,
        anchor_end: 120,
      }),
      ev({
        event_id: '01HW0000000000000000000007',
        event_kind: 'anchor_dead',
        thread_root_id: '01HW0000000000000000000001',
        author_kind: 'system',
        author_id: 'reanchor-walker',
        created_at: 1_700_000_000_300,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    const row = result[0]!
    expect(row.status).toBe('dead')
    expect(row.current_start).toBe(null)
    expect(row.current_end).toBe(null)
    expect(row.drift_hint_start).toBe(null)
    expect(row.drift_hint_end).toBe(null)
  })

  it('dead → relocated transitions back to live', () => {
    // The S2 walker can resurrect an anchor when a P7.4 revert
    // restores the original content (brief § 9.3). The materialiser
    // must fold those events back into status='live'.
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        thread_root_id: null,
        anchor_start: 100,
        anchor_end: 120,
      }),
      ev({
        event_id: '01HW0000000000000000000007',
        event_kind: 'anchor_dead',
        thread_root_id: '01HW0000000000000000000001',
        author_kind: 'system',
        author_id: 'reanchor-walker',
        created_at: 1_700_000_000_300,
      }),
      ev({
        event_id: '01HW0000000000000000000008',
        event_kind: 'anchor_relocated',
        thread_root_id: '01HW0000000000000000000001',
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({
          to_start: 150,
          to_end: 170,
          lev_distance: 0,
        }),
        created_at: 1_700_000_000_400,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    const row = result[0]!
    expect(row.status).toBe('live')
    expect(row.current_start).toBe(150)
    expect(row.current_end).toBe(170)
  })
})

describe('materialiseAnchors — non-anchor events', () => {
  it('escalate_to_chat does not mutate the anchor', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        thread_root_id: null,
        anchor_start: 100,
        anchor_end: 120,
      }),
      ev({
        event_id: '01HW0000000000000000000009',
        event_kind: 'escalate_to_chat',
        thread_root_id: '01HW0000000000000000000001',
        author_kind: 'user',
        author_id: 'user_sam',
        metadata_json: JSON.stringify({ chat_message_id: 'msg_x' }),
        created_at: 1_700_000_000_500,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    const row = result[0]!
    expect(row.current_start).toBe(100)
    expect(row.current_end).toBe(120)
    expect(row.status).toBe('live')
  })

  it('agent_reply_skipped does not mutate the anchor', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        thread_root_id: null,
        anchor_start: 100,
        anchor_end: 120,
      }),
      ev({
        event_id: '01HW000000000000000000000A',
        event_kind: 'agent_reply_skipped',
        thread_root_id: '01HW0000000000000000000001',
        author_kind: 'system',
        author_id: 'agent-watcher',
        metadata_json: JSON.stringify({ reason: 'classifier_statement' }),
        created_at: 1_700_000_000_600,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    const row = result[0]!
    expect(row.current_start).toBe(100)
    expect(row.current_end).toBe(120)
    expect(row.status).toBe('live')
  })
})

describe('materialiseAnchors — idempotency + sort', () => {
  it('produces identical output when called twice on the same stream', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        thread_root_id: null,
        anchor_start: 10,
        anchor_end: 20,
      }),
      ev({
        event_id: '01HW0000000000000000000002',
        thread_root_id: '01HW0000000000000000000001',
        parent_event_id: '01HW0000000000000000000001',
        body: 'reply',
        created_at: 1_700_000_000_010,
      }),
    ]
    const first = materialiseAnchors(events, { now: () => FIXED_NOW })
    const second = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(second).toEqual(first)
  })

  it('orders events by (created_at, event_id) regardless of input order', () => {
    // Same event_id ULIDs but supplied in reverse order; the
    // materialiser must still seed the root before the reply.
    const root = ev({
      event_id: '01HW0000000000000000000001',
      thread_root_id: null,
      anchor_start: 10,
      anchor_end: 20,
      created_at: 1_700_000_000_000,
    })
    const reply = ev({
      event_id: '01HW0000000000000000000002',
      thread_root_id: '01HW0000000000000000000001',
      parent_event_id: '01HW0000000000000000000001',
      body: 'reply',
      created_at: 1_700_000_000_010,
    })
    const fwd = materialiseAnchors([root, reply], { now: () => FIXED_NOW })
    const rev = materialiseAnchors([reply, root], { now: () => FIXED_NOW })
    expect(rev).toEqual(fwd)
    expect(fwd[0]!.reply_count).toBe(1)
  })
})

describe('materialiseAnchors — S2 stale walker-event suppression', () => {
  it('drops walker events whose based_on_modified_at is older than a newer walker run for the same thread', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        event_kind: 'comment_posted',
        thread_root_id: null,
        anchor_start: 100,
        anchor_end: 120,
        anchor_text_excerpt: 'highlighted',
        body: 'root',
        created_at: 1_700_000_000_000,
      }),
      // Slow walker A — older mtime, emits anchor_dead.
      ev({
        event_id: '01HW000000000000000000000A',
        event_kind: 'anchor_dead',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 1_700_000_000_500,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({
          last_known_start: 100,
          last_known_end: 120,
        }),
        created_at: 1_700_000_001_000,
      }),
      // Fast walker B — newer mtime, emits anchor_relocated. The
      // materialiser should drop walker A and apply walker B.
      ev({
        event_id: '01HW000000000000000000000B',
        event_kind: 'anchor_relocated',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 1_700_000_001_500,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({
          from_start: 100,
          from_end: 120,
          to_start: 150,
          to_end: 170,
          lev_distance: 0,
        }),
        created_at: 1_700_000_000_900, // INTENTIONALLY earlier in created_at than A
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result.length).toBe(1)
    expect(result[0]!.status).toBe('live')
    expect(result[0]!.current_start).toBe(150)
    expect(result[0]!.current_end).toBe(170)
  })

  it('keeps walker events when no newer walker run exists for the thread', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        event_kind: 'comment_posted',
        thread_root_id: null,
        anchor_start: 100,
        anchor_end: 120,
        anchor_text_excerpt: 'highlighted',
        body: 'root',
        created_at: 1_700_000_000_000,
      }),
      ev({
        event_id: '01HW000000000000000000000A',
        event_kind: 'anchor_drifted',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 1_700_000_000_500,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({ hint_start: 105, hint_end: 125 }),
        created_at: 1_700_000_001_000,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result.length).toBe(1)
    expect(result[0]!.status).toBe('drifted')
    expect(result[0]!.drift_hint_start).toBe(105)
  })

  it('Argus r1 IMPORTANT #2 — a stale delete event with a finite mtime is suppressed by a newer write walker for the same thread', () => {
    // Race scenario: deleteDoc and writeDoc land on the same path in
    // quick succession. The deleter's walker emits anchor_dead with
    // mtime=1000 (the unlink time). The writer's walker (started
    // strictly later in wall time) emits anchor_relocated with
    // mtime=2000. Both walkers are serialised by the per-project
    // mutex, but the deleter's events landed first in created_at
    // because the deleter took the mutex first. Without the
    // finite-mtime stamp, the deleter's null-mtime anchor_dead
    // bypassed the stale-event filter ("null → always keep") and
    // clobbered the writer's relocated even though the file exists.
    // With the finite stamp, the materialiser drops the deleter's
    // event and `status='live'` survives.
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        event_kind: 'comment_posted',
        thread_root_id: null,
        anchor_start: 100,
        anchor_end: 120,
        anchor_text_excerpt: 'highlighted',
        body: 'root',
        created_at: 1_700_000_000_000,
      }),
      // Slow deleter — finite mtime=1000, emits anchor_dead at created_at=t+1000.
      ev({
        event_id: '01HW000000000000000000000A',
        event_kind: 'anchor_dead',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 1000,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({ reason: 'doc_deleted' }),
        created_at: 1_700_000_001_000,
      }),
      // Fast writer — newer mtime=2000, emits anchor_relocated at created_at=t+1500.
      // Note the writer's event lands LATER in created_at than the
      // deleter's, so even without the stale filter the writer would
      // win the fold by mere ordering. But the assertion below covers
      // the harder reorder case too via the third event.
      ev({
        event_id: '01HW000000000000000000000B',
        event_kind: 'anchor_relocated',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 2000,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({
          to_start: 200,
          to_end: 220,
          lev_distance: 0,
        }),
        created_at: 1_700_000_001_500,
      }),
      // Second slower deleter — its event lands AFTER the writer's
      // in created_at because the mutex serialisation isn't a wall-
      // clock guarantee in production (different DocStore mutations
      // can racily reach the hook). With mtime=1000 < walkerMax=2000,
      // the stale-event filter drops it.
      ev({
        event_id: '01HW000000000000000000000C',
        event_kind: 'anchor_dead',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 1000,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({ reason: 'doc_deleted' }),
        created_at: 1_700_000_002_000,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result.length).toBe(1)
    expect(result[0]!.status).toBe('live')
    expect(result[0]!.current_start).toBe(200)
  })

  it('keeps walker events with null based_on_modified_at (hand-authored / delete-without-mtime)', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        event_kind: 'comment_posted',
        thread_root_id: null,
        anchor_start: 100,
        anchor_end: 120,
        anchor_text_excerpt: 'highlighted',
        body: 'root',
        created_at: 1_700_000_000_000,
      }),
      ev({
        event_id: '01HW000000000000000000000A',
        event_kind: 'anchor_dead',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: null,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({ reason: 'doc_deleted' }),
        created_at: 1_700_000_001_000,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result.length).toBe(1)
    expect(result[0]!.status).toBe('dead')
  })

  it('only the highest mtime walker event applies when three runs race for the same thread', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        event_kind: 'comment_posted',
        thread_root_id: null,
        anchor_start: 100,
        anchor_end: 120,
        anchor_text_excerpt: 'x',
        body: 'root',
        created_at: 1_700_000_000_000,
      }),
      ev({
        event_id: '01HW000000000000000000000A',
        event_kind: 'anchor_dead',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 500,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: '{}',
        created_at: 1_700_000_001_000,
      }),
      ev({
        event_id: '01HW000000000000000000000B',
        event_kind: 'anchor_drifted',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 1000,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({ hint_start: 200, hint_end: 220 }),
        created_at: 1_700_000_001_200,
      }),
      ev({
        event_id: '01HW000000000000000000000C',
        event_kind: 'anchor_relocated',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 1500, // highest mtime → wins
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({
          from_start: 100,
          from_end: 120,
          to_start: 250,
          to_end: 270,
          lev_distance: 0,
        }),
        created_at: 1_700_000_001_500,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result.length).toBe(1)
    expect(result[0]!.status).toBe('live')
    expect(result[0]!.current_start).toBe(250)
  })
})

describe('materialiseAnchors — S2 anchor_relocated.to_doc_path support', () => {
  it('updates anchor.doc_path when metadata.to_doc_path is set', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        event_kind: 'comment_posted',
        doc_path: 'from.md',
        thread_root_id: null,
        anchor_start: 50,
        anchor_end: 60,
        anchor_text_excerpt: 'phrase',
        body: 'root',
        created_at: 1_700_000_000_000,
      }),
      ev({
        event_id: '01HW000000000000000000000A',
        event_kind: 'anchor_relocated',
        doc_path: 'to.md',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 1000,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({
          from_start: 50,
          from_end: 60,
          to_start: 50,
          to_end: 60,
          to_doc_path: 'to.md',
          from_doc_path: 'from.md',
          lev_distance: 0,
        }),
        created_at: 1_700_000_001_000,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result.length).toBe(1)
    expect(result[0]!.doc_path).toBe('to.md')
    expect(result[0]!.status).toBe('live')
    expect(result[0]!.current_start).toBe(50)
  })

  it('leaves anchor.doc_path unchanged when metadata.to_doc_path is absent', () => {
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        event_kind: 'comment_posted',
        doc_path: 'kept.md',
        thread_root_id: null,
        anchor_start: 50,
        anchor_end: 60,
        anchor_text_excerpt: 'phrase',
        body: 'root',
        created_at: 1_700_000_000_000,
      }),
      ev({
        event_id: '01HW000000000000000000000A',
        event_kind: 'anchor_relocated',
        doc_path: 'kept.md',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 1000,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({
          from_start: 50,
          from_end: 60,
          to_start: 80,
          to_end: 90,
          lev_distance: 0,
        }),
        created_at: 1_700_000_001_000,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result.length).toBe(1)
    expect(result[0]!.doc_path).toBe('kept.md')
    expect(result[0]!.current_start).toBe(80)
  })
})

describe('materialiseAnchors — S2 equal-ms tie-break (ISSUE #19)', () => {
  it('two walker events at identical based_on_modified_at fold deterministically across 100 runs', () => {
    const stamp = 2_000_000
    const ROOT = '01HW0000000000000000000ROOT'
    const ROOT_EV: DocCommentEvent = ev({
      event_id: ROOT,
      event_kind: 'comment_posted',
      thread_root_id: null,
      anchor_start: 100,
      anchor_end: 120,
      anchor_text_excerpt: 'highlighted',
      anchor_ctx_before: 'before',
      anchor_ctx_after: 'after',
      based_on_modified_at: 1_000_000,
      created_at: 1_700_000_000_000,
    })
    // Writer's anchor_relocated event_id is LEXICOGRAPHICALLY LARGER than
    // the deleter's anchor_dead event_id. The fix's stale filter drops
    // the lower-event_id event at equal stamps, so the writer wins.
    // ULIDs are Crockford-base32 (uppercase). Pick a writer with a
    // numerically/lexicographically larger suffix than the deleter to
    // exercise the equal-stamp tie-break decisively.
    const WRITER = '01HW00000000000000000ZZZZZZ'
    const DELETER = '01HW00000000000000000AAAAAA'
    const writeEv: DocCommentEvent = ev({
      event_id: WRITER,
      event_kind: 'anchor_relocated',
      thread_root_id: ROOT,
      based_on_modified_at: stamp,
      author_kind: 'system',
      author_id: 'reanchor-walker',
      metadata_json: JSON.stringify({
        from_start: 100,
        from_end: 120,
        to_start: 200,
        to_end: 220,
        lev_distance: 0,
      }),
      created_at: 1_700_000_000_001,
    })
    const deleteEv: DocCommentEvent = ev({
      event_id: DELETER,
      event_kind: 'anchor_dead',
      thread_root_id: ROOT,
      based_on_modified_at: stamp, // identical stamp to writer
      author_kind: 'system',
      author_id: 'reanchor-walker',
      metadata_json: JSON.stringify({ reason: 'doc_deleted' }),
      created_at: 1_700_000_000_001,
    })
    // 100x stress loop — fold should produce IDENTICAL output every time
    // regardless of input order, because the stale filter is order-
    // independent (it picks the higher event_id at the max stamp).
    let last: AnchorRow | null = null
    for (let i = 0; i < 100; i++) {
      const events: DocCommentEvent[] = i % 2 === 0
        ? [ROOT_EV, writeEv, deleteEv]
        : [ROOT_EV, deleteEv, writeEv]
      const out = materialiseAnchors(events, { now: () => FIXED_NOW })
      expect(out).toHaveLength(1)
      const row = out[0]!
      if (last !== null) {
        expect(row.status).toBe(last.status)
        expect(row.current_start).toBe(last.current_start)
        expect(row.current_end).toBe(last.current_end)
        expect(row.last_rebuilt_from).toBe(last.last_rebuilt_from)
      }
      last = row
    }
    // WRITER has the higher event_id at the equal stamp → wins the
    // stale filter → fold applies anchor_relocated → status='live' at
    // (200, 220).
    expect(last!.status).toBe('live')
    expect(last!.current_start).toBe(200)
    expect(last!.current_end).toBe(220)
    expect(last!.last_rebuilt_from).toBe(WRITER)
  })

  it('lower-event_id event at equal stamp is dropped from the fold', () => {
    // Reversed event_id race: the deleter has the LEXICOGRAPHICALLY
    // HIGHER event_id this time, so it wins the stale filter and
    // anchor_dead applies.
    const stamp = 2_000_000
    const ROOT = '01HW0000000000000000000ROOT'
    const ROOT_EV: DocCommentEvent = ev({
      event_id: ROOT,
      event_kind: 'comment_posted',
      thread_root_id: null,
      anchor_start: 100,
      anchor_end: 120,
      anchor_text_excerpt: 'highlighted',
      anchor_ctx_before: 'before',
      anchor_ctx_after: 'after',
      based_on_modified_at: 1_000_000,
      created_at: 1_700_000_000_000,
    })
    // DELETER > WRITER lexicographically.
    const DELETER_HI = '01HW00000000000000000ZZZZZZ'
    const WRITER_LO = '01HW00000000000000000AAAAAA'
    const writeEv: DocCommentEvent = ev({
      event_id: WRITER_LO,
      event_kind: 'anchor_relocated',
      thread_root_id: ROOT,
      based_on_modified_at: stamp,
      author_kind: 'system',
      author_id: 'reanchor-walker',
      metadata_json: JSON.stringify({
        from_start: 100,
        from_end: 120,
        to_start: 200,
        to_end: 220,
        lev_distance: 0,
      }),
      created_at: 1_700_000_000_001,
    })
    const deleteEv: DocCommentEvent = ev({
      event_id: DELETER_HI,
      event_kind: 'anchor_dead',
      thread_root_id: ROOT,
      based_on_modified_at: stamp,
      author_kind: 'system',
      author_id: 'reanchor-walker',
      metadata_json: JSON.stringify({ reason: 'doc_deleted' }),
      created_at: 1_700_000_000_001,
    })
    const out = materialiseAnchors([ROOT_EV, writeEv, deleteEv], {
      now: () => FIXED_NOW,
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.status).toBe('dead')
    expect(out[0]!.current_start).toBeNull()
    expect(out[0]!.current_end).toBeNull()
    expect(out[0]!.last_rebuilt_from).toBe(DELETER_HI)
  })
})

describe('materialiseAnchors — anchor_dead_moved fold (ISSUE #20)', () => {
  it('anchor_dead_moved updates doc_path and keeps status=dead', () => {
    // Previously-dead anchor on `from.md` carried over to `to.md` via
    // handleMove. The materialiser folds the dead-moved event so the
    // dead row's doc_path advances; status stays dead.
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        event_kind: 'comment_posted',
        doc_path: 'from.md',
        thread_root_id: null,
        anchor_start: 50,
        anchor_end: 60,
        anchor_text_excerpt: 'phrase',
        body: 'root',
        created_at: 1_700_000_000_000,
      }),
      ev({
        event_id: '01HW000000000000000000000A',
        event_kind: 'anchor_dead',
        doc_path: 'from.md',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 1000,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({ reason: 'doc_deleted' }),
        created_at: 1_700_000_001_000,
      }),
      // The doc was un-deleted and renamed; the walker carries the
      // dead row across to `to.md`.
      ev({
        event_id: '01HW000000000000000000000B',
        event_kind: 'anchor_dead_moved',
        doc_path: 'to.md',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 2000,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({
          from_doc_path: 'from.md',
          to_doc_path: 'to.md',
          last_known_start: 50,
          last_known_end: 60,
          last_known_text: 'phrase',
          reason: 'doc_moved',
        }),
        created_at: 1_700_000_002_000,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result.length).toBe(1)
    expect(result[0]!.doc_path).toBe('to.md')
    expect(result[0]!.status).toBe('dead')
    expect(result[0]!.current_start).toBeNull()
    expect(result[0]!.current_end).toBeNull()
    expect(result[0]!.last_rebuilt_from).toBe('01HW000000000000000000000B')
  })

  it('anchor_drifted with to_doc_path advances the anchor row doc_path', () => {
    // Symmetric with foldAnchorRelocated — a drifted-across-rename
    // event's metadata can carry to_doc_path so the materialiser folds
    // the drift onto the new file path.
    const events: DocCommentEvent[] = [
      ev({
        event_id: '01HW0000000000000000000001',
        event_kind: 'comment_posted',
        doc_path: 'from.md',
        thread_root_id: null,
        anchor_start: 50,
        anchor_end: 60,
        anchor_text_excerpt: 'phrase',
        body: 'root',
        created_at: 1_700_000_000_000,
      }),
      ev({
        event_id: '01HW000000000000000000000A',
        event_kind: 'anchor_drifted',
        doc_path: 'to.md',
        thread_root_id: '01HW0000000000000000000001',
        based_on_modified_at: 2000,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        metadata_json: JSON.stringify({
          hint_start: 120,
          hint_end: 130,
          from_doc_path: 'from.md',
          to_doc_path: 'to.md',
          reason: 'doc_moved',
        }),
        created_at: 1_700_000_001_000,
      }),
    ]
    const result = materialiseAnchors(events, { now: () => FIXED_NOW })
    expect(result.length).toBe(1)
    expect(result[0]!.doc_path).toBe('to.md')
    expect(result[0]!.status).toBe('drifted')
    expect(result[0]!.drift_hint_start).toBe(120)
    expect(result[0]!.drift_hint_end).toBe(130)
  })
})
