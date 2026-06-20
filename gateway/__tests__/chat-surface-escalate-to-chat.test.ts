/**
 * P7.2 S3 — chat surface escalate-to-chat tests.
 *
 * Covers the escalation-loader path that the production resolver
 * (`gateway/realmode-composer/build-phase-spec-resolver.ts`) consumes
 * on every chat turn. The loader lives at
 * `gateway/realmode-composer/escalation-loader.ts` and exports two
 * functions:
 *
 *   - `loadPendingEscalations(comment_store, project_id)` —
 *     atomically reads + marks-consumed up to `ESCALATION_RENDER_LIMIT`
 *     pending `escalate_to_chat` events in one `BEGIN IMMEDIATE`
 *     transaction on the per-project sidecar.
 *
 *   - `markEscalationsConsumed(comment_store, project_id, event_ids)` —
 *     idempotent no-op confirm; rows already marked by the loader.
 *
 * Plus the resolver-side splicing wrapper that prepends the rendered
 * `<escalated_comment_threads>...</escalated_comment_threads>` XML
 * envelope above the persona block before calling the base LLM. This
 * test imports the real `loadPendingEscalations` / `markEscalationsConsumed`
 * and exercises them against a real CommentStore — same setup pattern
 * the comments-production-composer test uses.
 *
 * Test cases (trimmed per plan Enhancement Summary):
 *   1. Pending event → next chat turn system prompt contains thread
 *      context (XML envelope + doc_path + anchor_excerpt + comment body).
 *      Spec-conformance: `loadPendingEscalations` AND
 *      `markEscalationsConsumed` called.
 *   2. Consumed event → next chat turn does NOT include it again.
 *   3. Multiple pending events ordered by created_at ASC.
 *   8. Concurrent loadPendingEscalations calls DO NOT double-splice
 *      (atomic-consumed-on-read invariant via `BEGIN IMMEDIATE`).
 *   9. Render uses <escalated_comment_threads> XML envelope.
 *
 * Time-dependent test discipline (Neutron CLAUDE.md hard rule):
 *   - All fixture timestamps via `Date.now()` — no hardcoded ISO strings.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CommentStore } from '../comments/comment-store.ts'
import {
  loadPendingEscalations,
  markEscalationsConsumed,
  ESCALATION_RENDER_LIMIT,
} from '../realmode-composer/escalation-loader.ts'

const PROJECT_ID = 'demo-project'

interface Harness {
  store: CommentStore
  owner_home: string
  tmp: string
  cleanup(): void
}

function start(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-escalate-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })

  // Date.now()-relative timestamps — no hardcoded ISO strings.
  const startTs = Date.now() - 60_000
  const events = { ts: startTs }
  const store = new CommentStore({
    owner_home,
    now: () => {
      events.ts += 1
      return events.ts
    },
  })
  return {
    store,
    owner_home,
    tmp,
    cleanup: () => {
      store.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function seedEscalateEvent(
  h: Harness,
  opts: {
    doc_path: string
    anchor_excerpt: string
    comment_body_history: string
    note?: string
    trigger?: 'user_button' | 'agent_escalation'
  },
): Promise<string> {
  // First, post a root comment so the thread_root_id exists.
  const root = await h.store.appendEvent(PROJECT_ID, {
    event_kind: 'comment_posted',
    doc_path: opts.doc_path,
    thread_root_id: null,
    parent_event_id: null,
    anchor_start: 0,
    anchor_end: opts.anchor_excerpt.length,
    anchor_text_excerpt: opts.anchor_excerpt,
    anchor_ctx_before: '',
    anchor_ctx_after: '',
    based_on_modified_at: Date.now() - 30_000,
    author_kind: 'user',
    author_id: 'user@example.com',
    body: opts.comment_body_history,
    metadata_json: null,
  })

  // Then append the escalate_to_chat event tied to the same thread.
  const metadata = {
    thread_root_id: root.thread_root_id,
    doc_path: opts.doc_path,
    anchor_excerpt: opts.anchor_excerpt,
    comment_body_history: opts.comment_body_history,
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    trigger: opts.trigger ?? 'user_button',
  }
  const esc = await h.store.appendEvent(PROJECT_ID, {
    event_kind: 'escalate_to_chat',
    doc_path: opts.doc_path,
    thread_root_id: root.thread_root_id,
    parent_event_id: root.event.event_id,
    anchor_start: null,
    anchor_end: null,
    anchor_text_excerpt: null,
    anchor_ctx_before: null,
    anchor_ctx_after: null,
    based_on_modified_at: null,
    author_kind: opts.trigger === 'agent_escalation' ? 'agent' : 'user',
    author_id:
      opts.trigger === 'agent_escalation' ? 'gateway-agent' : 'user@example.com',
    body: null,
    metadata_json: JSON.stringify(metadata),
  })
  return esc.event.event_id
}

/* ─── Case 1 — pending event → next chat turn includes thread context ─── */

