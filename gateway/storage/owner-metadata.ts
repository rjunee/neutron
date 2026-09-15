/**
 * @neutronai/gateway/storage — per-project `instance_metadata` reader.
 *
 * Closes ISSUES #40. The P6.1 nudge engine + current-focus surface had been
 * documenting "resolved from `instance_metadata.timezone` at engine invocation"
 * (see migrations/0045_p6_1_nudge_staleness.sql line 21) but neither call
 * site read the table — every instance fell back to `DEFAULT_OWNER_TIMEZONE`
 * regardless of the user's actual zone. This module supplies the missing read
 * so the wiring honours the spec.
 *
 * The `instance_metadata` table is per-project DB (one row per `project_slug`).
 * Migration 0050 creates it; future instance-level fields (locale, week-start,
 * etc.) land as additive columns on the same row. `transcription_backend`
 * (migration 0111 — which voice-note transcriber the owner chose) is the second
 * such field and is read/written here for the same reason: one module owns the
 * table, so a second reader can't drift from the first on what a NULL means.
 */

import { parsePhaseModelConfig } from '@neutronai/trident/phase-models.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  isTranscriptionBackendChoice,
  type TranscriptionBackendChoice,
} from '@neutronai/gateway/transcription/types.ts'

/**
 * Read the IANA timezone identifier for `project_slug` from `instance_metadata`.
 * Returns the column value (which may be `null` if the row exists but the
 * column was never written), or `null` when no row exists. Callers translate
 * `null` into their default — they DO NOT see the difference between
 * "no row" and "row with NULL timezone."
 */
export function readOwnerTimezone(
  db: ProjectDb,
  project_slug: string,
): string | null {
  const row = db
    .prepare<{ timezone: string | null }, [string]>(
      `SELECT timezone FROM instance_metadata WHERE instance_slug = ? LIMIT 1`,
    )
    .get(project_slug)
  if (row === null || row === undefined) return null
  if (typeof row.timezone !== 'string' || row.timezone.length === 0) {
    return null
  }
  return row.timezone
}

/**
 * Upsert the timezone for `project_slug`. Used by tests + future admin UI.
 * Preserves any other columns on the row by routing the timezone update
 * through `ON CONFLICT … DO UPDATE`.
 */
export async function writeOwnerTimezone(
  db: ProjectDb,
  project_slug: string,
  timezone: string,
): Promise<void> {
  await db.run(
    `INSERT INTO instance_metadata (instance_slug, timezone) VALUES (?, ?)
       ON CONFLICT(instance_slug) DO UPDATE SET timezone = excluded.timezone`,
    [project_slug, timezone],
  )
}

/** NULL is the product default: briefs are enabled unless explicitly disabled. */
export function readEmailDigestEnabled(db: ProjectDb, project_slug: string): boolean {
  const row = db
    .prepare<{ email_digest_enabled: number | null }, [string]>(
      `SELECT email_digest_enabled FROM instance_metadata WHERE instance_slug = ? LIMIT 1`,
    )
    .get(project_slug)
  return row?.email_digest_enabled !== 0
}

export async function writeEmailDigestEnabled(
  db: ProjectDb,
  project_slug: string,
  enabled: boolean,
): Promise<void> {
  await db.run(
    `INSERT INTO instance_metadata (instance_slug, email_digest_enabled) VALUES (?, ?)
       ON CONFLICT(instance_slug) DO UPDATE SET email_digest_enabled = excluded.email_digest_enabled`,
    [project_slug, enabled ? 1 : 0],
  )
}

/**
 * Read the owner's chosen voice-note transcriber (migration 0111).
 *
 * Returns `null` for "never chosen" — which covers no row, a NULL column, AND a
 * column holding anything other than the two legal values. A stored value the
 * code no longer recognises must never be coerced into one of the live options:
 * that would resolve an unanswered question by guessing, which is the whole
 * behaviour this setting replaces.
 */
export function readTranscriptionBackend(
  db: ProjectDb,
  project_slug: string,
): TranscriptionBackendChoice | null {
  const row = db
    .prepare<{ transcription_backend: string | null }, [string]>(
      `SELECT transcription_backend FROM instance_metadata WHERE instance_slug = ? LIMIT 1`,
    )
    .get(project_slug)
  if (row === null || row === undefined) return null
  return isTranscriptionBackendChoice(row.transcription_backend) ? row.transcription_backend : null
}

