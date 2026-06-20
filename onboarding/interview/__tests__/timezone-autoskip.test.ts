/**
 * #306 (2026-06-19) — timezone auto-skip.
 *
 * The browser auto-detects the user's IANA timezone and sends it as the
 * `?tz=` WS-upgrade param (landing/chat.ts:detectBrowserTimezone). This
 * suite pins the server-side half of the contract:
 *
 *   1. `sanitizeBrowserTimezone` accepts IANA-shaped zones and rejects
 *      empty / oversize / wrong-shape input (the trust boundary — a
 *      crafted `?tz=` could carry anything).
 *   2. `engine.start` STAMPS a valid timezone onto `phase_state.timezone`
 *      so persona-gen renders it into USER.md, and DROPS an invalid one.
 *   3. The live LLM envelope forbids asking for the timezone, and the
 *      gap-fill user prompt surfaces a known timezone as `known_timezone=`
 *      so the model treats it as already captured (never asks).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import { InterviewEngine } from '../engine.ts'
import { sanitizeBrowserTimezone } from '../engine-internals.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'

describe('sanitizeBrowserTimezone — server-side trust boundary', () => {
  test('accepts IANA-shaped zone names', () => {
    expect(sanitizeBrowserTimezone('America/Los_Angeles')).toBe('America/Los_Angeles')
    expect(sanitizeBrowserTimezone('Europe/London')).toBe('Europe/London')
    expect(sanitizeBrowserTimezone('Etc/GMT+5')).toBe('Etc/GMT+5')
    expect(sanitizeBrowserTimezone('UTC')).toBe('UTC')
    expect(sanitizeBrowserTimezone('  Asia/Kolkata  ')).toBe('Asia/Kolkata')
  })

  test('rejects empty, oversize, and wrong-shape input', () => {
    expect(sanitizeBrowserTimezone('')).toBeNull()
    expect(sanitizeBrowserTimezone('   ')).toBeNull()
    expect(sanitizeBrowserTimezone(null)).toBeNull()
    expect(sanitizeBrowserTimezone(undefined)).toBeNull()
    // Leading non-letter / injection-shaped / spaces.
    expect(sanitizeBrowserTimezone('/evil')).toBeNull()
    expect(sanitizeBrowserTimezone('drop table users')).toBeNull()
    expect(sanitizeBrowserTimezone('a'.repeat(65))).toBeNull()
  })
})

describe('engine.start — stamps phase_state.timezone from the ?tz= param', () => {
  let tmp: string
  let db: ProjectDb
  let buttonStore: ButtonStore
  let stateStore: InMemoryOnboardingStateStore
  let transcript: TranscriptWriter

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-tz-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    buttonStore = new ButtonStore({ db })
    stateStore = new InMemoryOnboardingStateStore()
    transcript = new TranscriptWriter({
      path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
    })
  })
  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function makeEngine(): InterviewEngine {
    return new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async () => ({ message_id: 'msg-1', was_new: true }),
      // Driver unwired → engine uses the static signup fallback. We only
      // care about the phase_state the start upsert writes.
    })
  }

  test('a valid browser timezone lands on phase_state.timezone', async () => {
    const engine = makeEngine()
    await engine.start({
      project_slug: 't-tz',
      topic_id: 'web:u-tz',
      user_id: 'u-tz',
      signup_via: 'web',
      timezone: 'America/Los_Angeles',
    })
    const state = await stateStore.get('t-tz', 'u-tz')
    expect(state).not.toBeNull()
    expect(state!.phase_state['timezone']).toBe('America/Los_Angeles')
  })

  test('an invalid browser timezone is dropped (key stays absent)', async () => {
    const engine = makeEngine()
    await engine.start({
      project_slug: 't-tz2',
      topic_id: 'web:u-tz2',
      user_id: 'u-tz2',
      signup_via: 'web',
      timezone: 'definitely not a zone',
    })
    const state = await stateStore.get('t-tz2', 'u-tz2')
    expect(state).not.toBeNull()
    expect(state!.phase_state['timezone']).toBeUndefined()
  })

  test('omitting the timezone never writes the key (Telegram / older clients)', async () => {
    const engine = makeEngine()
    await engine.start({
      project_slug: 't-tz3',
      topic_id: 'web:u-tz3',
      user_id: 'u-tz3',
      signup_via: 'web',
    })
    const state = await stateStore.get('t-tz3', 'u-tz3')
    expect(state).not.toBeNull()
    expect(state!.phase_state['timezone']).toBeUndefined()
  })
})

describe('live envelope + gap-fill prompt — never ask for the timezone', () => {
  test('the LLM envelope carries the never-ask-timezone rule', () => {
    const envelope = readFileSync(
      join(import.meta.dir, '..', 'skills', '_envelope.md'),
      'utf8',
    )
    expect(envelope).toContain('NEVER ask the user for their timezone')
    expect(envelope).toContain('known_timezone')
  })
})
