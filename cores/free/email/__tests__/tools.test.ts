import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import {
  CapabilityDeniedError,
  CapabilityGuard,
  SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import {
  MessageNotFoundError,
  buildSeededInMemoryGmailClient,
  buildStubEmailSummarizer,
  buildTools,
  loadManifest,
} from '../index.ts'

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog
const OWNER = 't1'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'email-managed-core-tools-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  audit = new SecretAuditLog({ db: projectDb })
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

function buildFixtures() {
  let nextN = 0
  const nextId = (): string => `em-${nextN++}`
  return {
    client: buildSeededInMemoryGmailClient({ nextId }),
    summarizer: buildStubEmailSummarizer(),
  }
}

describe('buildTools — capability-gated dispatch', () => {
  test('email_list returns metadata NEWEST-FIRST + writes an audit ok row', async () => {
    const { client, summarizer } = buildFixtures()
    client.seed({
      id: 'old',
      subject: 'old',
      from: 'old@x.com',
      internal_date: '2026-05-01T09:00:00Z',
    })
    client.seed({
      id: 'new',
      subject: 'new',
      from: 'new@x.com',
      internal_date: '2026-05-10T09:00:00Z',
    })
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      client,
      summarizer,
    })

    const { results } = await tools.email_list({})
    expect(results.map((r) => r.id)).toEqual(['new', 'old'])

    const auditRows = await audit.list({
      owner_slug: OWNER,
      core_slug: 'email_managed_core',
    })
    const ok = auditRows.filter((r) => r.outcome === 'ok')
    expect(ok.some((r) => r.label === 'email_list')).toBe(true)
  })

  test('email_list ordering regression — messages seeded in ascending time still surface newest-first (NOT seed-order)', async () => {
    // Pre-Argus regression: a naive sortNewestFirst implementation
    // that fell through to seed-order on tie would mis-order the
    // inbox. We assert strictly: seed-order is ASC by time; the
    // emitted list is DESC by time.
    const { client, summarizer } = buildFixtures()
    client.seed({
      id: 'a',
      subject: 'a',
      from: 'a@x.com',
      internal_date: '2026-05-01T09:00:00Z',
    })
    client.seed({
      id: 'b',
      subject: 'b',
      from: 'b@x.com',
      internal_date: '2026-05-05T09:00:00Z',
    })
    client.seed({
      id: 'c',
      subject: 'c',
      from: 'c@x.com',
      internal_date: '2026-05-10T09:00:00Z',
    })
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      client,
      summarizer,
    })

    const { results } = await tools.email_list({})
    expect(results.map((r) => r.id)).toEqual(['c', 'b', 'a'])
  })

  test('email_read returns the full body + to / cc', async () => {
    const { client, summarizer } = buildFixtures()
    client.seed({
      id: 'msg-1',
      subject: 'kickoff',
      from: 'casey@example.com',
      to: ['user@example.com', 'morgan@example.com'],
      cc: ['nikolai@example.com'],
      body_text: 'Hi Sam,\nLet me know.\n— A',
    })
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      client,
      summarizer,
    })

    const { message } = await tools.email_read({ message_id: 'msg-1' })
    expect(message.subject).toBe('kickoff')
    expect(message.from).toBe('casey@example.com')
    expect(message.to).toEqual(['user@example.com', 'morgan@example.com'])
    expect(message.cc).toEqual(['nikolai@example.com'])
    expect(message.body_text).toContain('Let me know')
  })

  test('email_read on missing id surfaces MessageNotFoundError', async () => {
    const { client, summarizer } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      client,
      summarizer,
    })
    await expect(
      tools.email_read({ message_id: 'does-not-exist' }),
    ).rejects.toThrow(MessageNotFoundError)
  })

  test('email_search honours Gmail query syntax (from: / is:unread)', async () => {
    const { client, summarizer } = buildFixtures()
    client.seed({
      id: 'a',
      subject: 'invoice',
      from: 'billing@stripe.com',
      label_ids: ['INBOX', 'UNREAD'],
      body_text: 'invoice attached',
      internal_date: '2026-05-10T09:00:00Z',
    })
    client.seed({
      id: 'b',
      subject: 'lunch',
      from: 'friend@x.com',
      label_ids: ['INBOX'],
      body_text: 'lunch tomorrow?',
      internal_date: '2026-05-09T09:00:00Z',
    })
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      client,
      summarizer,
    })

    const r1 = await tools.email_search({ query: 'from:stripe.com' })
    expect(r1.results.map((m) => m.id)).toEqual(['a'])

    const r2 = await tools.email_search({ query: 'is:unread' })
    expect(r2.results.map((m) => m.id)).toEqual(['a'])
  })

  test('email_summarize calls the summarizer on the full message body and returns the locked structured shape', async () => {
    const { client } = buildFixtures()
    client.seed({
      id: 'msg-x',
      subject: 'Re: deadline',
      from: 'casey@example.com',
      body_text: 'Please confirm by EOD. Urgent.',
    })

    // Spy summarizer — wraps the stub but records the call so we
    // can assert it actually ran (NOT just that the handler
    // returned something).
    let callCount = 0
    let lastInputId = ''
    const stub = buildStubEmailSummarizer()
    const summarizer = {
      async summarize(input: Parameters<typeof stub.summarize>[0]) {
        callCount++
        lastInputId = input.message.id
        return stub.summarize(input)
      },
    }
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      client,
      summarizer,
    })

    const { summary } = await tools.email_summarize({ message_id: 'msg-x' })
    expect(callCount).toBe(1)
    expect(lastInputId).toBe('msg-x')
    expect(summary.message_id).toBe('msg-x')
    expect(summary.subject).toBe('Re: deadline')
    expect(summary.from).toBe('casey@example.com')
    // Sentiment + ask_or_response come from the stub's classifier —
    // body contains "Urgent" + "Please" → urgent + ask.
    expect(summary.sentiment).toBe('urgent')
    expect(summary.ask_or_response).toBe('ask')
    // Structured fields exist and are arrays / strings of the right
    // shape — the contract this Tier 1 surface guarantees.
    expect(Array.isArray(summary.key_points)).toBe(true)
  })

  test('email_summarize on a missing message id propagates MessageNotFoundError BEFORE invoking the summarizer (no half-call)', async () => {
    const { client } = buildFixtures()
    let summarizerCalled = false
    const summarizer = {
      async summarize() {
        summarizerCalled = true
        // never reached
        return {
          message_id: '',
          from: '',
          subject: '',
          key_points: [],
          sentiment: 'neutral' as const,
          ask_or_response: 'informational' as const,
        }
      },
    }
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      client,
      summarizer,
    })
    await expect(
      tools.email_summarize({ message_id: 'missing' }),
    ).rejects.toThrow(MessageNotFoundError)
    expect(summarizerCalled).toBe(false)
  })

  test('email_draft_prepare creates a draft (NOT a send) and returns draft_id + message_id + thread_id', async () => {
    const { client, summarizer } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      client,
      summarizer,
    })

    const result = await tools.email_draft_prepare({
      to: ['casey@example.com'],
      subject: 'follow-up',
      body: 'Following up on Tuesday.',
    })
    expect(result.draft_id.length).toBeGreaterThan(0)
    expect(result.message_id.length).toBeGreaterThan(0)
    expect(result.thread_id.length).toBeGreaterThan(0)

    // The draft's underlying message lands with DRAFT label — assert
    // via email_read that no SENT label appears (regression guard
    // against a stray send wire-up).
    const { message } = await tools.email_read({ message_id: result.message_id })
    expect(message.label_ids).toContain('DRAFT')
    expect(message.label_ids).not.toContain('SENT')
  })

  test('email_draft_prepare reply threads the draft onto the source message thread', async () => {
    const { client, summarizer } = buildFixtures()
    client.seed({
      id: 'src',
      thread_id: 'thread-42',
      subject: 'kickoff',
      from: 'casey@example.com',
    })
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      client,
      summarizer,
    })

    const result = await tools.email_draft_prepare({
      to: ['casey@example.com'],
      subject: 'Re: kickoff',
      body: 'Yes, 2pm works.',
      reply_to_message_id: 'src',
    })
    expect(result.thread_id).toBe('thread-42')
  })

  test('email_send sends, applies the owner visibility labels, and writes an audit ok row', async () => {
    const { client, summarizer } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, client, summarizer })

    const result = await tools.email_send({
      to: ['alice@example.com'],
      subject: 'hello',
      body: 'hi there',
    })
    expect(result.message_id.length).toBeGreaterThan(0)
    expect(result.applied_labels).toContain('INBOX')
    expect(result.applied_labels).toContain('IMPORTANT')
    expect(result.applied_labels).toContain('UNREAD')
    // The sent message is SENT-labeled, not DRAFT.
    const { message } = await tools.email_read({ message_id: result.message_id })
    expect(message.label_ids).toContain('SENT')
    expect(message.label_ids).not.toContain('DRAFT')
    // Audit row for the send dispatch.
    const rows = await audit.list({ owner_slug: OWNER, core_slug: 'email_managed_core' })
    const ok = rows.filter((r) => r.outcome === 'ok' && r.label === 'email_send')
    expect(ok.length).toBeGreaterThanOrEqual(1)
  })

  test('capability gate: stripping the send capability rejects email_send but leaves draft_prepare working', async () => {
    const { client, summarizer } = buildFixtures()
    const base = loadManifest()
    const manifest: NeutronManifest = {
      ...base,
      capabilities: base.capabilities.filter((c) => c !== 'write:email_managed_core.send'),
    }
    const tools = buildTools({ manifest, project_slug: OWNER, audit, client, summarizer })
    await expect(
      tools.email_send({ to: ['a@x.com'], subject: 's', body: 'b' }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError)
    // draft_prepare still works (its capability is untouched).
    const draft = await tools.email_draft_prepare({ to: ['a@x.com'], subject: 's', body: 'b' })
    expect(draft.applied_labels).toContain('INBOX')
  })

  test('capability gate: stripped WRITE_CAPABILITY rejects draft_prepare, leaves the four read tools intact', async () => {
    const { client, summarizer } = buildFixtures()
    client.seed({ id: 'msg-1', subject: 's', from: 'a@x.com', body_text: 'hi' })
    // Synthesise a manifest with all five tool entries but strip
    // `write:email_managed_core.drafts` from the capabilities[]
    // array. The guard MUST reject email_draft_prepare; the four
    // read tools still work.
    const m0 = loadManifest()
    const downgraded: NeutronManifest = {
      ...m0,
      capabilities: m0.capabilities.filter(
        (c) => c !== 'write:email_managed_core.drafts',
      ),
    }
    const tools = buildTools({
      manifest: downgraded,
      project_slug: OWNER,
      audit,
      client,
      summarizer,
    })

    await expect(
      tools.email_draft_prepare({
        to: ['x@y.com'],
        subject: 'x',
        body: 'x',
      }),
    ).rejects.toThrow(CapabilityDeniedError)

    // Read tools still work — read capability is still declared.
    const { results } = await tools.email_list({})
    expect(results.length).toBeGreaterThan(0)
    const { message } = await tools.email_read({ message_id: 'msg-1' })
    expect(message.id).toBe('msg-1')

    const denied = await audit.listDenied({
      owner_slug: OWNER,
      core_slug: 'email_managed_core',
    })
    const labels = new Set(denied.map((r) => r.label))
    expect(labels.has('email_draft_prepare')).toBe(true)
    expect(labels.has('email_list')).toBe(false)
    expect(labels.has('email_read')).toBe(false)
  })

  test('capability gate: stripped READ_CAPABILITY rejects all four read tools, leaves draft_prepare intact', async () => {
    const { client, summarizer } = buildFixtures()
    const m0 = loadManifest()
    const downgraded: NeutronManifest = {
      ...m0,
      capabilities: m0.capabilities.filter(
        (c) => c !== 'read:email_managed_core.messages',
      ),
    }
    const tools = buildTools({
      manifest: downgraded,
      project_slug: OWNER,
      audit,
      client,
      summarizer,
    })

    await expect(tools.email_list({})).rejects.toThrow(CapabilityDeniedError)
    await expect(
      tools.email_read({ message_id: 'x' }),
    ).rejects.toThrow(CapabilityDeniedError)
    await expect(
      tools.email_search({ query: 'x' }),
    ).rejects.toThrow(CapabilityDeniedError)
    await expect(
      tools.email_summarize({ message_id: 'x' }),
    ).rejects.toThrow(CapabilityDeniedError)

    // Draft creation still resolves — write capability still declared.
    const draft = await tools.email_draft_prepare({
      to: ['x@y.com'],
      subject: 'x',
      body: 'x',
    })
    expect(draft.draft_id.length).toBeGreaterThan(0)
  })

  test('capability gate: undeclared tool name is rejected by `tool_not_declared`', async () => {
    const m = loadManifest()
    const guard = new CapabilityGuard({
      manifest: m,
      core_slug: 'email_managed_core',
      owner_slug: OWNER,
      audit,
    })

    const result = guard.check({
      tool_name: 'email_unknown_tool',
      capability_required: 'write:email_managed_core.drafts',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('tool_not_declared')
    }
  })
})
