import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import {
  buildButtonPrompt,
  type ButtonChoice,
  type ButtonPrompt,
} from '../button-primitive.ts'
import { ButtonStore, ButtonStoreError } from '../button-store.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore
let now = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-bs-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  now = 1_000_000
  store = new ButtonStore({ db, now: () => now })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function samplePrompt(over: Partial<Parameters<typeof buildButtonPrompt>[0]> = {}): ButtonPrompt {
  return buildButtonPrompt({
    body: 'Pick A or B',
    options: [
      { label: 'A', body: 'a', value: 'a' },
      { label: 'B', body: 'b', value: 'b' },
    ],
    ...over,
  })
}

describe('ButtonStore.emit', () => {
  test('persists a new prompt and reports was_new=true', async () => {
    const prompt = samplePrompt()
    const out = await store.emit(prompt, { topic_id: 'topic-1' })
    expect(out.was_new).toBe(true)
    expect(out.prompt_id).toBe(prompt.prompt_id)
  })

  test('idempotency: same key collapses to a single row + was_new=false', async () => {
    const key = 'idemp-1'
    const a = samplePrompt({ idempotency_key: key })
    const b = samplePrompt({ idempotency_key: key })
    const out1 = await store.emit(a, { topic_id: 'topic-1' })
    const out2 = await store.emit(b, { topic_id: 'topic-1' })
    expect(out1.was_new).toBe(true)
    expect(out2.was_new).toBe(false)
    expect(out2.prompt_id).toBe(out1.prompt_id)

    const rows = db
      .prepare<{ c: number }, []>(`SELECT COUNT(*) AS c FROM button_prompts`)
      .get()
    expect(rows?.c).toBe(1)
  })

  test('different topic_id with same idempotency_key produces two rows', async () => {
    const key = 'idemp-cross'
    const a = samplePrompt({ idempotency_key: key })
    const b = samplePrompt({ idempotency_key: key })
    await store.emit(a, { topic_id: 'topic-1' })
    await store.emit(b, { topic_id: 'topic-2' })
    const rows = db
      .prepare<{ c: number }, []>(`SELECT COUNT(*) AS c FROM button_prompts`)
      .get()
    expect(rows?.c).toBe(2)
  })

  test('rejects an invalid prompt with code=invalid_prompt', async () => {
    const bad: ButtonPrompt = {
      prompt_id: 'not-a-uuid',
      body: 'b',
      options: [{ label: 'A', body: 'a', value: 'a' }],
      allow_freeform: false,
    }
    try {
      await store.emit(bad, { topic_id: 'topic-1' })
    } catch (err) {
      expect(err).toBeInstanceOf(ButtonStoreError)
      expect((err as ButtonStoreError).code).toBe('invalid_prompt')
      return
    }
    throw new Error('expected throw')
  })

  test('expires_at is created_at + expires_in_ms (default 24h)', async () => {
    const prompt = samplePrompt({ expires_in_ms: 60_000 })
    const out = await store.emit(prompt, { topic_id: 'topic-1' })
    expect(out.expires_at).toBe(1_000_000 + 60_000)
  })

  test('was_delivered is false on a fresh emit', async () => {
    const prompt = samplePrompt({ idempotency_key: 'k1' })
    const out = await store.emit(prompt, { topic_id: 'topic-1' })
    expect(out.was_delivered).toBe(false)
  })

  test('was_delivered becomes true after markDelivered + survives idempotent re-emit', async () => {
    const a = samplePrompt({ idempotency_key: 'k1' })
    const out1 = await store.emit(a, { topic_id: 'topic-1' })
    expect(out1.was_delivered).toBe(false)
    await store.markDelivered(out1.prompt_id)
    const b = samplePrompt({ idempotency_key: 'k1' })
    const out2 = await store.emit(b, { topic_id: 'topic-1' })
    expect(out2.was_new).toBe(false)
    expect(out2.was_delivered).toBe(true)
  })

  test('expired-undelivered row is replaced on re-emit, not reused (Codex r4 P2)', async () => {
    const a = samplePrompt({ idempotency_key: 'k1', expires_in_ms: 5_000 })
    const out1 = await store.emit(a, { topic_id: 'topic-1' })
    expect(out1.was_new).toBe(true)
    // Time passes well past expires_at; the prompt is stale + undelivered.
    now += 24 * 60 * 60 * 1000
    const b = samplePrompt({ idempotency_key: 'k1', expires_in_ms: 5_000 })
    const out2 = await store.emit(b, { topic_id: 'topic-1' })
    // Treated as a fresh emit — different prompt_id, was_new=true,
    // expires_at recalculated from `now`.
    expect(out2.was_new).toBe(true)
    expect(out2.prompt_id).not.toBe(out1.prompt_id)
    expect(out2.expires_at).toBe(now + 5_000)
    // Old stale row is gone; only the fresh row remains.
    const rows = db
      .prepare<{ c: number }, []>(`SELECT COUNT(*) AS c FROM button_prompts WHERE topic_id = 'topic-1'`)
      .get()
    expect(rows?.c).toBe(1)
  })

  test('expired delivered-but-unresolved row is replaced on re-emit (Codex r6 P1)', async () => {
    const a = samplePrompt({ idempotency_key: 'k1', expires_in_ms: 5_000 })
    const out1 = await store.emit(a, { topic_id: 'topic-1' })
    await store.markDelivered(out1.prompt_id, now)
    now += 24 * 60 * 60 * 1000
    const b = samplePrompt({ idempotency_key: 'k1', expires_in_ms: 5_000 })
    const out2 = await store.emit(b, { topic_id: 'topic-1' })
    // Stale-because-expired row is replaced even though it was delivered.
    expect(out2.was_new).toBe(true)
    expect(out2.prompt_id).not.toBe(out1.prompt_id)
    expect(out2.was_delivered).toBe(false)
  })

  test('expired sweep-resolved __timeout__ row is replaced on re-emit (Codex r6 P1)', async () => {
    const a = samplePrompt({ idempotency_key: 'k1', expires_in_ms: 5_000 })
    const out1 = await store.emit(a, { topic_id: 'topic-1' })
    await store.markDelivered(out1.prompt_id, now)
    now += 10_000
    await store.sweepExpired(now)
    now += 24 * 60 * 60 * 1000
    const b = samplePrompt({ idempotency_key: 'k1', expires_in_ms: 5_000 })
    const out2 = await store.emit(b, { topic_id: 'topic-1' })
    expect(out2.was_new).toBe(true)
    expect(out2.prompt_id).not.toBe(out1.prompt_id)
  })

  test('expired-but-resolved row is preserved on re-emit (audit trail)', async () => {
    const a = samplePrompt({ idempotency_key: 'k1', expires_in_ms: 5_000 })
    const out1 = await store.emit(a, { topic_id: 'topic-1' })
    await store.resolve({
      choice: {
        prompt_id: out1.prompt_id,
        choice_value: 'a',
        chosen_at: 1_001_000,
        speaker_user_id: 'u',
        channel_kind: 'telegram',
      },
    })
    now += 24 * 60 * 60 * 1000
    const b = samplePrompt({ idempotency_key: 'k1', expires_in_ms: 5_000 })
    const out2 = await store.emit(b, { topic_id: 'topic-1' })
    // Resolved expired row IS reused — the resolution is the audit
    // trail for "already answered."
    expect(out2.was_new).toBe(false)
    expect(out2.prompt_id).toBe(out1.prompt_id)
  })

  test('markDelivered is idempotent — second call leaves delivered_at unchanged', async () => {
    const prompt = samplePrompt({ idempotency_key: 'k1' })
    const out = await store.emit(prompt, { topic_id: 'topic-1' })
    now = 2_000_000
    await store.markDelivered(out.prompt_id, now)
    now = 3_000_000
    await store.markDelivered(out.prompt_id, now)
    const row = db
      .prepare<{ delivered_at: number | null }, [string]>(
        `SELECT delivered_at FROM button_prompts WHERE prompt_id = ?`,
      )
      .get(out.prompt_id)
    expect(row?.delivered_at).toBe(2_000_000)
  })
})