/**
 * Persist the owner's chosen transcriber. Upserts through `ON CONFLICT` so the
 * timezone already on the row survives (and vice versa).
 *
 * There is deliberately no "clear the choice" path: once the owner has said
 * which transcriber they want, un-saying it would drop them back into the
 * unchosen state for no reason they asked for. They change it by choosing the
 * other one.
 */
export async function writeTranscriptionBackend(
  db: ProjectDb,
  project_slug: string,
  backend: TranscriptionBackendChoice,
): Promise<void> {
  await db.run(
    `INSERT INTO instance_metadata (instance_slug, transcription_backend) VALUES (?, ?)
       ON CONFLICT(instance_slug) DO UPDATE SET transcription_backend = excluded.transcription_backend`,
    [project_slug, backend],
  )
}

/**
 * Read the owner's per-phase trident model/effort overrides (migration 0118).
 *
 * RE-VALIDATED ON THE WAY OUT, not trusted because it is stored. A row written by
 * an older or looser build must not reach the workflow: once a value is inside
 * `inner-workflow.mjs` the only available response to a bad entry is to log and
 * continue, and a log line in a detached background run is not a channel anyone
 * reads. So the last typed layer is the last chance to drop it, and it takes it.
 *
 * Returns `{}` for absent / NULL / unparseable / fully-invalid — all of which mean
 * "no overrides", which is the same thing the caller does with them. A partially
 * valid stored object yields only its valid entries, matching the write path's own
 * partial-acceptance shape.
 */
export function readTridentPhaseModels(
  db: ProjectDb,
  project_slug: string,
): Readonly<Record<string, { model?: string; effort?: string }>> {
  const { config, rejected } = readTridentPhaseModelsWithRejected(db, project_slug)
  const out = { ...config }
  for (const key of ['review_codex', 'review_kimi']) {
    if (rejected[key]?.model) out[key] = { model: rejected[key]!.model! }
  }
  return out
}

/**
 * The same read, KEEPING what validation threw away.
 *
 * A settings pane needs both halves. A stored override naming a tier that has since
 * been retired must not simply vanish into the default — the owner chose something,
 * and a control that silently reverts is one they cannot trust again. So the pane gets
 * `rejected` alongside `config` and renders the dead value struck through, naming the
 * invalid value. The build read preserves rejected peer model selections so the
 * panel refuses them by name; other phases retain validated defaults.
 */
export function readTridentPhaseModelsWithRejected(
  db: ProjectDb,
  project_slug: string,
): {
  config: Readonly<Record<string, { model?: string; effort?: string }>>
  rejected: Readonly<Record<string, { model?: string; effort?: string }>>
} {
  const row = db
    .prepare<{ trident_phase_models: string | null }, [string]>(
      `SELECT trident_phase_models FROM instance_metadata WHERE instance_slug = ? LIMIT 1`,
    )
    .get(project_slug)
  const raw = row?.trident_phase_models
  if (typeof raw !== 'string' || raw.trim().length === 0) return { config: {}, rejected: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupt JSON is "no overrides", never a thrown error on a build launch.
    return { config: {}, rejected: {} }
  }
  const { config, rejected } = parsePhaseModelConfig(parsed)
  return { config, rejected }
}

/**
 * Persist the owner's per-phase overrides.
 *
 * THE WRITE FAILS WHOLE when any entry is invalid — it returns the errors and
 * stores nothing. This is the opposite of the read path above and the asymmetry is
 * the point: at the settings boundary the owner is present and can be told, so a
 * silent partial write is the worst outcome available (they would set `xhigh`,
 * observe nothing, and reasonably conclude the feature is broken). At build time,
 * explicit peer selections must survive reads for named refusal; other invalid
 * entries use validated defaults.
 *
 * An empty config clears the setting to NULL rather than storing `{}`, so "never
 * configured" and "configured to nothing" are one state instead of two.
 */
export async function writeTridentPhaseModels(
  db: ProjectDb,
  project_slug: string,
  input: unknown,
): Promise<{ ok: boolean; errors: ReadonlyArray<string> }> {
  const { config, errors } = parsePhaseModelConfig(input)
  if (errors.length > 0) return { ok: false, errors }
  const value = Object.keys(config).length > 0 ? JSON.stringify(config) : null
  await db.run(
    `INSERT INTO instance_metadata (instance_slug, trident_phase_models) VALUES (?, ?)
       ON CONFLICT(instance_slug) DO UPDATE SET trident_phase_models = excluded.trident_phase_models`,
    [project_slug, value],
  )
  return { ok: true, errors: [] }
}

