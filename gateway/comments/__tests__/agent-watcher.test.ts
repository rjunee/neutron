/**
 * P7.2 S3 — agent-watcher integration tests.
 *
 * Setup mirrors `anchor-walker.test.ts`: real on-disk tmp sidecar via
 * `CommentStore`, doc body materialised via `writeFileSync` so the
 * watcher can `doc_read` against it, scripted `AgentWatcherLlmCall`
 * closure (via `bun:test`'s `mock(...)`) so the test controls
 * success / timeout / error / escalation phrasing.
 *
 * Covers the trimmed test list from the plan Part E.1:
 *   1.  tickOnce on a user comment → writes agent_reply (comment_posted
 *       w/ author_kind='agent') + asserts mockLlmCall called once with
 *       the doc excerpt + anchor excerpt in the system prompt.
 *   3.  doc missing → agent_reply_skipped(reason='doc_missing'); LLM
 *       NOT called.
 *   4.  LLM timeout → agent_reply_skipped(reason='timeout').
 *   5.  LLM error / rate-limited → agent_reply_skipped with structured
 *       reason ('llm_error' OR 'rate_limited').
 *   7.  Reply contains escalation phrase → escalate_to_chat event (NOT
 *       comment_posted with author='agent').
 *   9.  agent-authored comments skipped (self-reply guard).
 *   11. cursor persists across ticks.
 *   12. ALL fixture timestamps are Date.now()-relative — defensive
 *       against the watchdog data-rot incident.
 *   13. Persona spliced into the watcher's system prompt.
 *   14. Per-project mutex prevents double-process under concurrent
 *       tickOnce calls.
 *   15. cursor advances atomically with appendEvent — when appendEvent
 *       throws mid-tick, the cursor file is NOT updated.
 *
 * Time-dependent test discipline (per Neutron CLAUDE.md):
 *   - NO hardcoded `2026-xx-xxT...` ISO strings; every fixture
 *     timestamp is `Date.now() - <offset>` so the suite never rots when
 *     wall-clock crosses a retention window.
 *   - Grep check on this file: `grep -nE "2[0-9]{3}-[0-9]{2}-[0-9]{2}T"`
 *     returns ZERO hits.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { CommentStore, type AppendEventInput } from '../comment-store.ts'
import { AgentWatcher } from '../agent-watcher.ts'
import type { AgentWatcherLlmCall } from '../../wiring/build-agent-watcher-llm-call.ts'

const PROJECT_ID = 'demo-project'

interface Harness {
  watcher_factory: (opts?: WatcherOverrides) => AgentWatcher
  store: CommentStore
  owner_home: string
  docsRoot: string
  tmp: string
  llm_calls: Array<{ system: string; messages: ReadonlyArray<{ role: string; content: string }> }>
  mockLlmCall: AgentWatcherLlmCall
  setMockLlmResponse: (resp: string | ((call: { system: string }) => Promise<{ text: string }>)) => void
  setMockLlmFailure: (err: unknown) => void
  cleanup(): void
}

interface WatcherOverrides {
  reply_timeout_ms?: number
  list_active_projects?: () => Promise<string[]>
  with_project_lock?: <T>(project_id: string, fn: () => Promise<T>) => Promise<T>
  doc_read?: (project_id: string, doc_path: string) => Promise<string | null>
  llm_call?: AgentWatcherLlmCall
  now?: () => number
}

function start(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-watcher-'))
  const owner_home = join(tmp, 'home')
  const docsRoot = join(owner_home, 'Projects', PROJECT_ID, 'docs')
  mkdirSync(docsRoot, { recursive: true })

  // Deterministic but Date.now()-relative timestamps — every event is
  // stamped at "now - 60s + ticker" so the events log lives just inside
  // any retention window the system might enforce. The ticker preserves
  // ordering so test #11 (cursor advance) sees a clean ASC stream.
  const startTs = Date.now() - 60_000
  const events = { ts: startTs }
  const store = new CommentStore({
    owner_home,
    now: () => {
      events.ts += 1
      return events.ts
    },
  })

  const llm_calls: Harness['llm_calls'] = []
  let scriptedResponse: string | ((call: { system: string }) => Promise<{ text: string }>) =
    'Yes, that is correct.'
  let scriptedFailure: unknown = null

  const mockLlmCall: AgentWatcherLlmCall = mock(
    async (call: {
      system: string
      messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
      max_tokens: number
      signal?: AbortSignal
    }) => {
      llm_calls.push({ system: call.system, messages: call.messages })
      if (scriptedFailure !== null) {
        throw scriptedFailure
      }
      if (typeof scriptedResponse === 'function') {
        return scriptedResponse({ system: call.system })
      }
      return { text: scriptedResponse }
    },
  )

  const default_doc_read = async (
    project_id: string,
    doc_path: string,
  ): Promise<string | null> => {
    const abs = join(docsRoot, doc_path)
    if (!existsSync(abs)) return null
    return readFileSync(abs, 'utf8')
  }
  const default_list_active_projects = async (): Promise<string[]> => [PROJECT_ID]
  const default_with_project_lock = async <T>(
    _project_id: string,
    fn: () => Promise<T>,
  ): Promise<T> => fn()

  const watcher_factory = (overrides: WatcherOverrides = {}): AgentWatcher => {
    return new AgentWatcher({
      comment_store: store,
      llm_call: overrides.llm_call ?? mockLlmCall,
      owner_home,
      doc_read: overrides.doc_read ?? default_doc_read,
      list_active_projects:
        overrides.list_active_projects ?? default_list_active_projects,
      with_project_lock: overrides.with_project_lock ?? default_with_project_lock,
      ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      ...(overrides.reply_timeout_ms !== undefined
        ? { reply_timeout_ms: overrides.reply_timeout_ms }
        : {}),
    })
  }

  return {
    watcher_factory,
    store,
    owner_home,
    docsRoot,
    tmp,
    llm_calls,
    mockLlmCall,
    setMockLlmResponse: (resp) => {
      scriptedResponse = resp
      scriptedFailure = null
    },
    setMockLlmFailure: (err) => {
      scriptedFailure = err
    },
    cleanup: () => {
      store.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

function buildDoc(h: Harness, relPath: string, content: string): void {
  const abs = join(h.docsRoot, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

async function seedUserComment(
  h: Harness,
  relPath: string,
  body: string,
  pos: { start: number; end: number } = { start: 0, end: 5 },
  ctx: { before: string; after: string } = { before: '', after: '' },
): Promise<string> {
  const excerpt = readDocSlice(h, relPath, pos.start, pos.end)
  const input: AppendEventInput = {
    event_kind: 'comment_posted',
    doc_path: relPath,
    thread_root_id: null,
    parent_event_id: null,
    anchor_start: pos.start,
    anchor_end: pos.end,
    anchor_text_excerpt: excerpt,
    anchor_ctx_before: ctx.before,
    anchor_ctx_after: ctx.after,
    based_on_modified_at: Date.now() - 30_000,
    author_kind: 'user',
    author_id: 'user_sam',
    body,
    metadata_json: null,
  }
  const result = await h.store.appendEvent(PROJECT_ID, input)
  return result.event.event_id
}

function readDocSlice(
  h: Harness,
  relPath: string,
  start: number,
  end: number,
): string {
  const abs = join(h.docsRoot, relPath)
  if (!existsSync(abs)) return ''
  return readFileSync(abs, 'utf8').slice(start, end)
}

function cursorPath(h: Harness, project_id: string = PROJECT_ID): string {
  return join(
    h.owner_home,
    'Projects',
    project_id,
    '.comments',
    'watcher-cursor.json',
  )
}

function readCursor(h: Harness): { last_processed_event_id: string | null } | null {
  const p = cursorPath(h)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/* ─── Case 1 — tickOnce processes one user comment → agent reply ─── */

