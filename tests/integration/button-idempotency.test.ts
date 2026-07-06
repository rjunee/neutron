/**
 * Integration test for the button-primitive idempotency contract.
 *
 * Per docs/plans/P2-onboarding.md § 6a:
 *
 *   Given: an interview-engine that emits a button prompt twice with the
 *     same `idempotency_key` (e.g. retry on transient error).
 *   When:  both emits run sequentially.
 *   Then:  the second emit returns the same `prompt_id` as the first; only
 *     one Telegram `sendMessage` call is made; the agent's audit log
 *     shows one `button_emitted` event, not two.
 *   Mocks: Telegram client (asserts call count=1); ButtonStore real over
 *     an in-memory SQLite.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  buildButtonPrompt,
  canonicalPromptSeed,
  deriveIdempotencyKey,
  type ButtonPrompt,
} from '@neutronai/channels/button-primitive.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import { renderButtonPromptTelegram } from '@neutronai/channels/adapters/telegram/render-button-prompt.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore
let transcript: TranscriptWriter
let sendCount: number

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-int-idem-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new ButtonStore({ db })
  transcript = new TranscriptWriter({ path: join(tmp, 'persona', 'onboarding-transcript.jsonl') })
  sendCount = 0
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('button idempotency — repeat emit collapses to one render', () => {
  test('repeat emit under same idempotency_key sends Telegram once + writes one transcript line', async () => {
    // Re-anchored (K11a6-rem): the pinned behavior is RETAINED
    // ButtonStore idempotency. The engine's `start()` used to do
    // "emit → if was_new: render+send+transcript.append"; K11b1 deletes
    // that conversational-drive wrapper, so we drive ButtonStore.emit
    // directly with the SAME emit-guarded side-effects. A repeat emit
    // under the same idempotency_key returns was_new=false + the ORIGINAL
    // prompt_id, so the caller renders/sends + appends the agent
    // transcript line at most once.
    const seed = canonicalPromptSeed({
      body: "What's your name?",
      options: [{ value: 'use-telegram-name' }],
    })
    const idempotency_key = deriveIdempotencyKey({
      project_slug: 't1',
      topic_id: 'topic-1',
      seed,
    })
    const build = (): ButtonPrompt =>
      buildButtonPrompt({
        body: "What's your name?",
        options: [{ label: 'A', body: 'Use my Telegram display name', value: 'use-telegram-name' }],
        idempotency_key,
      })
    // Mirror the retained emit-guarded delivery: render/send + transcript
    // append ONLY on the first (was_new) emit.
    const emitOnce = async (): Promise<{ prompt_id: string; was_new: boolean }> => {
      const prompt = build()
      const out = await store.emit(prompt, { topic_id: 'topic-1' })
      if (out.was_new) {
        renderButtonPromptTelegram(prompt)
        sendCount++
        transcript.append({ role: 'agent', body: prompt.body })
      }
      return out
    }

    const a = await emitOnce()
    const b = await emitOnce()

    expect(a.was_new).toBe(true)
    expect(b.was_new).toBe(false)
    expect(b.prompt_id).toBe(a.prompt_id)

    // At-most-one render per idempotency key: the second emit
    // short-circuits on was_new=false before the send.
    expect(sendCount).toBe(1)

    const rows = db
      .prepare<{ c: number }, []>(`SELECT COUNT(*) AS c FROM button_prompts`)
      .get()
    expect(rows?.c).toBe(1)

    const transcriptRows = transcript.readAll()
    // One agent line — NOT two. The skeleton dedupes transcript writes
    // on `was_new`, matching the channel-side dedup.
    const agentLines = transcriptRows.filter((e) => e.role === 'agent')
    expect(agentLines.length).toBe(1)
  })

  test('explicit caller-provided idempotency_key dedupes outside the engine', async () => {
    // Direct ButtonStore-only test — the engine builds its own key via
    // deriveIdempotencyKey; this test exercises a caller that supplies
    // one explicitly (e.g., debug-mode compaction prompt — § 2.1 idea
    // #11 first downstream consumer).
    const seed = canonicalPromptSeed({
      body: 'Compact?',
      options: [{ value: 'yes' }, { value: 'no' }],
    })
    const idempotency_key = deriveIdempotencyKey({
      project_slug: 't1',
      topic_id: 'topic-2',
      seed,
    })
    const a = buildButtonPrompt({
      body: 'Compact?',
      options: [
        { label: 'A', body: 'yes', value: 'yes' },
        { label: 'B', body: 'no', value: 'no' },
      ],
      idempotency_key,
    })
    const b = buildButtonPrompt({
      body: 'Compact?',
      options: [
        { label: 'A', body: 'yes', value: 'yes' },
        { label: 'B', body: 'no', value: 'no' },
      ],
      idempotency_key,
    })
    // a.prompt_id !== b.prompt_id (fresh UUIDs) but emit collapses
    expect(a.prompt_id).not.toBe(b.prompt_id)

    const out1 = await store.emit(a, { topic_id: 'topic-2' })
    const out2 = await store.emit(b, { topic_id: 'topic-2' })

    expect(out1.was_new).toBe(true)
    expect(out2.was_new).toBe(false)
    expect(out2.prompt_id).toBe(a.prompt_id) // collapsed onto the first

    // Single row in the DB
    const rows = db
      .prepare<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM button_prompts WHERE topic_id = ?`)
      .all('topic-2')
    expect(rows[0]?.c).toBe(1)
  })

  test('two prompts with different idempotency_keys produce two rows', async () => {
    const a: ButtonPrompt = buildButtonPrompt({
      body: 'Q1',
      options: [{ label: 'A', body: 'a', value: 'a' }],
      idempotency_key: 'k1',
    })
    const b: ButtonPrompt = buildButtonPrompt({
      body: 'Q2',
      options: [{ label: 'A', body: 'a', value: 'a' }],
      idempotency_key: 'k2',
    })
    await store.emit(a, { topic_id: 'topic-1' })
    await store.emit(b, { topic_id: 'topic-1' })
    const rows = db
      .prepare<{ c: number }, []>(`SELECT COUNT(*) AS c FROM button_prompts`)
      .get()
    expect(rows?.c).toBe(2)
  })
})
