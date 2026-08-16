/**
 * WHERE A REFUSED SCOPE MIGRATION IS JOURNALLED, and how much each row says —
 * the policy, unit-level (INVARIANTS #116(b)).
 *
 * The boot-level regressions (`gateway/__tests__/boot-refusal-scope.test.ts`,
 * `open/__tests__/open-scope-rekey-direction-boot.test.ts`) prove the wiring on
 * ONE shape of database. This file pins the shapes a boot test would need a
 * fixture apiece for, and which Argus r1 found untested and broken:
 *
 *   - the FROZEN credential handle DIVERGES from the live handle (a rename) —
 *     the case where scoping to the stale handle is as invisible as scoping to
 *     the fallback;
 *   - TWO or more handles — where a per-handle fan-out of the FULL payload puts
 *     one scope's names and volumes into another scope's feed;
 *   - a BLANK handle — a scope no owner ever passes to `listRecentForScope`;
 *   - the SAME refusal, twice — the starvation hazard against a 50-row window
 *     with no retention sweep behind it.
 */

import { expect, test } from 'bun:test'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import type { PersistedSystemEvent } from '@neutronai/persistence/system-events.ts'

import {
  isNewJournalState,
  planCredentialRefusalRows,
  planInstanceRefusalRows,
  readOwnerReadableScopes,
  resolveOwnerReadableScopes,
  shouldJournal,
} from '../scope-refusal-journal.ts'

/** The anonymous handle every refusal in this file was attempted by. */
const FALLBACK = 'dev'

function freshDb(): ProjectDb {
  const db = ProjectDb.open(':memory:')
  applyMigrations(db.raw())
  return db
}

function seedOnboarding(db: ProjectDb, slug: string, user = 'owner'): void {
  db.raw()
    .prepare(
      `INSERT INTO onboarding_state
         (project_slug, user_id, phase, started_at, last_advanced_at)
       VALUES (?, ?, 'completed', 1, 1)`,
    )
    .run(slug, user)
}

function seedLedger(db: ProjectDb, slug: string): void {
  db.raw()
    .prepare(`INSERT INTO instance_scope_ledger (id, project_slug, updated_at) VALUES (1, ?, 1)`)
    .run(slug)
}

// ── resolveOwnerReadableScopes ────────────────────────────────────────────────

test('the LEDGER is the answer when it has one — it is written only by an explicit boot', () => {
  const db = freshDb()
  try {
    seedLedger(db, 'alpha')
    // A leftover onboarding row under a DIFFERENT handle must not dilute it.
    seedOnboarding(db, 'beta')
    expect(resolveOwnerReadableScopes(db)).toEqual(['alpha'])
  } finally {
    db.close()
  }
})

test('no ledger yet → onboarding_state, the same anchor table the backfill trusts', () => {
  const db = freshDb()
  try {
    seedOnboarding(db, 'alpha')
    expect(resolveOwnerReadableScopes(db)).toEqual(['alpha'])
  } finally {
    db.close()
  }
})

test('an instance whose own handle IS the fallback string still reads under it (Argus r2)', () => {
  // The coincidence case, and it is production-reachable: the owner boots
  // explicitly with `NEUTRON_INSTANCE_SLUG=dev` (source `'env'`, so the ledger
  // records `dev`), and a later anonymous boot resolves to the same string by
  // ABSENCE. `dev` is then the only scope he ever passes to `listRecentForScope`
  // — dropping it by string equality moved the row to an unreadable scope, which
  // is worse than the code this module replaced.
  const db = freshDb()
  try {
    seedLedger(db, FALLBACK)
    expect(resolveOwnerReadableScopes(db)).toEqual([FALLBACK])
  } finally {
    db.close()
  }
})

test('the same coincidence via onboarding_state, with no ledger yet', () => {
  const db = freshDb()
  try {
    seedOnboarding(db, FALLBACK)
    expect(resolveOwnerReadableScopes(db)).toEqual([FALLBACK])
  } finally {
    db.close()
  }
})

