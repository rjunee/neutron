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
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import {
  SystemEventsStore,
  type PersistedSystemEvent,
} from '@neutronai/persistence/system-events.ts'
import { DEFAULT_MAX_RECENT_EVENTS } from '../diagnostics/instance-sources.ts'

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
  seedMigratedDb(':memory:')
  const db = ProjectDb.open(':memory:')
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

test('the LEDGER WINS over a leftover onboarding row under a different handle', () => {
  // The name says what the body checks, and no more (Argus r2 blocker,
  // 2026-08-16). It previously claimed the ledger "is written only by an
  // explicit boot" — a property this test never exercised (it INSERTs the ledger
  // directly and performs no boot at all) and which the code contradicts: a
  // fallback boot with nothing stranded falls past the guard and seeds it, as
  // `migrations/__tests__/scope-rekey-direction-guard.test.ts` "a FRESH dev box
  // still seeds" proves. A test name is read as an assertion; this one asserted
  // something no assertion in its body could fail on.
  const db = freshDb()
  try {
    seedLedger(db, 'alpha')
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

test('one row per readable scope, each naming ONLY its own handle — and NO row count at all', () => {
  const rows = planInstanceRefusalRows({
    owner_scopes: ['alpha', 'gamma'],
    stranded_keys: ['alpha', 'gamma'],
    attempted_by_slug: FALLBACK,
  })
  expect(rows.map((r) => r.scope)).toEqual(['alpha', 'gamma'])
  expect(rows[0]!.payload).toEqual({
    targeted_slug: 'alpha',
    other_targeted_handles: 1,
    attempted_by_slug: FALLBACK,
  })
  // THE DISCLOSURE ASSERTION: `alpha`'s row names no other handle, anywhere in
  // the serialized payload — not in a `from` list, not in a count breakdown.
  expect(JSON.stringify(rows[0]!.payload)).not.toContain('gamma')
  expect(JSON.stringify(rows[1]!.payload)).not.toContain('alpha')
  // And it does not lose the fact that there IS more: a count, never a name.
  // THE SECOND ROW IS ASSERTED IN FULL, not just on its `other_*` count (Argus
  // r1, 2026-08-16), because with only the first row pinned exactly a mutant
  // that computed one scope's value once and reused it for every later row
  // survived the whole suite.
  expect(rows[1]!.payload).toEqual({
    targeted_slug: 'gamma',
    other_targeted_handles: 1,
    attempted_by_slug: FALLBACK,
  })
})

test('THE PAYLOAD KEY SET IS PINNED — a row count may never come back (Argus r2 blocker)', () => {
  // The unit-level guard for the starvation fixed in round 3. The end-to-end
  // proof lives in `boot-refusal-scope.test.ts` ("ORDINARY OWNER ACTIVITY
  // between boots"), but that test is slow and its failure mode reads as a dedup
  // bug rather than as its cause. This one names the cause: the edge trigger
  // hashes the whole payload, so ANY field sourced from a `COUNT(*)` over the
  // swept tables moves whenever the owner creates a task and re-arms the trigger
  // on every boot. Freezing the key set is what stops the next well-meaning
  // "let's tell him how many rows were at stake" from silently draining his
  // 50-row diagnostics window again.
  const rows = planInstanceRefusalRows({
    owner_scopes: ['alpha'],
    stranded_keys: ['alpha', 'gamma'],
    attempted_by_slug: FALLBACK,
  })
  expect(Object.keys(rows[0]!.payload).sort()).toEqual([
    'attempted_by_slug',
    'other_targeted_handles',
    'targeted_slug',
  ])
})

test('the SAME refusal is byte-identical however much data sits under the handle (Argus r2 blocker)', () => {
  // The property, stated directly: the payload is a function of the CONDITION
  // (who attempted it, whose handle was targeted, how many other handles) and of
  // nothing that ordinary owner activity moves. `planInstanceRefusalRows` no
  // longer has an input that could carry a row volume, so this is the type
  // system's assertion made executable — it is what fails first if anyone
  // re-adds one.
  const call = (): Record<string, unknown> =>
    planInstanceRefusalRows({
      owner_scopes: ['alpha'],
      stranded_keys: ['alpha'],
      attempted_by_slug: FALLBACK,
    })[0]!.payload
  expect(JSON.stringify(call())).toBe(JSON.stringify(call()))
  // The control: a genuine CHANGE in the refusal still reads as new information,
  // or "stable" would be satisfied by a constant.
  const withAnotherHandle = planInstanceRefusalRows({
    owner_scopes: ['alpha'],
    stranded_keys: ['alpha', 'gamma'],
    attempted_by_slug: FALLBACK,
  })[0]!.payload
  expect(isNewJournalState([{ payload: call() } as never], withAnotherHandle)).toBe(true)
})

test('a suppression window WIDER than the feed hides the warning — why the two are one constant (Argus r1)', () => {
  // The coupling made executable. Boot suppresses against
  // `DEFAULT_MAX_RECENT_EVENTS` (`gateway/index.ts`) and the owner's feed is
  // built with the SAME constant (`gateway/diagnostics/instance-sources.ts` —
  // neither production caller, `open/composer.ts` nor
  // `open/diagnostics-cli-impl.ts`, passes `maxRecentEvents`). Nothing in the
  // type system connects them, so this pins the CONSEQUENCE of letting them
  // diverge rather than the number: suppress against a window wider than the
  // feed and a row the owner cannot see counts as one he is already looking at,
  // which is this module's own failure mode one level in.
  const db = freshDb()
  try {
    const store = new SystemEventsStore({ db })
    const payload = { targeted_slug: 'alpha', other_targeted_handles: 0 }
    db.runSync(
      `INSERT INTO system_events (id, ts, level, module, event_name, payload_json, project_slug, duration_ms)
       VALUES ('refusal', 1, 'warn', 'gateway', 'instance_scope_rekey_refused', ?, 'alpha', NULL)`,
      [JSON.stringify(payload)],
    )
    for (let i = 0; i < 3; i++) {
      db.runSync(
        `INSERT INTO system_events (id, ts, level, module, event_name, payload_json, project_slug, duration_ms)
         VALUES (?, ?, 'warn', 'gateway', 'cron_job_error', '{}', 'alpha', NULL)`,
        [`filler-${i}`, 100 + i],
      )
    }

    // A feed NARROWED to 2 rows no longer shows the refusal…
    const narrowed = store.listRecentForScope('alpha', 2)
    expect(narrowed.some((e) => e.event === 'instance_scope_rekey_refused')).toBe(false)
    // …yet a suppression window of `DEFAULT_MAX_RECENT_EVENTS` still finds it and
    // would skip the write. THAT is the invisible suppression, reproduced.
    expect(
      shouldJournal(
        () =>
          store.listVisibleForScopeAndName(
            'alpha',
            'instance_scope_rekey_refused',
            DEFAULT_MAX_RECENT_EVENTS,
          ),
        payload,
      ),
    ).toBe(false)
    // CONTROL — matched to the narrowed feed, the same call writes, which proves
    // the `false` above is the WINDOW MISMATCH and not a payload that never
    // matched anything.
    expect(
      shouldJournal(
        () => store.listVisibleForScopeAndName('alpha', 'instance_scope_rekey_refused', 2),
        payload,
      ),
    ).toBe(true)
  } finally {
    db.close()
  }
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
    attempted_by_slug: FALLBACK,
  })
  expect(rows.map((r) => r.scope)).toEqual([FALLBACK])
})

test('a readable scope is trimmed, and a PADDED persisted key is not counted as a foreign handle', () => {
  // A legacy persisted key of `' alpha '` is the same handle as `alpha`. The
  // scope on the row is trimmed, so an untrimmed comparison would tell the reader
  // TWO other handles were targeted when only one was — and the extra one would
  // be himself (Argus r2).
  const rows = planInstanceRefusalRows({
    owner_scopes: [' alpha '],
    stranded_keys: [' alpha ', 'gamma'],
    attempted_by_slug: FALLBACK,
  })
  expect(rows.map((r) => r.scope)).toEqual(['alpha'])
  expect(rows[0]!.payload['targeted_slug']).toBe('alpha')
  expect(rows[0]!.payload['other_targeted_handles']).toBe(1)
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
    attempted_by_slug: FALLBACK,
  })[0]!.payload
  expect(isNewJournalState([], payload)).toBe(true)
  expect(isNewJournalState([persisted(payload)], payload)).toBe(false)
  // Key order must not matter — the stored row comes back through JSON.parse.
  expect(
    isNewJournalState(
      [
        persisted({
          attempted_by_slug: FALLBACK,
          other_targeted_handles: 0,
          targeted_slug: 'alpha',
        }),
      ],
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
  expect(isNewJournalState([persisted(before)], after)).toBe(true)
  expect(isNewJournalState([persisted(after)], after)).toBe(false)
  // Nested KEY ORDER still must not matter — the stored row is a JSON round-trip.
  expect(
    isNewJournalState(
      [persisted({ orphan_counts: [{ rows: 9, table: 'secrets' }], refused_direction: true })],
      after,
    ),
  ).toBe(false)
})

test('shouldJournal treats a THROWN read as "not visible" and writes (Argus r2)', () => {
  // One corrupt historical `payload_json` makes the reader throw, and this runs
  // on the boot path before the boot's own failure cleanup exists. A dedup
  // optimisation must never be able to abort a boot.
  const payload = { targeted_slug: 'alpha', other_targeted_handles: 0 }
  expect(
    shouldJournal(() => {
      throw new Error('corrupt payload_json in system_events')
    }, payload),
  ).toBe(true)
  // And with a working read it is still the edge trigger.
  expect(shouldJournal(() => [], payload)).toBe(true)
  expect(shouldJournal(() => [persisted(payload)], payload)).toBe(false)
})

test('THE ALTERNATION BLOCKER: two shapes under one event key settle, they do not accumulate (Argus r1)', () => {
  // `credential_scope_orphaned` is written in TWO payload shapes under ONE
  // `(scope, event_name)` key: the direction REFUSAL (an anonymous boot) and the
  // ordinary AMBIGUOUS census (an explicit boot). A unit that intermittently
  // loses its slug env alternates between them.
  //
  // Compared against the NEWEST row only, each shape saw the other one as the
  // latest and every boot wrote — {ambiguous_after_refused: true,
  // refused_after_ambiguous: true} — so the trigger suppressed nothing and the
  // owner's 50-row window drained exactly as if it did not exist. Making both
  // branches edge-trigger (the r2 fix) did not close it: the hole is in the
  // COMPARISON, not in the coverage.
  const refused = planCredentialRefusalRows({
    owner_scopes: ['alpha'],
    orphan_counts: [{ table: 'secrets', handle: 'beta', rows: 2 }],
    attempted_by_slug: FALLBACK,
  })[0]!.payload
  const ambiguous = {
    from: ['beta'],
    orphan_counts: [{ table: 'secrets', handle: 'beta', rows: 2 }],
    reason: 'ambiguous_census',
  }

  // Simulate the alternating feed, newest first, exactly as the reader returns it.
  const visible: PersistedSystemEvent[] = []
  const write = (payload: Record<string, unknown>): boolean => {
    const isNew = shouldJournal(() => visible, payload)
    if (isNew) visible.unshift(persisted(payload))
    return isNew
  }

  expect(write(refused)).toBe(true) // boot 1: anonymous
  expect(write(ambiguous)).toBe(true) // boot 2: explicit — genuinely new
  // THE ASSERTION: from here on, alternating forever adds nothing.
  for (let i = 0; i < 12; i++) {
    expect(write(refused)).toBe(false)
    expect(write(ambiguous)).toBe(false)
  }
  expect(visible).toHaveLength(2)

  // CONTROL — the same feed still admits a CHANGED refusal, so the `false`s
  // above are suppression of a repeat and not a trigger that stopped firing.
  const grown = planCredentialRefusalRows({
    owner_scopes: ['alpha'],
    orphan_counts: [{ table: 'secrets', handle: 'beta', rows: 9 }],
    attempted_by_slug: FALLBACK,
  })[0]!.payload
  expect(write(grown)).toBe(true)
  expect(visible).toHaveLength(3)
})

test('a CHANGED refusal is new information and does get a row', () => {
  // "Changed" now means the CONDITION changed, which is the only kind of change
  // worth a slot in a 50-row window (Argus r2 blocker). This used to assert on a
  // growing row count — the very field whose drift defeated the trigger on any
  // instance the owner was actually using. A second handle coming under attack
  // is real news; four more tasks in his own database is not.
  const before = planInstanceRefusalRows({
    owner_scopes: ['alpha'],
    stranded_keys: ['alpha'],
    attempted_by_slug: FALLBACK,
  })[0]!.payload
  const anotherHandleTargeted = planInstanceRefusalRows({
    owner_scopes: ['alpha'],
    stranded_keys: ['alpha', 'gamma'],
    attempted_by_slug: FALLBACK,
  })[0]!.payload
  expect(isNewJournalState([persisted(before)], anotherHandleTargeted)).toBe(true)

  // And a different anonymous process attempting the move is also new.
  const differentAttempt = planInstanceRefusalRows({
    owner_scopes: ['alpha'],
    stranded_keys: ['alpha'],
    attempted_by_slug: 'someone-else',
  })[0]!.payload
  expect(isNewJournalState([persisted(before)], differentAttempt)).toBe(true)
})