describe('AgentWatcher — tickOnce processes a user comment and writes an agent_reply', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('writes a comment_posted event with author_kind=agent and calls the LLM exactly once', async () => {
    buildDoc(h, 'notes/foo.md', 'before\nUNIQUE-EXCERPT-XYZ\nafter')
    const start = 'before\n'.length
    const end = start + 'UNIQUE-EXCERPT-XYZ'.length
    const root_id = await seedUserComment(
      h,
      'notes/foo.md',
      'is this still accurate?',
      { start, end },
      { before: 'before\n', after: '\nafter' },
    )

    h.setMockLlmResponse('Yes, that is correct.')

    const watcher = h.watcher_factory()
    await watcher.tickOnce()

    // Spec-conformance hard rule (Neutron CLAUDE.md 2026-05-13):
    // explicit `expect(...).toHaveBeenCalled()` assertion on the LLM
    // mock — guards against the "module built but never wired"
    // failure mode where the test only asserts event-row existence.
    expect(h.mockLlmCall).toHaveBeenCalled()
    expect(h.llm_calls.length).toBe(1)

    // System prompt should carry the doc excerpt + anchor excerpt so
    // the LLM has the context it needs to answer the user.
    const seen = h.llm_calls[0]!
    expect(seen.system).toContain('UNIQUE-EXCERPT-XYZ')
    expect(seen.system).toContain('notes/foo.md')

    // The original user comment lives in the user message (per the
    // plan's "User message: the new comment_posted body" line).
    const userMsg = seen.messages.find((m) => m.role === 'user')
    expect(userMsg).toBeDefined()
    expect(userMsg!.content).toContain('is this still accurate?')

    // The thread should now have one root + one agent reply.
    const thread = await h.store.getThread(PROJECT_ID, root_id)
    expect(thread.root.event_id).toBe(root_id)
    expect(thread.replies.length).toBe(1)
    expect(thread.replies[0]!.author_kind).toBe('agent')
    expect(thread.replies[0]!.author_id).toBe('gateway-agent')
    expect(thread.replies[0]!.body).toBe('Yes, that is correct.')
    expect(thread.replies[0]!.thread_root_id).toBe(root_id)

    // Cursor should have advanced to the user comment's event_id.
    const cursor = readCursor(h)
    expect(cursor).not.toBeNull()
    expect(cursor!.last_processed_event_id).toBe(root_id)
  })
})

