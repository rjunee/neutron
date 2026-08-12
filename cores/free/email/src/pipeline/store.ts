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

import { openSidecar } from '@neutronai/persistence/index.ts'

// NOT `@neutronai/migrations/runner.ts` directly. A bundled Core may not import
// `migrations/` (`cores-use-sdk-only`), and the layering baseline that
// grandfathers `cache.ts`'s edge may only SHRINK, so this module goes through
// the Core's single owned seam instead. See `applyEmailSidecarMigrations`.
import { applyEmailSidecarMigrations } from '../cache.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Instance-level sidecar dir name, under `<owner_home>`. No leading dot —
 *  same user-visible convention the per-project `email/` dir uses. */
export const EMAIL_PIPELINE_DIR = 'email'
export const EMAIL_PIPELINE_DB = 'pipeline.db'

/** This Core's SECOND migration tree — see the module header. */
export const EMAIL_PIPELINE_MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations-pipeline')

/**
 * How the poller acted on a message.
 *
 * `preexisting` is the BACKLOG marker: mail that was already in the inbox when
 * the pipeline was switched on. The owner has already triaged it by hand, so it
 * is recorded as handled and then left completely alone — never classified,
 * never escalated, never briefed, and never label-mutated. Its row exists for
 * exactly one reason: `hasEmail` is the steady-state "already handled" test, so
 * a row here is what keeps the backlog out of the pipeline forever after
 * WITHOUT re-deciding "is this history?" on every future poll.
 */
