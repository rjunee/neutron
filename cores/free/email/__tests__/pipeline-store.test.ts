/**
 * Email pipeline — the owner-level sidecar store.
 *
 * Per docs/plans/2026-08-06-email-core-consolidation-plan.md § 5.
 * Every fixture address is `*.example.com`.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EMAIL_PIPELINE_DB,
  EMAIL_PIPELINE_DIR,
  EMAIL_PIPELINE_MIGRATIONS_DIR,
  openEmailPipelineStore,
  type EmailPipelineStore,
} from '../src/pipeline/store.ts'

function withStore(run: (store: EmailPipelineStore, home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'email-pipeline-'))
  const store = openEmailPipelineStore({ owner_home: home, now: () => 1_000 })
  try {
    run(store, home)
  } finally {
    store.close()
    rmSync(home, { recursive: true, force: true })
  }
}

describe('openEmailPipelineStore', () => {
  test('creates <owner_home>/email/pipeline.db and applies migration 0001', () => {
    withStore((store, home) => {
      expect(existsSync(join(home, EMAIL_PIPELINE_DIR, EMAIL_PIPELINE_DB))).toBe(true)
      const applied = store.db
        .query<{ version: number; name: string }, []>(
          `SELECT version, name FROM _migrations ORDER BY version`,
        )
        .all()
      // The namespace is per-DB-FILE, so this tree starts at 1 regardless of
      // the per-project cache tree's numbering.
      expect(applied[0]?.version).toBe(1)
      expect(applied[0]?.name).toBe('email_pipeline')
      // The pipeline tree is its OWN namespace — the per-project cache tables
      // must NOT be here.
      const tables = store.db
        .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all()
        .map((r) => r.name)
      expect(tables).toContain('emails')
      expect(tables).toContain('sender_cache')
      expect(tables).toContain('sender_rules')
      expect(tables).toContain('checkpoints')
      expect(tables).not.toContain('triage_cache')
    })
  })

  test('sender_rules ships EMPTY — no seeded owner data anywhere in the tree', () => {
    withStore((store) => {
      expect(store.listSenderRules()).toEqual([])
      // "anywhere in the tree" is the claim, so check the tree. Asserting ONE
      // table empty would pass a seed dropped into `sender_cache` or
      // `checkpoints` — the same shipped-someone-else's-inbox defect, one table
      // over.
      for (const table of ['sender_cache', 'checkpoints', 'emails']) {
        const counted = store.db
          .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`)
          .get()
        expect(counted?.n).toBe(0)
      }

      // And the SOURCE of the tree, so a seed added to a LATER migration file is
      // caught at the file rather than at whichever table it happens to land in.
      const files = readdirSync(EMAIL_PIPELINE_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        const sql = readFileSync(join(EMAIL_PIPELINE_MIGRATIONS_DIR, file), 'utf8')
        expect(sql.toUpperCase()).not.toContain('INSERT INTO')
      }
    })
  })

  test('addSenderRule roundtrips, including the protected flag', () => {
    withStore((store) => {
      const rule = store.addSenderRule({
        pattern: 'billing@vendor.example.com',
        kind: 'sender',
        category: 'important',
        protected: true,
      })
      expect(rule.protected).toBe(1)
      expect(store.listSenderRules()).toHaveLength(1)
    })
  })

  test('checkpoints get/set roundtrip and overwrite', () => {
    withStore((store) => {
      expect(store.getCheckpoint('go_live_after')).toBeNull()
      store.setCheckpoint('go_live_after', '42')
      expect(store.getCheckpoint('go_live_after')).toBe('42')
      store.setCheckpoint('go_live_after', '43')
      expect(store.getCheckpoint('go_live_after')).toBe('43')
    })
  })

  test('sender_cache upsert overwrites the learned category', () => {
    withStore((store) => {
      expect(store.getSenderCache('news@list.example.com')).toBeNull()
      store.upsertSenderCache('news@list.example.com', 'newsletter')
      expect(store.getSenderCache('news@list.example.com')?.category).toBe('newsletter')
      store.upsertSenderCache('news@list.example.com', 'other')
      expect(store.getSenderCache('news@list.example.com')?.category).toBe('other')
    })
  })

  test('insert / hasEmail / listPendingEscalations / markEscalated semantics', () => {
    withStore((store) => {
      expect(store.hasEmail('m1')).toBe(false)
      store.insertEmail({
        id: 'm1',
        thread_id: 't1',
        sender: 'alerts@vendor.example.com',
        subject: 'Action required: payment failed',
        received_at: 100,
        processed_at: 100,
        category: 'important',
        handling: 'escalate',
      })
      expect(store.hasEmail('m1')).toBe(true)
      // A never-attempted escalation IS pending. It used to be excluded so the
      // poll path could own the first attempt — but that stranded any row
      // written just before a crash: skipped by the poll (hasEmail) and by the
      // resume (attempts = 0), undeliverable by anything.
      expect(store.listPendingEscalations(5)).toHaveLength(1)

      // The ATTEMPT is counted before it is made, so an interrupted attempt is
      // recoverable exactly like a failed one; the failure then records only
      // what went wrong.
      store.beginEscalationAttempt('m1', 200)
      store.recordEscalationFailure('m1', 'socket closed', 200)
      const pending = store.listPendingEscalations(5)
      expect(pending).toHaveLength(1)
      expect(pending[0]?.escalation_attempts).toBe(1)
      expect(pending[0]?.last_error).toBe('socket closed')

      // Attempt cap.
      expect(store.listPendingEscalations(1)).toHaveLength(0)

      store.markEscalated('m1', 300)
      expect(store.getEmail('m1')?.escalated_at).toBe(300)
      expect(store.listPendingEscalations(5)).toHaveLength(0)
    })
  })

  test('an archived row is never a pending escalation', () => {
    withStore((store) => {
      store.insertEmail({
        id: 'm2',
        thread_id: 't2',
        sender: 'news@list.example.com',
        subject: 'This week',
        received_at: 100,
        processed_at: 100,
        category: 'newsletter',
        handling: 'archive',
      })
      store.recordEscalationFailure('m2', 'irrelevant', 200)
      expect(store.listPendingEscalations(5)).toHaveLength(0)
    })
  })

  test('a re-record NEVER re-arms an escalation that already went out', () => {
    withStore((store) => {
      const row = {
        id: 'm3',
        thread_id: 't3',
        sender: 'billing@vendor.example.com',
        subject: 'Action required: payment failed',
        received_at: 100,
        processed_at: 100,
        category: 'important',
        handling: 'escalate' as const,
      }
      store.insertEmail(row)
      store.beginEscalationAttempt('m3', 150)
      store.markEscalated('m3', 200)
      store.markPushed('m3', 210)
      store.markMutated('m3', 220)

      // The statement names 12 of the 17 columns. Under `INSERT OR REPLACE` the
      // other five reset to their defaults, so this second record would tell the
      // owner about the same email again AND buzz their phone again.
      store.insertEmail({ ...row, subject: 'Action required: payment failed (resent)' })

      const after = store.getEmail('m3')
      expect(after?.subject).toBe('Action required: payment failed (resent)')
      expect(after?.escalated_at).toBe(200)
      expect(after?.pushed_at).toBe(210)
      expect(after?.mutated_at).toBe(220)
      expect(after?.escalation_attempts).toBe(1)
      expect(store.listPendingEscalations(5)).toHaveLength(0)
      expect(store.listPendingMutations(5)).toHaveLength(0)
    })
  })

  test('an escalation over the attempt cap is COUNTED, not just dropped', () => {
    withStore((store) => {
      store.insertEmail({
        id: 'm4',
        thread_id: 't4',
        sender: 'billing@vendor.example.com',
        subject: 'Action required: payment failed',
        received_at: 100,
        processed_at: 100,
        category: 'important',
        handling: 'escalate',
      })
      expect(store.countAbandonedEscalations(3)).toBe(0)
      for (const at of [110, 120, 130]) {
        store.beginEscalationAttempt('m4', at)
        store.recordEscalationFailure('m4', 'socket closed', at)
      }
      // It has fallen out of the retry queue — which is right — but it is an
      // important email the owner was never told about, so it must still be
      // countable. Otherwise the only trace is a row nobody reads.
      expect(store.listPendingEscalations(3)).toHaveLength(0)
      expect(store.countAbandonedEscalations(3)).toBe(1)

      // A DELIVERED row is never abandoned, whatever it cost to deliver.
      store.markEscalated('m4', 140)
      expect(store.countAbandonedEscalations(3)).toBe(0)
    })
  })
})