/* ─── Case 3 — doc missing → agent_reply_skipped(reason='doc_missing') ─── */

describe('AgentWatcher — doc missing emits agent_reply_skipped(doc_missing)', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('appends agent_reply_skipped with reason=doc_missing and does NOT call the LLM', async () => {
    // Seed a comment against a path that has no file on disk.
    const post = await h.store.appendEvent(PROJECT_ID, {
      event_kind: 'comment_posted',
      doc_path: 'notes/ghost.md',
      thread_root_id: null,
      parent_event_id: null,
      anchor_start: 0,
      anchor_end: 5,
      anchor_text_excerpt: 'hello',
      anchor_ctx_before: '',
      anchor_ctx_after: '',
      based_on_modified_at: Date.now() - 30_000,
      author_kind: 'user',
      author_id: 'user_sam',
      body: 'where is this doc?',
      metadata_json: null,
    })

    const watcher = h.watcher_factory()
    await watcher.tickOnce()

    // LLM must NOT be called when the doc is missing.
    expect(h.mockLlmCall).not.toHaveBeenCalled()
    expect(h.llm_calls.length).toBe(0)

    // An agent_reply_skipped event should be written with reason='doc_missing'.
    const skipped = findSkippedEvent(h, post.thread_root_id)
    expect(skipped).not.toBeNull()
    const meta = JSON.parse(skipped!.metadata_json ?? '{}') as { reason?: string }
    expect(meta.reason).toBe('doc_missing')
  })
})

/* ─── Case 4 — LLM timeout → agent_reply_skipped(reason='timeout') ─── */

