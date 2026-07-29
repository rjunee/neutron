/**
 * G2 — Hydration-parity characterization (three-transcript fidelity matrix).
 *
 * ONE canonical agent turn (carrying `options`, `prompt_id`, `citations`,
 * and `doc_refs`) is driven through the THREE real delivery paths a client
 * can receive a message on, and we record a field-by-field PRESENT/DROPPED
 * matrix:
 *
 *   (a) HTTP history      — `button_prompts` via
 *                           `gateway/http/chat-history-surface.ts`
 *                           (`ButtonStore.listHistoryByTopic` →
 *                            `ChatHistoryTurn`), served over a real
 *                           `Bun.serve` + `composeHttpHandler`.
 *   (b) WS resume replay  — `app_chat_messages` via
 *                           `channels/adapters/app-ws/adapter.ts`
 *                           (`AppWsAdapter.replayAfter` →
 *                            `appChatRowToEnvelope`).
 *   (c) live push         — the same `AppWsAdapter.send()` fan-out
 *                           envelope (`outgoingToEnvelope`), captured off
 *                           the real session registry.
 *
 * NO-MOCK-PAST-THE-SEAM (§2.8): every surface is the REAL producer over a
 * REAL SQLite `ProjectDb` (canonical migration chain). The button-prompt
 * store, the app-chat message log, the app-ws adapter, and the history
 * surface are all instantiated and driven for real — the only fake is the
 * WS transport sink (the registry `send` callback that captures the wire
 * envelope) and the cookie-claim resolver stub, both of which sit at the
 * legitimate socket/auth seam. A real regression in ANY of the three
 * producers (a dropped field, a new field, a shape change) fails this test.
 *
 * PINNED KNOWN-DIVERGENCE SNAPSHOT — this test asserts today's divergence
 * AS divergent so it is GREEN today. It is the contract W3 (transcript
 * unification) later flips to full parity: W3/W3a may ONLY change the
 * `DROPPED` entries below to `PRESENT` (and update the matching divergence
 * comments) — it must not need to touch the harness. See
 * `docs/plans/2026-07-02-world-class-refactor-plan.md` §G2 / §W3a / §W3.
 *
 * ── W3a UPDATE (2026-07): the resume-fidelity stage-0 fix landed. The WS
 * resume path (b) now round-trips ALL FOUR structured fields through the
 * `app_chat_messages.meta_json` column (`AppWsAdapter.send` stamps it,
 * `appChatRowToEnvelope` re-applies it), so its column below flipped from
 * DROPPED to PRESENT. The HTTP-history path (a) still diverges — that column
 * is W3's (full transcript unification) to flip.
 *
 * ── WHY EACH FIELD DROPS / SURVIVES (re-derived against HEAD) ──
 *
 *  Path (a) HTTP history — the wire shape `ChatHistoryTurn`
 *    (`channels/button-store.ts` → `type ChatHistoryTurn`) carries ONLY
 *    `{ prompt_id, body, created_at, resolved, resolution_text }`.
 *      • prompt_id → PRESENT (it is a `button_prompts` column + a wire field).
 *      • options   → DROPPED: `options_json` is parsed server-side ONLY to
 *                    compute `resolution_text` (`rowToHistoryTurn`); the
 *                    option list itself is never shipped.
 *      • citations → DROPPED: `button_prompts` / `ButtonPrompt` have no
 *                    citations column or field — structurally unstorable.
 *      • doc_refs  → DROPPED: same — no doc_refs column/field on the prompt.
 *
 *  Path (b) WS resume replay — `appChatRowToEnvelope` reconstructs the agent
 *    envelope from an `AppChatRow` (`persistence/app-chat-store.ts`). W3a added
 *    the nullable `meta_json` slot: `send()` stamps the agent message's
 *    structured fields (options/prompt_id/citations/doc_refs + kind/image_urls/
 *    allow_freeform/upload_affordance) at persist time, and the replay
 *    re-applies them → ALL FOUR PRESENT. This is the SAME row the live
 *    `send()` in path (c) persisted, so the round-trip is proven at the real
 *    persistence seam, not by a mock.
 *
 *  Path (c) live push — `outgoingToEnvelope` maps ALL FOUR from
 *    `OutgoingMessage.inline_choices` + `adapter_options` → full fidelity.
 *    After W3a the WS resume path (b) matches it; only the HTTP-history path
 *    (a) still diverges, which is exactly what the remaining W3 work unifies.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ButtonStore, type ChatHistoryTurn } from '@neutronai/channels/button-store.ts'
import { buildButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { AppWsAdapter } from '@neutronai/channels/adapters/app-ws/adapter.ts'
import { InMemoryAppWsSessionRegistry } from '@neutronai/channels/adapters/app-ws/session-registry.ts'
import type {
  AppWsOutbound,
  AppWsOutboundAgentMessage,
} from '@neutronai/channels/adapters/app-ws/envelope.ts'
import type { OutgoingMessage, Topic } from '@neutronai/channels/types.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { AppChatStore, ProjectDb } from '@neutronai/persistence/index.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { webTopicId } from '../http/web-topic-id.ts'
import {
  createChatHistorySurface,
  type UserClaim,
} from '../http/chat-history-surface.ts'

const USER_ID = 'user-parity'
const PROJECT_SLUG = 'demo'
const PROJECT_ID = 'proj-1'
// Canonical UUID — the button-prompt primitive validates `prompt_id` as a
// 36-char UUID, so the pinned id is a fixed valid UUID for exact matrix cells.
const PINNED_PROMPT_ID = '00000000-0000-4000-8000-000000000abc'

// The ONE canonical agent turn, defined once and fed to every surface in
// its production-shaped input form. Each path reads a different store /
// transport, but they all represent the same logical agent reply.
const TURN_BODY = 'Here are your options.'
const TURN_OPTIONS = [
  { label: 'Yes', body: 'Yes', value: 'yes' },
  { label: 'No', body: 'No', value: 'no' },
] as const
const TURN_CITATIONS = [{ title: 'Docs', url: 'https://example.test/doc' }] as const
const TURN_DOC_REFS = [
  { label: 'Plan', path: 'docs/plans/plan.md', project_id: PROJECT_ID },
] as const

// The web-side (HTTP history) topic and the app-ws topic are different
// topic strings for the same logical user conversation — the point of the
// matrix is the same agent-turn CONTENT flowing through each transport,
// not a shared topic key.
const WEB_TOPIC = webTopicId(USER_ID) // `web:user-parity`
const APP_TOPIC = `app:${USER_ID}`
const appTopic: Topic = {
  topic_id: 'topic-parity',
  channel_kind: 'app_socket',
  channel_topic_id: APP_TOPIC,
  project_id: PROJECT_ID,
  privacy_mode: 'regular',
}

type FieldState = 'PRESENT' | 'DROPPED'
type Field = 'options' | 'prompt_id' | 'citations' | 'doc_refs'
type PathKey = 'httpHistory' | 'wsResume' | 'livePush'
type Matrix = Record<Field, Record<PathKey, FieldState>>

/**
 * A field is PRESENT iff it is a defined key AND (for arrays) non-empty.
 * This is deliberately shape-agnostic so W3 can flip a DROPPED→PRESENT by
 * making the producer emit the field, without editing this predicate.
 */
