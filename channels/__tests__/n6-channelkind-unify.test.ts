/**
 * N6 (`[BEHAVIOR]` ChannelKind persisted-value unification) — acceptance suite
 * for the app-socket vocabulary collapse + dual-read window.
 *
 * Two vocabularies once spelled the same channel: the base `ChannelKind`
 * (`'app_socket'`, underscore, persisted in `topics.channel_kind`) and the
 * button `ChannelKindForButton` (`'app-socket'`, hyphen, persisted in
 * `button_prompts.resolution_channel_kind`). N6 makes `'app_socket'` the ONE
 * canonical token, migrates the persisted button rows (migration 0104), and
 * keeps a dual-read window so a row written just before the migration — or a
 * legacy token arriving off the wire — still routes correctly.
 *
 * Coverage:
 *   (a) dual-read: a pre-migration row persisted with the legacy hyphen still
 *       replays with the canonical token through `ButtonStore.resolve`.
 *   (c) new writes persist + read back the canonical `'app_socket'`.
 *   (d) `'webhook'` is retained (a live synthetic marker), not dropped; unknown
 *       tokens normalize to null.
 * Migration normalization + idempotency (b) live in
 * migrations/__tests__/0104-button-prompts-channel-kind-unify.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  LEGACY_APP_SOCKET_CHANNEL_KIND,
  normalizeChannelKindForButton,
  type ButtonChoice,
} from '../button-primitive.ts'
import { ButtonStore } from '../button-store.ts'
import { DefaultButtonRouter } from '../button-routing.ts'

describe('normalizeChannelKindForButton (dual-read)', () => {
  test('maps the legacy hyphen onto the canonical underscore token', () => {
    expect(normalizeChannelKindForButton('app-socket')).toBe('app_socket')
    // The exported legacy constant IS the hyphen form.
    expect(LEGACY_APP_SOCKET_CHANNEL_KIND).toBe('app-socket')
    expect(normalizeChannelKindForButton(LEGACY_APP_SOCKET_CHANNEL_KIND)).toBe('app_socket')
  })

  test('passes the canonical tokens through unchanged', () => {
    expect(normalizeChannelKindForButton('app_socket')).toBe('app_socket')
    expect(normalizeChannelKindForButton('telegram')).toBe('telegram')
    // 'webhook' is a LIVE synthetic marker (sweepExpired / persistInertAgentTurn),
    // retained — not an adapterless member to be dropped.
    expect(normalizeChannelKindForButton('webhook')).toBe('webhook')
  })

  test('absent / unrecognized tokens normalize to null', () => {
    expect(normalizeChannelKindForButton(null)).toBeNull()
    expect(normalizeChannelKindForButton(undefined)).toBeNull()
    expect(normalizeChannelKindForButton('cli')).toBeNull() // buttons never carry 'cli'
    expect(normalizeChannelKindForButton('slack')).toBeNull()
    expect(normalizeChannelKindForButton('')).toBeNull()
  })
})

describe('ButtonStore channel_kind persistence', () => {
  let tmp: string
  let db: ProjectDb
  let store: ButtonStore
  const now = 5_000_000

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-n6-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    store = new ButtonStore({ db, now: () => now })
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('(a) dual-read: a legacy hyphen row replays with the canonical token', async () => {
    // Simulate a row persisted by a pre-N6 process (or an in-flight row written
    // just before migration 0104 ran): resolution_channel_kind = 'app-socket'.
    await db.run(
      `INSERT INTO button_prompts
         (prompt_id, topic_id, body, options_json, allow_freeform,
          expires_at, idempotency_key, created_at, delivered_at,
          resolved_at, resolution_value, resolution_speaker_user_id,
          resolution_channel_kind, kind)
       VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, 'a', 'user-1', 'app-socket', NULL)`,
      [
        'legacy-prompt',
        'topic-legacy',
        'Pick A or B',
        JSON.stringify([{ label: 'A', body: 'a', value: 'a' }]),
        now + 60_000,
        now,
        now,
        now,
      ],
    )
    // A duplicate channel callback replays the PRIOR choice (was_new=false).
    // The prior choice's channel_kind is read out of the legacy column and MUST
    // route as the canonical 'app_socket', not the hyphen.
    const replay: ButtonChoice = {
      prompt_id: 'legacy-prompt',
      choice_value: 'a',
      chosen_at: now + 1,
      speaker_user_id: 'user-1',
      channel_kind: 'app_socket',
    }
    const res = await store.resolve({ choice: replay })
    expect(res.was_new).toBe(false)
    expect(res.choice.channel_kind).toBe('app_socket')
  })

  test('(c) a fresh resolve persists + reads back the canonical token', async () => {
    const prompt = { prompt_id: crypto.randomUUID(), body: 'q', options: [{ label: 'A', body: 'a', value: 'a' }], allow_freeform: false }
    await store.emit(prompt, { topic_id: 'topic-fresh' })
    const choice: ButtonChoice = {
      prompt_id: prompt.prompt_id,
      choice_value: 'a',
      chosen_at: now + 1,
      speaker_user_id: 'user-2',
      channel_kind: 'app_socket',
    }
    const first = await store.resolve({ choice })
    expect(first.was_new).toBe(true)

    // Persisted column carries the canonical underscore token.
    const row = db
      .prepare<{ resolution_channel_kind: string | null }, [string]>(
        `SELECT resolution_channel_kind FROM button_prompts WHERE prompt_id = ?`,
      )
      .get(prompt.prompt_id)
    expect(row?.resolution_channel_kind).toBe('app_socket')

    // And a replay reads it back canonically.
    const replay = await store.resolve({ choice: { ...choice, chosen_at: now + 2 } })
    expect(replay.was_new).toBe(false)
    expect(replay.choice.channel_kind).toBe('app_socket')
  })

  test('(a-wire) a legacy hyphen token off the wire routes + persists canonically', async () => {
    const router = new DefaultButtonRouter({ store, now: () => now })
    const prompt = { prompt_id: crypto.randomUUID(), body: 'q', options: [{ label: 'A', body: 'a', value: 'a' }], allow_freeform: false }
    await store.emit(prompt, { topic_id: 'topic-wire' })

    // A runtime/legacy caller hands the pre-unification hyphen token (the type
    // excludes it, so cast to model the wire/runtime value the contract must
    // still tolerate).
    const result = await router.routeChoice({
      prompt_id: prompt.prompt_id,
      raw_value: 'a',
      speaker_user_id: 'user-3',
      channel_kind: 'app-socket' as unknown as 'app_socket',
      chosen_at: now + 1,
    })

    // Returned choice is canonical...
    expect(result.delivered).toBe(true)
    expect(result.choice.channel_kind).toBe('app_socket')

    // ...and so is the persisted column.
    const row = db
      .prepare<{ resolution_channel_kind: string | null }, [string]>(
        `SELECT resolution_channel_kind FROM button_prompts WHERE prompt_id = ?`,
      )
      .get(prompt.prompt_id)
    expect(row?.resolution_channel_kind).toBe('app_socket')
  })

  test('(d-reject) an unknown runtime token is rejected at ingress + never persisted', async () => {
    const router = new DefaultButtonRouter({ store, now: () => now })
    const prompt = { prompt_id: crypto.randomUUID(), body: 'q', options: [{ label: 'A', body: 'a', value: 'a' }], allow_freeform: true }
    await store.emit(prompt, { topic_id: 'topic-bad' })

    const result = await router.routeChoice({
      prompt_id: prompt.prompt_id,
      raw_value: 'a',
      speaker_user_id: 'user-4',
      channel_kind: 'slack' as unknown as 'app_socket', // unsupported token
      chosen_at: now + 1,
    })

    // Rejected at the trust boundary — the prompt is NOT resolved and the
    // corrupt token never reaches resolution_channel_kind.
    expect(result.delivered).toBe(false)
    const row = db
      .prepare<{ resolved_at: number | null; resolution_channel_kind: string | null }, [string]>(
        `SELECT resolved_at, resolution_channel_kind FROM button_prompts WHERE prompt_id = ?`,
      )
      .get(prompt.prompt_id)
    expect(row?.resolved_at).toBeNull()
    expect(row?.resolution_channel_kind).toBeNull()
  })

  test('(d-provenance) an unknown persisted token replays VERBATIM, not swapped to the caller', async () => {
    // A row persisted with a channel token this build does not recognize must
    // keep its own provenance on replay — never silently rewritten to the
    // duplicate caller's channel.
    await db.run(
      `INSERT INTO button_prompts
         (prompt_id, topic_id, body, options_json, allow_freeform,
          expires_at, idempotency_key, created_at, delivered_at,
          resolved_at, resolution_value, resolution_speaker_user_id,
          resolution_channel_kind, kind)
       VALUES (?, ?, 'b', '[]', 0, ?, NULL, ?, ?, ?, 'a', 'user-5', 'slack', NULL)`,
      ['prov-prompt', 'topic-prov', now + 60_000, now, now, now],
    )
    const replay = await store.resolve({
      choice: {
        prompt_id: 'prov-prompt',
        choice_value: 'a',
        chosen_at: now + 1,
        speaker_user_id: 'user-6',
        channel_kind: 'telegram', // a DIFFERENT channel — must NOT overwrite provenance
      },
    })
    expect(replay.was_new).toBe(false)
    expect(replay.choice.channel_kind as string).toBe('slack')
  })
})