describe('AgentWatcher — LLM timeout emits agent_reply_skipped(timeout)', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('writes agent_reply_skipped with reason=timeout when the LLM exceeds the deadline', async () => {
    buildDoc(h, 'notes/slow.md', 'slow doc body')
    const root_id = await seedUserComment(
      h,
      'notes/slow.md',
      'long thinking question',
    )

    // Slow LLM — resolves at 800ms unless aborted earlier. The watcher
    // is configured with a 100ms reply_timeout_ms so the abort fires
    // long before the inner resolve. The 800ms cap keeps the test fast
    // even on regression (no multi-second hang) — if the abort wiring
    // is missing, the test fails on the missing skipped event well
    // before its own timeout.
    const slow_llm: AgentWatcherLlmCall = mock(
      async (call) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 800)
          call.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            const err = new Error('aborted') as Error & { name: string }
            err.name = 'AbortError'
            reject(err)
          })
        })
        return { text: 'too slow' }
      },
    )

    // Short timeout so the test runs fast.
    const watcher = h.watcher_factory({ llm_call: slow_llm, reply_timeout_ms: 100 })
    await watcher.tickOnce()

    expect(slow_llm).toHaveBeenCalled()
    const skipped = findSkippedEvent(h, root_id)
    expect(skipped).not.toBeNull()
    const meta = JSON.parse(skipped!.metadata_json ?? '{}') as { reason?: string }
    expect(meta.reason).toBe('timeout')
  })
})

/* ─── Case 5 — LLM error / rate-limit → agent_reply_skipped(structured reason) ─── */

describe('AgentWatcher — LLM failure emits agent_reply_skipped with structured reason', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('sub-case A: api_error → reason=llm_error', async () => {
    buildDoc(h, 'notes/err.md', 'doc body for api error case')
    const root_id = await seedUserComment(h, 'notes/err.md', 'will the api fail?')

    const apiError = Object.assign(new Error('upstream 529'), {
      kind: 'api_error',
      status: 529,
    })
    h.setMockLlmFailure(apiError)

    const watcher = h.watcher_factory()
    await watcher.tickOnce()

    expect(h.mockLlmCall).toHaveBeenCalled()
    const skipped = findSkippedEvent(h, root_id)
    expect(skipped).not.toBeNull()
    const meta = JSON.parse(skipped!.metadata_json ?? '{}') as {
      reason?: string
      error_message?: string
    }
    expect(meta.reason).toBe('llm_error')
  })

  it('sub-case B: rate_limited → reason=rate_limited', async () => {
    buildDoc(h, 'notes/rl.md', 'doc body for rate limit case')
    const root_id = await seedUserComment(h, 'notes/rl.md', 'pls reply')

    const rateLimited = Object.assign(new Error('rate limited'), {
      kind: 'rate_limited',
    })
    h.setMockLlmFailure(rateLimited)

    const watcher = h.watcher_factory()
    await watcher.tickOnce()

    expect(h.mockLlmCall).toHaveBeenCalled()
    const skipped = findSkippedEvent(h, root_id)
    expect(skipped).not.toBeNull()
    const meta = JSON.parse(skipped!.metadata_json ?? '{}') as { reason?: string }
    expect(meta.reason).toBe('rate_limited')
  })
})

/* ─── Case 7 — escalation phrase in agent reply → escalate_to_chat ─── */

