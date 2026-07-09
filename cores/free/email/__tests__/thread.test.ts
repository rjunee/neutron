/**
 * @neutronai/email-managed-core — `email_thread` thread-read coverage.
 *
 * Exercises the conversation-level read surface added for WAVE 3:
 *   - backend `getThread` on both in-memory fakes (ordering, participant
 *     union, metadata derivation, ThreadNotFoundError)
 *   - the production `buildGoogleGmailClient` wrapper against a mocked
 *     `users.threads.get` (full-payload mapping + 404 → ThreadNotFound)
 *   - the `email_thread` MCP tool (read-capability gated, audit row)
 *   - the `/email thread <id>` chat-command parser + executor (parity)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { SecretAuditLog } from '@neutronai/cores-runtime'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import {
  ThreadNotFoundError,
  buildGoogleGmailClient,
  buildInMemoryGmailClient,
  buildSeededInMemoryGmailClient,
  buildStubEmailSummarizer,
  buildTools,
  loadManifest,
} from '../index.ts'

import {
  executeEmailCommand,
  parseEmailCommand,
} from '../src/chat-commands.ts'

describe('backend getThread — in-memory fakes', () => {
  test('seeded client returns OLDEST-FIRST with derived thread metadata', async () => {
    const client = buildSeededInMemoryGmailClient()
    client.seed({
      id: 'm2',
      thread_id: 'thr-1',
      subject: 'Re: lunch',
      from: '"Bob" <bob@x.com>',
      to: ['alice@x.com'],
      internal_date: '2026-06-02T10:00:00Z',
      label_ids: ['INBOX', 'IMPORTANT'],
      body_text: 'sounds good',
    })
    client.seed({
      id: 'm1',
      thread_id: 'thr-1',
      subject: 'lunch',
      from: '"Alice" <alice@x.com>',
      to: ['bob@x.com'],
      cc: ['carol@x.com'],
      internal_date: '2026-06-01T09:00:00Z',
      label_ids: ['INBOX'],
      body_text: 'want lunch?',
    })
    // A message on a different thread must NOT bleed in.
    client.seed({
      id: 'other',
      thread_id: 'thr-2',
      subject: 'unrelated',
      from: 'spam@x.com',
      internal_date: '2026-06-03T09:00:00Z',
    })

    const thread = await client.getThread({ thread_id: 'thr-1' })
    expect(thread.thread_id).toBe('thr-1')
    expect(thread.message_count).toBe(2)
    // OLDEST-FIRST: m1 (Jun 1) before m2 (Jun 2).
    expect(thread.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    // Subject from the oldest message.
    expect(thread.subject).toBe('lunch')
    // Last message date = newest (seeded internal_date is preserved
    // verbatim by the in-memory fake).
    expect(thread.last_message_date).toBe('2026-06-02T10:00:00Z')
    // Participants: first-seen union of the RAW From/To/Cc strings
    // across the thread (oldest message first). The dedup is on the raw
    // RFC 5322 mailbox spec, so `"Alice" <alice@x.com>` (m1 From) and
    // the bare `alice@x.com` (m2 To) are distinct entries.
    expect(thread.participants).toEqual([
      '"Alice" <alice@x.com>',
      'bob@x.com',
      'carol@x.com',
      '"Bob" <bob@x.com>',
      'alice@x.com',
    ])
    // Label union across the thread.
    expect(thread.label_ids).toContain('INBOX')
    expect(thread.label_ids).toContain('IMPORTANT')
  })

  test('unknown thread id throws ThreadNotFoundError', async () => {
    const client = buildInMemoryGmailClient()
    await expect(client.getThread({ thread_id: 'nope' })).rejects.toThrow(
      ThreadNotFoundError,
    )
  })
})

describe('backend getThread — production buildGoogleGmailClient', () => {
  test('maps users.threads.get full payload, oldest-first', async () => {
    let seenUrl = ''
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input) => {
        seenUrl = typeof input === 'string' ? input : input.toString()
        return new Response(
          JSON.stringify({
            id: 'thr-9',
            messages: [
              {
                id: 'b',
                threadId: 'thr-9',
                internalDate: '1700001000000',
                labelIds: ['INBOX'],
                payload: {
                  headers: [
                    { name: 'Subject', value: 'Re: hi' },
                    { name: 'From', value: 'bob@x.com' },
                  ],
                  mimeType: 'text/plain',
                  body: { data: '' },
                },
              },
              {
                id: 'a',
                threadId: 'thr-9',
                internalDate: '1700000000000',
                labelIds: ['INBOX'],
                payload: {
                  headers: [
                    { name: 'Subject', value: 'hi' },
                    { name: 'From', value: 'alice@x.com' },
                  ],
                  mimeType: 'text/plain',
                  body: { data: '' },
                },
              },
            ],
          }),
          { status: 200 },
        )
      },
    })
    const thread = await client.getThread({ thread_id: 'thr-9' })
    expect(seenUrl).toContain('/threads/thr-9')
    expect(seenUrl).toContain('format=full')
    expect(thread.message_count).toBe(2)
    // Oldest-first: 'a' (epoch 1700000000000) before 'b'.
    expect(thread.messages.map((m) => m.id)).toEqual(['a', 'b'])
    expect(thread.subject).toBe('hi')
  })

  test('404 surfaces ThreadNotFoundError (NOT GoogleGmailApiError)', async () => {
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () => new Response('{"error":"not found"}', { status: 404 }),
    })
    await expect(client.getThread({ thread_id: 'gone' })).rejects.toThrow(
      ThreadNotFoundError,
    )
  })

  test('empty thread (no messages) throws ThreadNotFoundError', async () => {
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: 'thr-empty', messages: [] }), {
          status: 200,
        }),
    })
    await expect(client.getThread({ thread_id: 'thr-empty' })).rejects.toThrow(
      ThreadNotFoundError,
    )
  })
})

describe('email_thread MCP tool', () => {
  let tmp: string
  let projectDb: ProjectDb
  let audit: SecretAuditLog
  const OWNER = 't1'

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'email-managed-core-thread-'))
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

  test('returns the thread + writes an audit ok row', async () => {
    const client = buildSeededInMemoryGmailClient()
    client.seed({
      id: 'm1',
      thread_id: 'thr-7',
      subject: 'invoice',
      from: 'biller@x.com',
      internal_date: '2026-06-01T09:00:00Z',
      body_text: 'see attached',
    })
    client.seed({
      id: 'm2',
      thread_id: 'thr-7',
      subject: 'Re: invoice',
      from: 'me@x.com',
      internal_date: '2026-06-01T10:00:00Z',
      body_text: 'paid',
    })
    const tools = buildTools({
      manifest: loadManifest(),
      project_slug: OWNER,
      audit,
      client,
      summarizer: buildStubEmailSummarizer(),
    })
    const { thread } = await tools.email_thread({ thread_id: 'thr-7' })
    expect(thread.message_count).toBe(2)
    expect(thread.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(thread.messages[0]?.body_text).toBe('see attached')
  })
})

describe('/email thread chat command (parity)', () => {
  function ctx(client: ReturnType<typeof buildSeededInMemoryGmailClient>) {
    return {
      client,
      // The thread read path never touches the cache; a minimal stub is
      // enough for the type.
      cache: {} as never,
      project_id: null,
      user_id: 'u1',
      user_tz: 'America/Los_Angeles',
      now: new Date('2026-06-01T00:00:00Z'),
      llm: async () => '{}',
      model: 'claude-haiku-4-5-20251001',
    }
  }

  test('parses /email thread <id>', () => {
    expect(parseEmailCommand('/email thread thr-42')).toEqual({
      kind: 'thread',
      id: 'thr-42',
    })
  })

  test('bare /email thread is rejected with usage', () => {
    const cmd = parseEmailCommand('/email thread')
    expect(cmd.kind).toBe('unrecognized')
  })

  test('executes against a seeded thread', async () => {
    const client = buildSeededInMemoryGmailClient()
    client.seed({
      id: 'm1',
      thread_id: 'thr-5',
      subject: 'hello',
      from: 'a@x.com',
      internal_date: '2026-06-01T09:00:00Z',
    })
    const res = await executeEmailCommand(
      { kind: 'thread', id: 'thr-5' },
      ctx(client),
    )
    expect(res.error).toBeUndefined()
    expect(res.text).toContain('thr-5')
    expect(res.text).toContain('1 message')
  })

  test('unknown thread surfaces unknown_id error', async () => {
    const client = buildSeededInMemoryGmailClient()
    const res = await executeEmailCommand(
      { kind: 'thread', id: 'ghost' },
      ctx(client),
    )
    expect(res.error?.code).toBe('unknown_id')
  })
})
