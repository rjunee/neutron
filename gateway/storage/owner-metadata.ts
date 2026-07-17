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
 * etc.) land as additive columns on the same row.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'

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