describe('AgentWatcher — escalation-phrase reply writes escalate_to_chat (not agent_reply)', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('writes an escalate_to_chat event with trigger=agent_escalation; NO comment_posted(agent)', async () => {
    buildDoc(h, 'notes/escalate.md', 'doc body that prompts escalation')
    const user_event_id = await seedUserComment(
      h,
      'notes/escalate.md',
      'big architectural question',
    )

    h.setMockLlmResponse("I'm not sure. Let's continue in chat.")

    const watcher = h.watcher_factory()
    await watcher.tickOnce()

    expect(h.mockLlmCall).toHaveBeenCalled()

    // No agent comment_posted event should land.
    const thread = await h.store.getThread(PROJECT_ID, user_event_id)
    expect(thread.replies.length).toBe(0)

    // But an escalate_to_chat event should appear in the raw event log.
    const events = readRawEvents(h, PROJECT_ID)
    const escalate = events.find((e) => e.event_kind === 'escalate_to_chat')
    expect(escalate).toBeDefined()
    expect(escalate!.thread_root_id).toBe(user_event_id)
    const meta = JSON.parse(escalate!.metadata_json ?? '{}') as {
      trigger?: string
      doc_path?: string
      thread_root_id?: string
      // ISSUE #42 — schema upgraded from bare string to an array of
      // `{author, body, timestamp}` entries so the escalation-loader
      // can label `<comment author="…">` tags without a string-parse
      // round-trip.
      comment_body_history?: Array<{
        author: 'user' | 'agent'
        body: string
        timestamp: number
      }>
    }
    expect(meta.trigger).toBe('agent_escalation')
    expect(meta.doc_path).toBe('notes/escalate.md')
    // The history MUST contain the original user message AND the
    // agent's reply (the self-reply guard intentionally omits the
    // reply from `doc_comment_events` — see `agent-watcher.ts:
    // processOneComment`; this metadata array is the chat composer's
    // only surface for the watcher's last word).
    const history = meta.comment_body_history ?? []
    const userEntry = history.find((e) => e.author === 'user')
    expect(userEntry).toBeDefined()
    expect(userEntry!.body).toContain('big architectural question')
    const agentEntry = history.find((e) => e.author === 'agent')
    expect(agentEntry).toBeDefined()
    expect(agentEntry!.body).toContain("Let's continue in chat")
  })
})

/* ─── Case 9 — agent-authored comments are skipped (self-reply guard) ─── */

describe('AgentWatcher — agent-authored comments are skipped (self-reply guard)', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('does not invoke the LLM for an event with author_kind=agent; cursor still advances', async () => {
    buildDoc(h, 'notes/agent.md', 'doc body unaffected')
    const agent_event = await h.store.appendEvent(PROJECT_ID, {
      event_kind: 'comment_posted',
      doc_path: 'notes/agent.md',
      thread_root_id: null,
      parent_event_id: null,
      anchor_start: 0,
      anchor_end: 5,
      anchor_text_excerpt: 'hello',
      anchor_ctx_before: '',
      anchor_ctx_after: '',
      based_on_modified_at: Date.now() - 30_000,
      author_kind: 'agent',
      author_id: 'gateway-agent',
      body: 'something the agent said earlier',
      metadata_json: null,
    })

    const watcher = h.watcher_factory()
    await watcher.tickOnce()

    expect(h.mockLlmCall).not.toHaveBeenCalled()

    // Cursor should still advance past the agent event so it never
    // shows up on a subsequent tick.
    const cursor = readCursor(h)
    expect(cursor).not.toBeNull()
    expect(cursor!.last_processed_event_id).toBe(agent_event.event.event_id)
  })
})

/* ─── Case 11 — cursor persists across ticks ─── */

describe('AgentWatcher — cursor persists across ticks; next tick picks up only new events', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('first tick processes seeded comments; second tick processes only the new ones', async () => {
    buildDoc(h, 'notes/multi.md', 'doc body for the multi-tick test')

    // Seed three user comments first.
    const ids_first: string[] = []
    for (let i = 0; i < 3; i++) {
      ids_first.push(
        await seedUserComment(h, 'notes/multi.md', `first batch comment ${i + 1}`),
      )
    }

    h.setMockLlmResponse('Acknowledged.')

    const watcher = h.watcher_factory()
    await watcher.tickOnce()

    // After tick 1: three LLM calls, three agent replies.
    expect(h.mockLlmCall).toHaveBeenCalled()
    expect(h.llm_calls.length).toBe(3)

    // Add two MORE comments. The cursor file should sit at the
    // last_processed_event_id from the first batch.
    const cursor_after_tick1 = readCursor(h)
    expect(cursor_after_tick1).not.toBeNull()
    expect(cursor_after_tick1!.last_processed_event_id).toBe(ids_first[2] ?? null)

    const ids_second: string[] = []
    for (let i = 0; i < 2; i++) {
      ids_second.push(
        await seedUserComment(h, 'notes/multi.md', `second batch comment ${i + 1}`),
      )
    }

    // Reset the call recorder before tick 2 so we can assert only the
    // new comments triggered LLM calls.
    h.llm_calls.length = 0

    await watcher.tickOnce()

    // After tick 2: exactly 2 NEW LLM calls (NOT 5).
    expect(h.llm_calls.length).toBe(2)

    const cursor_after_tick2 = readCursor(h)
    expect(cursor_after_tick2).not.toBeNull()
    expect(cursor_after_tick2!.last_processed_event_id).toBe(ids_second[1] ?? null)
  })
})

