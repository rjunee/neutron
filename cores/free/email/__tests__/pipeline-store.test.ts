/**
 * Email pipeline — the instance-level sidecar store.
 *
 * Per docs/plans/2026-08-06-email-core-consolidation-plan.md § 5.
 * Every fixture address is `*.example.com`.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EMAIL_PIPELINE_DB,
  EMAIL_PIPELINE_DIR,
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
})
