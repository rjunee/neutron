/**
 * profile-pic/selection — button-prompt builders for the async UX.
 *
 * `selection.ts` is the channel-agnostic prompt-builder layer between the
 * onboarding engine and `pipeline.ts`. The engine emits one of two
 * prompts via these builders; the channel adapter renders them; user taps
 * dispatch back into pipeline.pick / pipeline.acceptUpload / pipeline.start.
 *
 * The actual upload-bytes ingestion path (Telegram photo → canonical
 * profile-pic.png) is `pipeline.acceptUpload(...)` — covered by
 * pipeline.test.ts. These tests pin the SHAPE of the prompts the engine
 * emits so the channel adapters' rendering layer keeps a stable contract.
 */

import { describe, expect, test } from 'bun:test'
import {
  PORTRAIT_PICK_PROMPT_BODY,
  PORTRAIT_WAIT_PROMPT_BODY,
  buildPortraitPickPrompt,
  buildPortraitWaitPrompt,
} from '../selection.ts'
import { deriveIdempotencyKey } from '@neutronai/channels/button-primitive.ts'

// Stable UUID factory — the prompt_id is always a 36-char canonical UUID;
// passing a deterministic uuid lets tests assert exact equality. The
// `seed` (1-4 hex chars) salts the high nibble of the last segment so
// distinct factories produce distinct UUIDs while staying within the
// 36-char canonical shape the validator checks for.
function uuidFactory(seed: string): () => string {
  let i = 0
  const salt = seed.padStart(4, '0').slice(-4)
  return (): string => {
    const n = (i++).toString(16).padStart(8, '0')
    return `00000000-0000-4000-8000-${salt}${n}`
  }
}

describe('buildPortraitWaitPrompt', () => {
  test('emits the [A] Wait / [B] Gallery / [C] Upload triad with locked body copy', () => {
    const prompt = buildPortraitWaitPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-1',
      uuid: uuidFactory('aa'),
    })
    expect(prompt.body).toBe(PORTRAIT_WAIT_PROMPT_BODY)
    expect(prompt.allow_freeform).toBe(false)
    expect(prompt.options).toHaveLength(3)
    expect(prompt.options[0]).toEqual({ label: 'A', body: 'Wait', value: 'wait' })
    expect(prompt.options[1]).toEqual({
      label: 'B',
      body: 'Pick from generic gallery',
      value: 'gallery',
    })
    expect(prompt.options[2]).toEqual({
      label: 'C',
      body: 'Upload my own',
      value: 'upload',
    })
  })

  test('idempotency_key is deterministic — same (project, topic, job_id) → same key', () => {
    const a = buildPortraitWaitPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-stable',
      uuid: uuidFactory('a'),
    })
    const b = buildPortraitWaitPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-stable',
      uuid: uuidFactory('b'),
    })
    expect(a.idempotency_key).toBeDefined()
    expect(a.idempotency_key).toBe(b.idempotency_key)
    expect(a.idempotency_key).toBe(
      deriveIdempotencyKey({
        project_slug: 'alice',
        topic_id: 'topic-onboarding',
        seed: 'portrait-wait:job-stable',
      }),
    )
    // prompt_id MUST still be unique (uuid factories differ).
    expect(a.prompt_id).not.toBe(b.prompt_id)
  })

  test('idempotency_key flips when job_id changes (no cross-job collision)', () => {
    const a = buildPortraitWaitPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-1',
    })
    const b = buildPortraitWaitPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-2',
    })
    expect(a.idempotency_key).not.toBe(b.idempotency_key)
  })

  test('omitting uuid still produces a valid prompt (default randomUUID path)', () => {
    const prompt = buildPortraitWaitPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-default-uuid',
    })
    // Validate prompt_id is a canonical UUID (the channels primitive enforces this).
    expect(prompt.prompt_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(prompt.options).toHaveLength(3)
  })
})