describe('ButtonStore.get', () => {
  test('returns the persisted prompt', async () => {
    const prompt = samplePrompt()
    await store.emit(prompt, { topic_id: 'topic-1' })
    const got = await store.get(prompt.prompt_id)
    expect(got?.body).toBe('Pick A or B')
    expect(got?.options.length).toBe(2)
  })

  test('returns null for unknown prompt_id', async () => {
    const got = await store.get('00000000-0000-0000-0000-000000000000')
    expect(got).toBeNull()
  })

  test('returns null for an unresolved expired prompt (callbacks-after-expiry path)', async () => {
    const prompt = samplePrompt({ expires_in_ms: 5_000 })
    await store.emit(prompt, { topic_id: 'topic-1' })
    now += 10_000
    const got = await store.get(prompt.prompt_id)
    expect(got).toBeNull()
  })

  test('returns null for sentinel-resolved expired prompts so late taps surface delivered:false (Codex r10 P2)', async () => {
    const prompt = samplePrompt({ expires_in_ms: 5_000 })
    await store.emit(prompt, { topic_id: 'topic-1' })
    now += 10_000
    const sweep = await store.sweepExpired(now)
    expect(sweep.resolved.length).toBe(1) // resolved as __timeout__
    // A late Telegram tap calling get() must see null — sentinel
    // resolution doesn't survive the expiry boundary.
    const got = await store.get(prompt.prompt_id, now + 1)
    expect(got).toBeNull()
  })

  test('still returns a resolved expired prompt (idempotency / audit access)', async () => {
    const prompt = samplePrompt({ expires_in_ms: 5_000 })
    await store.emit(prompt, { topic_id: 'topic-1' })
    await store.resolve({
      choice: {
        prompt_id: prompt.prompt_id,
        choice_value: 'a',
        chosen_at: 1_001_000, // observation BEFORE expires_at = 1_005_000
        speaker_user_id: 'u',
        channel_kind: 'telegram',
      },
    })
    now += 10_000
    const got = await store.get(prompt.prompt_id)
    expect(got).not.toBeNull()
  })
})

