/**
 * Chat-history hydration (2026-05-28 sprint) — surface tests.
 *
 * Round-trips `GET /api/v1/chat/history` through `composeHttpHandler`
 * with a stub `resolveUserClaim` and a real `ButtonStore` over a fresh
 * per-test SQLite file (so the canonical migration chain — including
 * the new 0049 covering index — runs end-to-end). Mirrors the
 * structure of `gateway/__tests__/app-tasks-surface.test.ts`.
 *
 * Per `docs/plans/2026-05-28-001-feat-chat-history-hydration-plan.md` § Phase 3.1.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ButtonStore, type ChatHistoryTurn } from '@neutronai/channels/button-store.ts'
import { buildButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeHttpHandler } from '../http/compose.ts'
import {
  createChatHistorySurface,
  type UserClaim,
} from '../http/chat-history-surface.ts'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  store: ButtonStore
  db: ProjectDb
  tmp: string
  /**
   * The currently-active stub claim. Tests mutate this before each
   * fetch to drive the auth path (null → 401, mismatched slug → 401,
   * matching slug → 200).
   */
  setClaim: (claim: UserClaim | null) => void
  close(): Promise<void>
}

const PROJECT_SLUG = 'demo'
const USER_ID = 'user-test'

async function startGateway(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-chat-history-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const store = new ButtonStore({ db })

  // Stub the claim via a closure-captured ref so individual tests can
  // toggle null / mismatched / valid for the same harness.
  let currentClaim: UserClaim | null = { project_slug: PROJECT_SLUG, user_id: USER_ID }
  const surface = createChatHistorySurface({
    store,
    resolveUserClaim: async () => currentClaim,
    project_slug: PROJECT_SLUG,
  })
  const composed = composeHttpHandler({
    chatHistory: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    store,
    db,
    tmp,
    setClaim: (claim) => {
      currentClaim = claim
    },
    close: async () => {
      await server.stop(true)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

/**
 * Seed N rows on `web:<USER_ID>` topic with relative timestamps so the
 * test data never rots against the wall clock (per
 * internal design notes).
 * Each row's `created_at` is `Date.now() - (idx * 60_000)` so idx=0 is
 * the newest, idx=N-1 the oldest.
 *
 * `resolve_at` is set on the first half so we cover both resolved and
 * unresolved rows; the unresolved rows carry `expires_at` in the
 * future so they survive the ghost-row filter.
 */
async function seedHistory(store: ButtonStore, count: number): Promise<void> {
  const now = Date.now()
  // Future expiry so unresolved rows ALL survive the
  // `expires_at > now` ghost-row filter when the surface queries.
  const farFuture = now + 24 * 60 * 60 * 1_000
  const topic = `web:${USER_ID}`
  for (let i = 0; i < count; i++) {
    const created = now - i * 60_000
    const prompt = buildButtonPrompt({
      body: `Turn ${i}`,
      options: [
        { label: 'Y', body: `yes-${i}`, value: 'yes' },
        { label: 'N', body: `no-${i}`, value: 'no' },
      ],
    })
    // Inject the per-row clock by constructing a single-shot store
    // whose `now()` returns the seeded `created_at`. The shared
    // `store` instance we hand back uses real `Date.now` for any
    // subsequent reads.
    const seedStore = new ButtonStore({ db: (store as unknown as { db: ProjectDb }).db, now: () => created })
    await seedStore.emit(prompt, { topic_id: topic })
    // Bump `expires_at` to `farFuture` for half the rows so the
    // resolved-via-real-choice path is also exercised. Half resolved,
    // half unresolved.
    if (i % 2 === 0) {
      const choice = {
        prompt_id: prompt.prompt_id,
        choice_value: 'yes',
        chosen_at: created + 1_000,
        speaker_user_id: USER_ID,
        channel_kind: 'app-socket' as const,
      }
      await seedStore.resolve({ choice })
    } else {
      // Stretch the unresolved row's expires_at into the future so it
      // survives the ghost filter.
      const rawDb = (store as unknown as { db: ProjectDb }).db.raw()
      rawDb.prepare('UPDATE button_prompts SET expires_at = ? WHERE prompt_id = ?').run(
        farFuture,
        prompt.prompt_id,
      )
    }
  }
}

interface HistoryResponse {
  ok?: boolean
  code?: string
  turns?: ChatHistoryTurn[]
  has_more?: boolean
  oldest_returned_at?: number | null
  oldest_returned_prompt_id?: string | null
}

describe('chat-history surface — GET /api/v1/chat/history', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  // T1 — happy path. 25 rows seeded, default limit (20). Returns the
  // 20 most-recent turns in DESC order, has_more=true, cursor fields
  // anchored to the boundary row.
  test('valid claim → 200 with 20 most-recent rows DESC by created_at', async () => {
    await seedHistory(harness.store, 25)
    const res = await fetch(`${harness.base}/api/v1/chat/history`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HistoryResponse
    expect(body.ok).toBe(true)
    expect(body.turns?.length).toBe(20)
    expect(body.has_more).toBe(true)
    // DESC ordering — newest first. Turn 0 has the highest created_at;
    // turn 19 is the oldest in this page.
    expect(body.turns?.[0]?.body).toBe('Turn 0')
    expect(body.turns?.[19]?.body).toBe('Turn 19')
    expect(body.oldest_returned_at).toBe(body.turns![19]!.created_at)
    expect(body.oldest_returned_prompt_id).toBe(body.turns![19]!.prompt_id)
  })

  // T2 — paginate. Use the T1 cursor to fetch the next 5 older turns,
  // has_more=false (we seeded exactly 25).
  test('?before=<cursor> → next 5 older turns, has_more: false', async () => {
    await seedHistory(harness.store, 25)
    const firstRes = await fetch(`${harness.base}/api/v1/chat/history?limit=20`)
    const firstBody = (await firstRes.json()) as HistoryResponse
    const before = firstBody.oldest_returned_at
    const beforePromptId = firstBody.oldest_returned_prompt_id
    const params = new URLSearchParams()
    params.set('before', String(before))
    params.set('before_prompt_id', String(beforePromptId))
    const res = await fetch(`${harness.base}/api/v1/chat/history?${params.toString()}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HistoryResponse
    expect(body.turns?.length).toBe(5)
    expect(body.has_more).toBe(false)
    expect(body.turns?.[0]?.body).toBe('Turn 20')
    expect(body.turns?.[4]?.body).toBe('Turn 24')
  })

  // T3 — auth gate. Null claim → 401 with `unauthorized` code.
  test('null claim → 401 unauthorized', async () => {
    harness.setClaim(null)
    const res = await fetch(`${harness.base}/api/v1/chat/history`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as HistoryResponse
    expect(body.ok).toBe(false)
    expect(body.code).toBe('unauthorized')
  })

  // T4 — instance-mismatch defense. Claim with WRONG project_slug → 401
  // even if user_id is present. The underlying resolver should never
  // return a mismatched slug (the cookieToUserClaim assertion catches
  // it first), but the handler-level double-check is the
  // defense-in-depth net.
  test('cross-project claim → 401 project_mismatch', async () => {
    harness.setClaim({ project_slug: 'other-project', user_id: USER_ID })
    const res = await fetch(`${harness.base}/api/v1/chat/history`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as HistoryResponse
    expect(body.ok).toBe(false)
    expect(body.code).toBe('project_mismatch')
  })

  // T5 — empty history (fresh instance). 200 with empty arrays +
  // null cursors.
  test('empty DB → 200 with empty turns + null cursors', async () => {
    const res = await fetch(`${harness.base}/api/v1/chat/history`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HistoryResponse
    expect(body.ok).toBe(true)
    expect(body.turns).toEqual([])
    expect(body.has_more).toBe(false)
    expect(body.oldest_returned_at).toBe(null)
    expect(body.oldest_returned_prompt_id).toBe(null)
  })

  // T6 — limit clamping. `?limit=10000` → server clamps to 100 max.
  test('?limit=10000 → server clamps to MAX_LIMIT (100)', async () => {
    await seedHistory(harness.store, 120)
    const res = await fetch(`${harness.base}/api/v1/chat/history?limit=10000`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HistoryResponse
    expect(body.turns?.length).toBe(100)
    expect(body.has_more).toBe(true)
  })

  // T6b — limit non-numeric / zero / negative → falls back to default
  // (20), never 0 or NaN-derived garbage.
  test('?limit=abc → 20 (default) | ?limit=0 → 20 | ?limit=-5 → 20', async () => {
    await seedHistory(harness.store, 25)
    for (const raw of ['abc', '0', '-5']) {
      const res = await fetch(`${harness.base}/api/v1/chat/history?limit=${raw}`)
      const body = (await res.json()) as HistoryResponse
      expect(body.turns?.length).toBe(20)
    }
  })

  // T7 — ghost-row exclusion. An unresolved row whose `expires_at` is
  // already in the past must NOT appear in the history payload (a
  // future `emit()` will delete-and-replace it; surfacing the ghost
  // would render a turn the client could never interact with).
  test('expired unresolved rows are excluded (ghost filter)', async () => {
    const topic = `web:${USER_ID}`
    const now = Date.now()
    // Seed one resolved row (always included) and one expired
    // unresolved row (must be filtered).
    const resolved = buildButtonPrompt({
      body: 'Resolved turn',
      options: [{ label: 'A', body: 'a', value: 'a' }],
    })
    const expiredStore = new ButtonStore({
      db: (harness.store as unknown as { db: ProjectDb }).db,
      now: () => now - 120_000,
    })
    await expiredStore.emit(resolved, { topic_id: topic })
    await expiredStore.resolve({
      choice: {
        prompt_id: resolved.prompt_id,
        choice_value: 'a',
        chosen_at: now - 119_000,
        speaker_user_id: USER_ID,
        channel_kind: 'app-socket',
      },
    })
    const ghost = buildButtonPrompt({
      body: 'Ghost (expired unresolved)',
      options: [{ label: 'A', body: 'a', value: 'a' }],
    })
    await expiredStore.emit(ghost, { topic_id: topic })
    // Force expires_at into the past so it's a ghost.
    const rawDb = (harness.store as unknown as { db: ProjectDb }).db.raw()
    rawDb
      .prepare('UPDATE button_prompts SET expires_at = ? WHERE prompt_id = ?')
      .run(now - 1_000, ghost.prompt_id)
    const res = await fetch(`${harness.base}/api/v1/chat/history`)
    const body = (await res.json()) as HistoryResponse
    expect(body.turns?.length).toBe(1)
    expect(body.turns?.[0]?.body).toBe('Resolved turn')
  })

  // T8 — defensive options_json. A row with malformed options_json AND
  // a real `resolution_value` must STILL be returned (resolution_text
  // falls back to the raw value rather than 500'ing the batch).
  test('malformed options_json row → returned with raw value fallback', async () => {
    const topic = `web:${USER_ID}`
    const prompt = buildButtonPrompt({
      body: 'Corrupt row',
      options: [{ label: 'A', body: 'pretty-display', value: 'opt_a' }],
    })
    await harness.store.emit(prompt, { topic_id: topic })
    await harness.store.resolve({
      choice: {
        prompt_id: prompt.prompt_id,
        choice_value: 'opt_a',
        chosen_at: Date.now(),
        speaker_user_id: USER_ID,
        channel_kind: 'app-socket',
      },
    })
    // Hand-patch options_json to garbage so the per-row parser
    // throws inside `rowToHistoryTurn`. The defensive try/catch
    // there should fall back to `resolution_value` rather than
    // 500 the request.
    const rawDb = (harness.store as unknown as { db: ProjectDb }).db.raw()
    rawDb
      .prepare("UPDATE button_prompts SET options_json = '<not json>' WHERE prompt_id = ?")
      .run(prompt.prompt_id)
    const res = await fetch(`${harness.base}/api/v1/chat/history`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HistoryResponse
    expect(body.turns?.length).toBe(1)
    const turn = body.turns![0]!
    expect(turn.resolved).toBe(true)
    // Fallback path: the option body lookup failed (parse exploded),
    // so server returns the raw `resolution_value` so the client
    // still renders SOMETHING for the user-side bubble.
    if (turn.resolved) {
      expect(turn.resolution_text).toBe('opt_a')
    }
  })

  // T9 — server-side resolution_text precompute. Button-choice rows
  // map `resolution_value → matching option.body`. Freeform rows ship
  // `resolution_freeform_text` directly. Unresolved rows ship
  // `resolved: false, resolution_text: null`.
  test('server pre-computes resolution_text (button.body | freeform | null)', async () => {
    const topic = `web:${USER_ID}`
    // 1) Button choice — should resolve to 'pretty-display'.
    const buttonPrompt = buildButtonPrompt({
      body: 'Button prompt',
      options: [
        { label: 'A', body: 'pretty-display', value: 'opt_a' },
        { label: 'B', body: 'b-display', value: 'opt_b' },
      ],
    })
    await harness.store.emit(buttonPrompt, { topic_id: topic })
    await harness.store.resolve({
      choice: {
        prompt_id: buttonPrompt.prompt_id,
        choice_value: 'opt_a',
        chosen_at: Date.now(),
        speaker_user_id: USER_ID,
        channel_kind: 'app-socket',
      },
    })
    // 2) Freeform — freeform_text wins over value lookup.
    const freeformPrompt = buildButtonPrompt({
      body: 'Freeform prompt',
      options: [{ label: 'Skip', body: 'skip', value: '__skip__' }],
      allow_freeform: true,
    })
    await harness.store.emit(freeformPrompt, { topic_id: topic })
    await harness.store.resolve({
      choice: {
        prompt_id: freeformPrompt.prompt_id,
        choice_value: '__freeform__',
        chosen_at: Date.now() + 100,
        speaker_user_id: USER_ID,
        channel_kind: 'app-socket',
        freeform_text: 'hello from a human',
      },
    })
    // 3) Unresolved — survives the ghost filter via future expires_at.
    const unresolvedPrompt = buildButtonPrompt({
      body: 'Active prompt',
      options: [{ label: 'A', body: 'a', value: 'a' }],
    })
    await harness.store.emit(unresolvedPrompt, { topic_id: topic })
    const rawDb = (harness.store as unknown as { db: ProjectDb }).db.raw()
    rawDb
      .prepare('UPDATE button_prompts SET expires_at = ? WHERE prompt_id = ?')
      .run(Date.now() + 60_000, unresolvedPrompt.prompt_id)

    const res = await fetch(`${harness.base}/api/v1/chat/history`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HistoryResponse
    expect(body.turns?.length).toBe(3)
    // Returned DESC by created_at → newest first.
    const byBody = new Map(body.turns!.map((t) => [t.body, t]))
    const buttonTurn = byBody.get('Button prompt')!
    expect(buttonTurn.resolved).toBe(true)
    if (buttonTurn.resolved) {
      expect(buttonTurn.resolution_text).toBe('pretty-display')
    }
    const freeformTurn = byBody.get('Freeform prompt')!
    expect(freeformTurn.resolved).toBe(true)
    if (freeformTurn.resolved) {
      expect(freeformTurn.resolution_text).toBe('hello from a human')
    }
    const unresolvedTurn = byBody.get('Active prompt')!
    expect(unresolvedTurn.resolved).toBe(false)
    if (!unresolvedTurn.resolved) {
      expect(unresolvedTurn.resolution_text).toBe(null)
    }
  })

  // T9b (Codex r2 P2, 2026-05-28) — synthetic resolution sentinels
  // (`__timeout__`, `__cancel__`) MUST NOT render as user replies.
  // sweepExpired() writes `__timeout__` into resolution_value when an
  // unresolved prompt's TTL elapses; the row is "resolved" in the
  // DB sense (resolved_at is set) but the user never actually
  // answered. Surfacing the sentinel as resolution_text would render
  // "You said: __timeout__" in the chat history — wrong UX.
  test('synthetic timeout/cancel sentinels surface as unresolved, not as user replies', async () => {
    const topic = `web:${USER_ID}`
    const prompt = buildButtonPrompt({
      body: 'Will the user answer?',
      options: [{ label: 'Y', body: 'yes', value: 'yes' }],
    })
    await harness.store.emit(prompt, { topic_id: topic })
    // Hand-roll a sweepExpired-style synthetic resolution: set
    // resolved_at + resolution_value='__timeout__' without
    // resolution_freeform_text.
    const rawDb = (harness.store as unknown as { db: ProjectDb }).db.raw()
    rawDb
      .prepare(
        `UPDATE button_prompts
            SET resolved_at = ?,
                resolution_value = '__timeout__',
                resolution_speaker_user_id = '__system__'
          WHERE prompt_id = ?`,
      )
      .run(Date.now(), prompt.prompt_id)
    const res = await fetch(`${harness.base}/api/v1/chat/history`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HistoryResponse
    expect(body.turns?.length).toBe(1)
    const turn = body.turns![0]!
    // The sentinel-resolution turn flips back to "unresolved" so
    // the client doesn't render "__timeout__" as a user bubble.
    expect(turn.resolved).toBe(false)
    if (!turn.resolved) {
      expect(turn.resolution_text).toBe(null)
    }
  })

  // T10 — method gate. POST returns 405 (not 200), so the handler
  // never accidentally mutates state on a GET-only endpoint.
  test('POST → 405 method_not_allowed', async () => {
    const res = await fetch(`${harness.base}/api/v1/chat/history`, { method: 'POST' })
    expect(res.status).toBe(405)
    const body = (await res.json()) as HistoryResponse
    expect(body.ok).toBe(false)
    expect(body.code).toBe('method_not_allowed')
  })

  // T11 — path fall-through. A request to a SIBLING path returns 404
  // from the defaultHandler, NOT from the chat-history surface (the
  // surface MUST return null for non-owned paths).
  test('GET /unrelated → falls through to defaultHandler', async () => {
    const res = await fetch(`${harness.base}/unrelated`)
    expect(res.status).toBe(404)
  })

  // T12 — topic isolation. A user authenticated as USER_ID must NOT
  // see rows seeded against a DIFFERENT user_id's topic, even though
  // they're in the same per-instance DB.
  test('topic_id is server-derived; other-user rows are invisible', async () => {
    const topic = `web:other-user-id`
    const prompt = buildButtonPrompt({
      body: 'Other user turn',
      options: [{ label: 'A', body: 'a', value: 'a' }],
    })
    await harness.store.emit(prompt, { topic_id: topic })
    const res = await fetch(`${harness.base}/api/v1/chat/history`)
    const body = (await res.json()) as HistoryResponse
    expect(res.status).toBe(200)
    expect(body.turns).toEqual([])
  })
})