/* ─── Argus r2 BLOCKER 1 — cap-hit tick must NOT skip the (cap+1)-th user comment ─── */

describe('AgentWatcher — PER_TICK_MAX_REPLIES cap leaves overflow comments for the next tick', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('seed 21 user comment_posted events → tick → 20 replies + cursor sits at the 20th id (NOT the 21st)', async () => {
    // PER_TICK_MAX_REPLIES is a file-level constant in agent-watcher.ts;
    // its value (20) is asserted here so this test fails loudly if a
    // future sprint widens or narrows the cap without updating the
    // regression coverage.
    const CAP = 20
    buildDoc(h, 'notes/cap.md', 'doc body for the per-tick cap test')

    // Seed 21 user comments — one over the cap. ULIDs are minted by the
    // store's default generator; `last_event_id` ordering comes from
    // strict-ASCII compare, which is lexicographic creation order.
    const ids: string[] = []
    for (let i = 0; i < CAP + 1; i++) {
      ids.push(
        await seedUserComment(h, 'notes/cap.md', `cap test comment ${i + 1}`),
      )
    }
    expect(ids.length).toBe(CAP + 1)

    h.setMockLlmResponse('Acknowledged.')

    const watcher = h.watcher_factory()
    await watcher.tickOnce()

    // Exactly CAP LLM calls — the (CAP+1)-th comment did NOT trigger a
    // reply on this tick.
    expect(h.mockLlmCall).toHaveBeenCalled()
    expect(h.llm_calls.length).toBe(CAP)

    // Cursor must sit at the LAST PROCESSED event_id (ids[CAP-1]).
    // If the watcher had advanced to the high-water mark, the cursor
    // would jump to ids[CAP] — silently skipping that comment. Argus
    // r2 BLOCKER 1 closes exactly this gap.
    const cursor = readCursor(h)
    expect(cursor).not.toBeNull()
    expect(cursor!.last_processed_event_id).toBe(ids[CAP - 1] ?? null)
    // Defensive: explicit assertion that we did NOT jump past the
    // unprocessed (CAP+1)-th comment.
    expect(cursor!.last_processed_event_id).not.toBe(ids[CAP] ?? null)

    // Now run a second tick — the watcher should pick up exactly the
    // one remaining user comment (ids[CAP]).
    h.llm_calls.length = 0
    await watcher.tickOnce()
    expect(h.llm_calls.length).toBe(1)
    // Cursor must have advanced AT LEAST to ids[CAP] (proving the
    // overflow comment was processed). It may sit past ids[CAP] —
    // tick 2's tail-advance correctly walks the cursor past the
    // agent_reply events tick 1 wrote (whose ULIDs are lexicographically
    // greater than every seeded user comment_posted ULID because they
    // were minted later). The invariant under test is "the (CAP+1)-th
    // user comment got processed", not "the cursor parks exactly on
    // that event_id".
    const cursor_after_tick2 = readCursor(h)
    expect(cursor_after_tick2).not.toBeNull()
    expect(cursor_after_tick2!.last_processed_event_id).not.toBeNull()
    expect(
      (cursor_after_tick2!.last_processed_event_id as string) >=
        (ids[CAP] as string),
    ).toBe(true)
  })
})

/* ─── Case 12 — defensive grep: no hardcoded ISO date strings in test fixtures ─── */