test('BLANK and whitespace handles are dropped — a row scoped to "" is unreadable forever', () => {
  const db = freshDb()
  try {
    seedOnboarding(db, '')
    seedOnboarding(db, '   ', 'owner2')
    seedOnboarding(db, 'alpha', 'owner3')
    expect(resolveOwnerReadableScopes(db)).toEqual(['alpha'])
  } finally {
    db.close()
  }
})

test('a database that records NO identity has no readable scope at all', () => {
  const db = freshDb()
  try {
    expect(resolveOwnerReadableScopes(db)).toEqual([])
  } finally {
    db.close()
  }
})

// ── readOwnerReadableScopes — the boot-path wrapper ───────────────────────────

test('a THROWING scope read degrades to the floor instead of aborting the boot', () => {
  // `boot()` calls this BEFORE `bootFailureCleanup` exists (gateway/index.ts —
  // the sink is registered at :327, the cleanup declared at :664), so a throw
  // out of these SELECTs escapes `boot()` with the DB open and this boot's
  // SystemEventsStore still on the ambient sink stack. That is the half-open
  // boot the hand-rolled guards at :310 and :360 each exist to prevent, and it
  // would be caused by a DIAGNOSTIC read. Same trade `shouldJournal` already
  // makes: losing the narrowing costs precision, losing the boot costs the
  // instance.
  const exploding = {
    all: () => {
      throw new Error('SQLITE_CORRUPT: database disk image is malformed')
    },
  }
  expect(() => resolveOwnerReadableScopes(exploding)).toThrow('SQLITE_CORRUPT')
  expect(readOwnerReadableScopes(exploding)).toEqual([])
})

test('the degraded read lands on the documented FLOOR, not on an unwritable plan', () => {
  // `[]` is not merely "no crash": it has to route to a scope that still gets
  // written, or the guard is silent again by a different mechanism. An empty
  // readable set falls through to the attempting handle — exactly what shipped
  // before this module existed.
  const rows = planInstanceRefusalRows({
    owner_scopes: readOwnerReadableScopes({
      all: () => {
        throw new Error('no such table: instance_scope_ledger')
      },
    }),
    stranded_keys: ['alpha'],
    stranded_rows_by_key: { alpha: 3 },
    attempted_by_slug: FALLBACK,
  })
  expect(rows.map((r) => r.scope)).toEqual([FALLBACK])
})

test('a healthy read is UNCHANGED by the wrapper — the control for the two above', () => {
  // Without this, both tests above would still pass if the wrapper swallowed
  // every call and always returned [].
  const db = freshDb()
  try {
    seedLedger(db, 'alpha')
    expect(readOwnerReadableScopes(db)).toEqual(['alpha'])
    expect(readOwnerReadableScopes(db)).toEqual(resolveOwnerReadableScopes(db))
  } finally {
    db.close()
  }
})

// ── planInstanceRefusalRows ───────────────────────────────────────────────────

test('one row per readable scope, each carrying ONLY its own handle and its own count', () => {
  const rows = planInstanceRefusalRows({
    owner_scopes: ['alpha', 'gamma'],
    stranded_keys: ['alpha', 'gamma'],
    stranded_rows_by_key: { alpha: 4, gamma: 11 },
    attempted_by_slug: FALLBACK,
  })
  expect(rows.map((r) => r.scope)).toEqual(['alpha', 'gamma'])
  expect(rows[0]!.payload).toEqual({
    stranded_slug: 'alpha',
    stranded_rows: 4,
    other_stranded_handles: 1,
    other_stranded_rows: 11,
    attempted_by_slug: FALLBACK,
  })
  // THE DISCLOSURE ASSERTION: `alpha`'s row names no other handle, anywhere in
  // the serialized payload — not in a `from` list, not in a count breakdown.
  expect(JSON.stringify(rows[0]!.payload)).not.toContain('gamma')
  expect(JSON.stringify(rows[1]!.payload)).not.toContain('alpha')
  // And it does not lose the fact that there IS more: a count, never a name.
  expect(rows[1]!.payload['other_stranded_handles']).toBe(1)
  expect(rows[1]!.payload['other_stranded_rows']).toBe(4)
})