export type EmailHandling = 'escalate' | 'archive' | 'preexisting'

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
  /** NULL ⇒ the Gmail label/archive write is still owed. See the migration. */
  mutated_at: number | null
  mutation_attempts: number
  /** NULL ⇒ the best-effort mobile push has not gone out for this message. */
  pushed_at: number | null
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
  /** 1 when the learned verdict was IMPORTANT. Stored, never re-derived from
   *  the category — the two are separate facts and do disagree. */
  important: number
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

  /**
   * "Already handled?" — keyed on (account, message), because Gmail ids are
   * ACCOUNT-LOCAL. Matching on the id alone would report a message from a
   * SECOND mailbox as already seen the moment the first mailbox happened to
   * use that id, and the poller would skip it silently: no classification, no
   * escalation, no brief row. `account_id` defaults to the '' single-account
   * sentinel so a single-backend install is unaffected.
   */
  hasEmail(id: string, account_id: string | null = null): boolean {
    const row = this.db
      .query<{ n: number }, [string, string]>(
        `SELECT 1 AS n FROM emails WHERE id = ? AND account_id = ?`,
      )
      .get(id, account_id ?? '')
    return row !== null
  }

  getEmail(id: string, account_id: string | null = null): EmailRow | null {
    return this.db
      .query<EmailRow, [string, string]>(
        `SELECT * FROM emails WHERE id = ? AND account_id = ?`,
      )
      .get(id, account_id ?? '')
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
        // '' is the single-account sentinel — NEVER NULL. A NULL component in
        // the (account_id, id) primary key never compares equal, so the same
        // message would insert twice and escalate twice.
        input.account_id ?? '',
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
   * EVERY escalation the owner has not been told about, under the attempt cap.
   * `escalated_at IS NULL` is the dedup guard itself — a delivered escalation
   * can never come back through this query.
   *
   * This deliberately includes rows with ZERO attempts. The query used to
   * require `attempts > 0` on the reasoning that the first attempt belongs to
   * the poll path — but that stranded any row inserted just before a crash:
   * the poll path skips it (`hasEmail` is true) and the resume path skipped it
   * too, so an important message sat in the store forever, undelivered and
   * invisible. Nothing is double-posted by including them, because a delivered
   * row has `escalated_at` set and a row this tick just posted is not visible
   * to a resume pass that already ran.
   */
  listPendingEscalations(max_attempts: number): EmailRow[] {
    return this.db
      .query<EmailRow, [number]>(
        `SELECT * FROM emails
          WHERE handling = 'escalate'
            AND escalated_at IS NULL
            AND escalation_attempts < ?
          ORDER BY received_at ASC`,
      )
      .all(max_attempts)
  }

  /** The best-effort push has gone out for this message; never send it again. */
  markPushed(id: string, at: number, account_id: string | null = null): void {
    this.db.run(
      `UPDATE emails SET pushed_at = ? WHERE id = ? AND account_id = ?`,
      [at, id, account_id ?? ''],
    )
  }

  /** Account-qualified, like `hasEmail` — the id alone is not an identity. */
  markEscalated(id: string, at: number, account_id: string | null = null): void {
    this.db.run(
      `UPDATE emails SET escalated_at = ?, last_error = NULL WHERE id = ? AND account_id = ?`,
      [at, id, account_id ?? ''],
    )
  }

  /**
   * Record that an escalation attempt is ABOUT TO BE MADE — before the call,
   * not after it fails.
   *
   * Counting the attempt afterwards left a crash-shaped hole. The row is
   * inserted before `deliver` runs, so a process exit in between left
   * `escalated_at NULL` with `escalation_attempts = 0`. The poll path then
   * skipped that message forever (`hasEmail` is true) and the resume query
   * skipped it too — it requires `attempts > 0` so a freshly-posted message is
   * not immediately re-posted. The message existed, was important, and could
   * never be delivered by anything.
   *
   * Incrementing FIRST closes it: an INTERRUPTED attempt becomes
   * indistinguishable from a FAILED one, which is exactly right — in both cases
   * the owner has not been told and the work is still owed.
   */
  beginEscalationAttempt(id: string, at: number, account_id: string | null = null): void {
    this.db.run(
      `UPDATE emails
          SET escalation_attempts = escalation_attempts + 1,
              processed_at = ?
        WHERE id = ? AND account_id = ?`,
      [at, id, account_id ?? ''],
    )
  }

  /** The attempt itself was already counted by `beginEscalationAttempt`. */
  recordEscalationFailure(
    id: string,
    error: string,
    at: number,
    account_id: string | null = null,
  ): void {
    this.db.run(
      `UPDATE emails
          SET last_error = ?,
              processed_at = ?
        WHERE id = ? AND account_id = ?`,
      [error, at, id, account_id ?? ''],
    )
  }

  /**
   * Rows whose Gmail label/archive write is still OWED, under the attempt cap.
   *
   * This is the other half of "record before you mutate": the row is written
   * first so a mutated message always has a durable record, which means the
   * row's existence proves only that the message was SEEN. Without this query,
   * a `modifyMessage` failure would be permanent — `hasEmail` skips the
   * message forever, the archive never happens, and nothing ever retries.
   *
   * `preexisting` is excluded because the backlog is never mutated by design.
   */
  listPendingMutations(max_attempts: number): EmailRow[] {
    return this.db
      .query<EmailRow, [number]>(
        `SELECT * FROM emails
          WHERE mutated_at IS NULL
            AND handling <> 'preexisting'
            AND mutation_attempts < ?
          ORDER BY received_at ASC`,
      )
      .all(max_attempts)
  }

  /** Account-qualified, like `hasEmail` — the id alone is not an identity. */
  markMutated(id: string, at: number, account_id: string | null = null): void {
    this.db.run(`UPDATE emails SET mutated_at = ? WHERE id = ? AND account_id = ?`, [
      at,
      id,
      account_id ?? '',
    ])
  }

  recordMutationFailure(
    id: string,
    error: string,
    account_id: string | null = null,
  ): void {
    this.db.run(
      `UPDATE emails
          SET mutation_attempts = mutation_attempts + 1,
              last_error = ?
        WHERE id = ? AND account_id = ?`,
      [error, id, account_id ?? ''],
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

  upsertSenderCache(sender: string, category: string, important = false, at?: number): void {
    this.db.run(
      `INSERT INTO sender_cache (sender, category, important, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(sender) DO UPDATE SET category = excluded.category,
                                           important = excluded.important,
                                           updated_at = excluded.updated_at`,
      [sender, category, important ? 1 : 0, at ?? this.now()],
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
  applyEmailSidecarMigrations(db, input.migrations_dir ?? EMAIL_PIPELINE_MIGRATIONS_DIR)
  return new EmailPipelineStore(db, input.now ?? ((): number => Date.now()))
}