describe('ButtonStore.resolve', () => {
  function buildChoice(prompt: ButtonPrompt, value: string, freeform_text?: string): ButtonChoice {
    const choice: ButtonChoice = {
      prompt_id: prompt.prompt_id,
      choice_value: value,
      chosen_at: 2_000_000,
      speaker_user_id: 'user-1',
      channel_kind: 'telegram',
    }
    if (freeform_text !== undefined) choice.freeform_text = freeform_text
    return choice
  }

  test('records the choice and reports was_new=true', async () => {
    const prompt = samplePrompt()
    await store.emit(prompt, { topic_id: 'topic-1' })
    const out = await store.resolve({ choice: buildChoice(prompt, 'a') })
    expect(out.was_new).toBe(true)
    expect(out.choice.choice_value).toBe('a')
  })

  test('duplicate resolve returns the prior choice with was_new=false', async () => {
    const prompt = samplePrompt()
    await store.emit(prompt, { topic_id: 'topic-1' })
    await store.resolve({ choice: buildChoice(prompt, 'a') })
    const out = await store.resolve({ choice: buildChoice(prompt, 'b') })
    expect(out.was_new).toBe(false)
    expect(out.choice.choice_value).toBe('a')
  })

  test('throws prompt_not_found for unknown prompt_id', async () => {
    const ghost: ButtonChoice = {
      prompt_id: '00000000-0000-0000-0000-000000000000',
      choice_value: 'x',
      chosen_at: 1,
      speaker_user_id: 'u',
      channel_kind: 'telegram',
    }
    try {
      await store.resolve({ choice: ghost })
    } catch (err) {
      expect(err).toBeInstanceOf(ButtonStoreError)
      expect((err as ButtonStoreError).code).toBe('prompt_not_found')
      return
    }
    throw new Error('expected throw')
  })

  test('resolve checks expiry against choice.chosen_at (transactional)', async () => {
    const prompt = samplePrompt({ expires_in_ms: 5_000 })
    await store.emit(prompt, { topic_id: 'topic-1' })
    // Tap observed AFTER expires_at — resolve must reject.
    const lateChoice: ButtonChoice = {
      prompt_id: prompt.prompt_id,
      choice_value: 'a',
      chosen_at: 1_000_000 + 6_000, // expires_at = 1_000_000 + 5_000
      speaker_user_id: 'u',
      channel_kind: 'telegram',
    }
    try {
      await store.resolve({ choice: lateChoice })
    } catch (err) {
      expect(err).toBeInstanceOf(ButtonStoreError)
      expect((err as ButtonStoreError).code).toBe('expired')
      return
    }
    throw new Error('expected throw')
  })

  test('resolve accepts a tap observed before expires_at even if Date.now() crossed it', async () => {
    const prompt = samplePrompt({ expires_in_ms: 5_000 })
    await store.emit(prompt, { topic_id: 'topic-1' })
    now += 10_000 // simulate routing delay; Date.now() now past expires_at.
    const earlyChoice: ButtonChoice = {
      prompt_id: prompt.prompt_id,
      choice_value: 'a',
      chosen_at: 1_000_000 + 4_999, // observation BEFORE expires_at.
      speaker_user_id: 'u',
      channel_kind: 'telegram',
    }
    const out = await store.resolve({ choice: earlyChoice })
    expect(out.was_new).toBe(true)
    expect(out.choice.choice_value).toBe('a')
  })

  test('resolve REJECTS a tap observed at exactly expires_at (Codex r3 P3)', async () => {
    const prompt = samplePrompt({ expires_in_ms: 5_000 })
    await store.emit(prompt, { topic_id: 'topic-1' })
    const exactDeadline: ButtonChoice = {
      prompt_id: prompt.prompt_id,
      choice_value: 'a',
      chosen_at: 1_000_000 + 5_000, // exactly expires_at
      speaker_user_id: 'u',
      channel_kind: 'telegram',
    }
    try {
      await store.resolve({ choice: exactDeadline })
    } catch (err) {
      expect(err).toBeInstanceOf(ButtonStoreError)
      expect((err as ButtonStoreError).code).toBe('expired')
      return
    }
    throw new Error('expected throw')
  })

  test('persists freeform_text for resolved freeform replies', async () => {
    const prompt = samplePrompt({ allow_freeform: true })
    await store.emit(prompt, { topic_id: 'topic-1' })
    const choice = buildChoice(prompt, '__freeform__', 'My name is Alice')
    const out = await store.resolve({ choice })
    expect(out.was_new).toBe(true)
    const row = db
      .prepare<{ resolution_freeform_text: string | null }, [string]>(
        `SELECT resolution_freeform_text FROM button_prompts WHERE prompt_id = ?`,
      )
      .get(prompt.prompt_id)
    expect(row?.resolution_freeform_text).toBe('My name is Alice')
  })
})

