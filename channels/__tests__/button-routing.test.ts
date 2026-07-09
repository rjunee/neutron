import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  buildButtonPrompt,
  encodePromptIdWire,
  ROUTING_PREFIX,
  type ButtonPrompt,
} from '../button-primitive.ts'
import { DefaultButtonRouter, parseTelegramCallbackData } from '../button-routing.ts'
import { ButtonStore } from '../button-store.ts'

const SAMPLE_UUID = '0123abcd-4567-89ef-0123-456789abcdef'

describe('parseTelegramCallbackData', () => {
  test('parses well-formed btn:<wire>:<value>', () => {
    const wire = encodePromptIdWire(SAMPLE_UUID)
    const data = `${ROUTING_PREFIX}${wire}:opt-A`
    const parsed = parseTelegramCallbackData(data)
    expect(parsed?.prompt_id).toBe(SAMPLE_UUID)
    expect(parsed?.value).toBe('opt-A')
  })

  test('returns null when prefix is missing', () => {
    expect(parseTelegramCallbackData('xxx:foo')).toBeNull()
  })

  test('returns null when separator is missing', () => {
    const wire = encodePromptIdWire(SAMPLE_UUID)
    const data = `${ROUTING_PREFIX}${wire}foo`
    expect(parseTelegramCallbackData(data)).toBeNull()
  })

  test('returns null when wire is malformed (wrong length)', () => {
    const data = `${ROUTING_PREFIX}AAAAAAAAAA:foo`
    expect(parseTelegramCallbackData(data)).toBeNull()
  })

  test('parses an empty value (the `:` is the separator, value can be empty)', () => {
    const wire = encodePromptIdWire(SAMPLE_UUID)
    const parsed = parseTelegramCallbackData(`${ROUTING_PREFIX}${wire}:`)
    expect(parsed?.prompt_id).toBe(SAMPLE_UUID)
    expect(parsed?.value).toBe('')
  })

  test('handles values containing additional `:` characters', () => {
    const wire = encodePromptIdWire(SAMPLE_UUID)
    const data = `${ROUTING_PREFIX}${wire}:opt:with:colons`
    const parsed = parseTelegramCallbackData(data)
    expect(parsed?.value).toBe('opt:with:colons')
  })

  test('returns null on non-string input', () => {
    // @ts-expect-error: deliberate bad input
    expect(parseTelegramCallbackData(undefined)).toBeNull()
  })
})