describe('escalation-loader — pending event surfaces in the next chat turn system prompt', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('loadPendingEscalations renders thread context AND markEscalationsConsumed is callable', async () => {
    const event_id = await seedEscalateEvent(h, {
      doc_path: 'notes/foo.md',
      anchor_excerpt: 'we should probably pre-compute the SHA at write time',
      comment_body_history:
        "Disagree, the read path is bottlenecked on the deflate anyway.",
    })

    const result = await loadPendingEscalations(h.store, PROJECT_ID)

    // Spec-conformance — the rendered block carries enough to seed
    // the chat with the conversation that should continue here.
    expect(result.consumed_event_ids).toContain(event_id)
    expect(result.rendered).toContain('notes/foo.md')
    expect(result.rendered).toContain(
      'we should probably pre-compute the SHA at write time',
    )
    expect(result.rendered).toContain(
      'Disagree, the read path is bottlenecked on the deflate anyway.',
    )

    // Now simulate how the resolver wraps a baseLlm: prepend the
    // rendered escalation block to a `system` prompt, capture what
    // the LLM would actually see. This mirrors the production
    // resolver wrapper at `build-phase-spec-resolver.ts:215-234`.
    const captured: Array<{ system: string }> = []
    const baseLlm = mock(async (call: { system: string }) => {
      captured.push({ system: call.system })
      return 'agent reply'
    })
    const base_system = '# Persona\n\nYou are the project agent.\n'
    const wrapped_system =
      result.rendered === ''
        ? base_system
        : `${result.rendered}\n\n${base_system}`
    await baseLlm({ system: wrapped_system })

    expect(baseLlm).toHaveBeenCalled()
    expect(captured.length).toBe(1)
    expect(captured[0]!.system).toContain('escalated_comment_threads')
    expect(captured[0]!.system).toContain('notes/foo.md')
    expect(captured[0]!.system).toContain(
      'we should probably pre-compute the SHA at write time',
    )

    // markEscalationsConsumed is an idempotent no-op confirm per the
    // plan ("rows already written by loadPending") — the spec-
    // conformance hard rule requires we still call it.
    await markEscalationsConsumed(h.store, PROJECT_ID, result.consumed_event_ids)
    // Idempotent — calling again must not throw.
    await markEscalationsConsumed(h.store, PROJECT_ID, result.consumed_event_ids)
  })
})

/* ─── Case 2 — consumed escalation does NOT re-splice ─── */

describe('escalation-loader — consumed events are not surfaced on subsequent turns', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('second loadPendingEscalations call returns empty after the first consumes the pending row', async () => {
    await seedEscalateEvent(h, {
      doc_path: 'notes/consume.md',
      anchor_excerpt: 'consume once',
      comment_body_history: 'turn one body',
    })

    const first = await loadPendingEscalations(h.store, PROJECT_ID)
    expect(first.consumed_event_ids.length).toBe(1)
    expect(first.rendered.length).toBeGreaterThan(0)

    // The first loadPending atomically marked the event consumed in
    // its `BEGIN IMMEDIATE` transaction. The second call sees no
    // pending events.
    const second = await loadPendingEscalations(h.store, PROJECT_ID)
    expect(second.consumed_event_ids).toEqual([])
    expect(second.rendered).toBe('')
  })
})

/* ─── Case 3 — multiple pending events ordered by created_at ASC ─── */