describe('ButtonStore.sweepExpired', () => {
  test('resolves expired unresolved prompts with __timeout__', async () => {
    const prompt = samplePrompt({ expires_in_ms: 5_000 })
    await store.emit(prompt, { topic_id: 'topic-1' })
    now += 10_000
    const sweep = await store.sweepExpired(now)
    expect(sweep.resolved.length).toBe(1)
    expect(sweep.resolved[0]?.choice_value).toBe('__timeout__')
    expect(sweep.resolved[0]?.prompt_id).toBe(prompt.prompt_id)
  })

  test('idempotent: a second sweep resolves nothing', async () => {
    const prompt = samplePrompt({ expires_in_ms: 5_000 })
    await store.emit(prompt, { topic_id: 'topic-1' })
    now += 10_000
    await store.sweepExpired(now)
    const second = await store.sweepExpired(now)
    expect(second.resolved.length).toBe(0)
  })

  test('does not resolve fresh prompts', async () => {
    const prompt = samplePrompt({ expires_in_ms: 5_000 })
    await store.emit(prompt, { topic_id: 'topic-1' })
    now += 1_000
    const sweep = await store.sweepExpired(now)
    expect(sweep.resolved.length).toBe(0)
  })

  test('does not resolve already-resolved prompts', async () => {
    const prompt = samplePrompt({ expires_in_ms: 5_000 })
    await store.emit(prompt, { topic_id: 'topic-1' })
    await store.resolve({
      choice: {
        prompt_id: prompt.prompt_id,
        choice_value: 'a',
        chosen_at: 1_001_000, // observation BEFORE expires_at = 1_005_000
        speaker_user_id: 'u',
        channel_kind: 'telegram',
      },
    })
    now += 10_000
    const sweep = await store.sweepExpired(now)
    expect(sweep.resolved.length).toBe(0)
  })
})

describe('Sprint 28 — kind persistence (Codex r4 P2)', () => {
  test('persists + round-trips ButtonPrompt.kind', async () => {
    const prompt = buildButtonPrompt({
      body: "Pick your agent's portrait.",
      kind: 'image-gallery',
      options: [
        { label: 'A', body: 'Portrait 1', value: 'cand-A', image_url: '/x/a.png' },
        { label: 'B', body: 'Skip portrait', value: 'skip-portrait' },
      ],
    })
    const emit = await store.emit(prompt, { topic_id: 'topic-gallery' })
    expect(emit.was_new).toBe(true)
    expect(emit.prompt.kind).toBe('image-gallery')
    expect(emit.prompt.options[0]?.image_url).toBe('/x/a.png')
    // Round-trip via get(...) — confirms the row was persisted with kind.
    const got = await store.get(emit.prompt_id)
    expect(got?.kind).toBe('image-gallery')
    expect(got?.options[0]?.image_url).toBe('/x/a.png')
  })

  test('legacy prompts (no kind) round-trip with kind=undefined', async () => {
    const prompt = samplePrompt()
    const emit = await store.emit(prompt, { topic_id: 'topic-legacy' })
    const got = await store.get(emit.prompt_id)
    expect(got?.kind).toBeUndefined()
  })
})

