/**
 * ISSUE #42 — Agent-triggered escalations now carry author-attributed
 * `<comment>` entries in the chat-surface envelope.
 *
 * Pre-fix bug: the watcher's auto-escalation stuffed the user's
 * comment AND the watcher-agent's own reply into
 * `escalate_to_chat.metadata_json.comment_body_history`, but the
 * escalation-loader renderer queried `doc_comment_events.comment_posted`
 * rows ONLY (the agent reply is intentionally NOT a `comment_posted`
 * row — self-reply guard at `agent-watcher.ts:processOneComment`
 * prevents the watcher from reading its own output on the next tick).
 * Net: the chat agent's next turn saw the user's comment but not the
 * watcher's response, losing the full thread context.
 *
 * Fix: the renderer now reads `metadata.comment_body_history` when
 * `metadata.trigger === 'agent_escalation'` AND emits per-comment
 * `<comment author="user|agent" timestamp="…">body</comment>` tags so
 * the chat composer can label who said what without a string-parse
 * round-trip.
 *
 * This test pins:
 *   1. New format → envelope contains author-attributed `<comment>`
 *      tags in the brief's exact order.
 *   2. Legacy bare-string format → renders as a single
 *      `<comment author="user">` (defensive parser per the brief's
 *      "typeof entry === 'string' → treat as user" rule).
 *   3. Legacy array-of-strings format → renders one
 *      `<comment author="user">` per entry (the brief's explicit
 *      back-compat case).
 *   4. User-triggered escalation paths IGNORE metadata.comment_body_history
 *      and stay on the `comment_posted`-row source — no double-render,
 *      no behaviour change for the existing user-click flow.
 *
 * Spec-conformance hard rule (Neutron CLAUDE.md 2026-05-13): each
 * assertion targets a SPEC-required side effect (envelope content,
 * author attribution, format selection by trigger), NOT phase-machine
 * bookkeeping. The closing condition in ISSUE #42 is "next chat turn's
 * system prompt contains both the user's comment AND the agent's
 * reply text, clearly labelled" — assertion 1 is the load-bearing
 * proof. The legacy back-compat tests guard the deploy-window where
 * stale escalate events from the pre-#42 agent-watcher still sit in
 * the events log waiting to be consumed.
 *
 * Time-dependent test discipline (Neutron CLAUDE.md hard rule): every
 * fixture timestamp comes from `Date.now() - <offset>` — no hardcoded
 * ISO strings, defensive against the watchdog test-data-rot incident.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CommentStore } from '../../comments/comment-store.ts'
import { loadPendingEscalations } from '../escalation-loader.ts'

const PROJECT_ID = 'demo-project'
const USER_ID = 'user@example.com'
const AGENT_ID = 'gateway-agent'

interface Harness {
  store: CommentStore
  owner_home: string
  tmp: string
  cleanup(): void
}

function start(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-escalate-author-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })

  // Date.now()-relative monotonic clock — no hardcoded ISO strings.
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

/**
 * Seed a thread root + an agent-triggered `escalate_to_chat` event
 * whose `metadata_json.comment_body_history` carries the supplied
 * value verbatim — the loader's renderer is the unit under test, so
 * this fixture mirrors the production wire shape from
 * `agent-watcher.ts:appendEscalation` (post-#42 writes the array
 * form; the legacy fixtures pass strings/arrays to exercise the
 * back-compat parser).
 */
async function seedAgentEscalateEvent(
  h: Harness,
  opts: {
    doc_path: string
    anchor_excerpt: string
    comment_body_history: unknown
    /** Default 'agent_escalation' — the path under test. */
    trigger?: 'agent_escalation' | 'user_button'
  },
): Promise<{ event_id: string; thread_root_id: string }> {
  // Root comment establishes the thread + supplies the user side that
  // both the new and legacy paths render.
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
    author_id: USER_ID,
    body: 'root user comment body — fixture',
    metadata_json: null,
  })

  const metadata: Record<string, unknown> = {
    thread_root_id: root.thread_root_id,
    doc_path: opts.doc_path,
    anchor_excerpt: opts.anchor_excerpt,
    comment_body_history: opts.comment_body_history,
    trigger: opts.trigger ?? 'agent_escalation',
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
    author_kind:
      (opts.trigger ?? 'agent_escalation') === 'agent_escalation'
        ? 'agent'
        : 'user',
    author_id:
      (opts.trigger ?? 'agent_escalation') === 'agent_escalation'
        ? AGENT_ID
        : USER_ID,
    body: null,
    metadata_json: JSON.stringify(metadata),
  })
  return {
    event_id: esc.event.event_id,
    thread_root_id: root.thread_root_id,
  }
}