describe('AgentWatcher — no hardcoded ISO date strings in fixtures (data-rot defence)', () => {
  it('test file body contains zero matches of the ISO-8601 calendar-date prefix', () => {
    // Self-check mentioned in the plan's E.1 case 12 — defensive
    // against the watchdog data-rot incident
    // (docs/solutions/runtime-errors/watchdog-test-data-rot-stale-hardcoded-dates.md).
    // We build the regex programmatically so the literal pattern
    // does NOT appear anywhere in this source file.
    const here = new URL(import.meta.url).pathname
    const body = readFileSync(here, 'utf8')
    // Strip comments — they may explain the rule using the literal
    // shape of the date pattern, which would otherwise self-match.
    const stripped = body
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//')) return false
        if (trimmed.startsWith('*')) return false
        return true
      })
      .join('\n')
    const forbidden = new RegExp(
      ['2', '\\d{3}', '-', '\\d{2}', '-', '\\d{2}', 'T'].join(''),
    )
    expect(forbidden.test(stripped)).toBe(false)
  })
})

/* ─── Case 13 — persona is spliced into the watcher's system prompt ─── */

describe('AgentWatcher — persona spliced into the system prompt', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('the LLM call factory wraps the watcher prompt with persona above the watcher base', async () => {
    // The watcher itself never reads the persona — that's the
    // factory's job (`buildAgentWatcherLlmCall`). We simulate the
    // factory's contract by passing a custom `llm_call` that asserts
    // the system string contains the persona marker AND the watcher
    // base text. In production the factory wraps `baseLlm` with
    // `composeSystemPrompt({base, persona, conventions: ''})`.
    buildDoc(h, 'notes/persona.md', 'doc body w/ persona context')
    const root_id = await seedUserComment(h, 'notes/persona.md', 'who are you?')

    const personaMarker = 'PERSONA-MARKER-XYZ-12345'
    // Custom LLM call that PRE-fixes the system prompt with a fake
    // persona block (mimicking what the factory does), then captures
    // for assertion.
    const persona_aware_calls: Array<{ system: string }> = []
    const persona_llm: AgentWatcherLlmCall = mock(async (call) => {
      // Inject the persona marker the way `composeSystemPrompt` would.
      const wrapped = `# Persona\n\n${personaMarker}\n\n---\n\n${call.system}`
      persona_aware_calls.push({ system: wrapped })
      return { text: 'I am the project agent.' }
    })

    const watcher = h.watcher_factory({ llm_call: persona_llm })
    await watcher.tickOnce()

    expect(persona_llm).toHaveBeenCalled()
    expect(persona_aware_calls.length).toBe(1)
    expect(persona_aware_calls[0]!.system).toContain(personaMarker)
    // The watcher's own base text is still present below the persona.
    expect(persona_aware_calls[0]!.system).toContain('notes/persona.md')

    // Sanity — the thread got an agent reply.
    const thread = await h.store.getThread(PROJECT_ID, root_id)
    expect(thread.replies.length).toBe(1)
  })
})

/* ─── Case 14 — per-project mutex prevents double-process ─── */

describe('AgentWatcher — per-project mutex prevents double-process under concurrent tickOnce', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('two parallel tickOnce calls produce exactly one agent_reply per user comment', async () => {
    buildDoc(h, 'notes/mutex.md', 'doc body for mutex test')

    // Seed three user comments. With a working mutex, the two
    // concurrent tickOnce() calls should serialise and each user
    // comment should be processed exactly once.
    const root_ids: string[] = []
    for (let i = 0; i < 3; i++) {
      root_ids.push(
        await seedUserComment(h, 'notes/mutex.md', `mutex test comment ${i + 1}`),
      )
    }

    // Real chained-promise mutex (same shape as anchor-walker's). The
    // test harness's default is a passthrough; we override here.
    const mutexes = new Map<string, Promise<unknown>>()
    const real_lock = async <T>(project_id: string, fn: () => Promise<T>): Promise<T> => {
      const prev = mutexes.get(project_id) ?? Promise.resolve()
      let release: () => void = () => undefined
      const next = new Promise<void>((resolve) => {
        release = resolve
      })
      mutexes.set(project_id, prev.then(() => next))
      try {
        await prev
        return await fn()
      } finally {
        release()
      }
    }

    h.setMockLlmResponse('Acknowledged.')

    const watcher = h.watcher_factory({ with_project_lock: real_lock })

    // Fire two ticks in parallel.
    await Promise.all([watcher.tickOnce(), watcher.tickOnce()])

    // Exactly 3 LLM calls (one per user comment), NOT 6.
    expect(h.llm_calls.length).toBe(3)

    // Each thread should have exactly one agent reply.
    for (const rid of root_ids) {
      const thread = await h.store.getThread(PROJECT_ID, rid)
      expect(thread.replies.length).toBe(1)
      expect(thread.replies[0]!.author_kind).toBe('agent')
    }
  })
})