/** Upper bound on an accepted IANA identifier (the longest real zone,
 *  `America/Argentina/Buenos_Aires`, is 31 chars; 64 is comfortable headroom
 *  and caps a hostile client's payload). */
export const MAX_TIMEZONE_LEN = 64

/**
 * Validate that `tz` is a real IANA timezone identifier (ISSUES #40 WRITE
 * path). The authoritative check is a `new Intl.DateTimeFormat(..., { timeZone })`
 * construction, which throws `RangeError` on any unknown / malformed identifier
 * — exactly the semantics migration 0050's header describes ("Validated by
 * `Intl.DateTimeFormat` … an unknown identifier throws"). This is the SERVER's
 * gate against a client sending garbage (a typo, an injection string,
 * `"UTC; DROP …"`): a rejected value is NEVER written, so the nudge read never
 * resolves a poison zone and `resolveOwnerDay` never throws at tick time.
 */
export function isValidIanaTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string') return false
  if (tz.length === 0 || tz.length > MAX_TIMEZONE_LEN) return false
  try {
    // Throws RangeError for an unknown / malformed identifier; a valid zone
    // constructs cleanly. `undefined` locale keeps this locale-independent.
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Outcome of {@link persistOwnerTimezoneIfChanged} — the exact reason the write
 *  did (or did not) happen, so callers can log/assert without re-deriving it. */
export type OwnerTimezonePersistResult = 'written' | 'unchanged' | 'invalid'

/**
 * Validate + idempotently persist a client-reported IANA timezone (ISSUES #40).
 *
 * The single server-side write chokepoint the app-ws surface calls when a client
 * reports its zone on connect. It:
 *   1. REJECTS garbage — a value that fails {@link isValidIanaTimezone} returns
 *      `'invalid'` and is NEVER written (fail-closed: the stored zone is left
 *      untouched, so a hostile/broken client can't poison the nudge read).
 *   2. DE-DUPES — when the stored zone already equals `tz` it returns
 *      `'unchanged'` WITHOUT a write, so a reconnecting client that reports the
 *      same zone on every open doesn't churn the row.
 *   3. WRITES — only a valid, changed zone upserts via {@link writeOwnerTimezone}
 *      and returns `'written'`.
 *
 * Keyed on `project_slug` (the socket's auth-resolved owner/instance slug), so it
 * only ever writes the OWNER's own zone — never a client-supplied identity.
 */
export async function persistOwnerTimezoneIfChanged(
  db: ProjectDb,
  project_slug: string,
  tz: string,
): Promise<OwnerTimezonePersistResult> {
  if (!isValidIanaTimezone(tz)) return 'invalid'
  if (readOwnerTimezone(db, project_slug) === tz) return 'unchanged'
  await writeOwnerTimezone(db, project_slug, tz)
  return 'written'
}

/** Live instance default. Invalid stored values fail at the shared resolver. */
export function readInstanceModelProvider(db: ProjectDb, instance: string): string | null {
  return db.prepare<{ model_provider: string | null }, [string]>(
    'SELECT model_provider FROM instance_metadata WHERE instance_slug = ?',
  ).get(instance)?.model_provider ?? null
}

/** Used by provisioning and live configuration; SQL enforces the provider vocabulary. */
export async function writeInstanceModelProvider(
  db: ProjectDb, instance: string, provider: string | null,
): Promise<'written' | 'unchanged'> {
  const current = readInstanceModelProvider(db, instance)
  const initialized = db.prepare<{ model_provider_initialized: number }, [string]>(
    'SELECT model_provider_initialized FROM instance_metadata WHERE instance_slug = ?',
  ).get(instance)?.model_provider_initialized === 1
  if (initialized && current === provider) return 'unchanged'
  await db.run(
    `INSERT INTO instance_metadata (instance_slug, model_provider, model_provider_initialized) VALUES (?, ?, 1)
     ON CONFLICT(instance_slug) DO UPDATE SET model_provider = excluded.model_provider, model_provider_initialized = 1`,
    [instance, provider],
  )
  return 'written'
}

/** One-time import of the former boot setting; explicit configuration always wins. */
export async function initializeInstanceModelProvider(
  db: ProjectDb, instance: string, legacyProvider: string | null,
): Promise<void> {
  await db.run(
    `INSERT INTO instance_metadata (instance_slug, model_provider, model_provider_initialized) VALUES (?, ?, 1)
     ON CONFLICT(instance_slug) DO UPDATE SET model_provider = excluded.model_provider, model_provider_initialized = 1
     WHERE instance_metadata.model_provider_initialized = 0`,
    [instance, legacyProvider],
  )
}
