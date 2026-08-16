/**
 * @neutronai/gateway — WHERE A REFUSED SCOPE MIGRATION GETS JOURNALLED, and
 * how much of it each row is allowed to say.
 *
 * ── THE PROBLEM THIS MODULE EXISTS FOR ─────────────────────────────────────
 * The direction guard (INVARIANTS #116(a)) refuses to let a FALLBACK identity
 * pull rows off an EXPLICIT handle. Its only durable, owner-visible signal is a
 * `system_events` row — and `system_events` is read back through
 * `listRecentForScope`, which is strictly `WHERE project_slug = ?` by design
 * (`persistence/system-events.ts:310-322`). So the row's SCOPE decides whether
 * the warning is readable at all, and a refusal has more candidate scopes than
 * it has readers:
 *
 *   - the ANONYMOUS handle that attempted the move — unreadable by
 *     construction *when this database does not claim it as its own*. `dev`
 *     means "nobody told me who I am"; no owner opens a diagnostics page under
 *     it, and the refusal deliberately does not re-key the ledger, so the next
 *     explicit boot takes the ledger-agrees fast path
 *     (`migrations/scope-rekey.ts:585-594`) and never sweeps the row back. A row
 *     written there is `/dev/null` with a row id.
 *     BUT THE COINCIDENCE IS NOT THE ANONYMITY (Argus r2 blocker, 2026-08-16).
 *     An owner whose instance really IS called `dev` boots explicitly
 *     (`NEUTRON_INSTANCE_SLUG=dev`, source `'env'`), his ledger records `dev`,
 *     and `dev` is the one and only string he ever passes to
 *     `listRecentForScope`. Excluding the attempting handle by STRING EQUALITY
 *     threw that scope away and pushed the row to the next candidate — which is
 *     an unreadable one — making this module worse than the code it replaced on
 *     its own axis. Readability is decided by the EVIDENCE (does the ledger /
 *     `onboarding_state` name this handle as the database's own?), never by
 *     whether the string happens to match the booting process.
 *   - the FROZEN credential handles (`secrets.project_slug` /
 *     `project_credentials.owner_slug`) — the handles the stranded credentials
 *     are stuck under. These are ALSO not, in general, readable: the whole
 *     premise of the credential reconciler is that the frozen handle DIVERGES
 *     from the live one (a rename), so scoping the warning there reproduces the
 *     invisibility it was meant to fix (Argus r1 blocker, 2026-08-16). They are
 *     therefore not a scope on ANY path, including the last resort — a
 *     fallback that engages only in the state nobody tested is a rule that only
 *     holds where it is watched (Argus r2 blocker, 2026-08-16).
 *   - the LIVE handle — the one the owner's own gateway boots as, and therefore
 *     the one his diagnostics feed queries.
 *
 * The refusal belongs to the LIVE handle. That is what
 * {@link resolveOwnerReadableScopes} computes, from the two places this database
 * records who it belongs to: `instance_scope_ledger` (authoritative — it is
 * written only by an explicit boot) and, when the ledger is absent, the distinct
 * `onboarding_state.project_slug` (the anchor table the re-key backfill itself
 * trusts for exactly this question).
 *
 * ── AND HOW MUCH EACH ROW MAY SAY ──────────────────────────────────────────
 * One row per readable scope, and each row's payload is NARROWED to its own
 * scope: its own handle name and its own row count, with everything else
 * reduced to counts. A per-scope fan-out carrying the full multi-handle payload
 * would put scope A's handle names and volumes into scope B's instance-scoped
 * feed — the cross-scope disclosure `listRecentForScope`'s own docblock exists
 * to prevent (Argus r1, 2026-08-16).
 *
 * ── AND HOW OFTEN ──────────────────────────────────────────────────────────
 * The owner's diagnostics window is the newest `DEFAULT_MAX_RECENT_EVENTS` = 50
 * rows and `system_events` has no retention sweep, so two unconditional rows per
 * anonymous boot is a way to evict every OTHER degrade event out of the feed —
 * a warning that starves the report it is trying to appear in. {@link
 * isNewJournalState} makes the journal edge-triggered: identical state, already
 * the latest row under that scope for that event ⇒ nothing is written.
 *
 * THE COMPARISON IS AGAINST THE VISIBLE FEED, NOT AGAINST HISTORY (Argus r2
 * blocker, 2026-08-16). Suppression is only ever "the owner is already looking
 * at this"; measured against unbounded history it becomes "the owner saw this
 * once, years ago, before 50 other events pushed it off the page" — and the
 * warning is then suppressed FOREVER, which is a strictly worse and completely
 * silent version of the invisibility this module exists to remove. So the read
 * is `latestVisibleForScopeAndName(scope, event, DEFAULT_MAX_RECENT_EVENTS)`:
 * the newest matching row *inside the same window the feed returns*. Rotated
 * out ⇒ not visible ⇒ new information ⇒ written again.
 *
 * AND THE READ IS BEST-EFFORT. {@link shouldJournal} owns the try/catch: this
 * runs on the boot path, one corrupt historical `payload_json` row makes the
 * reader throw (`persistence/system-events.ts` `rowToPersisted`, `onCorrupt:
 * 'throw'`), and a dedup optimisation that can abort a boot is a far worse
 * defect than the duplicate row it saves. A failed read means "assume not
 * visible" — write.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { PersistedSystemEvent } from '@neutronai/persistence/system-events.ts'

/** One journal write: which scope reads it, and what it is allowed to say. */
export interface RefusalJournalRow {
  scope: string
  payload: Record<string, unknown>
}

