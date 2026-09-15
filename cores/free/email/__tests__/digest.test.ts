import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GmailClient, GmailSendInput } from '../src/contract.ts'
import { deliverDueDigest, digestWindow } from '../src/digest.ts'
import { openEmailPipelineStore } from '../src/pipeline/store.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function harness() {
  const owner_home = mkdtempSync(join(tmpdir(), 'email-digest-'))
  dirs.push(owner_home)
  const store = openEmailPipelineStore({ owner_home })
  store.recordDiscoveredAccount('primary', 'owner@example.com')
  store.setAccountEnabled('primary', true, 'owner@example.com', 1)
  store.insertEmail({ id: 'm1', thread_id: 't1', sender: 'sender@example.com', subject: 'Quarterly plan', snippet: 'Please review', received_at: 1, processed_at: 2, category: 'Work', handling: 'archive' })
  const sent: GmailSendInput[] = []
  const gmail = { sendMessage: async (message: GmailSendInput) => { sent.push(message); return { message_id: 'sent', thread_id: 'sent-thread', applied_labels: [] } } } as unknown as GmailClient
  return { store, gmail, sent }
}

describe('twice-daily email digest', () => {
  test('owner-local 10:00 remains 10:00 across the spring DST boundary', () => {
    expect(digestWindow(Date.parse('2026-03-07T15:00:00Z'), 'America/New_York')).toEqual({ local_day: '2026-03-07', period: 'morning' })
    expect(digestWindow(Date.parse('2026-03-09T14:00:00Z'), 'America/New_York')).toEqual({ local_day: '2026-03-09', period: 'morning' })
  })

  test('sends email with queued content once per local window and never needs a chat sink', async () => {
    const h = harness()
    const now_ms = Date.parse('2026-09-15T14:05:00Z')
    expect(await deliverDueDigest({ ...h, now_ms, time_zone: 'America/New_York', enabled: true })).toBe('delivered')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({ to: ['owner@example.com'] })
    expect(h.sent[0]!.body).toContain('Quarterly plan')
    expect(await deliverDueDigest({ ...h, now_ms, time_zone: 'America/New_York', enabled: true })).toBe('already_delivered')
    expect(h.sent).toHaveLength(1)
  })

  test('the off setting prevents delivery', async () => {
    const h = harness()
    expect(await deliverDueDigest({ ...h, now_ms: Date.parse('2026-09-15T19:00:00Z'), time_zone: 'America/New_York', enabled: false })).toBe('disabled')
    expect(h.sent).toHaveLength(0)
  })
})
