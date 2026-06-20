/**
 * Action 5 — follow-up email draft tests.
 *
 * Critical assertions: drafts.create called; users.messages.send NEVER
 * called; recipient hashed in telemetry; scope-missing path emits a
 * permission prompt without drafting.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import action05 from '../05-followup-email-draft.ts'
import {
  buildContext,
  buildRecordingGmail,
  makeFixture,
  teardown,
  type TestFixture,
} from '../../__tests__/test-helpers.ts'
import type { GmailScopeState, StalledEmailThread } from '../../action-types.ts'

let fix: TestFixture
const NOW = 1_700_000_000_000

beforeEach(() => {
  fix = makeFixture()
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

function freshThread(): StalledEmailThread {
  return {
    thread_id: 'thread-1',
    recipient_email: 'priya@example.com',
    subject: 'Q3 invoice',
    last_inbound_at: NOW - 20 * 24 * 60 * 60 * 1000,
    last_outbound_at: NOW - 35 * 24 * 60 * 60 * 1000,
    inbound_count: 3,
    one_line_preview: 'circling back on this',
  }
}

function fullScope(): GmailScopeState {
  return { scopes: ['gmail.readonly', 'gmail.compose'], has_compose: true }
}

describe('action 05-followup-email-draft', () => {
  test('does not fire when no stalled threads', () => {
    const ctx = buildContext(fix, { now: () => NOW })
    expect(action05.triggerCondition(ctx)).toBe(false)
  })

  test('fires when ≥1 thread is stalled (14d/30d/2-inbound)', () => {
    const ctx = buildContext(fix, {
      now: () => NOW,
      stalled_threads: [freshThread()],
    })
    expect(action05.triggerCondition(ctx)).toBe(true)
  })

  test('does not fire when inbound_count < 2', () => {
    const t = freshThread()
    t.inbound_count = 1
    const ctx = buildContext(fix, { now: () => NOW, stalled_threads: [t] })
    expect(action05.triggerCondition(ctx)).toBe(false)
  })

  test('drafts only — drafts.create called, send NEVER called', async () => {
    const gmail = buildRecordingGmail(fix)
    const ctx = buildContext(fix, {
      now: () => NOW,
      stalled_threads: [freshThread()],
      gmail_scopes: fullScope(),
      gmail,
    })
    const result = await action05.run(ctx)
    expect(result.fired).toBe(true)
    expect(result.reason).toBe('draft_created')
    expect(fix.gmailCalls.drafts.length).toBe(1)
    expect(fix.gmailCalls.sends.length).toBe(0)
    // recipient hashed in telemetry — never raw email.
    const json = JSON.stringify(result.redacted_payload)
    expect(json).not.toContain('priya@example.com')
    expect(typeof result.redacted_payload?.recipient_hash).toBe('string')
    expect((result.redacted_payload?.recipient_hash as string).length).toBe(16)
  })

  test('subject auto-prefixes Re: only if missing', async () => {
    const t = freshThread()
    t.subject = 'Re: prior thread'
    const gmail = buildRecordingGmail(fix)
    const ctx = buildContext(fix, {
      now: () => NOW,
      stalled_threads: [t],
      gmail_scopes: fullScope(),
      gmail,
    })
    await action05.run(ctx)
    expect(fix.gmailCalls.drafts[0]!.subject).toBe('Re: prior thread')
  })

  test('missing gmail.compose surfaces permission prompt + does NOT draft', async () => {
    const gmail = buildRecordingGmail(fix)
    const ctx = buildContext(fix, {
      now: () => NOW,
      stalled_threads: [freshThread()],
      gmail_scopes: { scopes: ['gmail.readonly'], has_compose: false },
      gmail,
    })
    const result = await action05.run(ctx)
    expect(result.fired).toBe(false)
    expect(result.reason).toBe('scope_missing')
    expect(fix.gmailCalls.drafts.length).toBe(0)
    expect(fix.channelCalls.prompts.length).toBe(1)
    const opts = fix.channelCalls.prompts[0]!.prompt.options.map((o) => o.value)
    expect(opts).toContain('grant')
    expect(opts).toContain('skip')
  })

  test('null gmail client returns gmail_not_wired', async () => {
    const ctx = buildContext(fix, {
      now: () => NOW,
      stalled_threads: [freshThread()],
      gmail_scopes: fullScope(),
      gmail: null,
    })
    const result = await action05.run(ctx)
    expect(result.fired).toBe(false)
    expect(result.reason).toBe('gmail_not_wired')
  })

  test('engagement decoder maps opened/discarded', () => {
    expect(action05.decodeEngagement?.('opened')).toBe('opened')
    expect(action05.decodeEngagement?.('discarded')).toBe('discarded')
    expect(action05.decodeEngagement?.('grant')).toBeNull()
  })
})
