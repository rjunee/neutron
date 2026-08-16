/**
 * @neutronai/gateway — WHERE A REFUSED SCOPE MIGRATION GETS JOURNALLED, and
 * how much of it each row is allowed to say.
 *
 * ── THE PROBLEM THIS MODULE EXISTS FOR ─────────────────────────────────────
 * The direction guard (INVARIANTS #116(a)) refuses to let a FALLBACK identity
 * pull rows off an EXPLICIT handle. Its only durable, owner-visible signal is a
 * `system_events` row — and `system_events` is read back through
 * `listRecentForScope`, which is strictly `WHERE project_slug = ?` by design
 * (`persistence/system-events.ts:337-349`). So the row's SCOPE decides whether
 * the warning is readable at all, and a refusal has more candidate scopes than
 * it has readers:
 *
 *   - the ANONYMOUS handle that attempted the move — unreadable by
 *     construction *when this database does not claim it as its own*. `dev`
 *     means "nobody told me who I am"; no owner opens a diagnostics page under
 *     it, and the refusal deliberately does not re-key the ledger, so the next
 *     explicit boot takes the ledger-agrees fast path
 *     (`migrations/scope-rekey.ts:596-609`) and never sweeps the row back. A row
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
 * records who it belongs to: `instance_scope_ledger` (authoritative — it names a
 * handle this database has committed to inside the re-key transaction; see that
 * function for why "explicit boots only" is NOT the property being relied on)
 * and, when the ledger is absent, the distinct `onboarding_state.project_slug`
 * (the anchor table the re-key backfill itself trusts for exactly this
 * question).
 *
 * ── AND HOW MUCH EACH ROW MAY SAY ──────────────────────────────────────────
 * One row per readable scope, and each row's payload is NARROWED to its own
 * scope: its own handle NAMED, every other handle reduced to a count. A
 * per-scope fan-out carrying the full multi-handle payload would put scope A's
 * handle names and volumes into scope B's instance-scoped feed — the cross-scope
 * disclosure `listRecentForScope`'s own docblock exists to prevent (Argus r1,
 * 2026-08-16). And no ACTIVITY-COUPLED count in either direction — see the next
 * section, which is where that constraint comes from, why it is not merely
 * about disclosure, and why it bans coupling rather than numbers per se.
 *
 * ── AND HOW OFTEN ──────────────────────────────────────────────────────────
 * The owner's diagnostics window is the newest `DEFAULT_MAX_RECENT_EVENTS` = 50
 * rows and `system_events` has no retention sweep, so two unconditional rows per
 * anonymous boot is a way to evict every OTHER degrade event out of the feed —
 * a warning that starves the report it is trying to appear in. {@link
 * isNewJournalState} makes the journal edge-triggered: a payload already visible
 * under that scope for that event ⇒ nothing is written.
 *
 * AN EDGE TRIGGER IS ONLY AS STABLE AS THE PAYLOAD IT HASHES, AND THAT IS A
 * CONSTRAINT ON WHAT MAY GO IN A PAYLOAD (Argus r2 blocker on PR #322,
 * 2026-08-16). Any field that moves with ordinary owner activity re-arms the
 * trigger on every boot and restores the starvation in full, silently, on
 * precisely the instances that are in use — while every test that boots against
 * an idle database still passes. `instance_scope_rekey_refused` carried
 * `stranded_rows`, a `COUNT(*)` over ~40 swept tables including `tasks` and
 * `reminders`, and did exactly that. So the rule these payloads are now built to
 * is: NO FIELD THAT MOVES WHEN THE OWNER MERELY USES HIS INSTANCE. It is a rule
 * about COUPLING, not about numbers per se: {@link planCredentialRefusalRows}
 * lawfully carries `orphaned_rows`/`orphaned_handles`, because those count rows
 * in the credential tables only — tasks and reminders never touch them, so they
 * move only when the orphaned credential set itself changes, and a changed
 * orphan set IS new information worth a fresh row. Volumes that drift with use
 * go to the log lines, which are unbounded and compete with nothing. See
 * {@link planInstanceRefusalRows}.
 *
 * THE COMPARISON IS AGAINST THE VISIBLE FEED, NOT AGAINST HISTORY (Argus r2
 * blocker, 2026-08-16). Suppression is only ever "the owner is already looking
 * at this"; measured against unbounded history it becomes "the owner saw this
 * once, years ago, before 50 other events pushed it off the page" — and the
 * warning is then suppressed FOREVER, which is a strictly worse and completely
 * silent version of the invisibility this module exists to remove. So the read
 * is `listVisibleForScopeAndName(scope, event, DEFAULT_MAX_RECENT_EVENTS)`:
 * the matching rows *inside the same window the feed returns*. Rotated
 * out ⇒ not visible ⇒ new information ⇒ written again.
 *
 * AND AGAINST THE WHOLE PAGE, NOT ITS LAST LINE (Argus r1 blocker on PR #322,
 * 2026-08-16). `credential_scope_orphaned` carries TWO payload shapes under ONE
 * `(scope, event_name)` key — this module's refusal and `gateway/index.ts`'s
 * ordinary ambiguous census — so a box whose boots ALTERNATE between anonymous
 * and explicit produces a newest row that differs from the payload every single
 * time. Comparing only against the newest row, both branches then wrote on
 * every boot and the 50-row window drained exactly as if there were no trigger
 * at all; making both branches edge-trigger (the r2 fix) did not close it,
 * because the hole is in the COMPARISON and not in the coverage.
 * {@link isNewJournalState} therefore asks whether this payload is already
 * ANYWHERE in the visible set. Two alternating shapes settle at two rows.
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
 * The ledger wins when it is present: it is written inside the re-key
 * transaction, and it therefore records the handle a boot of THIS database
 * committed to. Only when it is absent (a first boot that never completed the
 * backfill) does this fall back to `onboarding_state`, the anchor table the
 * reconciler itself uses to answer the same question (`migrations/scope-rekey.ts`
 * — the stale-key discovery query).
 *
 * "WRITTEN ONLY BY AN EXPLICIT BOOT" IS NOT TRUE AND THIS MODULE MUST NOT REST
 * ON IT (Argus r2 blocker, 2026-08-16 — a docblock stating a property one branch
 * of the code contradicts, CLAUDE.md rule 3a). A FALLBACK boot returns early
 * without touching the ledger only when something is STRANDED; on a database
 * with nothing stranded it falls straight through to the seed and writes `dev`
 * (`migrations/scope-rekey.ts` — the guard's `staleKeys.length > 0` condition,
 * then the ledger INSERT below it; proven by
 * `migrations/__tests__/scope-rekey-direction-guard.test.ts` "a FRESH dev box
 * still seeds"). The property this module actually needs is the weaker and
 * true one — the ledger names a handle THIS database has booted under, so it is
 * a handle whose diagnostics feed someone can open — and that holds on both
 * branches. It is also self-correcting: the only way a fallback boot seeds `dev`
 * is on a database with no other identity in it, and the first explicit boot
 * afterwards re-keys forward and overwrites it.
 *
 * NOTHING IS EXCLUDED BY STRING EQUALITY WITH THE BOOTING PROCESS. If the
 * ledger says this database is `dev`, then `dev` is the handle its owner reads
 * under and the refusal belongs there — even when the process that tripped the
 * guard also resolved to `dev`. The two facts are independent: `source` is what
 * says a boot is anonymous — and that resolver LIVES in `config/index.ts`
 * `resolveOwnerSlugSourceFromConfig` since #320, `gateway/index.ts` merely
 * re-exports it, because defining it on the entry module put the entry into the
 * Open composer's import graph. INVARIANTS #116(a) insists on that precise
 * pointer for the same reason (Argus r1, 2026-08-16).
 * The credential guard arms on `source === 'fallback'` alone
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
 * NO ROW COUNT APPEARS IN THIS PAYLOAD, AND THAT IS THE WHOLE POINT (Argus r2
 * blocker on PR #322, 2026-08-16). It used to carry `stranded_rows` — the
 * reader's own handle's share of `countRowsByKey`, a `COUNT(*)` across every
 * swept table (`migrations/scope-rekey.ts` `SCOPE_SWEEP_COLUMNS`). Two things
 * were wrong with it at once, and they are the same mistake seen from two sides:
 *
 *   - IT DRIFTS, so the edge trigger never fired on a box anyone was USING.
 *     `tasks`, `reminders`, `topics`, `gateway_events`, `work_board_items` are
 *     all swept, so writing one task between two anonymous boots changed the
 *     payload, {@link isNewJournalState} correctly read that as new information,
 *     and the row was written AGAIN — unbounded, into the 50-row window with no
 *     retention sweep behind it. Measured on this branch before the fix: four
 *     anonymous boots with one task created between each produced FOUR rows and
 *     a count that climbed 1 → 3 → 4. Every earlier dedup test passed because
 *     each one boots against a database nobody touches, which freezes the
 *     payload by construction and never asks the trigger a hard question. So the
 *     starvation this module exists to prevent was live on exactly the instances
 *     it was written for, and invisible on every instance it was tested on.
 *   - IT IS ALSO A LIE. Since the row moved to the LIVE handle, `stranded_slug`
 *     was the READER'S OWN handle and `stranded_rows` was his own healthy row
 *     count. The guard REFUSED: nothing of his moved, nothing of his is
 *     stranded. The feed rendered his ordinary growth as a worsening data-loss
 *     condition. The names described the WRITER's frame (the re-key's stale
 *     keys) and were read in the READER's — CLAUDE.md rule 10, in the payload
 *     rather than in a field name.
 *
 * The cure for both is the same: the reader is told WHAT HAPPENED, which does
 * not drift, instead of HOW MUCH, which does and is not his to worry about.
 * An anonymous process was pointed at this database and tried to pull rows off
 * his handle; it was refused. The number of rows at stake keeps its value for
 * the operator and stays where an unbounded stream belongs — the log line at
 * `migrations/scope-rekey.ts` `scope_rekey_refused_fallback_direction` and
 * `gateway/index.ts` `instance_scope_rekey_refused`, neither of which competes
 * for the owner's 50 slots.
 *
 * KEYS ARE TRIMMED BEFORE THEY ARE COMPARED. The scope on the row is the trimmed
 * handle (`usable`), so a legacy persisted key of `' alpha '` is the same handle
 * as `'alpha'` and must not also be counted as a foreign one (Argus r2,
 * 2026-08-16).
 */
