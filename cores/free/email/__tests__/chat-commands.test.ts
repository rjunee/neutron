/**
 * Email-Managed Core — `/email ...` chat-command parser + dispatcher.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.2.
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  executeEmailCommand,
  parseEmailCommand,
  type EmailCommandContext,
} from '../src/chat-commands.ts'
import {
  EmailProjectCacheResolver,
} from '../src/cache.ts'
import { buildSeededInMemoryGmailClient } from '../src/in-memory.ts'
import { buildStubEmailSummarizer } from '../src/summarizer.ts'

function tmpHome(): { home: string; close: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'email-cc-'))
  return { home, close: (): void => rmSync(home, { recursive: true, force: true }) }
}

describe('parseEmailCommand', () => {
  test('bare /email → help', () => {
    expect(parseEmailCommand('/email')).toEqual({ kind: 'help' })
  })

  test('/email triage', () => {
    expect(parseEmailCommand('/email triage')).toEqual({ kind: 'triage' })
  })

  test('/email summarize <id>', () => {
    expect(parseEmailCommand('/email summarize thread_abc')).toEqual({
      kind: 'summarize',
      id: 'thread_abc',
    })
  })

  test('/email summarize without id → unrecognized', () => {
    const cmd = parseEmailCommand('/email summarize')
    expect(cmd.kind).toBe('unrecognized')
  })

  test('/email search <query>', () => {
    expect(parseEmailCommand('/email search from:alice')).toEqual({
      kind: 'search',
      query: 'from:alice',
    })
  })

  test('/email draft <to> <subject> <body>', () => {
    expect(
      parseEmailCommand('/email draft casey@example.com hi Hello there'),
    ).toEqual({
      kind: 'draft',
      to: 'casey@example.com',
      subject: 'hi',
      body: 'Hello there',
    })
  })

  test('/email draft with quoted subject', () => {
    expect(
      parseEmailCommand('/email draft casey@example.com "multi word subject" body here'),
    ).toEqual({
      kind: 'draft',
      to: 'casey@example.com',
      subject: 'multi word subject',
      body: 'body here',
    })
  })

  test('/email draft missing body → unrecognized', () => {
    const cmd = parseEmailCommand('/email draft casey@example.com hi')
    expect(cmd.kind).toBe('unrecognized')
  })

  test('non-/email body → unrecognized', () => {
    const cmd = parseEmailCommand('hello world')
    expect(cmd.kind).toBe('unrecognized')
  })

  test('/email help', () => {
    expect(parseEmailCommand('/email help')).toEqual({ kind: 'help' })
  })

  test('/email unknown-verb → unrecognized', () => {
    const cmd = parseEmailCommand('/email foo bar')
    expect(cmd.kind).toBe('unrecognized')
  })

  test('/emailfoo (no space) → unrecognized', () => {
    const cmd = parseEmailCommand('/emailfoo')
    expect(cmd.kind).toBe('unrecognized')
  })

  test('leading whitespace honored', () => {
    expect(parseEmailCommand('   /email triage')).toEqual({ kind: 'triage' })
  })
})

describe('executeEmailCommand', () => {
  async function buildCtx(opts: { project_id?: string | null } = {}): Promise<{
    ctx: EmailCommandContext
    cleanup: () => void
  }> {
    const { home, close } = tmpHome()
    const resolver = new EmailProjectCacheResolver({ owner_home: home })
    const project_id = opts.project_id ?? 'default'
    const cache = await resolver.resolve(project_id)
    const client = buildSeededInMemoryGmailClient()
    return {
      ctx: {
        client,
        cache,
        project_id: opts.project_id === null ? null : project_id,
        user_id: 'u1',
        user_tz: 'America/Los_Angeles',
        now: new Date(),
        llm: async (_p) => {
          throw new Error('llm not wired in this test')
        },
        model: 'claude-haiku-test',
        summarizer: buildStubEmailSummarizer(),
      },
      cleanup: (): void => {
        resolver.closeAll()
        close()
      },
    }
  }

  test('help returns the cheatsheet text', async () => {
    const { ctx, cleanup } = await buildCtx()
    try {
      const res = await executeEmailCommand({ kind: 'help' }, ctx)
      expect(res.text).toContain('/email triage')
      expect(res.text).toContain('/email draft')
    } finally {
      cleanup()
    }
  })

  test('triage on empty inbox → "inbox is empty"', async () => {
    const { ctx, cleanup } = await buildCtx()
    try {
      const res = await executeEmailCommand({ kind: 'triage' }, ctx)
      expect(res.text).toContain('empty')
    } finally {
      cleanup()
    }
  })

  test('triage on seeded inbox → top-N via deterministic fallback (LLM throws)', async () => {
    const { ctx, cleanup } = await buildCtx({ project_id: null })
    try {
      const seeded = ctx.client as ReturnType<typeof buildSeededInMemoryGmailClient>
      seeded.seed({
        subject: 's1',
        from: 'a@x.com',
        label_ids: ['INBOX', 'UNREAD', 'IMPORTANT'],
      })
      seeded.seed({
        subject: 's2',
        from: 'b@x.com',
        label_ids: ['INBOX'],
      })
      const res = await executeEmailCommand({ kind: 'triage' }, ctx)
      // The LLM stub throws, so deterministic fallback runs — the
      // outcome stamped onto the audit row is 'llm_error'.
      expect(res.text).toContain('1.')
      const rows = ctx.cache.listRecentTriage()
      expect(rows.length).toBeGreaterThanOrEqual(1)
      expect(rows[0]?.outcome).toBe('llm_error')
    } finally {
      cleanup()
    }
  })

  test('summarize fetches structured row + falls back when LLM throws', async () => {
    const { ctx, cleanup } = await buildCtx()
    try {
      const seeded = ctx.client as ReturnType<typeof buildSeededInMemoryGmailClient>
      const id = seeded.seed({
        subject: 'kickoff',
        from: 'alice@example.com',
        body_text: 'Please confirm Tuesday at 2pm.',
      })
      const res = await executeEmailCommand(
        { kind: 'summarize', id },
        ctx,
      )
      // The brief composer's LLM throws → deterministic fallback
      // returns a bulletised render of the key_points.
      expect(res.text.length).toBeGreaterThan(0)
      const data = res.data as { summary?: { from?: string } }
      expect(data.summary?.from).toBe('alice@example.com')
    } finally {
      cleanup()
    }
  })

  test('search calls Gmail-style query through the in-memory client', async () => {
    const { ctx, cleanup } = await buildCtx({ project_id: null })
    try {
      const seeded = ctx.client as ReturnType<typeof buildSeededInMemoryGmailClient>
      seeded.seed({ subject: 'urgent invoice', from: 'billing@x.com' })
      seeded.seed({ subject: 'social newsletter', from: 'news@x.com' })
      const res = await executeEmailCommand(
        { kind: 'search', query: 'subject:invoice' },
        ctx,
      )
      const data = res.data as { results?: { subject: string }[] }
      expect(data.results?.length).toBeGreaterThanOrEqual(1)
      expect(data.results?.[0]?.subject).toContain('invoice')
    } finally {
      cleanup()
    }
  })

  test('draft applies the Sam 4-point labels + records audit row', async () => {
    const { ctx, cleanup } = await buildCtx({ project_id: 'demo' })
    try {
      const res = await executeEmailCommand(
        {
          kind: 'draft',
          to: 'casey@example.com',
          subject: 'hi',
          body: 'just checking in',
        },
        ctx,
      )
      expect(res.text).toContain('Draft prepared')
      const data = res.data as {
        applied_labels: string[]
        draft_id: string
      }
      expect(data.applied_labels).toContain('INBOX')
      expect(data.applied_labels).toContain('IMPORTANT')
      expect(data.applied_labels).toContain('UNREAD')
      const audit = ctx.cache.listDraftAudit()
      expect(audit.length).toBeGreaterThanOrEqual(1)
      expect(audit[0]?.outcome).toBe('ok')
      expect(audit[0]?.applied_labels).toContain('INBOX')
    } finally {
      cleanup()
    }
  })

  test('summarize on unknown id surfaces unknown_id error', async () => {
    const { ctx, cleanup } = await buildCtx()
    try {
      const res = await executeEmailCommand(
        { kind: 'summarize', id: 'nope' },
        ctx,
      )
      expect(res.error?.code).toBe('unknown_id')
    } finally {
      cleanup()
    }
  })

  test('unrecognized → malformed error envelope', async () => {
    const { ctx, cleanup } = await buildCtx()
    try {
      const res = await executeEmailCommand(
        { kind: 'unrecognized', reason: 'test' },
        ctx,
      )
      expect(res.error?.code).toBe('malformed')
    } finally {
      cleanup()
    }
  })
})

// Touch the import so it doesn't get tree-shaken in tsc-noEmit.
void Database