test('no readable scope recorded at all → the attempting handle, never a stranded key', () => {
  // The FLOOR (Argus r2 blocker): a stranded key is a handle whose divergence
  // from the live one is the thing being reported, so it is not a reader. With
  // no recorded identity the only handle anyone can currently open is the one
  // this process booted as — which is exactly what shipped before this module,
  // so the worst case is never worse than the code it replaced.
  const rows = planInstanceRefusalRows({
    owner_scopes: [],
    stranded_keys: ['', '  ', 'alpha'],
    stranded_rows_by_key: { '': 1, '  ': 1, alpha: 3 },
    attempted_by_slug: FALLBACK,
  })
  expect(rows.map((r) => r.scope)).toEqual([FALLBACK])
})

test('a readable scope is trimmed, and PADDED persisted keys still count as its own rows', () => {
  // A legacy persisted key of `' alpha '` is the same handle as `alpha`. The
  // scope on the row is trimmed, so an untrimmed count lookup reported the
  // reader ZERO rows of his own AND counted his own rows as somebody else's —
  // wrong in both directions at once (Argus r2).
  const rows = planInstanceRefusalRows({
    owner_scopes: [' alpha '],
    stranded_keys: [' alpha ', 'gamma'],
    stranded_rows_by_key: { ' alpha ': 4, gamma: 11 },
    attempted_by_slug: FALLBACK,
  })
  expect(rows.map((r) => r.scope)).toEqual(['alpha'])
  expect(rows[0]!.payload['stranded_rows']).toBe(4)
  expect(rows[0]!.payload['other_stranded_handles']).toBe(1)
  expect(rows[0]!.payload['other_stranded_rows']).toBe(11)
})

// ── planCredentialRefusalRows ─────────────────────────────────────────────────

test('the credential refusal goes to the LIVE handle even when the frozen handle diverges', () => {
  // The Managed-rename shape: the owner reads under `alpha`; his credentials are
  // frozen under `beta` (which is the whole condition being reported). Scoping
  // the warning to `beta` is the invisibility this card exists to remove.
  const rows = planCredentialRefusalRows({
    owner_scopes: ['alpha'],
    orphan_counts: [
      { table: 'secrets', handle: 'beta', rows: 2 },
      { table: 'project_credentials', handle: 'beta', rows: 1 },
    ],
    attempted_by_slug: FALLBACK,
  })
  expect(rows.map((r) => r.scope)).toEqual(['alpha'])
  expect(rows[0]!.payload).toEqual({
    refused_direction: true,
    orphaned_handles: 1,
    orphaned_rows: 3,
    orphaned_tables: ['project_credentials', 'secrets'],
    attempted_by_slug: FALLBACK,
  })
  // No handle NAME at all: the frozen handle is not the reader's own key, and
  // the volume is what he needs from the journal. The integrations surface names
  // it, scoped to him, where the repair is offered.
  expect(JSON.stringify(rows[0]!.payload)).not.toContain('beta')
})

test('multi-handle credential refusal discloses no handle into any scope', () => {
  const rows = planCredentialRefusalRows({
    owner_scopes: ['alpha', 'gamma'],
    orphan_counts: [
      { table: 'secrets', handle: 'beta', rows: 2 },
      { table: 'secrets', handle: 'delta', rows: 5 },
    ],
    attempted_by_slug: FALLBACK,
  })
  expect(rows.map((r) => r.scope)).toEqual(['alpha', 'gamma'])
  for (const row of rows) {
    const serialized = JSON.stringify(row.payload)
    for (const foreign of ['beta', 'delta']) expect(serialized).not.toContain(foreign)
    expect(row.payload['orphaned_handles']).toBe(2)
    expect(row.payload['orphaned_rows']).toBe(7)
  }
})