export function planInstanceRefusalRows(input: {
  owner_scopes: string[]
  stranded_keys: string[]
  attempted_by_slug: string
}): RefusalJournalRow[] {
  const targetedKeys = [
    ...new Set(input.stranded_keys.map(usable).filter((k): k is string => k !== null)),
  ]
  return journalScopes(input.owner_scopes, input.attempted_by_slug).map((scope) => ({
    scope,
    payload: {
      // The handle THIS row is about: the one the anonymous boot would have
      // pulled rows OFF. Named, because it is the reader's own. `targeted`, not
      // `stranded` — the guard held, so nothing of his is stranded anywhere.
      targeted_slug: scope,
      // Everything else is a COUNT: a foreign handle's NAME in this feed is the
      // cross-scope disclosure the strict scope predicate forbids. A count of
      // HANDLES, not of rows — the handle set is the refusal, and it does not
      // move when the owner uses his instance.
      other_targeted_handles: targetedKeys.filter((k) => k !== scope).length,
      attempted_by_slug: input.attempted_by_slug,
    },
  }))
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
 * array; a defect the moment anyone NESTS an object in a payload
 * (Argus r2, 2026-08-16). Array ORDER is preserved —
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
 * ALREADY CONTAIN? `visible` is every row for that `(scope, event)` pair inside
 * the diagnostics window — see {@link shouldJournal}, which is how production
 * reads it.
 *
 * Twenty-five anonymous boots are twenty-five identical refusals, and the
 * owner's window is 50 rows deep with no retention sweep behind it — writing
 * every one of them evicts the events the report exists to show. A CHANGE in the
 * refusal (more rows stranded, a different attempting handle) is new
 * information and does get a row.
 *
 * THE TEST IS MEMBERSHIP, NOT "IS IT THE LATEST" (Argus r1 blocker on PR #322,
 * 2026-08-16). `credential_scope_orphaned` is written in TWO payload shapes
 * under ONE `(scope, event_name)` key — the direction refusal
 * ({@link planCredentialRefusalRows}) and the ordinary ambiguous census
 * (`gateway/index.ts`). A box that alternates between them — an anonymous boot,
 * then an explicit one, then anonymous again, which is what a unit that
 * intermittently loses its slug env actually does — makes the NEWEST row differ
 * from the payload on every single boot, so a latest-only comparison writes
 * every boot and drains the 50-row window regardless. Both branches
 * edge-triggering does not help; the trigger itself has to look at the page
 * rather than at its last line. Against the whole visible set the second
 * occurrence of either shape is already something the owner is looking at, and
 * the feed settles at one row per distinct shape.
 *
 * It also generalises: any future third shape on this event key is covered
 * without anyone having to notice it exists.
 *
 * The window bound is what keeps this recoverable — a row that rotated out is
 * not visible, so it is new information again (see
 * `persistence/system-events.ts` `listVisibleForScopeAndName`).
 */
export function isNewJournalState(
  visible: readonly PersistedSystemEvent[],
  payload: Record<string, unknown>,
): boolean {
  const wanted = canonical(payload)
  return !visible.some((row) => canonical(row.payload) === wanted)
}

/**
 * The production form of the edge trigger: read the VISIBLE rows for this
 * `(scope, event)` pair, and decide.
 *
 * `readVisible` is the caller's bound
 * `SystemEventsStore.listVisibleForScopeAndName(scope, event,
 * DEFAULT_MAX_RECENT_EVENTS)` — window-bounded, because suppression is only
 * ever "the owner is already looking at this".
 *
 * THE WINDOW ARGUMENT MUST BE THE SAME ONE THE FEED USES.
 * `DEFAULT_MAX_RECENT_EVENTS` is the diagnostics default
 * (`gateway/diagnostics/instance-sources.ts`) and the coupling is the property,
 * not the number: suppressing against a window WIDER than the feed's suppresses
 * a warning the owner cannot see, which is this module's own failure mode one
 * level in. `gateway/__tests__/scope-refusal-journal.test.ts` pins the two
 * constants equal so a change to either is a red test rather than a silent
 * re-introduction (Argus r1, 2026-08-16).
 *
 * A THROWN READ MEANS WRITE. This runs synchronously on the boot path, before
 * the boot's own failure cleanup exists, and the reader deserialises stored
 * payloads with `onCorrupt: 'throw'` — so ONE corrupt historical row would turn
 * a best-effort dedup into a boot abort with the database already open
 * (Argus r2, 2026-08-16). Losing the suppression costs one duplicate row;
 * losing the boot costs the instance.
 */
export function shouldJournal(
  readVisible: () => readonly PersistedSystemEvent[],
  payload: Record<string, unknown>,
): boolean {
  let visible: readonly PersistedSystemEvent[]
  try {
    visible = readVisible()
  } catch {
    return true
  }
  return isNewJournalState(visible, payload)
}
