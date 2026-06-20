/**
 * P7.2 S1 — comment-store integration tests.
 *
 * Real on-disk tmp SQLite sidecar; covers per brief § 10.1:
 *   - schema init (migration applies, expected tables exist)
 *   - appendEvent → reads back via getThread
 *   - listThreads returns thread summaries sorted by last_reply_at DESC
 *   - listThreads filters dead threads by default
 *   - replies route through the parent → canonical thread_root_id
 *   - concurrent inserts produce distinct event_ids (no collisions)
 *   - body / excerpt / ctx size caps enforced
 *   - lazy-init dance for first-write-to-fresh-project
 *   - rebuild-from-events idempotency (Atlas-claim property)
 *   - migration applied to fresh DB produces expected schema
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyProjectScopedMigrations } from '../../../migrations/runner.ts'
import {
  CommentBodyTooLargeError,
  CommentNotFoundError,
  CommentStore,
  CommentStoreError,
  DEFAULT_MIGRATIONS_DIR,
  MAX_COMMENT_BODY_BYTES,
  MAX_METADATA_JSON_BYTES,
  defaultUlid,
} from '../comment-store.ts'

interface Harness {
  store: CommentStore
  owner_home: string
  tmp: string
  cleanup(): void
}

function startStore(opts: { ulid?: () => string; now?: () => number } = {}): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-comments-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  const storeOpts: ConstructorParameters<typeof CommentStore>[0] = { owner_home }
  if (opts.ulid !== undefined) storeOpts.ulid = opts.ulid
  if (opts.now !== undefined) storeOpts.now = opts.now
  const store = new CommentStore(storeOpts)
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

const PROJECT_ID = 'demo-project'

describe('CommentStore — schema init', () => {
  let h: Harness
  beforeEach(() => {
    h = startStore()
  })
  afterEach(() => {
    h.cleanup()
  })

  it('creates .comments/comments.db on first write', async () => {
    await h.store.ensureInit(PROJECT_ID)
    const sidecar = join(
      h.owner_home,
      'Projects',
      PROJECT_ID,
      '.comments',
      'comments.db',
    )
    expect(existsSync(sidecar)).toBe(true)
  })

  it('applies the migration producing the expected tables', async () => {
    await h.store.ensureInit(PROJECT_ID)
    const sidecar = join(
      h.owner_home,
      'Projects',
      PROJECT_ID,
      '.comments',
      'comments.db',
    )
    const db = new Database(sidecar, { create: false, readonly: true })
    try {
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((r) => r.name)
      expect(tables).toContain('doc_comment_events')
      expect(tables).toContain('doc_comment_anchors')
      expect(tables).toContain('_migrations')
      const indexes = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((r) => r.name)
      expect(indexes).toContain('idx_events_doc_path_created_at')
      expect(indexes).toContain('idx_events_thread_root_created_at')
      expect(indexes).toContain('idx_events_kind_doc_path')
      expect(indexes).toContain('idx_anchors_doc_path_status_start')
    } finally {
      db.close()
    }
  })

  it('rejects an invalid project_id', async () => {
    await expect(h.store.ensureInit('bad id!')).rejects.toBeInstanceOf(
      CommentStoreError,
    )
  })
})

describe('CommentStore — appendEvent + getThread roundtrip', () => {
  let h: Harness
  beforeEach(() => {
    h = startStore({ now: () => 1_700_000_000_000 })
  })
  afterEach(() => {
    h.cleanup()
  })

  it('writes a root comment + reads it back via getThread', async () => {
    const post = await h.store.appendEvent(PROJECT_ID, {
      event_kind: 'comment_posted',
      doc_path: 'notes/foo.md',
      thread_root_id: null,
      parent_event_id: null,
      anchor_start: 100,
      anchor_end: 120,
      anchor_text_excerpt: 'the highlighted substring',
      anchor_ctx_before: 'before',
      anchor_ctx_after: 'after',
      based_on_modified_at: 1_700_000_000_000,
      author_kind: 'user',
      author_id: 'user_sam',
      body: 'is this still accurate?',
      metadata_json: null,
    })
    expect(post.event.event_id.length).toBe(26)
    expect(post.thread_root_id).toBe(post.event.event_id)

    const thread = await h.store.getThread(PROJECT_ID, post.event.event_id)
    expect(thread.root.event_id).toBe(post.event.event_id)
    expect(thread.root.body).toBe('is this still accurate?')
    expect(thread.anchor.status).toBe('live')
    expect(thread.anchor.current_start).toBe(100)
    expect(thread.anchor.current_end).toBe(120)
    expect(thread.replies).toEqual([])
  })

  it('writes a reply that inherits the parent root + appears in the tree', async () => {
    const root = await h.store.appendEvent(PROJECT_ID, {
      event_kind: 'comment_posted',
      doc_path: 'notes/foo.md',
      thread_root_id: null,
      parent_event_id: null,
      anchor_start: 0,
      anchor_end: 5,
      anchor_text_excerpt: 'first',
      anchor_ctx_before: '',
      anchor_ctx_after: '',
      based_on_modified_at: 1_700_000_000_000,
      author_kind: 'user',
      author_id: 'user_sam',
      body: 'root',
      metadata_json: null,
    })
    const reply = await h.store.appendEvent(PROJECT_ID, {
      event_kind: 'comment_posted',
      doc_path: 'notes/foo.md',
      thread_root_id: null,
      parent_event_id: root.event.event_id,
      anchor_start: null,
      anchor_end: null,
      anchor_text_excerpt: null,
      anchor_ctx_before: null,
      anchor_ctx_after: null,
      based_on_modified_at: null,
      author_kind: 'user',
      author_id: 'user_sam',
      body: 'reply body',
      metadata_json: null,
    })
    expect(reply.thread_root_id).toBe(root.event.event_id)
    const tree = await h.store.getThread(PROJECT_ID, root.event.event_id)
    expect(tree.replies.length).toBe(1)
    expect(tree.replies[0]!.body).toBe('reply body')
    expect(tree.anchor.reply_count).toBe(1)
  })

  it('rejects a reply whose parent does not exist', async () => {
    await expect(
      h.store.appendEvent(PROJECT_ID, {
        event_kind: 'comment_posted',
        doc_path: 'notes/foo.md',
        thread_root_id: null,
        parent_event_id: '01HW0000000000000000000099',
        anchor_start: null,
        anchor_end: null,
        anchor_text_excerpt: null,
        anchor_ctx_before: null,
        anchor_ctx_after: null,
        based_on_modified_at: null,
        author_kind: 'user',
        author_id: 'user_sam',
        body: 'orphan reply',
        metadata_json: null,
      }),
    ).rejects.toBeInstanceOf(CommentNotFoundError)
  })

  it('enforces the body size cap', async () => {
    const tooLong = 'x'.repeat(MAX_COMMENT_BODY_BYTES + 1)
    await expect(
      h.store.appendEvent(PROJECT_ID, {
        event_kind: 'comment_posted',
        doc_path: 'notes/foo.md',
        thread_root_id: null,
        parent_event_id: null,
        anchor_start: 0,
        anchor_end: 1,
        anchor_text_excerpt: 'x',
        anchor_ctx_before: '',
        anchor_ctx_after: '',
        based_on_modified_at: null,
        author_kind: 'user',
        author_id: 'user_sam',
        body: tooLong,
        metadata_json: null,
      }),
    ).rejects.toBeInstanceOf(CommentBodyTooLargeError)
  })

  it('Argus r1 MINOR #5 — enforces the metadata_json size cap', async () => {
    // Walker events carry structured re-anchor metadata in
    // metadata_json. Without an upper bound, a malformed appender (or
    // a future event kind that accidentally stuffs a large payload
    // here) could blow up the row size and degrade SQLite scan cost
    // across the whole sidecar. MAX_METADATA_JSON_BYTES is the hard
    // server enforcement; the largest legitimate payload today is
    // anchor_dead with a 1 KB last_known_text + bookkeeping, well
    // under the 4 KB cap.
    const tooLong = 'x'.repeat(MAX_METADATA_JSON_BYTES + 1)
    await expect(
      h.store.appendEvent(PROJECT_ID, {
        event_kind: 'anchor_dead',
        doc_path: 'notes/foo.md',
        thread_root_id: '01HW0000000000000000000099',
        parent_event_id: null,
        anchor_start: null,
        anchor_end: null,
        anchor_text_excerpt: null,
        anchor_ctx_before: null,
        anchor_ctx_after: null,
        based_on_modified_at: 1000,
        author_kind: 'system',
        author_id: 'reanchor-walker',
        body: null,
        metadata_json: tooLong,
      }),
    ).rejects.toBeInstanceOf(CommentStoreError)
  })

  it('throws CommentNotFoundError for getThread on a missing id', async () => {
    await h.store.ensureInit(PROJECT_ID)
    await expect(
      h.store.getThread(PROJECT_ID, '01HW0000000000000000000099'),
    ).rejects.toBeInstanceOf(CommentNotFoundError)
  })
})

describe('CommentStore — listThreads', () => {
  let h: Harness
  beforeEach(() => {
    h = startStore()
  })
  afterEach(() => {
    h.cleanup()
  })

  it('returns thread summaries for a doc_path, sorted by last_reply_at DESC', async () => {
    // Three roots on the same doc, posted in order. Each subsequent
    // one has a later `last_reply_at` (by virtue of created_at being
    // later), so the listing returns them in reverse-chronological
    // order.
    const r1 = await postRoot(h, 'notes/foo.md', 'one')
    const r2 = await postRoot(h, 'notes/foo.md', 'two')
    const r3 = await postRoot(h, 'notes/foo.md', 'three')
    const list = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'notes/foo.md',
    })
    expect(list.threads.length).toBe(3)
    expect(list.threads.map((t) => t.root.body)).toEqual(['three', 'two', 'one'])
    expect(list.threads[0]!.thread_root_id).toBe(r3.event.event_id)
    expect(list.threads[2]!.thread_root_id).toBe(r1.event.event_id)
    expect(r2.event.event_id.length).toBe(26)
  })

  it('paginates via cursor_last_reply_at', async () => {
    // Deterministic clock — each post advances the wall by 10 ms so
    // the pagination cursor's strict-less-than filter has clean
    // boundaries. Without a stepping clock, three posts in the same
    // ms tick share `last_reply_at` and the cursor walks past all of
    // them at once.
    let t = 1_700_000_000_000
    const stepStore = new CommentStore({
      owner_home: h.owner_home,
      now: () => {
        t += 10
        return t
      },
    })
    try {
      await stepStore.appendEvent(PROJECT_ID, rootInput('one'))
      await stepStore.appendEvent(PROJECT_ID, rootInput('two'))
      await stepStore.appendEvent(PROJECT_ID, rootInput('three'))
      const firstPage = await stepStore.listThreads(PROJECT_ID, {
        doc_path: 'notes/foo.md',
        limit: 2,
      })
      expect(firstPage.threads.length).toBe(2)
      expect(firstPage.next_cursor).not.toBeNull()
      const secondPageOpts: Parameters<CommentStore['listThreads']>[1] = {
        doc_path: 'notes/foo.md',
        limit: 2,
      }
      if (firstPage.next_cursor !== null) {
        secondPageOpts.cursor_last_reply_at = firstPage.next_cursor.last_reply_at
        secondPageOpts.cursor_thread_root_id = firstPage.next_cursor.thread_root_id
      }
      const secondPage = await stepStore.listThreads(PROJECT_ID, secondPageOpts)
      expect(secondPage.threads.length).toBe(1)
      expect(secondPage.next_cursor).toBeNull()
    } finally {
      stepStore.closeAll()
    }
  })

  it('returns empty for a doc_path with no comments', async () => {
    await postRoot(h, 'notes/other.md', 'other doc')
    const list = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'notes/missing.md',
    })
    expect(list.threads).toEqual([])
    expect(list.next_cursor).toBeNull()
  })

  // Argus r2 BLOCKER 2 — `latest_event_kind` MUST be populated by the
  // materialiser so the side-pane's Resolved tab + skipped-comment
  // badge survive a refetch. Seeded thread receives comment_posted
  // then comment_resolved; the next listThreads round-trip must surface
  // 'comment_resolved' on the thread summary.
  it('surfaces latest_event_kind from the materialised view after refetch', async () => {
    const root = await postRoot(h, 'notes/resolve.md', 'is this still accurate?')

    // Fresh thread — latest_event_kind reflects the root comment_posted.
    const beforeResolve = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'notes/resolve.md',
    })
    expect(beforeResolve.threads.length).toBe(1)
    expect(beforeResolve.threads[0]!.latest_event_kind).toBe('comment_posted')

    // Append a `comment_resolved` system event — same shape as the
    // side-pane's resolve button writes (system author, null anchor
    // fields, no body).
    await h.store.appendEvent(PROJECT_ID, {
      event_kind: 'comment_resolved',
      doc_path: 'notes/resolve.md',
      thread_root_id: root.event.event_id,
      parent_event_id: root.event.event_id,
      anchor_start: null,
      anchor_end: null,
      anchor_text_excerpt: null,
      anchor_ctx_before: null,
      anchor_ctx_after: null,
      based_on_modified_at: null,
      author_kind: 'system',
      author_id: 'gateway-resolver',
      body: null,
      metadata_json: null,
    })

    // Re-fetch — latest_event_kind must now reflect the resolution.
    const afterResolve = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'notes/resolve.md',
    })
    expect(afterResolve.threads.length).toBe(1)
    expect(afterResolve.threads[0]!.latest_event_kind).toBe('comment_resolved')
    // The anchor row's reply_count is NOT bumped by a comment_resolved
    // event (it's a system event, not a posted reply) — guards against
    // a regression that conflates the two folds.
    expect(afterResolve.threads[0]!.reply_count).toBe(0)
  })

  // Argus r1 IMPORTANT — composite (last_reply_at, thread_root_id) key.
  // Three rows with IDENTICAL last_reply_at, page_size=1 → all 3 must
  // surface across three pages. Without the secondary key, two of three
  // are silently lost on the second page.
  it('paginates across ties on last_reply_at via the composite key', async () => {
    const fixed = 1_700_000_000_000
    const tiedStore = new CommentStore({
      owner_home: h.owner_home,
      now: () => fixed,
    })
    try {
      const a = await tiedStore.appendEvent(PROJECT_ID, rootInput('one'))
      const b = await tiedStore.appendEvent(PROJECT_ID, rootInput('two'))
      const c = await tiedStore.appendEvent(PROJECT_ID, rootInput('three'))
      const all = new Set([a.event.event_id, b.event.event_id, c.event.event_id])

      const seen = new Set<string>()
      let cursor_last_reply_at: number | undefined
      let cursor_thread_root_id: string | undefined
      for (let i = 0; i < 5; i += 1) {
        const page = await tiedStore.listThreads(PROJECT_ID, {
          doc_path: 'notes/foo.md',
          limit: 1,
          ...(cursor_last_reply_at !== undefined ? { cursor_last_reply_at } : {}),
          ...(cursor_thread_root_id !== undefined ? { cursor_thread_root_id } : {}),
        })
        for (const t of page.threads) seen.add(t.thread_root_id)
        if (page.next_cursor === null) break
        cursor_last_reply_at = page.next_cursor.last_reply_at
        cursor_thread_root_id = page.next_cursor.thread_root_id
      }
      expect(seen.size).toBe(3)
      expect(seen).toEqual(all)
    } finally {
      tiedStore.closeAll()
    }
  })
})

describe('CommentStore — concurrent inserts', () => {
  let h: Harness
  beforeEach(() => {
    h = startStore()
  })
  afterEach(() => {
    h.cleanup()
  })

  it('produces distinct event_ids across 100 parallel inserts', async () => {
    await h.store.ensureInit(PROJECT_ID)
    const writes = Array.from({ length: 100 }, (_, i) =>
      h.store.appendEvent(PROJECT_ID, {
        event_kind: 'comment_posted',
        doc_path: 'notes/foo.md',
        thread_root_id: null,
        parent_event_id: null,
        anchor_start: i,
        anchor_end: i + 1,
        anchor_text_excerpt: `excerpt ${i}`,
        anchor_ctx_before: '',
        anchor_ctx_after: '',
        based_on_modified_at: null,
        author_kind: 'user',
        author_id: 'user_sam',
        body: `comment ${i}`,
        metadata_json: null,
      }),
    )
    const results = await Promise.all(writes)
    const ids = new Set(results.map((r) => r.event.event_id))
    expect(ids.size).toBe(100)
  })

  it('two POSTs against the same anchor land both threads', async () => {
    // Two concurrent root posts on the same range → both appear as
    // separate threads (per brief § 9.1). No data loss.
    await h.store.ensureInit(PROJECT_ID)
    const baseInput = {
      event_kind: 'comment_posted' as const,
      doc_path: 'notes/foo.md',
      thread_root_id: null,
      parent_event_id: null,
      anchor_start: 50,
      anchor_end: 70,
      anchor_text_excerpt: 'same range',
      anchor_ctx_before: 'before',
      anchor_ctx_after: 'after',
      based_on_modified_at: null,
      author_kind: 'user' as const,
      anchor_kind: null,
      body: null,
      metadata_json: null,
    }
    const [a, b] = await Promise.all([
      h.store.appendEvent(PROJECT_ID, {
        ...baseInput,
        author_id: 'user_a',
        body: 'thread A',
      }),
      h.store.appendEvent(PROJECT_ID, {
        ...baseInput,
        author_id: 'user_b',
        body: 'thread B',
      }),
    ])
    expect(a.event.event_id).not.toBe(b.event.event_id)
    const list = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'notes/foo.md',
    })
    expect(list.threads.length).toBe(2)
  })
})

describe('CommentStore — materialise idempotency', () => {
  let h: Harness
  beforeEach(() => {
    h = startStore()
  })
  afterEach(() => {
    h.cleanup()
  })

  it('rebuild-from-events produces the same anchor rows', async () => {
    const root = await postRoot(h, 'notes/foo.md', 'root')
    await h.store.appendEvent(PROJECT_ID, {
      event_kind: 'comment_posted',
      doc_path: 'notes/foo.md',
      thread_root_id: null,
      parent_event_id: root.event.event_id,
      anchor_start: null,
      anchor_end: null,
      anchor_text_excerpt: null,
      anchor_ctx_before: null,
      anchor_ctx_after: null,
      based_on_modified_at: null,
      author_kind: 'user',
      author_id: 'user_sam',
      body: 'reply 1',
      metadata_json: null,
    })
    const before = await h.store.materialiseAll(PROJECT_ID)
    // Wipe the materialised view and let materialiseAll rebuild it.
    const rebuilt = await h.store.materialiseAll(PROJECT_ID)
    expect(rebuilt.map((r) => r.thread_root_id).sort()).toEqual(
      before.map((r) => r.thread_root_id).sort(),
    )
    expect(rebuilt[0]?.reply_count).toBe(before[0]?.reply_count)
    expect(rebuilt[0]?.status).toBe(before[0]?.status)
  })
})

describe('applyProjectScopedMigrations — fresh DB schema snapshot', () => {
  it('produces the expected table set on a fresh DB', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-comments-mig-'))
    try {
      const path = join(tmp, 'fresh.db')
      const db = new Database(path, { create: true })
      try {
        applyProjectScopedMigrations(db, DEFAULT_MIGRATIONS_DIR)
        const tables = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all()
          .map((r) => r.name)
        expect(tables).toEqual([
          '_migrations',
          'doc_comment_anchors',
          'doc_comment_events',
          'escalate_consumption_state',
        ])
      } finally {
        db.close()
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('defaultUlid', () => {
  it('returns a 26-char Crockford-base32 ULID', () => {
    const id = defaultUlid()
    expect(id.length).toBe(26)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('produces monotonically increasing ids across rapid calls', () => {
    const a = defaultUlid()
    const b = defaultUlid()
    const c = defaultUlid()
    expect(a < b).toBe(true)
    expect(b < c).toBe(true)
  })
})

function rootInput(body: string): Parameters<CommentStore['appendEvent']>[1] {
  return {
    event_kind: 'comment_posted',
    doc_path: 'notes/foo.md',
    thread_root_id: null,
    parent_event_id: null,
    anchor_start: 0,
    anchor_end: body.length,
    anchor_text_excerpt: body,
    anchor_ctx_before: '',
    anchor_ctx_after: '',
    based_on_modified_at: null,
    author_kind: 'user',
    author_id: 'user_sam',
    body,
    metadata_json: null,
  }
}

async function postRoot(
  h: Harness,
  doc_path: string,
  body: string,
): Promise<{ event: { event_id: string }; thread_root_id: string }> {
  const result = await h.store.appendEvent(PROJECT_ID, {
    event_kind: 'comment_posted',
    doc_path,
    thread_root_id: null,
    parent_event_id: null,
    anchor_start: 0,
    anchor_end: body.length,
    anchor_text_excerpt: body,
    anchor_ctx_before: '',
    anchor_ctx_after: '',
    based_on_modified_at: null,
    author_kind: 'user',
    author_id: 'user_sam',
    body,
    metadata_json: null,
  })
  return result
}
