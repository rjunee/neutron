/**
 * The Kimi cross-model reviewer.
 *
 * The tests that matter here are not "does it parse a happy response" — they are
 * the three ways this reviewer could silently stop reviewing while still looking
 * like it worked:
 *
 *   1. HTTP 200 with a thinking block and no text block (the measured
 *      thinking-budget trap). Treating that as "reviewed, no findings" is an
 *      APPROVE from a reviewer that produced no answer.
 *   2. A review that ran but whose verdict line is missing or garbled becoming an
 *      APPROVE by omission.
 *   3. A missing credential being reported as anything other than the graceful
 *      not_connected path — or a present-but-broken credential being reported AS
 *      not_connected, which would let the panel proceed as though nothing were
 *      wrong.
 */

import { describe, expect, it } from 'bun:test'

import {
  extractAnswerText,
  kimiRequestsChanges,
  reviewWithKimi,
  KIMI_DEFAULT_MAX_TOKENS,
  type KimiFetch,
} from '../kimi-review.ts'

const DIFF = '--- a/x.ts\n+++ b/x.ts\n@@\n-const a = 1\n+const a = 2\n'
const TASK = 'bump a'
const KEY = 'sk-kimi-synthetic'

function res(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

function fetchReturning(body: unknown, init?: { ok?: boolean; status?: number }): KimiFetch {
  return async () => res(body, init)
}

const TEXT_OK = { content: [{ type: 'text', text: 'looks fine\nVERDICT: APPROVE' }] }

describe('reviewWithKimi — the panel-degrading failures', () => {
  it('a 200 with ONLY a thinking block is DEFERRED, not an empty pass', async () => {
    // Measured: at max_tokens=6000 on a 2.7KB diff, K3 spent its whole budget
    // thinking and returned no text block. If that became "reviewed, no
    // findings", every non-trivial diff would be approved by a reviewer that
    // never answered.
    const r = await reviewWithKimi({
      diff: DIFF,
      task: TASK,
      apiKey: KEY,
      fetchImpl: fetchReturning({
        content: [{ type: 'thinking', thinking: 'long internal reasoning...' }],
      }),
    })
    expect(r.status).toBe('deferred')
    expect(r.text).toBe('')
    expect(r.reason).toContain('no answer text')
  })

  it('an empty content array is DEFERRED too', async () => {
    const r = await reviewWithKimi({
      diff: DIFF,
      task: TASK,
      apiKey: KEY,
      fetchImpl: fetchReturning({ content: [] }),
    })
    expect(r.status).toBe('deferred')
  })

  it('no credential is the GRACEFUL not_connected path, and never calls out', async () => {
    let called = false
    const r = await reviewWithKimi({
      diff: DIFF,
      task: TASK,
      apiKey: null,
      fetchImpl: async () => {
        called = true
        return res(TEXT_OK)
      },
    })
    expect(r.status).toBe('not_connected')
    expect(called).toBe(false)
  })

  it('an empty-string key is not_connected as well', async () => {
    const r = await reviewWithKimi({ diff: DIFF, task: TASK, apiKey: '', fetchImpl: fetchReturning(TEXT_OK) })
    expect(r.status).toBe('not_connected')
  })

  it('a REJECTED key is DEFERRED — never not_connected', async () => {
    // The distinction is the whole gate. `not_connected` lets the panel proceed
    // Claude-only on purpose; a configured-but-rejected key must BLOCK, or a
    // rotated/expired key silently removes the cross-model reviewer.
    const r = await reviewWithKimi({
      diff: DIFF,
      task: TASK,
      apiKey: KEY,
      fetchImpl: fetchReturning({ error: 'invalid api key' }, { ok: false, status: 401 }),
    })
    expect(r.status).toBe('deferred')
    expect(r.reason).toContain('401')
  })

  it('a 429 whose BODY names a quota is EXHAUSTED, not merely deferred (#567)', async () => {
    // THE ASSERTION THAT SPLIT. This used to expect `deferred`, and that conflation is
    // the incident: a maxed-out account reported as a transient blip, so the workflow
    // retried it, paid for the rest of the panel, and still could not merge — every
    // run, because quota does not clear between two calls. `exhausted` is a distinct
    // status precisely so the run stops paying to rediscover it and surfaces the
    // remedy, which is the owner's to choose.
    const r = await reviewWithKimi({
      diff: DIFF,
      task: TASK,
      apiKey: KEY,
      fetchImpl: fetchReturning({ error: 'insufficient quota' }, { ok: false, status: 429 }),
    })
    expect(r.status).toBe('exhausted')
    expect(r.reason).toContain('429')
    // The message names all three ways out rather than leaving a blocked merge with no
    // stated remedy.
    expect(r.reason).toContain('add capacity')
    expect(r.reason).toContain('NONE')
  })

  it('a 429 with NO quota in the body stays DEFERRED — the status alone is ambiguous', async () => {
    // THE NECESSARY CONTROL. This provider returns 429 for a per-minute rate limit as
    // well as for an empty account, so keying on the code alone would declare every
    // traffic burst an exhausted account and block merges on a blip. Splitting on the
    // BODY is the whole reason `classifyProviderResponse` exists; without this case the
    // test above would pass on a rule that simply mapped 429 → exhausted.
    const r = await reviewWithKimi({
      diff: DIFF,
      task: TASK,
      apiKey: KEY,
      fetchImpl: fetchReturning({ error: 'rate limit exceeded, retry in 20s' }, { ok: false, status: 429 }),
    })
    expect(r.status).toBe('deferred')
    expect(r.reason).toContain('429')
  })

  it('a network failure is DEFERRED, not a pass', async () => {
    const r = await reviewWithKimi({
      diff: DIFF,
      task: TASK,
      apiKey: KEY,
      fetchImpl: async () => {
        throw new Error('ECONNRESET')
      },
    })
    expect(r.status).toBe('deferred')
    expect(r.reason).toContain('ECONNRESET')
  })

  it('an empty diff is DEFERRED — a reviewer handed nothing must not answer', async () => {
    const r = await reviewWithKimi({
      diff: '',
      task: TASK,
      apiKey: KEY,
      fetchImpl: fetchReturning(TEXT_OK),
    })
    expect(r.status).toBe('deferred')
    expect(r.reason).toContain('empty diff')
  })

  it('a real review comes back connected with its text', async () => {
    const r = await reviewWithKimi({
      diff: DIFF,
      task: TASK,
      apiKey: KEY,
      fetchImpl: fetchReturning(TEXT_OK),
    })
    expect(r.status).toBe('connected')
    expect(r.text).toContain('VERDICT: APPROVE')
  })

  it('never puts the key in a surfaced reason', async () => {
    // Reasons are rendered into the panel line and can reach chat.
    const r = await reviewWithKimi({
      diff: DIFF,
      task: TASK,
      apiKey: KEY,
      fetchImpl: fetchReturning({}, { ok: false, status: 403 }),
    })
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('sends a thinking-sized budget by default', async () => {
    let sent: Record<string, unknown> = {}
    await reviewWithKimi({
      diff: DIFF,
      task: TASK,
      apiKey: KEY,
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body) as Record<string, unknown>
        return res(TEXT_OK)
      },
    })
    // A budget small enough to be consumed by thinking makes the reviewer defer
    // on every real diff, so the default is asserted rather than assumed.
    expect(sent['max_tokens']).toBe(KIMI_DEFAULT_MAX_TOKENS)
    expect(KIMI_DEFAULT_MAX_TOKENS).toBeGreaterThanOrEqual(20_000)
  })

  it('authenticates with x-api-key and never a bearer Authorization header', async () => {
    let headers: Record<string, string> = {}
    await reviewWithKimi({
      diff: DIFF,
      task: TASK,
      apiKey: KEY,
      fetchImpl: async (_url, init) => {
        headers = init.headers
        return res(TEXT_OK)
      },
    })
    expect(headers['x-api-key']).toBe(KEY)
    expect(headers['Authorization']).toBeUndefined()
  })
})

describe('extractAnswerText', () => {
  it('returns null (not empty string) when there is no text block', () => {
    // The distinction IS the guard — '' would read as a valid empty review.
    expect(extractAnswerText(JSON.stringify({ content: [{ type: 'thinking' }] }))).toBeNull()
  })

  it('skips thinking blocks and joins the text ones', () => {
    const body = JSON.stringify({
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    })
    expect(extractAnswerText(body)).toBe('first\nsecond')
  })

  it('returns null on unparseable or unexpected bodies', () => {
    expect(extractAnswerText('not json')).toBeNull()
    expect(extractAnswerText(JSON.stringify({ content: 'a string' }))).toBeNull()
    expect(extractAnswerText(JSON.stringify({}))).toBeNull()
  })
})

describe('kimiRequestsChanges — ambiguity resolves toward blocking', () => {
  it('reads an explicit APPROVE', () => {
    expect(kimiRequestsChanges('fine\nVERDICT: APPROVE')).toBe(false)
  })

  it('reads an explicit REQUEST_CHANGES', () => {
    expect(kimiRequestsChanges('bad\nVERDICT: REQUEST_CHANGES')).toBe(true)
  })

  it('a MISSING verdict line blocks rather than approving by omission', () => {
    expect(kimiRequestsChanges('I looked at it and it seems okay overall.')).toBe(true)
  })

  it('empty text blocks', () => {
    expect(kimiRequestsChanges('')).toBe(true)
  })

  it('takes the LAST verdict when the review discusses both', () => {
    // A review that mentions the words earlier while reasoning must not have an
    // early mention win over its actual concluding line.
    expect(kimiRequestsChanges('might be VERDICT: REQUEST_CHANGES\nVERDICT: APPROVE')).toBe(false)
    expect(kimiRequestsChanges('looked like VERDICT: APPROVE at first\nVERDICT: REQUEST_CHANGES')).toBe(true)
  })

  it('survives a trailing code fence on the verdict line', () => {
    expect(kimiRequestsChanges('VERDICT: APPROVE ```')).toBe(false)
  })
})