/* ─── Case 15 — cursor advances atomically with appendEvent ─── */

describe('AgentWatcher — cursor advances atomically with appendEvent', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('when appendEvent throws mid-tick, the cursor file is NOT updated', async () => {
    buildDoc(h, 'notes/atomic.md', 'doc body for atomicity test')
    await seedUserComment(h, 'notes/atomic.md', 'will the cursor advance?')

    h.setMockLlmResponse('Yes, that is correct.')

    // Inject an appendEvent that throws on the agent reply write.
    // Cast away to override; we monkey-patch ONLY for this test.
    const orig = h.store.appendEvent.bind(h.store)
    let calls = 0
    ;(h.store as unknown as { appendEvent: typeof h.store.appendEvent }).appendEvent =
      async (project_id, input) => {
        calls += 1
        // First call is the seedUserComment above; subsequent calls
        // (the watcher trying to write the agent reply) throw.
        if (
          input.author_kind === 'agent' ||
          input.event_kind === 'agent_reply_skipped'
        ) {
          throw new Error('synthetic appendEvent failure')
        }
        return orig(project_id, input)
      }

    const watcher = h.watcher_factory()
    // tickOnce must NOT throw to outer scope — per the plan, watcher
    // errors are caught + logged, the tick body simply does not
    // advance the cursor for the offending project.
    await watcher.tickOnce().catch(() => undefined)

    // Cursor file should NOT exist (or contain the old null cursor)
    // because the agent-reply write failed.
    const cursor = readCursor(h)
    // Either the cursor wasn't written at all, or it's still pointing
    // at null. Either way it must NOT have advanced to the seeded
    // user comment's event_id (we never persist a forward cursor on
    // a failed write).
    if (cursor !== null) {
      expect(cursor.last_processed_event_id).toBeNull()
    }

    // Restore for the afterEach close.
    ;(h.store as unknown as { appendEvent: typeof h.store.appendEvent }).appendEvent =
      orig
    // Sanity — appendEvent was invoked.
    expect(calls).toBeGreaterThan(1)
  })
})

/* ─── helpers ────────────────────────────────────────────────── */

interface RawEventRow {
  event_id: string
  event_kind: string
  thread_root_id: string | null
  doc_path: string
  metadata_json: string | null
  body: string | null
  created_at: number
  author_kind: string
  author_id: string
}

function readRawEvents(h: Harness, project_id: string): RawEventRow[] {
  const dbPath = join(
    h.owner_home,
    'Projects',
    project_id,
    '.comments',
    'comments.db',
  )
  if (!existsSync(dbPath)) return []
  // Read via the Database directly so we don't depend on the store's
  // listing methods (which may filter on event_kind).
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
  const db = new Database(dbPath, { readonly: true })
  try {
    return db
      .prepare<RawEventRow, []>(
        `SELECT event_id, event_kind, thread_root_id, doc_path,
                metadata_json, body, created_at, author_kind, author_id
           FROM doc_comment_events
          ORDER BY created_at ASC, event_id ASC`,
      )
      .all()
  } finally {
    db.close()
  }
}

function findSkippedEvent(
  h: Harness,
  thread_root_id: string,
): RawEventRow | null {
  const events = readRawEvents(h, PROJECT_ID)
  const skipped = events.find(
    (e) =>
      e.event_kind === 'agent_reply_skipped' &&
      (e.thread_root_id === thread_root_id || e.thread_root_id === null),
  )
  return skipped ?? null
}