describe('DefaultButtonRouter.routeChoice', () => {
  let tmp: string
  let db: ProjectDb
  let store: ButtonStore
  let router: DefaultButtonRouter

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-br-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    store = new ButtonStore({ db })
    router = new DefaultButtonRouter({ store })
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function makePrompt(allow_freeform = false): ButtonPrompt {
    return buildButtonPrompt({
      body: 'Pick',
      options: [
        { label: 'A', body: 'a', value: 'opt-A' },
        { label: 'B', body: 'b', value: 'opt-B' },
      ],
      allow_freeform,
    })
  }

  test('delivers a known choice and reports was_new=true', async () => {
    const prompt = makePrompt()
    await store.emit(prompt, { topic_id: 'topic-1' })
    const out = await router.routeChoice({
      prompt_id: prompt.prompt_id,
      raw_value: 'opt-A',
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    })
    expect(out.delivered).toBe(true)
    expect(out.was_new).toBe(true)
    expect(out.choice.choice_value).toBe('opt-A')
    expect(out.prompt?.prompt_id).toBe(prompt.prompt_id)
  })

  test('delivered=false on unknown prompt_id (agent moved on)', async () => {
    const out = await router.routeChoice({
      prompt_id: '00000000-0000-0000-0000-000000000000',
      raw_value: 'opt-A',
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    })
    expect(out.delivered).toBe(false)
    expect(out.prompt).toBeUndefined()
  })

  test('duplicate channel callback resolves once', async () => {
    const prompt = makePrompt()
    await store.emit(prompt, { topic_id: 'topic-1' })
    const a = await router.routeChoice({
      prompt_id: prompt.prompt_id,
      raw_value: 'opt-A',
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    })
    const b = await router.routeChoice({
      prompt_id: prompt.prompt_id,
      raw_value: 'opt-B',
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    })
    expect(a.was_new).toBe(true)
    expect(b.was_new).toBe(false)
    expect(b.choice.choice_value).toBe('opt-A')
  })

  test('Telegram non-matching value NEVER falls back to freeform (Codex r8 P2)', async () => {
    // The freeform path is via inbound text messages, not via
    // callback_data. A Telegram callback that doesn't match any option
    // is rejected with delivered:false — even when allow_freeform=true.
    const prompt = makePrompt(true)
    await store.emit(prompt, { topic_id: 'topic-1' })
    const out = await router.routeChoice({
      prompt_id: prompt.prompt_id,
      raw_value: 'My freeform answer',
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    })
    expect(out.delivered).toBe(false)
    expect(out.choice.choice_value).toBe('My freeform answer')
  })

  test('app-socket non-matching value with allow_freeform=true resolves as __freeform__', async () => {
    const prompt = makePrompt(true)
    await store.emit(prompt, { topic_id: 'topic-1' })
    const out = await router.routeChoice({
      prompt_id: prompt.prompt_id,
      raw_value: 'My freeform answer',
      speaker_user_id: 'u-1',
      channel_kind: 'app-socket',
    })
    expect(out.delivered).toBe(true)
    expect(out.choice.choice_value).toBe('__freeform__')
    expect(out.choice.freeform_text).toBe('My freeform answer')
  })

  test('non-matching value with allow_freeform=false → delivered:false', async () => {
    const prompt = makePrompt(false)
    await store.emit(prompt, { topic_id: 'topic-1' })
    const out = await router.routeChoice({
      prompt_id: prompt.prompt_id,
      raw_value: 'random',
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    })
    expect(out.delivered).toBe(false)
    expect(out.prompt?.prompt_id).toBe(prompt.prompt_id)
  })

  test('reserved __freeform__ value from app-socket with explicit text routes through', async () => {
    const prompt = makePrompt(true)
    await store.emit(prompt, { topic_id: 'topic-1' })
    const out = await router.routeChoice({
      prompt_id: prompt.prompt_id,
      raw_value: '__freeform__',
      freeform_text: 'a literal answer',
      speaker_user_id: 'u-1',
      channel_kind: 'app-socket',
    })
    expect(out.delivered).toBe(true)
    expect(out.choice.freeform_text).toBe('a literal answer')
  })

  test('Telegram callback carrying a reserved sentinel is REJECTED (Codex r8 P2)', async () => {
    // The bot never rendered __cancel__/__timeout__ as a Telegram
    // button. A crafted callback carrying one is hostile; reject with
    // delivered:false regardless of allow_freeform.
    const prompt = makePrompt(true)
    await store.emit(prompt, { topic_id: 'topic-1' })
    const out = await router.routeChoice({
      prompt_id: prompt.prompt_id,
      raw_value: '__cancel__',
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    })
    expect(out.delivered).toBe(false)
  })

  test('__cancel__ from app-socket resolves the prompt', async () => {
    const prompt = makePrompt(false)
    await store.emit(prompt, { topic_id: 'topic-1' })
    const out = await router.routeChoice({
      prompt_id: prompt.prompt_id,
      raw_value: '__cancel__',
      speaker_user_id: 'u-1',
      channel_kind: 'app-socket',
    })
    expect(out.delivered).toBe(true)
    expect(out.choice.choice_value).toBe('__cancel__')
  })

  test('callback for an expired-but-not-yet-swept prompt → delivered:false', async () => {
    let now = 1_000_000
    const localStore = new ButtonStore({ db, now: () => now })
    const localRouter = new DefaultButtonRouter({ store: localStore, now: () => now })
    const prompt = buildButtonPrompt({
      body: 'Pick',
      options: [
        { label: 'A', body: 'a', value: 'opt-A' },
      ],
      allow_freeform: false,
      expires_in_ms: 5_000,
    })
    await localStore.emit(prompt, { topic_id: 'topic-1' })
    // Advance past expires_at WITHOUT calling sweepExpired — this is the
    // race the Codex P1 finding flagged.
    now += 10_000
    const out = await localRouter.routeChoice({
      prompt_id: prompt.prompt_id,
      raw_value: 'opt-A',
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    })
    expect(out.delivered).toBe(false)
    expect(out.prompt).toBeUndefined()
  })
})
