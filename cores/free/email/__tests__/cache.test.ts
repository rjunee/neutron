/**
 * Email-Managed Core — per-project SQLite sidecar.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 6.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EMAIL_SCHEMA_VERSION,
  EmailProjectCacheResolver,
  EmailSidecarMismatchError,
} from '../src/cache.ts'

function tmp(): { home: string; close: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'email-cache-'))
  return { home, close: (): void => rmSync(home, { recursive: true, force: true }) }
}

describe('EmailProjectCacheResolver', () => {
  test('first resolve creates the dir + db; second is cached', async () => {
    const { home, close } = tmp()
    try {
      const r = new EmailProjectCacheResolver({ owner_home: home })
      const p = r.pathFor('alpha')
      expect(existsSync(p)).toBe(false)
      const c1 = await r.resolve('alpha')
      expect(existsSync(p)).toBe(true)
      const c2 = await r.resolve('alpha')
      expect(c1).toBe(c2)
    } finally {
      close()
    }
  })

  test('sidecar copied between projects throws EmailSidecarMismatchError', async () => {
    const { home, close } = tmp()
    try {
      const r1 = new EmailProjectCacheResolver({ owner_home: home })
      await r1.resolve('alpha')
      r1.closeAll()
      // Build a new resolver whose `resolveProjectRoot` mis-maps the
      // beta project to alpha's on-disk dir (simulates a sidecar
      // copied between project trees).
      const r2 = new EmailProjectCacheResolver({
        owner_home: home,
        resolveProjectRoot: () => join(home, 'Projects', 'alpha'),
      })
      let caught: unknown
      try {
        await r2.resolve('beta')
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EmailSidecarMismatchError)
    } finally {
      close()
    }
  })
})

describe('EmailProjectCache CRUD', () => {
  test('triage_cache append + listRecent', async () => {
    const { home, close } = tmp()
    try {
      const r = new EmailProjectCacheResolver({ owner_home: home })
      const cache = await r.resolve('alpha')
      cache.upsertTriage({
        fired_at: 1000,
        model: 'haiku',
        outcome: 'ok',
        prompt_hash: 'h1',
        top5_json: '[]',
      })
      cache.upsertTriage({
        fired_at: 2000,
        model: 'haiku',
        outcome: 'llm_error',
        prompt_hash: 'h2',
        top5_json: '[]',
      })
      const rows = cache.listRecentTriage()
      expect(rows).toHaveLength(2)
      expect(rows[0]?.fired_at).toBe(2000) // newest first
    } finally {
      close()
    }
  })

  test('summary_cache upsert + TTL expiry', async () => {
    const { home, close } = tmp()
    try {
      let now = 1_000_000
      const r = new EmailProjectCacheResolver({ owner_home: home, now: () => now })
      const cache = await r.resolve('alpha')
      cache.upsertSummary({
        message_id: 'm1',
        template_hash: 'tmpl',
        brief_text: 'hello brief',
        model: 'haiku',
        prompt_hash: 'p1',
      })
      const hit = cache.getSummary({ message_id: 'm1', template_hash: 'tmpl' })
      expect(hit?.brief_text).toBe('hello brief')
      // Advance time past the 24h TTL.
      now += 25 * 60 * 60 * 1000
      const stale = cache.getSummary({ message_id: 'm1', template_hash: 'tmpl' })
      expect(stale).toBeNull()
    } finally {
      close()
    }
  })

  test('draft_audit append + listDraftAudit deserialises applied_labels', async () => {
    const { home, close } = tmp()
    try {
      const r = new EmailProjectCacheResolver({ owner_home: home })
      const cache = await r.resolve('alpha')
      cache.recordDraftAudit({
        draft_id: 'd1',
        thread_id: 't1',
        message_id: 'm1',
        project_id: 'alpha',
        applied_labels: ['INBOX', 'IMPORTANT', 'UNREAD', 'Neutron/alpha'],
        outcome: 'ok',
      })
      const audit = cache.listDraftAudit()
      expect(audit).toHaveLength(1)
      expect(audit[0]?.applied_labels).toEqual([
        'INBOX',
        'IMPORTANT',
        'UNREAD',
        'Neutron/alpha',
      ])
    } finally {
      close()
    }
  })

  test('email_project_label_cache CRUD', async () => {
    const { home, close } = tmp()
    try {
      const r = new EmailProjectCacheResolver({ owner_home: home })
      const cache = await r.resolve('alpha')
      expect(cache.getProjectLabelId('alpha')).toBeNull()
      cache.setProjectLabelId({
        project_id: 'alpha',
        gmail_label_id: 'Label_123',
        label_name: 'Neutron/alpha',
      })
      const row = cache.getProjectLabelId('alpha')
      expect(row?.gmail_label_id).toBe('Label_123')
      expect(row?.label_name).toBe('Neutron/alpha')
    } finally {
      close()
    }
  })

  test('schema version pinned to EMAIL_SCHEMA_VERSION', () => {
    expect(EMAIL_SCHEMA_VERSION).toBe(1)
  })
})