/** A `(table, handle, rows)` orphan tuple, as the credential census reports it. */
export interface OrphanCountish {
  table: string
  handle: string
  rows: number
}

/** Trim, and treat blank as absent — an empty scope key is unreadable forever. */
function usable(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * The handles under which an owner can ACTUALLY read this database's
 * diagnostics feed — i.e. the handles this database RECORDS AS ITS OWN.
 *
 * The ledger wins when it is present: it is written only inside the re-key
 * transaction, by an EXPLICIT boot, and it therefore records the handle the
 * owner's gateway boots as. Only when it is absent (a first boot that never
 * completed the backfill) does this fall back to `onboarding_state`, the anchor
 * table the reconciler itself uses to answer the same question
 * (`migrations/scope-rekey.ts:597-605`).
 *
 * NOTHING IS EXCLUDED BY STRING EQUALITY WITH THE BOOTING PROCESS. If the
 * ledger says this database is `dev`, then `dev` is the handle its owner reads
 * under and the refusal belongs there — even when the process that tripped the
 * guard also resolved to `dev`. The two facts are independent: `source` is what
 * says a boot is anonymous (`gateway/index.ts` `resolveOwnerSlugSourceFromConfig`),
 * and the credential guard arms on `source === 'fallback'` alone
 * (`auth/credential-scope-reconcile.ts`), so this coincidence is REACHABLE —
 * an explicitly-`dev` instance whose credentials are frozen under an older
 * handle. Excluding it moved the only readable row to an unreadable scope
 * (Argus r2 blocker, 2026-08-16).
 *
 * Blank/whitespace handles are dropped on both paths: a row scoped to `''` is
 * the unreadable-forever row this whole module exists to stop writing.
 */
export function resolveOwnerReadableScopes(db: Pick<ProjectDb, 'all'>): string[] {
  const out = new Set<string>()
  const ledger = db.all<{ project_slug: string | null }, []>(
    `SELECT project_slug FROM instance_scope_ledger WHERE id = 1`,
    [],
  )
  for (const row of ledger) {
    const scope = usable(row.project_slug)
    if (scope !== null) out.add(scope)
  }
  if (out.size === 0) {
    const onboarding = db.all<{ project_slug: string | null }, []>(
      `SELECT DISTINCT project_slug FROM onboarding_state`,
      [],
    )
    for (const row of onboarding) {
      const scope = usable(row.project_slug)
      if (scope !== null) out.add(scope)
    }
  }
  return [...out].sort()
}