describe('ButtonStore.persistInertUserTurn (Connect tag_gated quiet messages)', () => {
  test('persists a standalone resolved USER turn (empty body, freeform text)', async () => {
    const topic = 'web:u-1:projx'
    await store.persistInertUserTurn({
      topic_id: topic,
      text: 'a quiet message',
      speaker_user_id: 'u-1',
      channel_kind: 'app_socket',
    })
    const { turns } = await store.listHistoryByTopic({
      topic_id: topic,
      before: now + 1,
      before_prompt_id: null,
      limit: 10,
      now,
    })
    expect(turns).toHaveLength(1)
    expect(turns[0]!.resolved).toBe(true)
    // The agent body is empty; the user's text rides resolution_text.
    expect(turns[0]!.body).toBe('')
    expect(turns[0]!.resolution_text).toBe('a quiet message')
  })

  test('consecutive inert user turns each persist (no dropped message)', async () => {
    const topic = 'web:u-1:projx'
    for (const text of ['one', 'two', 'three']) {
      now += 10
      await store.persistInertUserTurn({
        topic_id: topic,
        text,
        speaker_user_id: 'u-1',
        channel_kind: 'app_socket',
      })
    }
    const { turns } = await store.listHistoryByTopic({
      topic_id: topic,
      before: now + 1,
      before_prompt_id: null,
      limit: 10,
      now,
    })
    expect(turns.map((t) => t.resolution_text)).toEqual(['three', 'two', 'one'])
  })

  test('sidebar preview falls back to freeform text for an inert user turn', async () => {
    const topic = 'web:u-1:projx'
    await store.persistInertUserTurn({
      topic_id: topic,
      text: 'latest quiet line',
      speaker_user_id: 'u-1',
      channel_kind: 'app_socket',
    })
    const rows = await store.listTopicsByUser({ user_id_prefix: 'web:u-1', now })
    const row = rows.find((r) => r.topic_id === topic)
    expect(row).toBeDefined()
    // Without the COALESCE this would be '' (the empty agent body).
    expect(row!.last_body).toBe('latest quiet line')
  })

  test('rejects empty text / topic', async () => {
    await expect(
      store.persistInertUserTurn({ topic_id: '', text: 'x', speaker_user_id: 'u', channel_kind: 'app_socket' }),
    ).rejects.toThrow(ButtonStoreError)
    await expect(
      store.persistInertUserTurn({ topic_id: 't', text: '', speaker_user_id: 'u', channel_kind: 'app_socket' }),
    ).rejects.toThrow(ButtonStoreError)
  })
})

describe('ButtonStore.latestTurnByTopic — insertion-order recency (same-ms tiebreak)', () => {
  test('two rows minted in the SAME ms resolve to the LAST-inserted row (rowid), not a random prompt_id', async () => {
    // The reflection-layer bug: an inert user-turn row and the agent-reply row can
    // share a `created_at` ms; listHistoryByTopic's `prompt_id DESC` (random UUID)
    // tiebreak would non-deterministically pick either. latestTurnByTopic must
    // ALWAYS return the one inserted last. Run enough rounds that a UUID-ordered
    // implementation would flake.
    for (let i = 0; i < 20; i++) {
      rmSync(tmp, { recursive: true, force: true })
      tmp = mkdtempSync(join(tmpdir(), 'neutron-bs-recency-'))
      db.close()
      db = ProjectDb.open(join(tmp, 'project.db'))
      applyMigrations(db.raw())
      now = 1_000_000
      store = new ButtonStore({ db, now: () => now })

      // Both emitted at the SAME `now` → tied created_at. `second` is inserted last.
      await store.emit(samplePrompt({ body: 'first' }), { topic_id: 'topic-1' })
      const last = await store.emit(samplePrompt({ body: 'second' }), { topic_id: 'topic-1' })

      const latest = await store.latestTurnByTopic({ topic_id: 'topic-1', before: now, now })
      expect(latest).not.toBeNull()
      expect(latest!.body).toBe('second')
      expect(latest!.prompt_id).toBe(last.prompt_id)
    }
  })

  test('returns null for a topic with no rows', async () => {
    const latest = await store.latestTurnByTopic({ topic_id: 'empty-topic', before: now, now })
    expect(latest).toBeNull()
  })

  test('excludes expired unresolved ghost rows (same filter as listHistoryByTopic)', async () => {
    await store.emit(samplePrompt({ body: 'ghost', expires_in_ms: 10 }), { topic_id: 'topic-1' })
    const after = now + 1000 // past the 10ms TTL
    const latest = await store.latestTurnByTopic({ topic_id: 'topic-1', before: after, now: after })
    expect(latest).toBeNull()
  })
})