function state(obj: Record<string, unknown>, key: string): FieldState {
  const v = obj[key]
  if (v === undefined || v === null) return 'DROPPED'
  if (Array.isArray(v) && v.length === 0) return 'DROPPED'
  return 'PRESENT'
}

interface Harness {
  db: ProjectDb
  store: ButtonStore
  adapter: AppWsAdapter
  captured: AppWsOutbound[]
  server: import('bun').Server<unknown>
  base: string
  tmp: string
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-hydration-parity-'))
  // ONE real database, one canonical migration chain — the button-prompt
  // store, the app-chat log, and the served history surface all read from
  // it, so this is genuinely one conversation over three read paths.
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  const store = new ButtonStore({ db })

  // Real app-ws adapter over a real durable message log; the registry
  // callback captures the live wire envelope (the WS transport seam).
  const registry = new InMemoryAppWsSessionRegistry()
  const captured: AppWsOutbound[] = []
  registry.register(APP_TOPIC, (e) => captured.push(e))
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async () => {} },
    now: () => 1_700_000_000_000,
    generate_message_id: () => 'agent-msg-1',
    chat_log: new AppChatStore({ db }),
  })

  // Real chat-history HTTP surface, served over a real Bun.serve so the
  // full request→response path (cookie stub aside) executes.
  const claim: UserClaim = { project_slug: PROJECT_SLUG, user_id: USER_ID }
  const surface = createChatHistorySurface({
    store,
    resolveUserClaim: async () => claim,
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
    db,
    store,
    adapter,
    captured,
    server,
    base: `http://127.0.0.1:${server.port}`,
    tmp,
    close: async () => {
      await server.stop(true)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

describe('G2 — hydration-parity characterization (3-transcript fidelity matrix)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  test('records the pinned field-by-field fidelity matrix across all three real paths', async () => {
    // ── Drive path (c) live push + (b) WS resume ────────────────────────
    // A single agent turn carrying all four structured fields. `send()`
    // both fans out the live envelope (captured) AND persists the durable
    // row that the resume replay in (b) reconstructs from.
    const outgoing: OutgoingMessage = {
      topic: appTopic,
      text: TURN_BODY,
      inline_choices: TURN_OPTIONS.map((o) => ({
        label: o.body,
        callback_data: o.value,
      })),
      adapter_options: {
        prompt_id: PINNED_PROMPT_ID,
        kind: 'buttons',
        citations: TURN_CITATIONS.map((c) => ({ ...c })),
        doc_refs: TURN_DOC_REFS.map((d) => ({ ...d })),
        project_id: PROJECT_ID,
      },
    }
    await h.adapter.send(outgoing)

    const livePush = h.captured.at(-1) as AppWsOutboundAgentMessage
    expect(livePush?.type).toBe('agent_message')

    const replayed = await h.adapter.replayAfter(APP_TOPIC, 0)
    expect(replayed.length).toBe(1)
    const wsResume = replayed[0] as AppWsOutboundAgentMessage
    expect(wsResume?.type).toBe('agent_message')

    // ── Drive path (a) HTTP history ─────────────────────────────────────
    // The same agent turn as a persisted button-prompt (pinned prompt_id so
    // the matrix cell is exact). citations/doc_refs cannot even be expressed
    // as inputs to a button-prompt — there is no slot — which is itself the
    // structural reason they are DROPPED on this path.
    const prompt = buildButtonPrompt({
      body: TURN_BODY,
      options: TURN_OPTIONS.map((o) => ({ ...o })),
      uuid: () => PINNED_PROMPT_ID,
    })
    await h.store.emit(prompt, { topic_id: WEB_TOPIC })

    const res = await fetch(`${h.base}/api/v1/chat/history`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; turns: ChatHistoryTurn[] }
    expect(body.ok).toBe(true)
    const turn = body.turns.find((t) => t.prompt_id === PINNED_PROMPT_ID)
    expect(turn).toBeDefined()
    const httpTurn = turn as unknown as Record<string, unknown>

    // ── Compute the ACTUAL matrix from the three real driven surfaces ────
    const fields: Field[] = ['options', 'prompt_id', 'citations', 'doc_refs']
    const actual = {} as Matrix
    for (const f of fields) {
      actual[f] = {
        httpHistory: state(httpTurn, f),
        wsResume: state(wsResume as unknown as Record<string, unknown>, f),
        livePush: state(livePush as unknown as Record<string, unknown>, f),
      }
    }

    // Legible printout of the pinned matrix (survives in CI logs).
    // eslint-disable-next-line no-console
    console.log(
      '\nG2 hydration-parity matrix (PRESENT/DROPPED):\n' +
        `  field      | httpHistory | wsResume | livePush\n` +
        fields
          .map(
            (f) =>
              `  ${f.padEnd(10)} | ${actual[f].httpHistory.padEnd(11)} | ${actual[f].wsResume.padEnd(
                8,
              )} | ${actual[f].livePush}`,
          )
          .join('\n') +
        '\n',
    )

    // ── PINNED DIVERGENCE SNAPSHOT (post-W3a) ───────────────────────────
    // W3a flipped the `wsResume` column to PRESENT (durable meta_json
    // round-trip). W3 flips the remaining `httpHistory` DROPPED cells to
    // PRESENT. It should need to change ONLY this literal (and the mirrored
    // per-field asserts below).
    const PINNED: Matrix = {
      // options: live push + WS resume (via meta_json) carry the button list;
      // HTTP history keeps resolution_text only, so it still drops the list.
      options: { httpHistory: 'DROPPED', wsResume: 'PRESENT', livePush: 'PRESENT' },
      // prompt_id: survives on HTTP history (a button_prompts column) AND on
      // resume (W3a persists it in meta_json).
      prompt_id: { httpHistory: 'PRESENT', wsResume: 'PRESENT', livePush: 'PRESENT' },
      // citations: resume round-trips them (meta_json); HTTP history has no
      // column/field so it remains unstorable there.
      citations: { httpHistory: 'DROPPED', wsResume: 'PRESENT', livePush: 'PRESENT' },
      // doc_refs: same — round-trips on resume, unstorable on HTTP history.
      doc_refs: { httpHistory: 'DROPPED', wsResume: 'PRESENT', livePush: 'PRESENT' },
    }
    expect(actual).toEqual(PINNED)

    // ── Mirrored per-field asserts ──────────────────────────────────────
    // Live push is the full-fidelity reference on every field.
    expect(actual.options.livePush).toBe('PRESENT')
    expect(actual.prompt_id.livePush).toBe('PRESENT')
    expect(actual.citations.livePush).toBe('PRESENT')
    expect(actual.doc_refs.livePush).toBe('PRESENT')

    // PARITY (W3a): the WS resume path now matches live push on all four.
    expect(actual.options.wsResume).toBe('PRESENT')
    expect(actual.prompt_id.wsResume).toBe('PRESENT')
    expect(actual.citations.wsResume).toBe('PRESENT')
    expect(actual.doc_refs.wsResume).toBe('PRESENT')

    // DIVERGENT (W3 → PRESENT): HTTP history still strips options/citations/
    // doc_refs; prompt_id survives there as a real column.
    expect(actual.options.httpHistory).toBe('DROPPED')
    expect(actual.prompt_id.httpHistory).toBe('PRESENT')
    expect(actual.citations.httpHistory).toBe('DROPPED')
    expect(actual.doc_refs.httpHistory).toBe('DROPPED')

    // ── Concrete evidence the live push really carried the fields (proves
    //    the DROPPED cells are a real per-path strip, not an empty turn) ──
    expect(livePush.options?.map((o) => o.value)).toEqual(['yes', 'no'])
    expect(livePush.prompt_id).toBe(PINNED_PROMPT_ID)
    expect(livePush.citations?.[0]?.url).toBe(TURN_CITATIONS[0].url)
    expect(livePush.doc_refs?.[0]?.path).toBe(TURN_DOC_REFS[0].path)
    // And the resume envelope is the SAME logical message AND — post-W3a —
    // carries the SAME structured fields the live push did (round-tripped
    // through the durable meta_json column, not re-derived).
    expect(wsResume.body).toBe(TURN_BODY)
    expect(wsResume.options?.map((o) => o.value)).toEqual(['yes', 'no'])
    expect(wsResume.prompt_id).toBe(PINNED_PROMPT_ID)
    expect(wsResume.kind).toBe('buttons')
    expect(wsResume.citations?.[0]?.url).toBe(TURN_CITATIONS[0].url)
    expect(wsResume.doc_refs?.[0]?.path).toBe(TURN_DOC_REFS[0].path)
    // And the HTTP-history turn is the SAME turn (same body + prompt_id).
    expect(httpTurn['body']).toBe(TURN_BODY)
    expect(httpTurn['prompt_id']).toBe(PINNED_PROMPT_ID)
  })
})