/**
 * {@link resolveOwnerReadableScopes}, made SAFE FOR THE BOOT PATH.
 *
 * The resolver runs two raw SELECTs, and it is called from `boot()` at a point
 * where `bootFailureCleanup` DOES NOT EXIST YET (`gateway/index.ts` — the sink
 * is registered at `:327`, the cleanup is declared far below at `:664`). So an
 * uncaught throw there does not merely lose the journal row: it escapes `boot()`
 * with the project DB open and the process-wide `SystemEventsStore` still on the
 * ambient sink stack — the half-open boot the surrounding guards at `:310` and
 * `:360` each hand-roll a `clearOwnedSystemEventSink` / `drain` / `close` to
 * prevent. `onboarding_state` and `instance_scope_ledger` are both reachable in
 * states that make those SELECTs throw (a partially-applied migration set, a
 * corrupt page), and the throw would arrive from a DIAGNOSTIC read.
 *
 * This is the same call the module already makes for {@link shouldJournal}, for
 * the same reason and with the same answer: losing the suppression, or the
 * narrowing, costs a row of precision; losing the boot costs the instance. A
 * failed read means "this database records no identity I can prove", which
 * {@link journalScopes} already has a defined answer for — the attempting
 * handle, the documented FLOOR that is exactly what shipped before this module
 * existed. Degraded, never worse, and never fatal.
 */
export function readOwnerReadableScopes(db: Pick<ProjectDb, 'all'>): string[] {
  try {
    return resolveOwnerReadableScopes(db)
  } catch {
    return []
  }
}

/**
 * The scopes a refusal row is actually written under: the readable ones, or —
 * when this database records NO identity at all (no ledger row, no onboarding
 * row) — the attempting handle, as the only handle any reader of this database
 * could currently open.
 *
 * That last resort is a FLOOR, not a preference: it is exactly what shipped
 * before this module existed, so the worst case here is never worse than the
 * code it replaced, and it is reached only on a database with no owner
 * identity recorded anywhere (in the ordinary flow the boot re-key seeds the
 * ledger before this runs — `migrations/scope-rekey.ts`). It is deliberately
 * NOT the frozen credential handles and NOT the stranded re-key keys: a handle
 * whose divergence from the live one is the thing being reported is not a
 * handle anyone reads under, and writing there just moves the invisibility
 * (Argus r1 + r2 blockers, 2026-08-16).
 */
function journalScopes(owner_scopes: string[], attempted_by_slug: string): string[] {
  const readable = [...new Set(owner_scopes.map(usable).filter((s): s is string => s !== null))]
  if (readable.length > 0) return readable.sort()
  const attempted = usable(attempted_by_slug)
  return attempted === null ? [] : [attempted]
}

/**
 * Rows for `instance_scope_rekey_refused` — one per readable scope, narrowed.
 *
 * KEYS ARE TRIMMED BEFORE THEY ARE COMPARED OR COUNTED. The scope on the row is
 * the trimmed handle (`usable`), so a legacy persisted key of `' alpha '` would
 * otherwise report the reader ZERO stranded rows of his own and count his own
 * rows as somebody else's — a payload that is wrong in both directions at once
 * (Argus r2, 2026-08-16). Two keys that trim to the same handle are one handle
 * and their counts add.
 */
export function planInstanceRefusalRows(input: {
  owner_scopes: string[]
  stranded_keys: string[]
  stranded_rows_by_key: Record<string, number>
  attempted_by_slug: string
}): RefusalJournalRow[] {
  const countByKey = new Map<string, number>()
  for (const [key, rows] of Object.entries(input.stranded_rows_by_key)) {
    const trimmed = key.trim()
    countByKey.set(trimmed, (countByKey.get(trimmed) ?? 0) + rows)
  }
  const strandedKeys = [
    ...new Set(input.stranded_keys.map(usable).filter((k): k is string => k !== null)),
  ]
  const totalRows = [...countByKey.values()].reduce((a, n) => a + n, 0)
  return journalScopes(input.owner_scopes, input.attempted_by_slug).map((scope) => {
    const own = countByKey.get(scope) ?? 0
    const others = strandedKeys.filter((k) => k !== scope)
    return {
      scope,
      payload: {
        // The handle THIS row is about. Named, because it is the reader's own.
        stranded_slug: scope,
        stranded_rows: own,
        // Everything else is a COUNT: a foreign handle's NAME in this feed is
        // the cross-scope disclosure the strict scope predicate forbids.
        other_stranded_handles: others.length,
        other_stranded_rows: totalRows - own,
        attempted_by_slug: input.attempted_by_slug,
      },
    }
  })
}