describe('escalation-loader — agent-triggered escalations render author-attributed <comment> tags (ISSUE #42)', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('new {author, body, timestamp}[] history renders ordered <comment author="…"> tags', async () => {
    // Brief's case 1–3: three-entry history with alternating authors.
    await seedAgentEscalateEvent(h, {
      doc_path: 'notes/auto.md',
      anchor_excerpt: 'controversial passage',
      comment_body_history: [
        { author: 'user', body: 'help', timestamp: 1_700_000_000_001 },
        { author: 'agent', body: 'try X', timestamp: 1_700_000_000_002 },
        {
          author: 'user',
          body: 'tried X, still broken',
          timestamp: 1_700_000_000_003,
        },
      ],
      trigger: 'agent_escalation',
    })

    const result = await loadPendingEscalations(h.store, PROJECT_ID)

    // Spec-conformance — author-attributed tags AND ordered as written.
    // Substring matches preserve the exact tag the chat agent will see.
    expect(result.rendered).toContain(
      '<comment author="user" timestamp="1700000000001">help</comment>',
    )
    expect(result.rendered).toContain(
      '<comment author="agent" timestamp="1700000000002">try X</comment>',
    )
    expect(result.rendered).toContain(
      '<comment author="user" timestamp="1700000000003">tried X, still broken</comment>',
    )

    // Ordering: the three tags appear in the brief's stated sequence.
    const helpIdx = result.rendered.indexOf('>help</comment>')
    const tryXIdx = result.rendered.indexOf('>try X</comment>')
    const stillBrokenIdx = result.rendered.indexOf(
      '>tried X, still broken</comment>',
    )
    expect(helpIdx).toBeGreaterThan(-1)
    expect(tryXIdx).toBeGreaterThan(helpIdx)
    expect(stillBrokenIdx).toBeGreaterThan(tryXIdx)

    // Envelope shape — `<thread doc_path="…" anchor_excerpt="…">`
    // wraps the comment entries (the brief's exact XML structure).
    expect(result.rendered).toContain(
      '<thread doc_path="notes/auto.md" anchor_excerpt="controversial passage">',
    )
    expect(result.rendered).toContain('</thread>')

    // Negative — the seeded user root comment body MUST NOT also
    // appear in the envelope when the agent-triggered path is in
    // effect. The metadata's history is authoritative; pulling
    // comment_posted rows in parallel would double-render the user
    // side and re-introduce the very confusion #42 closes.
    expect(result.rendered).not.toContain('root user comment body — fixture')
  })

  it('legacy bare-string comment_body_history renders as a single <comment author="user"> (back-compat)', async () => {
    // Pre-#42 production format: a single concatenated string that the
    // old agent-watcher built by joining `<kind>:<id> — body` lines
    // with `\n---\n`. The defensive parser collapses the whole blob
    // into one user comment (the chat agent sees the dump) — only
    // matters for the deploy window because escalate events are
    // consumed-on-read and the upgrade writes the new array shape
    // going forward.
    await seedAgentEscalateEvent(h, {
      doc_path: 'notes/legacy-string.md',
      anchor_excerpt: 'legacy excerpt',
      comment_body_history: 'legacy string',
      trigger: 'agent_escalation',
    })

    const result = await loadPendingEscalations(h.store, PROJECT_ID)
    expect(result.rendered).toContain(
      '<comment author="user">legacy string</comment>',
    )
  })

  it('legacy array-of-strings comment_body_history renders each entry as a <comment author="user"> (back-compat)', async () => {
    // Brief's case 4: array-of-strings legacy shape. Each entry maps
    // to a `<comment author="user">` per the defensive parser's
    // `typeof entry === 'string' → treat as user` rule.
    await seedAgentEscalateEvent(h, {
      doc_path: 'notes/legacy-array.md',
      anchor_excerpt: 'legacy array excerpt',
      comment_body_history: ['first legacy body', 'second legacy body'],
      trigger: 'agent_escalation',
    })

    const result = await loadPendingEscalations(h.store, PROJECT_ID)
    expect(result.rendered).toContain(
      '<comment author="user">first legacy body</comment>',
    )
    expect(result.rendered).toContain(
      '<comment author="user">second legacy body</comment>',
    )

    // Order preserved (first → second).
    const firstIdx = result.rendered.indexOf('>first legacy body</comment>')
    const secondIdx = result.rendered.indexOf('>second legacy body</comment>')
    expect(firstIdx).toBeGreaterThan(-1)
    expect(secondIdx).toBeGreaterThan(firstIdx)
  })

  it('user-triggered escalation IGNORES metadata.comment_body_history and sources from comment_posted rows', async () => {
    // Sentinel proves the trigger-gated branch: if the renderer were
    // ALSO pulling metadata.comment_body_history on the user-click
    // path, the sentinel string would appear in the envelope. The
    // user-click path's source-of-truth is the comment_posted row(s)
    // on the thread — which is what the existing chat-surface tests
    // already exercise.
    await seedAgentEscalateEvent(h, {
      doc_path: 'notes/user-click.md',
      anchor_excerpt: 'user-click excerpt',
      comment_body_history: [
        {
          author: 'agent',
          body: 'SENTINEL-AGENT-METADATA-SHOULD-NOT-APPEAR',
          timestamp: 1_700_000_000_004,
        },
      ],
      trigger: 'user_button',
    })

    const result = await loadPendingEscalations(h.store, PROJECT_ID)

    // The root comment_posted row IS rendered (the user-click path's
    // authoritative source).
    expect(result.rendered).toContain(
      '<comment author="user"',
    )
    expect(result.rendered).toContain('root user comment body — fixture')
    // The metadata-only sentinel is correctly suppressed.
    expect(result.rendered).not.toContain(
      'SENTINEL-AGENT-METADATA-SHOULD-NOT-APPEAR',
    )
  })

  it('xml-escapes attribute and body content to block sibling-tag injection from user text', async () => {
    // Defense-in-depth: a user could embed `</comment>` or `</thread>`
    // in their reply body to confuse the chat agent's parse of the
    // envelope. `escapeXmlText` / `escapeXmlAttr` collapse those into
    // entity references so injected tags don't survive the round-trip.
    await seedAgentEscalateEvent(h, {
      doc_path: 'notes/<inject>.md',
      anchor_excerpt: 'anchor with "quotes" & <tag> and \'apostrophe\'',
      comment_body_history: [
        {
          author: 'user',
          body: 'body with </comment> and <thread> and & ampersand',
          timestamp: 1_700_000_000_010,
        },
      ],
      trigger: 'agent_escalation',
    })

    const result = await loadPendingEscalations(h.store, PROJECT_ID)
    // Attribute values escape `<`, `>`, `&`, `"`, `'` — five predefined
    // XML entities. The apostrophe assertion guards against a future
    // refactor that re-narrows `escapeXmlAttr` to drop `'` (an LLM
    // consumer is forgiving, but a strict XML parser would choke).
    expect(result.rendered).toContain('doc_path="notes/&lt;inject&gt;.md"')
    expect(result.rendered).toContain(
      'anchor_excerpt="anchor with &quot;quotes&quot; &amp; &lt;tag&gt; and &apos;apostrophe&apos;"',
    )
    // Body content escapes `<`, `>`, `&` only.
    expect(result.rendered).toContain(
      'body with &lt;/comment&gt; and &lt;thread&gt; and &amp; ampersand',
    )
    // Raw injection attempt MUST NOT survive.
    expect(result.rendered).not.toMatch(/body with <\/comment>/)
  })

  it('user-triggered escalation with a STRUCTURED-array metadata still sources from comment_posted rows (post-deploy realistic state)', async () => {
    // Regression guard against I-3 audit gap: the prior sentinel test
    // proved metadata is ignored when it carries an `agent`-authored
    // entry on the user-click path. But once both writers ship the
    // new array format, a user-triggered escalate row will likely
    // ALSO carry the structured shape (the docs surface's
    // `handleEscalateComment` could trivially adopt it). This test
    // proves the trigger-gated branch is the load-bearing dispatcher
    // — even with a recognisably-new {author, body, timestamp}
    // array, the user-click path still pulls comments from
    // `comment_posted` rows. Without this case a future refactor
    // that flips the user-trigger path to ALSO read metadata would
    // silently double-render the user's own comment.
    await seedAgentEscalateEvent(h, {
      doc_path: 'notes/user-click-structured.md',
      anchor_excerpt: 'user click new shape',
      comment_body_history: [
        {
          author: 'user',
          body: 'METADATA-USER-ENTRY-SHOULD-NOT-APPEAR',
          timestamp: 1_700_000_000_020,
        },
        {
          author: 'agent',
          body: 'METADATA-AGENT-ENTRY-SHOULD-NOT-APPEAR',
          timestamp: 1_700_000_000_021,
        },
      ],
      trigger: 'user_button',
    })

    const result = await loadPendingEscalations(h.store, PROJECT_ID)

    // Root `comment_posted` row IS rendered (the user-click path's
    // authoritative source — same as the prior sentinel test).
    expect(result.rendered).toContain('root user comment body — fixture')
    expect(result.rendered).toContain('<comment author="user"')
    // Neither metadata entry leaks — the trigger gate held even with
    // a structurally-valid array.
    expect(result.rendered).not.toContain(
      'METADATA-USER-ENTRY-SHOULD-NOT-APPEAR',
    )
    expect(result.rendered).not.toContain(
      'METADATA-AGENT-ENTRY-SHOULD-NOT-APPEAR',
    )
  })
})