test('a FROZEN credential handle is not a scope even when nothing readable exists (Argus r2)', () => {
  // The blocker: the old last-resort branch keyed the row to `stale_handles`,
  // i.e. to the frozen handles — the exact scopes the invariant forbids, on the
  // one path no test exercised. There is no such parameter any more, so the
  // rule cannot be re-broken by a branch nobody watches.
  const rows = planCredentialRefusalRows({
    owner_scopes: [],
    orphan_counts: [{ table: 'secrets', handle: 'beta', rows: 2 }],
    attempted_by_slug: FALLBACK,
  })
  expect(rows.map((r) => r.scope)).toEqual([FALLBACK])
  expect(JSON.stringify(rows)).not.toContain('beta')
})

// ── isNewJournalState ─────────────────────────────────────────────────────────

function persisted(payload: Record<string, unknown>): PersistedSystemEvent {
  return {
    id: 'e1',
    ts: 1,
    level: 'warn',
    module: 'gateway',
    event: 'instance_scope_rekey_refused',
    // Round-tripped, as the reader returns it — the comparison must survive
    // JSON key-order, or the dedup silently never matches and writes forever.
    payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
    project_slug: 'alpha',
  }
}

test('an unchanged repeat is NOT re-journalled — 25 anonymous boots cannot evict the feed', () => {
  const payload = planInstanceRefusalRows({
    owner_scopes: ['alpha'],
    stranded_keys: ['alpha'],
    stranded_rows_by_key: { alpha: 4 },
    attempted_by_slug: FALLBACK,
  })[0]!.payload
  expect(isNewJournalState(null, payload)).toBe(true)
  expect(isNewJournalState(persisted(payload), payload)).toBe(false)
  // Key order must not matter — the stored row comes back through JSON.parse.
  expect(
    isNewJournalState(
      persisted({
        attempted_by_slug: FALLBACK,
        other_stranded_rows: 0,
        other_stranded_handles: 0,
        stranded_rows: 4,
        stranded_slug: 'alpha',
      }),
      payload,
    ),
  ).toBe(false)
})

test('a change INSIDE a nested payload object is a change (Argus r2)', () => {
  // `JSON.stringify(p, Object.keys(p).sort())` applies its array argument as a
  // recursive ALLOWLIST, so every nested key vanished from the comparison and
  // two payloads differing only inside an object compared EQUAL — the change
  // swallowed silently. The ordinary ambiguous orphan already ships a nested
  // shape (`orphan_counts`), so this is not hypothetical.
  const before = { refused_direction: true, orphan_counts: [{ table: 'secrets', rows: 1 }] }
  const after = { refused_direction: true, orphan_counts: [{ table: 'secrets', rows: 9 }] }
  expect(isNewJournalState(persisted(before), after)).toBe(true)
  expect(isNewJournalState(persisted(after), after)).toBe(false)
  // Nested KEY ORDER still must not matter — the stored row is a JSON round-trip.
  expect(
    isNewJournalState(persisted({ orphan_counts: [{ rows: 9, table: 'secrets' }], refused_direction: true }), after),
  ).toBe(false)
})

test('shouldJournal treats a THROWN read as "not visible" and writes (Argus r2)', () => {
  // One corrupt historical `payload_json` makes the reader throw, and this runs
  // on the boot path before the boot's own failure cleanup exists. A dedup
  // optimisation must never be able to abort a boot.
  const payload = { stranded_slug: 'alpha', stranded_rows: 4 }
  expect(
    shouldJournal(() => {
      throw new Error('corrupt payload_json in system_events')
    }, payload),
  ).toBe(true)
  // And with a working read it is still the edge trigger.
  expect(shouldJournal(() => null, payload)).toBe(true)
  expect(shouldJournal(() => persisted(payload), payload)).toBe(false)
})

test('a CHANGED refusal is new information and does get a row', () => {
  const before = planInstanceRefusalRows({
    owner_scopes: ['alpha'],
    stranded_keys: ['alpha'],
    stranded_rows_by_key: { alpha: 4 },
    attempted_by_slug: FALLBACK,
  })[0]!.payload
  const after = planInstanceRefusalRows({
    owner_scopes: ['alpha'],
    stranded_keys: ['alpha'],
    stranded_rows_by_key: { alpha: 9 },
    attempted_by_slug: FALLBACK,
  })[0]!.payload
  expect(isNewJournalState(persisted(before), after)).toBe(true)
})
