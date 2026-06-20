/**
 * ISSUE #44 — agent-watcher auto-escalation routing regression test.
 *
 * PR #300 (ISSUE #41) fixed the user-clicked escalate path so the docs
 * surface's escalate handler pins `WebChatSessionProjectRegistry` to the
 * URL's project_id. But the LLM auto-escalation twin in
 * `gateway/comments/agent-watcher.ts:appendEscalation` was NOT updated —
 * when the watcher classifier fires `escalate_to_chat` from a non-default
 * project, the registry was never pinned and the next chat turn for that
 * user silently fell back to the hardcoded `'default'` sidecar (the same
 * pre-#41 silent-no-op shape, just on the auto-path).
 *
 * This test pins the auto-escalation routing flow:
 *
 *   - Seed a user comment in project `foo`, owned by `user_uA`.
 *   - Mock the watcher LLM to return an escalation-phrase reply
 *     (e.g. "let's continue in chat"). One tick → the watcher writes
 *     `escalate_to_chat` to foo's sidecar and pins the registry to
 *     `(user_uA, 'foo')`.
 *   - Build the production-shaped chat resolver
 *     (`buildPhaseSpecResolver` with the same closure shape
 *     `gateway/index.ts` wires) and resolve one turn against the foo
 *     sidecar — the rendered system prompt MUST contain
 *     `<escalated_comment_threads>` and the foo anchor excerpt.
 *   - Companion: seed a second user comment in project `bar` by the
 *     same user, escalate via the watcher → registry now points at
 *     `bar` (most-recent-wins, matching ISSUE #41 semantics) and the
 *     resolver's next turn pulls envelope content from bar (not foo).
 *
 * Spec-conformance hard rule (Neutron CLAUDE.md 2026-05-13): each
 * assertion targets a SPEC-required side effect (registry mutation +
 * envelope content), NOT phase-machine bookkeeping. The `setActive`
 * call is the load-bearing wire; the envelope assertion proves the
 * wire actually routes the chat composer, not just that the event row
 * lands.
 *
 * Out of scope (explicitly per the brief):
 *   - changing classifier policy
 *   - multi-project escalation aggregation
 *   - per-project chat composer architecture
 *
 * Time-dependent test discipline (per Neutron CLAUDE.md): every
 * fixture timestamp is `Date.now() - <offset>` — NO hardcoded ISO
 * strings, defensive against the watchdog test-data-rot incident.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ApiKeyStore } from '../../../auth/api-key-store.ts'
import { SecretsStore } from '../../../auth/secrets-store.ts'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { CommentStore, type AppendEventInput } from '../comment-store.ts'
import { AgentWatcher } from '../agent-watcher.ts'
import { InMemoryWebChatSessionProjectRegistry } from '../../http/chat-bridge.ts'
import { buildPhaseSpecResolver } from '../../realmode-composer/build-phase-spec-resolver.ts'
import type { AgentWatcherLlmCall } from '../../realmode-composer/build-agent-watcher-llm-call.ts'

const PROJECT_SLUG = 'demo'
const USER_ID = 'user_uA'

interface Harness {
  tmp: string
  owner_home: string
  store: CommentStore
  registry: InMemoryWebChatSessionProjectRegistry
  apiKeys: ApiKeyStore
  db: ProjectDb
  llm_calls: Array<{ system: string }>
  /** Mutable script — flip per-tick to drive different reply text. */
  setMockReply: (text: string) => void
  buildWatcher: () => AgentWatcher
  /** Mirror of the production resolver wiring in `gateway/index.ts`. */
  buildResolver: (captured: string[]) => Promise<
    NonNullable<Awaited<ReturnType<typeof buildPhaseSpecResolver>>>
  >
  cleanup: () => void
}