describe('escalation-loader — multiple pending events render oldest-first', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('rendered block lists threads in created_at ASC (FIFO) order', async () => {
    await seedEscalateEvent(h, {
      doc_path: 'notes/first.md',
      anchor_excerpt: 'OLDEST-EXCERPT',
      comment_body_history: 'first thread body',
    })
    await seedEscalateEvent(h, {
      doc_path: 'notes/second.md',
      anchor_excerpt: 'MIDDLE-EXCERPT',
      comment_body_history: 'second thread body',
    })
    await seedEscalateEvent(h, {
      doc_path: 'notes/third.md',
      anchor_excerpt: 'NEWEST-EXCERPT',
      comment_body_history: 'third thread body',
    })

    const result = await loadPendingEscalations(h.store, PROJECT_ID)
    expect(result.consumed_event_ids.length).toBe(3)

    // Oldest must appear before newest in the rendered block.
    const oldestIdx = result.rendered.indexOf('OLDEST-EXCERPT')
    const middleIdx = result.rendered.indexOf('MIDDLE-EXCERPT')
    const newestIdx = result.rendered.indexOf('NEWEST-EXCERPT')
    expect(oldestIdx).toBeGreaterThan(-1)
    expect(middleIdx).toBeGreaterThan(oldestIdx)
    expect(newestIdx).toBeGreaterThan(middleIdx)
  })
})

/* ─── Case 8 — concurrent loadPendingEscalations calls do not double-splice ─── */

describe('escalation-loader — concurrent loadPending calls return disjoint consumed sets', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('two parallel loadPendingEscalations calls yield disjoint consumed_event_ids arrays', async () => {
    // Seed 3 pending events.
    const seeded: string[] = []
    for (let i = 0; i < 3; i++) {
      seeded.push(
        await seedEscalateEvent(h, {
          doc_path: `notes/race-${i}.md`,
          anchor_excerpt: `excerpt ${i}`,
          comment_body_history: `body ${i}`,
        }),
      )
    }

    // Spawn two concurrent loaders. The `BEGIN IMMEDIATE` + `INSERT
    // OR IGNORE` design guarantees each event is consumed by AT MOST
    // ONE of the two calls (the second call's INSERT IGNORE is a
    // no-op for any event the first claimed). The union of consumed
    // ids across both calls must equal `seeded`, and the intersection
    // must be empty.
    const [a, b] = await Promise.all([
      loadPendingEscalations(h.store, PROJECT_ID),
      loadPendingEscalations(h.store, PROJECT_ID),
    ])

    const consumedA = new Set(a.consumed_event_ids)
    const consumedB = new Set(b.consumed_event_ids)

    // Disjoint: no event appears in both arrays.
    for (const id of consumedA) {
      expect(consumedB.has(id)).toBe(false)
    }

    // Together they cover every seeded event exactly once.
    const union = new Set<string>([...consumedA, ...consumedB])
    expect(union.size).toBe(seeded.length)
    for (const id of seeded) {
      expect(union.has(id)).toBe(true)
    }
  })
})

/* ─── Case 9 — render uses <escalated_comment_threads> XML envelope ─── */

describe('escalation-loader — render uses <escalated_comment_threads> XML envelope', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('rendered block opens and closes with the XML envelope tags + carries labelled fields', async () => {
    await seedEscalateEvent(h, {
      doc_path: 'notes/envelope.md',
      anchor_excerpt: 'envelope check excerpt',
      comment_body_history: 'envelope check body',
    })

    const result = await loadPendingEscalations(h.store, PROJECT_ID)
    expect(result.rendered).toContain('<escalated_comment_threads>')
    expect(result.rendered).toContain('</escalated_comment_threads>')
    // ISSUE #42 — the per-thread frame uses XML attributes
    // (`doc_path="…"` / `anchor_excerpt="…"`) so the chat agent can
    // parse the structure deterministically; the old `key:` prefixes
    // are gone.
    expect(result.rendered).toContain('<thread doc_path="notes/envelope.md"')
    expect(result.rendered).toContain('anchor_excerpt="envelope check excerpt"')
    expect(result.rendered).toContain('</thread>')
  })

  it('exports ESCALATION_RENDER_LIMIT as a positive constant', () => {
    expect(typeof ESCALATION_RENDER_LIMIT).toBe('number')
    expect(ESCALATION_RENDER_LIMIT).toBeGreaterThan(0)
  })
})
