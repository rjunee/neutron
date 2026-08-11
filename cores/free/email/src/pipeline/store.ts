/**
 * @neutronai/email-managed-core — the email pipeline sidecar store.
 *
 * Opens `<owner_home>/email/pipeline.db` — INSTANCE-level, not per-project.
 * The inbox is instance-scoped (the multi-account client merges accounts into
 * one stream), so there is no `project_id` and no `ProjectSidecarResolver`
 * here; the per-project sidecars (`cache.ts`) are untouched.
 *
 * Open mechanics are exactly `cache.ts`'s: `openSidecar(path)` +
 * `applyProjectScopedMigrations(db, dir)` — but against this Core's SECOND
 * migration tree (`migrations-pipeline/`), because a migration namespace is
 * per-DB-file (`migrations/runner.ts:58-63`) and reusing the cache tree would
 * drag `triage_cache` et al. into the pipeline DB.
 *
 * Per docs/plans/2026-08-06-email-core-consolidation-plan.md § 5.
 */

import type { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyProjectScopedMigrations } from '@neutronai/migrations/runner.ts'
import { openSidecar } from '@neutronai/persistence/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Instance-level sidecar dir name, under `<owner_home>`. No leading dot —
 *  same user-visible convention the per-project `email/` dir uses. */
export const EMAIL_PIPELINE_DIR = 'email'
export const EMAIL_PIPELINE_DB = 'pipeline.db'

/** This Core's SECOND migration tree — see the module header. */
export const EMAIL_PIPELINE_MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations-pipeline')

/** How the poller acted on a message. */
export type EmailHandling = 'escalate' | 'archive'

export interface EmailRow {
  id: string
  thread_id: string
  account_id: string | null
  sender: string
  subject: string
  snippet: string
  body_text: string | null
  received_at: number
  processed_at: number
  /** NULL ⇒ never classified (pre-cutoff mail). */
  category: string | null
  handling: EmailHandling
  brief_id: number | null
  escalated_at: number | null
  escalation_attempts: number
  last_error: string | null
}

/** The caller-supplied half of an `emails` row; the rest defaults. */
export interface InsertEmailInput {
  id: string
  thread_id: string
  account_id?: string | null
  sender: string
  subject: string
  snippet?: string
  body_text?: string | null
  received_at: number
  processed_at: number
  category: string | null
  handling: EmailHandling
  escalation_attempts?: number
}

export interface SenderCacheRow {
  sender: string
  category: string
  updated_at: number
}

export type SenderRuleKind = 'sender' | 'domain'

export interface SenderRule {
  id: number
  pattern: string
  kind: SenderRuleKind
  category: string | null
  handling: string | null
  /** 1 ⇒ always important, immune to the mass-mailer downgrade. */
  protected: number
  created_at: number
}

export interface AddSenderRuleInput {
  pattern: string
  kind: SenderRuleKind
  category?: string | null
  handling?: string | null
  protected?: boolean
  created_at?: number
}

export interface EmailPipelineStoreOptions {
  owner_home: string
  now?: () => number
  /** Override the migration tree. Tests only. */
  migrations_dir?: string
}

/**
 * Typed CRUD over the pipeline sidecar. Every statement is prepared once at
 * construction — a poll tick touches this store once per message.
 */
export class EmailPipelineStore {
  readonly db: Database
  private readonly now: () => number

  constructor(db: Database, now: () => number) {
    this.db = db
    this.now = now
  }

  hasEmail(id: string): boolean {
    const row = this.db.query<{ n: number }, [string]>(`SELECT 1 AS n FROM emails WHERE id = ?`).get(id)
    return row !== null
  }

  getEmail(id: string): EmailRow | null {
    return this.db.query<EmailRow, [string]>(`SELECT * FROM emails WHERE id = ?`).get(id)
  }

  insertEmail(input: InsertEmailInput): void {
    this.db.run(
      `INSERT OR REPLACE INTO emails (
         id, thread_id, account_id, sender, subject, snippet, body_text,
         received_at, processed_at, category, handling, escalation_attempts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.thread_id,
        input.account_id ?? null,
        input.sender,
        input.subject,
        input.snippet ?? '',
        input.body_text ?? null,
        input.received_at,
        input.processed_at,
        input.category,
        input.handling,
        input.escalation_attempts ?? 0,
      ],
    )
  }

  /**
   * Escalations that were ATTEMPTED and failed, and are still under the
   * attempt cap. `escalated_at IS NULL` is the dedup guard itself — a
   * delivered escalation can never come back through this query.
   *
   * `escalation_attempts > 0` keeps the first attempt in the poll path (where
   * the freshly-classified message is escalated inline) rather than making
   * the resume step re-deliver everything it just posted.
   */
  listPendingEscalations(max_attempts: number): EmailRow[] {
    return this.db
      .query<EmailRow, [number]>(
        `SELECT * FROM emails
          WHERE handling = 'escalate'
            AND escalated_at IS NULL
            AND escalation_attempts > 0
            AND escalation_attempts < ?
          ORDER BY received_at ASC`,
      )
      .all(max_attempts)
  }

  markEscalated(id: string, at: number): void {
    this.db.run(`UPDATE emails SET escalated_at = ?, last_error = NULL WHERE id = ?`, [at, id])
  }

  recordEscalationFailure(id: string, error: string, at: number): void {
    this.db.run(
      `UPDATE emails
          SET escalation_attempts = escalation_attempts + 1,
              last_error = ?,
              processed_at = ?
        WHERE id = ?`,
      [error, at, id],
    )
  }

  getCheckpoint(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>(`SELECT value FROM checkpoints WHERE key = ?`)
      .get(key)
    return row === null ? null : row.value
  }

  setCheckpoint(key: string, value: string): void {
    this.db.run(
      `INSERT INTO checkpoints (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    )
  }

  getSenderCache(sender: string): SenderCacheRow | null {
    return this.db
      .query<SenderCacheRow, [string]>(`SELECT * FROM sender_cache WHERE sender = ?`)
      .get(sender)
  }

  upsertSenderCache(sender: string, category: string, at?: number): void {
    this.db.run(
      `INSERT INTO sender_cache (sender, category, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(sender) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at`,
      [sender, category, at ?? this.now()],
    )
  }

  listSenderRules(): SenderRule[] {
    return this.db.query<SenderRule, []>(`SELECT * FROM sender_rules ORDER BY id ASC`).all()
  }

  addSenderRule(input: AddSenderRuleInput): SenderRule {
    this.db.run(
      `INSERT INTO sender_rules (pattern, kind, category, handling, protected, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.pattern,
        input.kind,
        input.category ?? null,
        input.handling ?? null,
        input.protected === true ? 1 : 0,
        input.created_at ?? this.now(),
      ],
    )
    // Non-null: the row was just inserted.
    return this.db
      .query<SenderRule, []>(`SELECT * FROM sender_rules ORDER BY id DESC LIMIT 1`)
      .get() as SenderRule
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Open (creating on first use) the instance-level pipeline sidecar and apply
 * its migration tree. Same two-line open `cache.ts:328-329` performs, minus
 * the per-project resolver.
 */
export function openEmailPipelineStore(input: EmailPipelineStoreOptions): EmailPipelineStore {
  const dir = join(input.owner_home, EMAIL_PIPELINE_DIR)
  mkdirSync(dir, { recursive: true })
  const db = openSidecar(join(dir, EMAIL_PIPELINE_DB))
  applyProjectScopedMigrations(db, input.migrations_dir ?? EMAIL_PIPELINE_MIGRATIONS_DIR)
  return new EmailPipelineStore(db, input.now ?? ((): number => Date.now()))
}