function start(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-watcher-routing-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })

  // Per-project docs roots — the watcher's `doc_read` returns the file
  // body so the system prompt builder has real text to embed.
  for (const project_id of ['foo', 'bar']) {
    const docsDir = join(owner_home, 'Projects', project_id, 'docs', 'notes')
    mkdirSync(docsDir, { recursive: true })
    writeFileSync(
      join(docsDir, 'doc.md'),
      `# ${project_id} doc body\n`,
      'utf8',
    )
  }

  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const secrets = new SecretsStore({ data_dir: tmp, db })
  const apiKeys = new ApiKeyStore({ db, secrets })

  // Monotonic Date.now()-relative event-stamp clock so the events log
  // sits just inside any retention window (per the watchdog data-rot
  // discipline doc).
  const startTs = Date.now() - 60_000
  const events = { ts: startTs }
  const store = new CommentStore({
    owner_home,
    now: () => {
      events.ts += 1
      return events.ts
    },
  })

  const registry = new InMemoryWebChatSessionProjectRegistry()
  const llm_calls: Harness['llm_calls'] = []
  let scriptedReply = "I'm not sure. Let's continue in chat."

  const mockLlmCall: AgentWatcherLlmCall = mock(
    async (call: { system: string }) => {
      llm_calls.push({ system: call.system })
      return { text: scriptedReply }
    },
  )

  const list_active_projects = async (): Promise<string[]> => ['foo', 'bar']
  const with_project_lock = async <T>(
    _project_id: string,
    fn: () => Promise<T>,
  ): Promise<T> => fn()
  const doc_read = async (
    project_id: string,
    doc_path: string,
  ): Promise<string | null> => {
    const abs = join(owner_home, 'Projects', project_id, 'docs', doc_path)
    try {
      return require('node:fs').readFileSync(abs, 'utf8') as string
    } catch {
      return null
    }
  }

  const buildWatcher = (): AgentWatcher =>
    new AgentWatcher({
      comment_store: store,
      llm_call: mockLlmCall,
      owner_home,
      doc_read,
      list_active_projects,
      with_project_lock,
      chat_session_projects: registry,
    })

  const buildResolver = async (
    captured: string[],
  ): Promise<NonNullable<Awaited<ReturnType<typeof buildPhaseSpecResolver>>>> => {
    // Sprint cc-substrate-migration-3-sites (2026-05-31) — resolver now
    // consumes a `Substrate`. The fake substrate captures `spec.prompt`
    // (which packs `<composed system>\n\n<user>` — the system body
    // containing any escalation splice is the prefix of each captured
    // string) so existing tests keep their string-array assertion shape.
    const substrate: import('../../../runtime/substrate.ts').Substrate = {
      start(spec): import('../../../runtime/session-handle.ts').SessionHandle {
        captured.push(spec.prompt)
        const events = (async function* (): AsyncGenerator<
          import('../../../runtime/events.ts').Event,
          void,
          void
        > {
          yield { kind: 'token', text: JSON.stringify({ body: 'hi' }) }
          yield {
            kind: 'completion',
            usage: { input_tokens: 1, output_tokens: 1 },
            substrate_instance_id: 'agent-watcher-escalation-fake',
          }
        })()
        return {
          events,
          respondToTool: async () => {
            throw new Error('fake substrate: respondToTool unused')
          },
          cancel: async () => undefined,
          tool_resolution: 'internal',
        }
      },
    }
    // Closure shape MUST match the production wiring in
    // `gateway/index.ts:2511-2536` — `() => registry.getActive(user) ?? 'default'`.
    const ownerChatProjectIdResolver = (): string =>
      registry.getActive(USER_ID) ?? 'default'
    const resolver = await buildPhaseSpecResolver({
      substrate,
      log_slug: 't1',
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      owner_data_dir: null,
      personaLoader: null,
      commentStore: store,
      escalation_project_id: ownerChatProjectIdResolver,
    })
    if (resolver === null) {
      throw new Error('resolver was null; expected a working resolver')
    }
    return resolver
  }

  return {
    tmp,
    owner_home,
    store,
    registry,
    apiKeys,
    db,
    llm_calls,
    setMockReply: (text) => {
      scriptedReply = text
    },
    buildWatcher,
    buildResolver,
    cleanup: () => {
      store.closeAll()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function seedUserCommentInProject(
  h: Harness,
  project_id: string,
  body: string,
  anchor_excerpt: string,
): Promise<{ event_id: string }> {
  // Anchor pos doesn't need to match the doc — the watcher's reply
  // pipeline uses `anchor_text_excerpt` verbatim when composing the
  // system prompt + the escalate metadata.
  const input: AppendEventInput = {
    event_kind: 'comment_posted',
    doc_path: 'notes/doc.md',
    thread_root_id: null,
    parent_event_id: null,
    anchor_start: 0,
    anchor_end: anchor_excerpt.length,
    anchor_text_excerpt: anchor_excerpt,
    anchor_ctx_before: '',
    anchor_ctx_after: '',
    based_on_modified_at: Date.now() - 30_000,
    author_kind: 'user',
    author_id: USER_ID,
    body,
    metadata_json: null,
  }
  const result = await h.store.appendEvent(project_id, input)
  return { event_id: result.event.event_id }
}

const RESOLVE_BUNDLE = {
  project_slug: PROJECT_SLUG,
  topic_id: `web:${USER_ID}`,
  user_id: USER_ID,
  signup_via: 'web' as const,
  telegram_display_name: null,
  phase: 'signup' as const,
  intent: {
    goal: 'g',
    shape: 'free-text' as const,
    allowed_option_values: [] as string[],
    max_body_chars: 200,
  },
  captured: {},
  recent_turns: [] as never[],
  attempt_count: 0,
  rejection_reason: null,
}

describe('AgentWatcher — auto-escalation pins WebChatSessionProjectRegistry (ISSUE #44)', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('escalation in project foo pins registry to (uA, foo) AND next chat turn pulls envelope from foo; subsequent escalation in bar re-pins and excludes foo content', async () => {
    /* ── Phase 1: seed a user comment in foo and tick the watcher. ──── */
    await seedUserCommentInProject(
      h,
      'foo',
      'big architectural question in foo',
      'FOO-PROJECT-ANCHOR',
    )
    // Sanity: registry empty pre-tick.
    expect(h.registry.getActive(USER_ID)).toBeNull()

    h.setMockReply("I'm not sure. Let's continue in chat.")
    const watcher = h.buildWatcher()
    const result1 = await watcher.tickOnce()

    // Spec-conformance hard rule — explicit assertions on the SPEC-
    // required side effects (registry pin + escalate event lands).
    expect(result1.escalations).toBe(1)
    expect(h.registry.getActive(USER_ID)).toBe('foo')

    /* ── Phase 2: drive a chat resolver turn — envelope must source
     * from foo's sidecar (NOT bar, NOT the hardcoded `default`). ───── */
    const captured: string[] = []
    const resolver = await h.buildResolver(captured)
    await resolver.resolve(RESOLVE_BUNDLE)
    expect(captured.length).toBe(1)
    expect(captured[0]).toContain('<escalated_comment_threads>')
    expect(captured[0]).toContain('FOO-PROJECT-ANCHOR')
    expect(captured[0]).toContain('big architectural question in foo')
    // Cross-project bleed forbidden.
    expect(captured[0]).not.toContain('BAR-PROJECT-ANCHOR')

    /* ── Phase 3: same user posts in bar; watcher escalates that too. ─ */
    await seedUserCommentInProject(
      h,
      'bar',
      'different question in bar',
      'BAR-PROJECT-ANCHOR',
    )
    // Reply stays escalation-phrased so the second tick fires
    // appendEscalation in `bar`.
    const result2 = await watcher.tickOnce()
    expect(result2.escalations).toBe(1)
    // Registry MUST now point at `bar` — most-recent-escalation-wins
    // semantic, matching the user-click path's ISSUE #41 behaviour.
    expect(h.registry.getActive(USER_ID)).toBe('bar')

    /* ── Phase 4: another resolver turn — envelope sources from bar. ── */
    await resolver.resolve(RESOLVE_BUNDLE)
    expect(captured.length).toBe(2)
    expect(captured[1]).toContain('<escalated_comment_threads>')
    expect(captured[1]).toContain('BAR-PROJECT-ANCHOR')
    expect(captured[1]).toContain('different question in bar')
    // Load-bearing negative assertion: foo content from Phase 2 must
    // NOT leak into this turn even though both sidecars share one
    // CommentStore.
    expect(captured[1]).not.toContain('FOO-PROJECT-ANCHOR')
    expect(captured[1]).not.toContain('big architectural question in foo')
  })

  it('non-escalation reply does NOT mutate the registry (negative control)', async () => {
    // Seed a user comment whose watcher reply will be a plain answer
    // (NOT one of the ESCALATION_KEYWORDS). The watcher should write
    // a `comment_posted (author=agent)` event and leave the registry
    // alone — confirming the setActive call is gated on the escalate
    // branch only, not bolted onto every appendEvent.
    await seedUserCommentInProject(
      h,
      'foo',
      'simple question',
      'FOO-ANCHOR-NONESCALATE',
    )
    h.setMockReply('Yes, that is correct.')

    const watcher = h.buildWatcher()
    const result = await watcher.tickOnce()
    expect(result.agent_replies).toBe(1)
    expect(result.escalations).toBe(0)
    expect(h.registry.getActive(USER_ID)).toBeNull()
  })

  it('omitting chat_session_projects leaves the auto-escalate path non-fatal (legacy boot back-compat)', async () => {
    // Spin up a parallel watcher with no registry — proves the option
    // is truly optional and the auto-escalate event still lands.
    await seedUserCommentInProject(
      h,
      'foo',
      'edge-case question',
      'FOO-ANCHOR-LEGACY',
    )
    h.setMockReply("Let's continue in chat.")

    const watcher_no_registry = new AgentWatcher({
      comment_store: h.store,
      llm_call: mock(
        async () => ({ text: "Let's continue in chat." }),
      ) as AgentWatcherLlmCall,
      owner_home: h.owner_home,
      doc_read: async (project_id, doc_path) => {
        const abs = join(h.owner_home, 'Projects', project_id, 'docs', doc_path)
        try {
          return require('node:fs').readFileSync(abs, 'utf8') as string
        } catch {
          return null
        }
      },
      list_active_projects: async () => ['foo', 'bar'],
      with_project_lock: async <T>(_pid: string, fn: () => Promise<T>): Promise<T> => fn(),
      // chat_session_projects omitted — pre-#44 shape.
    })
    const result = await watcher_no_registry.tickOnce()
    // Escalate event still lands; only the side-effect of pinning the
    // registry is skipped.
    expect(result.escalations).toBe(1)
    // And the shared registry the harness owns was untouched (no
    // accidental cross-instance writes).
    expect(h.registry.getActive(USER_ID)).toBeNull()
  })
})