/**
 * Rows for `credential_scope_orphaned` WHEN IT CARRIES `refused_direction` —
 * one per readable scope, narrowed.
 *
 * No handle NAME appears here at all, in either direction. The frozen
 * credential handles are not, in general, the reader's own handle (that
 * divergence IS the defect being reported), so naming them would be disclosing
 * one scope's key into another's feed while telling the reader nothing he can
 * act on in this row. What he needs from the JOURNAL is that an anonymous
 * process was pointed at his database and that N credential rows across these
 * tables are unreachable; the live integrations surface — which is scoped to him
 * and is the place a repair is actually offered — is what names them
 * (`auth/credential-scope-reconcile.ts` `censusCredentialScope`).
 *
 * AND THE FROZEN HANDLES ARE NOT A SCOPE ON ANY PATH — there is no
 * `stale_handles` parameter here at all, so the rule cannot be re-broken by a
 * fallback branch nobody exercises (Argus r2 blocker, 2026-08-16). When no
 * readable handle is recorded, {@link journalScopes} falls back to the
 * attempting handle, which is at worst what shipped before.
 */
export function planCredentialRefusalRows(input: {
  owner_scopes: string[]
  orphan_counts: OrphanCountish[]
  attempted_by_slug: string
}): RefusalJournalRow[] {
  const payload = {
    refused_direction: true,
    orphaned_handles: new Set(input.orphan_counts.map((o) => o.handle)).size,
    orphaned_rows: input.orphan_counts.reduce((a, o) => a + o.rows, 0),
    orphaned_tables: [...new Set(input.orphan_counts.map((o) => o.table))].sort(),
    attempted_by_slug: input.attempted_by_slug,
  }
  return journalScopes(input.owner_scopes, input.attempted_by_slug).map((scope) => ({
    scope,
    payload: { ...payload },
  }))
}

/**
 * Canonical form for comparing two journal payloads — key order is normalised at
 * EVERY depth, so a round-trip through `JSON.stringify`/`parse` compares equal
 * to a freshly built literal.
 *
 * The one-line version of this (`JSON.stringify(p, Object.keys(p).sort())`) is
 * wrong in a way that fails CLOSED: the array form of `stringify`'s second
 * argument is an ALLOWLIST applied recursively, so every key of a nested object
 * that is not also a top-level key is dropped from the output — and two
 * payloads differing only inside a nested object compare EQUAL and the change
 * is silently swallowed. Harmless while every value is a scalar or a string
 * array; a defect the moment anyone adds a `Record<string, number>` such as
 * `stranded_rows_by_key` (Argus r2, 2026-08-16). Array ORDER is preserved —
 * `orphaned_tables` is sorted where it is built, and a reordered array is a
 * change worth reporting anywhere else.
 */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) out[key] = sortKeysDeep(source[key])
  return out
}

/**
 * EDGE-TRIGGERED: is this refusal a state the scope's VISIBLE feed does not
 * already end with? `latest` is the newest row for that `(scope, event)` pair
 * INSIDE the diagnostics window — see {@link shouldJournal}, which is how
 * production reads it.
 *
 * Twenty-five anonymous boots are twenty-five identical refusals, and the
 * owner's window is 50 rows deep with no retention sweep behind it — writing
 * every one of them evicts the events the report exists to show. A CHANGE in the
 * refusal (more rows stranded, a different attempting handle) is new
 * information and does get a row.
 */
export function isNewJournalState(
  latest: PersistedSystemEvent | null,
  payload: Record<string, unknown>,
): boolean {
  if (latest === null) return true
  return canonical(latest.payload) !== canonical(payload)
}

/**
 * The production form of the edge trigger: read the newest VISIBLE row for this
 * `(scope, event)` pair, and decide.
 *
 * `readLatest` is the caller's bound
 * `SystemEventsStore.latestVisibleForScopeAndName(scope, event,
 * DEFAULT_MAX_RECENT_EVENTS)` — window-bounded, because suppression is only
 * ever "the owner is already looking at this".
 *
 * A THROWN READ MEANS WRITE. This runs synchronously on the boot path, before
 * the boot's own failure cleanup exists, and the reader deserialises stored
 * payloads with `onCorrupt: 'throw'` — so ONE corrupt historical row would turn
 * a best-effort dedup into a boot abort with the database already open
 * (Argus r2, 2026-08-16). Losing the suppression costs one duplicate row;
 * losing the boot costs the instance.
 */
export function shouldJournal(
  readLatest: () => PersistedSystemEvent | null,
  payload: Record<string, unknown>,
): boolean {
  let latest: PersistedSystemEvent | null = null
  try {
    latest = readLatest()
  } catch {
    return true
  }
  return isNewJournalState(latest, payload)
}