describe('buildPortraitPickPrompt', () => {
  test('1 candidate → single [A] option, no Regenerate', () => {
    const prompt = buildPortraitPickPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-1',
      candidate_ids: ['cand-1'],
    })
    expect(prompt.body).toBe(PORTRAIT_PICK_PROMPT_BODY)
    expect(prompt.allow_freeform).toBe(false)
    expect(prompt.options).toHaveLength(1)
    expect(prompt.options[0]).toEqual({
      label: 'A',
      body: 'Portrait 1',
      value: 'cand-1',
    })
  })

  test('2 candidates with allow_regenerate=true → [A][B][C] Regenerate', () => {
    const prompt = buildPortraitPickPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-2',
      candidate_ids: ['cand-1', 'cand-2'],
      allow_regenerate: true,
    })
    expect(prompt.options).toHaveLength(3)
    expect(prompt.options.map((o) => o.label)).toEqual(['A', 'B', 'C'])
    expect(prompt.options.map((o) => o.value)).toEqual([
      'cand-1',
      'cand-2',
      'regen',
    ])
    expect(prompt.options[2]?.body).toBe('Regenerate')
  })

  test('3 candidates with allow_regenerate=true → [A][B][C][D] Regenerate', () => {
    const prompt = buildPortraitPickPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-3',
      candidate_ids: ['c1', 'c2', 'c3'],
      allow_regenerate: true,
    })
    expect(prompt.options.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D'])
    expect(prompt.options[3]).toEqual({
      label: 'D',
      body: 'Regenerate',
      value: 'regen',
    })
  })

  test('3 candidates without allow_regenerate → no Regenerate option', () => {
    const prompt = buildPortraitPickPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-no-regen',
      candidate_ids: ['c1', 'c2', 'c3'],
    })
    expect(prompt.options).toHaveLength(3)
    expect(prompt.options.some((o) => o.value === 'regen')).toBe(false)
  })

  test('candidate values flow through verbatim (engine routes the tap back to pipeline.pick)', () => {
    const ids = ['ce0a7a48', 'b71d-fff', 'long-but-37-byte-cap-ok']
    const prompt = buildPortraitPickPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-verbatim',
      candidate_ids: ids,
    })
    expect(prompt.options.map((o) => o.value)).toEqual(ids)
  })

  test('idempotency_key is deterministic and distinct from the wait-prompt key', () => {
    const wait = buildPortraitWaitPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-shared',
    })
    const pick = buildPortraitPickPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-shared',
      candidate_ids: ['c1'],
    })
    expect(pick.idempotency_key).toBeDefined()
    expect(pick.idempotency_key).not.toBe(wait.idempotency_key)
    expect(pick.idempotency_key).toBe(
      deriveIdempotencyKey({
        project_slug: 'alice',
        topic_id: 'topic-onboarding',
        seed: 'portrait-pick:job-shared',
      }),
    )
  })

  test('zero candidates → throws (contract: 1-3 only)', () => {
    expect(() =>
      buildPortraitPickPrompt({
        owner_slug: 'alice',
        topic_id: 'topic-onboarding',
        job_id: 'job-x',
        candidate_ids: [],
      }),
    ).toThrow(/1-3 candidate_ids, got 0/)
  })

  test('four candidates → throws (contract: 1-3 only)', () => {
    expect(() =>
      buildPortraitPickPrompt({
        owner_slug: 'alice',
        topic_id: 'topic-onboarding',
        job_id: 'job-x',
        candidate_ids: ['c1', 'c2', 'c3', 'c4'],
      }),
    ).toThrow(/1-3 candidate_ids, got 4/)
  })

  test('omitting uuid still produces a valid prompt (default randomUUID path)', () => {
    const prompt = buildPortraitPickPrompt({
      owner_slug: 'alice',
      topic_id: 'topic-onboarding',
      job_id: 'job-default-uuid',
      candidate_ids: ['c1'],
    })
    expect(prompt.prompt_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })
})
