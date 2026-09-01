# Neutron Open — Invariants Inventory

Compiled 2026-07-03 for refactor unit **G10** (`docs/plans/2026-07-02-world-class-refactor-plan.md`
§G10). This is the checklist Fable synthesis runs per merge: every load-bearing subtlety named in
the **11 critic reports** (`docs/research/refactor-audit-2026-07-02/critic-*.md`), one line each,
with a concrete `file:line` anchor and the refactor unit (or existing test) that protects it. An
invariant tagged **unprotected — covered by review only** has no automated guard today; a unit
touching that area must add one or an Argus/Codex reviewer must explicitly re-verify it by hand.

> **On the count.** The plan (§G10) says "all 12 critic reports"; there are in fact **11**
> `critic-*.md` files in the audit directory. `critic-security-config.md` has no dedicated
> "load-bearing subtleties" section (its charter is config/secrets/auth-gate posture), so its
> preserve-verbatim items are folded into §11 below. Everything in this doc is keyed to the 11
> files that exist; the "12" in the plan is the pre-audit estimate, reconciled here.

Anchor convention: every invariant carries a `file:line` (or `file:line-range`) pointing at the
governing code site. Where an invariant is genuinely cross-cutting (many near-identical copies, or
a proposed consolidation target that does not exist yet), the anchor names the **representative**
site — the canonical producer, the file the audit cites, or the test that pins it — so each line is
verifiable from the doc; a `~` prefix marks an approximate line from the audit not re-pinned to HEAD.

Source reports are untracked working docs (`docs/research/refactor-audit-2026-07-02/`, see plan
§1.4) — this file is the durable, tracked distillation. Grouped by the critic dimension that
surfaced each item; a subtlety repeated across reports is listed once under its primary dimension
with cross-references noted inline.

---

## 1. Composition & boot order (`critic-composition.md`)

1. `open/server.ts` mutates `process.env` as its DI mechanism BEFORE `boot()` re-reads it
   independently for DB path/slug/host/port. `open/server.ts:58-73`, `gateway/index.ts:118-157`.
   Protects: **C1** (Typed BootConfig) — must thread both sides in lockstep.
2. Module registration order: `replToolBridge` mounted after `mcp`; `cron.scheduler.start()` only
   after `graph.compose()`; overlays applied before `buildComposedHttpFromComposition`;
   same-object-reference mutation of the composition. `gateway/composition.ts:336-434`.
   Protects: **C8** (Evict product orchestration from the composition layer).
3. Shutdown order including `shutdownAllPersistentRepls`; init-failure teardown exists in both
   `boot()` and `composeProductionGraph`. `gateway/index.ts:236-255,385-458`.
   Protects: **C1**/**C8**.
4. Compose ladder semantics: authGate first with Set-Cookie stitch; chunked-upload before legacy;
   per-project children mounted before appProjects; landing path-set before connect; operator
   routes bypass the gate. `open/composer.ts:894-1072`.
   Protects: **C4** (Data-driven surface registry / RouteSlot), **C5** (One auth-gate seam +
   landing route manifest).
5. Open gate: single-use `?start=` JTI claim; cookie minted only on first claim; stale-cookie-over-
   wiped-DB cold-start path; React bootstrap injected by exact-string replace on the
   `/chat-react.js` tag. `open/composer.ts:1616-1748`.
   Protects: **S1** (Per-install owner credential).
6. Prewarm promise never rejects and is not awaited at boot; `prewarmSettled` elevates cold-window
   timeouts. `open/composer.ts:3661-3684,508-521`.
   Protects: **D1**/**D2** (PoolRuntime reification / Substrate banner split) — flag/promise pair
   must move together.
7. Substrate instance-id prefixes are pool keys; the trident fire substrate must stay warm
   per-repo-cwd; the OWNER-FACING CONVERSATIONAL PAIR — `cc-agent-` (live chat) and `cc-nudge-`
   (background proactive compose: fired reminders/rituals + the work-board wakeup) — and ONLY that
   pair get `enableToolBridge` and `PROFILE_WARM_CHAT`. `cc-nudge-` is a deliberate equal-grant,
   separate-session twin of `cc-agent-`: equal grants because a ritual composes there and ISSUES
   #504 settled that it must reach Core tools; separate session because a background compose that
   aborts must not poison the child the owner is talking to. `open/wiring/substrates.ts`.
   Protects: **D1**/**D2**.
8. `Bun.serve` selects the chained fetch handler per-request inside the serve arrow so the live
   server ref reaches WS upgrades; `maxRequestBodySize` = import cap + 64MB.
   `gateway/index.ts:302-323`.
   Protects: unprotected — covered by review only (no unit targets the serve-arrow wiring
   directly; **C8** touches adjacent code and must not regress it).
9. Holder fill-before-first-dispatch timing. `open/composer.ts:654,1329,2183,2321`.
   Protects: **F8** (Re-arm-from-durable-state sweep).

## 2. Contracts & wire protocol (`critic-contracts.md`, `critic-duplication.md` §7)

10. `latestTurnByTopic` tiebreak is `rowid DESC`, not `prompt_id DESC`; history's first page is
    inclusive `<=`, later pages use a strict composite tuple. `button-store.ts:697-815`.
    Protects: **G2** (Hydration-parity characterization), **W3** (Transcript unification, gated on
    G2).
11. `__timeout__`/`__cancel__` prompt resolutions render as UNRESOLVED, never as user bubbles;
    `EmitResult.was_delivered` governs the re-render rule. `button-store.ts:1050-1069`
    (the `RESERVED_RESOLUTION_VALUES` sentinel-handling block).
    Protects: **G2**, **L1** (Chat-protocol leaf module).
12. `button_prompts.body` has `[[OPTIONS]]` stripped on persist — every consumer must read
    `latestPromptByTopic`/`options_json`, never re-parse `body` (PR#144 trap).
    `button-store.ts:289-368`.
    Protects: **L1**, **W3**.
13. `{ok:false, code, message}` wire bytes and stable code strings are load-bearing — the Expo
    client branches on them; a surface-kit consolidation must stay byte-identical. Representative
    producer `gateway/http/app-backups-surface.ts:338` (the shape is emitted from ~19 near-identical
    copies per `critic-duplication.md:116`; O7 folds them into a proposed `gateway/http/surface-kit.ts`).
    Protects: **O7** (Gateway surface-kit).
14. Compose ladder orderings are semantic and must be preserved 1:1 if lifted into a registry:
    chunked-upload before legacy; `focusCurrent` before `focus`; per-project children before
    appProjects; SPA catch-all last; `LANDING_PATHS` completeness is a recurring 404 factory.
    `gateway/http/compose.ts:722-752` (LANDING_PATHS), `:833-1320` (route ladder).
    Protects: **C4**.
15. `chat-core` merge laws — receipts are union-monotonic, edits are rev-LWW, seq ordering is
    strict — must not be "harmonized" with server-side projections during unification.
    `chat-core/store.ts:82-171`.
    Protects: **L7** (chat-core scope rename), **W1** (client-core shared package), **W3**.

## 3. Data layer & persistence (`critic-data-layer.md`)

16. `ProjectDb` mutex + AsyncLocalStorage re-entry; swallowing mutex-chain rebuild; `isBusyError`
    rejects the `BusyRetryExhaustedError` wrapper; busy-retry sleeps must stay **async** (sync
    sleeps starve the systemd `WATCHDOG=1` heartbeat). `db.ts:216-226`, `retry.ts:47-59`.
    Protects: **P1** (ProjectDb API widening).
17. Migration runner: PRAGMA preamble hoisted out of the per-migration transaction;
    `PRAGMA foreign_keys=ON` re-asserted in a `finally`; per-migration BEGIN/COMMIT atomicity;
    migration version numbers are never renumbered or backfilled, and **the runner decides
    "has this run?" from the migration's NAME, never from its ordinal** (`classifyMigration`;
    `_migrations` is keyed on `name`, `version` is data and two rows may share one). Keying on the
    ordinal is what took the live instance down three times: a migration whose number a branch
    migration had spent read as applied, so its `ALTER`s never ran and the schema silently lacked
    them. Renumbering to dodge a collision is not the fix — it repairs the instance where the
    ordinal was spent and breaks every instance where the migration already applied. `migrations/runner.ts`
    (`applyMigrations`' apply loop, `splitPragmaPreamble`) — cited by function rather than by line,
    because the previous line anchor had drifted off the code it named.
    Protects: **P2** (raw() migration sweep restricts `raw()` to this file), existing schema
    snapshot test (`regen-snapshot.ts`).
    Six refusals in that runner are fail-closed and must stay so: a duplicate ordinal
    (`assertUniqueMigrationOrdinals`), a duplicate migration NAME (`assertUniqueMigrationNames` —
    the name is the ledger key, so two files sharing a slug make one read as applied forever), TWO
    FILES WITH IDENTICAL BYTES where one is already applied
    (`formatDuplicateContentMigrations` — the hash cannot tell them apart, so calling the second
    one applied means it never runs at all), a recorded migration NO file in this build corresponds
    to by name or by content hash
    (`formatUnexplainedLedgerRows`, resolvable only via a hand-verified `migrations/repairs.json`
    entry), a pending migration file the deployed checkout does not track
    (`formatUntrackedMigration` in `migrations/runner.ts`, on the verdict from `resolveDeployedTree`
    in `migrations/provenance.ts`), and an OCCUPIED REKEY SCRATCH NAME
    (`formatOccupiedRekeyScratch` — `_migrations_version_keyed` can never be this runner's own
    leftover, because the whole rekey is one transaction, so a table there is somebody's data and is
    refused rather than dropped; an earlier version's unconditional `DROP TABLE IF EXISTS` destroyed
    exactly that, silently and permanently, and the test that should have caught it used a VIEW,
    which SQLite refuses to drop).
    **ALL SIX DECIDE BEFORE ANY WRITE**, without exception, and the sixth had to be MOVED to make
    that true rather than reworded. It was thrown from inside `rekeyLedgerOnName`, which runs AFTER
    this boot's `_migration_repairs` acknowledgements, so on the only population that reaches it — an
    instance mid-incident, carrying repairs — its own claim that nothing had been written was false
    as the operator read it. Every condition it rests on (`ledgerExists`, `ledgerIsVersionKeyed`,
    `tableExists`) is a pure read, so it now sits in the read-only preflight with the other five.
    `ordinal-identity.test.ts` CASE 6d asserts `_migration_repairs` DOES NOT EXIST after the
    refusal, with the un-refused boot as its positive control. A guard that has to disclose its own
    write is still a guard that writes.
    THE ACKNOWLEDGED-REPAIR WRITE HAPPENS ONCE PER ENTRY, NOT ONCE PER BOOT, which is what keeps
    `applyMigrations` a pure read on a fully-migrated database — the property that lets a backup be
    opened read-only, and the one that instances carrying repairs did not have. Rows in
    `_migration_repairs` are never rewritten, so "already acknowledged" and "nothing to write" are
    the same condition. CASE 10 pins it against a connection that genuinely refuses writes.
    A repair entry is MATCHED ON (`recorded_name`, `version`) — the pair, for every entry, orphan or
    not. `repairs.json` ships to the whole fleet, so an entry is one instance's history that every
    instance evaluates, and two databases can legitimately record one unmerged branch migration at
    DIFFERENT ordinals. Matching an orphan on the name alone let a shipped entry speak on the second
    database, where its `file_name` marked a genuinely pending migration as applied: the `ALTER`s
    never ran, no row was recorded, and the boot exited zero — this class, exported to an instance
    the incident was never about (CASE 8c reproduces it and reads the columns back).
    A repair entry that has ALREADY ACTIVATED on a database stays active on it —
    `_migration_repairs` is consulted as a second, durable trigger, and THAT is what carries an entry
    through the rekey rather than a looser match. The ledger predicate reads state the rekey erases:
    `collapseLedgerRowsByName` drops the drifted row of a duplicated name, so a `recorded_name` this
    build ships comes out of the rekey sitting exactly where a healthy apply would have put it, and
    an entry keyed only on that mismatch goes inert while the instance still needs it — silently
    un-suppressing a hand-verified migration whose `ALTER`s then re-run. The durable trigger cannot
    over-activate: a database that never had the incident never wrote the row. CASE 8 pins the orphan
    shape, CASE 8b the tree-file shape.
    Hash widening MUST stay conditioned on the recording row being one no file in this build
    accounts for. Widening on a bare hash set is a silent-skip bug: a new, distinctly-named,
    tracked migration whose bytes duplicate an applied one reads as applied, so it never runs,
    never records, and is reported under `skipped` by a boot that exits zero — this invariant's own
    defect class, reached through its fix.
    AND ON THE FILE BEING THE ONLY CLAIMANT OF THOSE BYTES IN THIS BUILD, which is the same
    ambiguity with the recording row off-tree. The condition above sees a row whose name is a file
    here; it cannot see an ORPHAN row whose bytes TWO files here carry. Then one row marked both as
    applied, neither was `duplicates-an-applied-file`, the refusal never fired, and both were skipped
    and never recorded on a boot that exited zero. CASE 9 pins it, with the single-claimant rename —
    the case the widening exists for — as its positive control.
    A name match with a MISMATCHED hash is REPORTED and never enforced: it emits
    `migration_content_drift` (`enforced=false`) and boots. Refusing is a rejected decision (see the
    README's "recorded and reported, not enforced" — an in-place comment edit must not become a
    crash loop), but silence was never the decision: an amended-during-review migration renumbered
    by the merge reads as applied while its added statements never ran. `renumbered=true` is the
    discriminating field, because bytes AND ordinal both moving is what an in-place edit cannot do.
    A steady-state boot must stay SILENT — a notice that fires every boot is noise.
    The collapse must adopt the provenance triple from ONE donor row, never column by column:
    `content_sha256`/`applied_by_commit`/`tree_provenance` are written together and mixing them
    fabricates a tuple no row ever had, in the columns that exist to be trusted.
    The unexplained-row refusal adjudicates ONLY rows carrying a `content_sha256`, and that gate is
    load-bearing rather than lenient: migration files are deliberately deleted here (`0059`,
    `0064`–`0068`), so every long-lived database holds hashless rows naming migrations this tree no
    longer contains, and refusing on them would take down the oldest instances in the fleet over
    evidence that is a NULL. A recorded hash is never used to REFUSE a file — only ever to mark one
    as already applied (see the README's "recorded and reported, not enforced").
    Reapply repairs leave the scar row immutable and transact the SQL body with its firing receipt; `migrations/__tests__/live-ledger-122-reapply.test.ts` pins the live row-122 path, rollout window, strict failure, fresh-install inertness, and second-boot no-op.
    The untracked refusal takes PRECEDENCE over the collision check when the tree can tell a stray
    from a real file, and that is a diagnosis rule, not a weakening: all six still throw before any
    write. A stray landing beside a tracked file at the same ordinal reads as a duplicate ordinal,
    which sends the operator hunting a duplicate they never committed when the real remedy is to
    delete the stray. So `assertUniqueMigrationOrdinals` takes the tree verdict and stands aside
    when one side of a collision is untracked. That verdict MUST be resolved on every boot that has
    a collision — never gated on something being pending. A recorded untracked stray is a supported
    state (the untracked loop checks pending files only, sparing a stray applied long ago), so a
    `pending`-gated verdict reads null on the boot AFTER a successful upgrade and turns a tolerated
    collision into a hard refusal forever. A NAME collision is a trigger too, and there the better
    message is unreachable any other way: a shared slug makes both files read as applied, so nothing
    is pending and the untracked loop reaches nobody. Two TRACKED files at one ordinal, and any
    collision on an install where the tree cannot be verified, still report as a duplicate ordinal. Where tracking cannot be established (no git metadata, an index
    shape the reader does not decode, an index that fails its own checksum or carries none, a
    migration directory git does not track at all) the runner applies and records
    `tree_provenance = unverifiable:<reason>` — "cannot verify" is a distinct state from "not
    tracked" and collapsing them either breaks tarball installs or re-opens the class. The verified
    value is `tracked-in-index` and names its evidence: the index is the STAGED tree, so a
    staged-but-uncommitted file passes; HEAD-tree verification is deliberately out of scope (it would
    need a packfile reader on the boot path) and the value must not be renamed to imply otherwise.
18. Schema snapshot test is the refactor's data-layer safety net; regenerate only via
    `regen-snapshot.ts`, never hand-edit. `migrations/snapshot.test.ts:1` (the test),
    `migrations/regen-snapshot.ts:9-15` (writes `expected-schema.txt`).
    Protects: existing test asset (not a unit) — leaned on by **P1–P4**, **P8**, **P11**.
19. `sqlite-state-store` upsert is a read-merge-write inside **one** transaction; single-statement
    crash-atomicity claims in its header comment depend on this. `sqlite-state-store.ts:82-210`.
    Protects: **P3** (openSidecar() + shared store helpers).
20. Trident `fired`/`redispatched` in-memory sets are crash-unsafe **by design**
    (`orchestrator.ts:198-206`) — persisting them would break orphan recovery.
    Protects: **F1** (SupervisedLoop primitive), **P10** (Trident checkpoint hardening).
21. `GBrainSyncHook`: remove-before-add edge ordering, once-only binary-missing latch,
    deferred-drain on `pageLanded` — must stay fail-soft byte-identical while adding observability.
    `GBrainSyncHook.ts:130-256`.
    Protects: **P9** (GBrain sync observability).
22. Reminders: single-flight tick, claim-then-dispatch with only-if-unchanged reverts,
    persist-before-send outbound to the `app:` registry. `reminders/tick.ts:130-177`,
    `reminders/store.ts:234-293`, `reminders/outbound.ts:7-18`.
    Protects: **F1** (adopts `SupervisedLoop` in `reminders/tick.ts`).
23. Task↔reminder link: the reminder INSERT + link INSERT share ONE transaction with each
    other (not with the task mutation — the task row is already committed when the
    subscriber runs), and a reminder is only ever scheduled for a future moment
    (`MAX_PAST_DUE_DRIFT_SECONDS`), so a bulk import of past-dated tasks cannot fire a
    wall of instant pings. `tasks/reminder-link.ts`.
    Protects: unprotected — covered by review only.
24. App-chat: idempotency keyed on `(topic_id, client_msg_id)`; per-topic `MAX(seq)+1` computed
    inside the transaction; persist-first-then-fan-out in the adapter. `adapter.ts:174-199`.
    Protects: **P5** (app-chat store fold).
25. Import runner: honest-failure gate (`attempted>0 && succeeded==0 && projects==0` →
    `failed`, never a blank `completed`); fire-and-forget with swallowed escapes routes to a
    `failed` row; the cancel-set is checked before result publication.
    `build-synthesis-import-runner.ts:191-220`.
    Protects: **P6** (`[BEHAVIOR]` Import durability P0).
26. `button_prompts` ordering tiebreaks differ on purpose between history pagination (inclusive
    first page, strict composite later) and `latestPromptByTopic` (rowid-DESC).
    `button-store.ts:697-815`. (Duplicate of #10/#12, cross-referenced from the data-layer critic.)
    Protects: **G2**, **W3**.
112. `code_trident_runs` INSERT is corruption-proof by construction: `INSERT_PLACEHOLDERS` is
    DERIVED from `COLS` (`trident/store.ts:277`), so the placeholder count equals the column
    count always — a hand-miscounted `?` list would otherwise silently corrupt every insert with
    no type error to catch it. `trident/store.test.ts` pins `COLS.length` against the live
    `PRAGMA table_info` column count and round-trips distinct values through every column, going
    red on any swap or short bound array.
    Protects: crash-recovery migration 0123 (`crash_recoveries` column) and every prior column
    addition to the same table.
116. SCOPE DIRECTION, and the visibility of a refusal. Two halves of one rule, added 2026-08-16
    (defect 2026-08-14 19:35 — a slug-unset boot that inherited a live `NEUTRON_HOME` re-keyed
    every credential row onto the `'dev'` fallback and the running gateway read zero secrets).
    (a) A FALLBACK identity may never pull rows off an EXPLICIT handle, ON ANY SURFACE. The fallback means
    "nobody told me who I am", and every reconciler that sweeps a scope column has to carry the
    guard independently — closing the direction on one table set closes nothing, because the next
    sweep simply takes what the first refused. Both live guards read the same provenance input,
    `slugResolution.source === 'fallback'`, which is why `resolveOwnerSlugSourceFromConfig`
    returning the wrong `source` is a scope-integrity defect and not a cosmetic one: `'file'`
    mis-typed as `'fallback'` REFUSES a real rename and strands the owner's rows, and a BLANK
    `NEUTRON_INSTANCE_SLUG` read as `'env'` DISARMS the guard entirely (it is a deploy that failed
    to set the slug, so it resolves to `'fallback'` — `config/index.ts` `resolveOwnerSlugSourceFromConfig`,
    which is where that resolver LIVES since #320; `gateway/index.ts` only re-exports it, because
    defining it on the entry module put the entry into the Open composer's own import graph).
    Guards, all THREE of them: `migrations/scope-rekey.ts` (the boot re-key),
    `auth/credential-scope-reconcile.ts` `reconcileCredentialScope` (the boot credential sweep),
    and `migrateOrphanedCredentialScope` (the EXPLICIT repair the integrations surface offers —
    `gateway/cores/integrations.ts`, `cores-integrations-surface.ts`, `integrations-tools.ts`).
    THE THIRD ONE IS WHY THIS SAYS "ON ANY SURFACE" AND NOT "ON THE BOOT PATH" (closed by PR #320,
    2026-08-16; this paragraph previously recorded it as an open gap). "Explicit" is not the
    property that makes a move safe: the owner asking is only meaningful when the process knows
    WHO it is, so a fallback handle means there was no owner to have asked. While that surface
    took `(db, boot_handle)` with no provenance argument the guard was real and bypassable in one
    step — boot as `'dev'`, call the explicit migration, and every row moves off the live handle.
    Its provenance argument is REQUIRED rather than optional-defaulting-to-false precisely so the
    next surface cannot reintroduce the gap by omission: forgetting it is a type error
    (`auth/credential-scope-reconcile.ts:509-539`).
    (b) A refusal event is journalled under a handle the OWNER CAN READ, WHENEVER THIS DATABASE
    RECORDS ONE — never under a FROZEN credential handle whose divergence from the live one is the
    very thing being reported, and never under the anonymous handle that attempted the move EXCEPT
    on the one documented floor named below (a database that records no identity at all, which
    includes a diagnostic read that threw). That exception is stated here, in the first sentence,
    because the rule previously read as absolute while the code had two lawful paths to the
    attempting handle — and a claim of coverage the code does not have is worse than no claim, since
    it is the sentence the next reviewer trusts instead of reading the code (Argus r1 on PR #322,
    2026-08-16). ON ANY SURFACE, exactly as (a): the boot re-key refusal, the boot credential
    refusal, AND the EXPLICIT owner-driven migration refusal
    (`gateway/cores/integrations.ts` `migrateOrphanedCredentials`) all resolve the scope through the
    same `gateway/scope-refusal-journal.ts` planner. The explicit one is not an exception on the
    grounds of being owner-initiated: it refuses only when the handle IS the fallback, so writing it
    under the request's own handle put the audit row for a security-relevant refusal in the same
    unreadable place. It keeps its own two differences, both deliberate — it is NOT deduped (a
    repeated owner ATTEMPT is the fact an audit trail exists to preserve, and the reachable surfaces
    are owner-authenticated, so the row count is bounded by owner actions rather than by traffic),
    and it adds `surface: 'explicit_migrate'` so one journal query finds both rows and can still
    tell them apart. `listRecentForScope` is
    strictly `WHERE project_slug = ?` by design (`persistence/system-events.ts`) and the refusal
    deliberately does not re-key the ledger, so the next explicit boot takes the ledger-agrees
    fast path and never sweeps the row back: scoped anywhere else, the guard's only observable
    signal is invisible to the instance it protects, forever. The readable handles are the
    ledger's (authoritative — it names a handle THIS database has booted under and committed inside
    the re-key transaction; NOT "written only by an explicit boot", which is false — a fallback boot
    with nothing stranded falls past the guard and seeds it, proven by
    `migrations/__tests__/scope-rekey-direction-guard.test.ts` "a FRESH dev box still seeds", and
    `gateway/scope-refusal-journal.ts` `resolveOwnerReadableScopes` documents why the weaker
    property is the one relied on) or, absent that, `onboarding_state`'s; blank handles are dropped. READABILITY IS DECIDED BY THAT EVIDENCE, NOT
    BY STRING INEQUALITY WITH THE BOOTING PROCESS: an owner whose instance really is called `dev`
    reads under `dev`, and dropping that scope because the attempting process resolved to the same
    string moved the row to an unreadable one — worse than the code the rule replaced (Argus r2,
    2026-08-16). Only when the database records NO identity at all does the row fall back to the
    attempting handle, which is the floor (exactly what shipped before) and is never the frozen
    credential handles — there is no parameter for those any more, so the rule cannot be re-broken
    by a branch nobody exercises. Three further rules, all in
    `gateway/scope-refusal-journal.ts`: the attempting handle rides in `payload.attempted_by_slug`;
    each row is NARROWED to its own scope (its own handle and counts — a foreign handle's NAME in
    an instance-scoped feed is the cross-scope disclosure the strict predicate exists to prevent,
    and keys are TRIMMED before they are counted or compared so a padded legacy key does not report
    the reader zero rows of his own); and the journal is EDGE-TRIGGERED AGAINST THE VISIBLE WINDOW
    (`listVisibleForScopeAndName` + `shouldJournal`), because the owner's window is 50 rows with
    no retention sweep and an unconditional row per anonymous boot evicts the report it is trying to
    appear in. FOUR properties of that trigger, each a defect when it was absent: the comparison is
    bounded to the SAME window the feed returns (measured against unbounded history, a repeat that
    rotated out of the feed is suppressed permanently and silently — strictly worse than the
    starvation it prevents), and that window is `DEFAULT_MAX_RECENT_EVENTS`, the diagnostics
    default, pinned equal by test because suppressing against a window WIDER than the feed's hides a
    warning the owner cannot see; the dedup READ is best-effort inside a try (one corrupt historical
    `payload_json` row would otherwise abort the boot, since the reader parses with
    `onCorrupt: 'throw'` and this runs before the boot's own failure cleanup); BOTH
    `credential_scope_orphaned` branches trigger, since the ordinary ambiguous orphan writes under
    the same `(scope, event_name)` key and an unconditional write there writes a row every boot;
    and THE COMPARISON IS MEMBERSHIP OF THE VISIBLE SET, NOT EQUALITY WITH ITS NEWEST ROW. That last
    one is what actually closes the alternation hole, and covering both branches did not (Argus r1
    on PR #322, 2026-08-16): the two shapes share one `(scope, event_name)` key, so a box that
    alternates between an anonymous and an explicit boot — a unit that intermittently loses its slug
    env — sees the OTHER shape as the newest row every time, and every boot writes. Asked "is this
    payload already anywhere on the page", the feed settles at one row per distinct shape, and any
    future third shape is covered without anyone noticing it exists.
    AND NO JOURNAL PAYLOAD ON THIS PATH MAY CONTAIN AN ACTIVITY-COUPLED COUNT — no field that moves
    when the owner merely USES his instance. The trigger hashes the payload, so such a field re-arms
    it on every boot and the starvation returns in full, on exactly the instances that are in USE
    and on none of the idle databases the dedup tests boot against (Argus r2 blocker on PR #322,
    2026-08-16: `instance_scope_rekey_refused` carried `stranded_rows`, a `COUNT(*)` over ~40 swept
    tables including `tasks`; four anonymous boots with one task between each wrote FOUR rows). That
    same field was independently FALSE once the row moved to the live handle —
    `stranded_slug`/`stranded_rows` named the reader's own handle and his own healthy data, which
    the guard had just protected, and the feed rendered his ordinary growth as a worsening data-loss
    condition. So the instance-refusal payload is `targeted_slug`, `other_targeted_handles`,
    `attempted_by_slug`: the CONDITION, never its volume. The RULE IS ACTIVITY-COUPLING, NOT "no
    number anywhere": the credential refusal's `orphaned_handles`/`orphaned_rows`
    (`gateway/scope-refusal-journal.ts` `planCredentialRefusalRows`) count rows in the CREDENTIAL
    tables only, which tasks and reminders never touch — they move only when the orphaned credential
    set itself changes, and a changed orphan set IS new information the trigger should re-fire on
    (the drift test pins this: four boots with a task between each hold the credential feed at one
    row). Unbounded volumes go to the log lines, which compete with nothing — and for the same reason those log
    counts EXCLUDE `system_events`, since counting the journal's own table reported the previous
    boot's warning as "rows at stake" and climbed 1 → 3 → 4 across three IDENTICAL boots.
    AND THE READER MUST RESOLVE THE SAME SCOPE BOOT FROZE: `neutron doctor`
    (`open/owner-identity.ts` `resolveOwnerSlug` → `open/diagnostics-cli-impl.ts`) follows boot's
    precedence exactly — `.url_slug` file > trimmed `NEUTRON_INSTANCE_SLUG` > `dev` — because a
    resolver that disagrees by a space or ignores the rename file queries a scope no row was ever
    written under, which is this same invisibility one layer out.
    Protects: `migrations/__tests__/scope-rekey-direction-guard.test.ts` (policy),
    `gateway/__tests__/owner-slug-provenance.test.ts` (the `source` field itself — including blank
    and padded env values — plus a file-driven forward re-key through a real `boot()`),
    `gateway/__tests__/scope-refusal-journal.test.ts` (scope choice including the `dev`-is-my-name
    coincidence, narrowing, blank + padded handles, the nested-payload comparison, the thrown-read
    path), `persistence/system-events.test.ts` (the window bound itself, with a wider-window control
    proving the null is the window and not a broken query),
    `gateway/__tests__/boot-refusal-scope.test.ts` (through a real `boot()` on the shape where the
    frozen credential handle DIVERGES from the live one, with both unreadable scopes asserted empty
    as the control; three identical boots writing one row; a rotated-out repeat written again; an
    ambiguous non-refused orphan deduped across two boots; and a corrupt row that does not abort the
    boot), `open/__tests__/diagnostics-cli.test.ts` (the doctor's scope — padded env, blank env, and
    the rename file, with a no-file control), `open/__tests__/open-scope-rekey-direction-boot.test.ts`
    (the flag reaching the reconciler from the composition root, and both refusal rows read back
    through the production `listRecentForScope` with the anonymous scope asserted empty as the
    control).


118. Trident terminal-verdict HONESTY + built-work SALVAGE (added 2026-08-31; the 30-day
    measurement: 97 of 160 recorded REQUEST_CHANGES rows carried no findings, 33 already at
    `forge-done` — built work recorded as rejected, then rebuilt from scratch).
    (a) `REQUEST_CHANGES` requires non-empty recorded findings AT BOTH WRITE SITES, because a
    precondition only one of two writers honours is not a precondition. In-process:
    `update`/`save`/`saveIfActive` throw `TridentEmptyFindingsRejectionError` when the effective
    post-write state would be `REQUEST_CHANGES` with NULL/`[]`/unparseable findings
    (`trident/store.ts`, the throw sites in `update`/`save`/`saveIfActive`; RED-on-revert pins in
    `trident/store.test.ts:990`
    "empty-findings rejection guard"). Out-of-process: the LIVE inner workflow does not go through
    the store — it invokes `trident/checkpoint.sh`, which writes the verdict through a SQL CASE
    over the effective findings (`json_valid`/`json_type`/`json_array_length`, the SQL spelling of
    `parseCheckpointFindings`) and records `REVIEW_NOT_RUN` instead when they are empty
    (`trident/checkpoint.sh`, "THE VERDICT WRITE"; `trident/checkpoint-sh.test.ts`, "a REJECTION
    MUST STATE A REASON"). REFUSED, not failed: the rest of the write still lands, because losing
    the branch/checkpoint/result would trade one bad column for a blind row. `writeTerminalResult`
    therefore carries the rejection's findings into the SAME invocation as the verdict
    (`trident/inner-workflow.mjs`). Never "fixed" by defaulting to APPROVE — that would merge
    unreviewed code. THE PRECONDITION IS ON THE ROW, NOT ON THE INVOCATION: a findings-only write
    that empties the set DEMOTES a stored `REQUEST_CHANGES` to `REVIEW_NOT_RUN` (an `APPROVE` or
    null-verdict row is untouched), or the forbidden shape is reachable in two legal steps — and
    the findings file is read ONCE, in bash, and emitted as a single SQL literal, because
    `readfile()` is re-evaluated at every one of the CASE's four mentions and a file swapped
    mid-statement decided the verdict from bytes other than the ones stored
    (`trident/checkpoint.sh` `read_file_literal`/`findings_case`; both pinned RED-on-revert in
    `trident/checkpoint-sh.test.ts`). THAT STATEMENT REACHES `sqlite3` ON STDIN, never as an argv
    element: the materialised bytes appear in it four times, Linux caps ONE argument at 128 KiB
    whatever `ARG_MAX` says, and a 33 KB findings file therefore killed the whole terminal write
    with `Argument list too long` — losing verdict, findings and branch together on exactly the
    reviews that found the most to say. AND A SETTLED REJECTION IS NOT ERASED: on a TERMINAL row a
    findings-only write that would empty REAL recorded findings is refused on BOTH columns at once
    (the verdict and the findings), because `artifactCheckpointCommand` opens every phase
    checkpoint with `printf '%s' '[]' > <tmp>` and a cancelled build's workflow keeps checkpointing
    (rjunee/neutron#177), so the demotion that is right for a live row would otherwise let an
    orphan rewrite a reviewer's decision to `REVIEW_NOT_RUN` and delete their words with it —
    manufacturing the built-never-reviewed row this invariant exists to prevent. A LIVE row still
    demotes; adding real findings to a terminal row is still allowed; only erasure is refused. The
    guard arms on the row's CLAIM (`inner_verdict = 'REQUEST_CHANGES'`, so the legacy findings-free
    population is protected too) OR on stored findings that really parse (so a terminal
    `REVIEW_NOT_RUN`/`APPROVE` row keeps the evidence `recordedTerminalVerdict` promises is
    "still PRESERVED" and `builtButNeverReviewedSeed` carries forward), and it covers the
    verdict-carrying invocation as well as the findings-only one: `inner_verdict REQUEST_CHANGES`
    beside `[]` is the same emptying write with a verdict stapled on, and it asks for the ONE
    verdict this script refuses to write findings-free, so it can never be a caller deciding
    something new. `APPROVE` and a clearing write still land. The BOUND-REVIEW executor obeys the same rule for the same
    reason (`trident/orchestrator.ts`, `recorded_verdict`): its verdict comes from the panel's
    `inner_result` JSON while its findings come from the panel's column, so the two can disagree,
    and the store's throw would otherwise keep the run non-terminal and re-run the whole review on
    every tick (`trident/review-run.test.ts`, "the row must be WRITABLE" + its positive control).
    (b) `REVIEW_NOT_RUN` is the ONE no-reviewer terminal verdict
    (`migrations/0138_code_trident_runs_review_not_run.sql`), written at source by
    `writeTerminalResult` (`trident/inner-workflow.mjs`) and at every orchestrator fabrication
    site through `recordedTerminalVerdict` (`trident/orchestrator.ts:912`; REQUEST_CHANGES survives
    only with Argus provenance + non-empty findings). A run terminating at `forge-done` with no
    review records REVIEW_NOT_RUN, never REQUEST_CHANGES
    (`trident/inner-workflow-built-head.test.ts:435`).
    (c) The three-way taxonomy — died-before-build / built-never-reviewed / reviewed-rejected — is
    derivable from EXISTING COLUMNS ALONE via `terminalRunDisposition`
    (`trident/run-disposition.ts:155`; table pinned in `trident/run-disposition.test.ts`). No new
    column; historical rows are never rewritten (they are the measurement evidence). A
    REQUEST_CHANGES row classifies `reviewed-rejected` whether or not it carries findings, so a
    legacy fabricated row can never seed a resume; `died-before-build` means "no build this
    dispatch may resume" (`ralph-task-built` sits there WITH a commit, because the workflow
    rebuilds that shape by design). The classifier is mode-blind so an offline count of the
    historical table never turns on a flag, and the offline SQL published in `docs/AS_BUILT.md` is
    executed against it rather than asserted (`trident/as-built-disposition-sql.test.ts`).
    (d) A built-but-never-reviewed terminal SEEDS the next dispatch of the same card
    (`builtButNeverReviewedSeed`, `trident/run-disposition.ts:210`; chokepoint
    `trident/board-dispatch.ts`, the `cardsPriorRun` block, via `latestTerminalBySlug`,
    `trident/store.ts:677`) under
    SIX preconditions, each of which replaces a guard the seed itself removes: the prior row was
    not STOPPED (`stopped` has two writers, `/code stop` and the board X-cancel/delete via
    `trident/terminate.ts`, so it is always an explicit operator discard — never a crash, reap or
    budget death; the DISPOSITION still reads `built-never-reviewed`, because the offline count is
    about what happened, only the SEED refuses), the prior row's
    FULL TASK TEXT is this card's (the slug truncates at 35 chars, so two cards can collide on it
    and share a branch), THE CARD'S OWN `linked_run_id` NAMES THAT RUN — task text is a proxy and
    two distinct cards can carry identical text, so identity is taken from the board's own link
    and an absent/null/whitespace-only one FAILS CLOSED to a fresh dispatch
    (`trident/board-dispatch.ts` `cardsPriorRun !== '' && cardsPriorRun === prior.id`, pinned by
    `trident/board-dispatch.test.ts` "a card carrying NO LINK AT ALL does not seed"), the prior
    row carries a 40-hex `base_sha`, the branch tip resolves to
    EXACTLY the recorded head THROUGH THE REF THE LAUNCH WILL READ (`ls-remote --heads origin` in
    pr mode, mirroring `resolveResumeLiveHead`; the local ref in local mode — a local-ref proof in
    pr mode predicts a resume that cannot happen, since Forge does not push in pr mode and
    `classifyResume` answers `head-branch-absent`), AND THAT REMOTE READ IS CREDENTIALED — a
    bare-env `ls-remote` against a private origin exits non-zero and collapses to `''`, which is a
    silent no-seed, so the composition root hands its own `tridentHostRunner` to EVERY production
    dispatch site as `BoardBoundBuildDeps.hostRunner` (paired with `landedProbe`, the other
    credentialed remote read, and pinned that way in
    `open/__tests__/open-trident-prod-boot-wiring.test.ts`; the fail-closed direction means an
    unwired site is invisible except as work rebuilt), and the checkpoint is one
    `resumeOnUnchangedHead` really reviews — a bare `forge-done` in RALPH mode is not (it rebuilds,
    'ralph-progress-unknown'). The base pin is REQUIRED, not carried-if-present: a seeded row is
    not a fresh launch and `launch()` never re-pins it, so a null-base seed would leave the
    publish-time cut-from-origin refusal permanently inert for it and every re-seed off it. The
    seed does NOT carry `pr`, which would short-circuit `detectExistingPr` onto a possibly-closed
    PR (`trident/board-dispatch.test.ts:478` "dispatch seeds a resume from a built-but-never-
    reviewed prior run"). Any non-qualifying shape dispatches byte-identically to a fresh launch,
    guard intact. AND THE PROOF IS RE-VERIFIED WHERE IT IS CONSUMED: the dispatch proof is taken a
    process earlier, so `launch()` drops the entire seed — checkpoint, head, findings, base pin —
    when the live head it reads anyway is a 40-hex OTHER than the recorded one, restoring the
    fresh-launch base pin and leftover-branch refusal (`trident/orchestrator.ts`, "SEEDED RESUME —
    REVALIDATED AT LAUNCH"; `trident/orchestrator.test.ts`, "a SEEDED row whose branch MOVED since
    dispatch"). A row that has already FIRED (`workflow_run_id !== null`) is never treated as
    seeded — its branch legitimately advances past its own last checkpoint — and NEITHER IS A
    RECOVERED ONE: `beginCrashRecovery`/`beginInfraRetry` NULL `workflow_run_id` on a row that
    earned its checkpoint by firing, so the discriminator also requires `crash_recoveries` and
    `infra_retries` to be 0 (both are 0 by construction on a freshly seeded row). Without that,
    a crash-recovered run whose live head had legitimately moved past its checkpoint — the
    everyday shape, since `checkpoint.sh` records `fix-round-N` BEFORE that round's commits —
    lost its checkpoint AND its base pin to the falsification branch and was then failed
    terminally by the ownership guard over its own commits (`trident/orchestrator.test.ts`, "a
    CRASH-RECOVERED run is not a seed" and "an INFRA-RETRIED run is not a seed either", both
    built through the real store methods). AND THE SEED NO LONGER
    STRIPS THE LOCAL-BRANCH OWNERSHIP CHECK: that refusal runs for every row that has NOT fired
    (`freshLaunch || seeded_resume`), because the seed's proof is about the ref
    `resolveResumeLiveHead` reads — the REMOTE in pr mode — while the refusal is about the LOCAL
    branch Forge re-enters, and an absent/unreadable/even matching remote says nothing about it
    (`trident/orchestrator.test.ts`, "a SEEDED row runs the local-branch ownership check" and "a
    seed the REMOTE proves is still no proof about the LOCAL branch"). It refuses nothing that was
    previously fine: a tip contained in the pinned base, or descended from this row's own
    `base_sha` AND containing this row's own recorded checkpoint head (`ownCrashLeftover`), is
    exempt — the shape a legitimate salvage seed has. DESCENT FROM THE PIN ALONE IS NOT
    OWNERSHIP: a sibling lane that cut the same branch name from the same base descends from it
    too, so the recorded head — a commit this row demonstrably owns, which a sibling's tip cannot
    contain — is the comparison that separates them (`trident/orchestrator.test.ts`, "a SIBLING
    lane cut from the same base is refused" and its positive control "a seeded resume whose
    branch CONTAINS its recorded head proceeds"). The comparison is made only when the recorded
    commit is READABLE here (`cat-file -e`), because `merge-base --is-ancestor` cannot tell "not
    an ancestor" from "unknown object" and refusing on an unreadable object would discard built
    work on evidence the guard does not have. The seed-DROP half stays narrow (40-hex mismatch only): widening the drop
    to "not a confirmed match" would discard exactly the built work this invariant exists to
    preserve the first time an origin read blipped. The pr-mode tip
    probe is CREDENTIALED, like the landed probe beside it — uncredentialed it exits non-zero
    against a private origin and the salvage silently never happens
    (`trident/board-dispatch.test.ts`, "THE PR-MODE TIP PROBE IS CREDENTIALED").
    (e) `round` is DERIVED from round-carrying checkpoint names at BOTH write seams — TS
    (`checkpointRound`, applied in `trident/store.ts:1047` and at create `trident/store.ts:461`) and
    bash (`round_for_checkpoint`, `trident/checkpoint.sh:183`, folded into the same atomic UPDATE at
    `trident/checkpoint.sh:337`) — as `MAX(round, N)`, monotonic, pinned by the cross-language
    equivalence suite (`trident/checkpoint-round.test.ts:58`) and the derivation suite
    (`trident/checkpoint-sh.test.ts:508`). Both copies clamp the round to at most nine digits and
    both TRIM before matching, which is what makes the equivalence total rather than true only over
    the names a writer emits today: bash's `$(( 10#N ))` wraps NEGATIVE past 2^63 and would
    interpolate a minus sign into the UPDATE, and an untrimmed bash copy answered '' for
    ` fix-round-3 ` where the TS copy answered 3. A round that reaches the row is also always an
    INTEGER — `code_trident_runs.round` is INTEGER on a STRICT table, so both the parse
    (`trident/inner-loop.ts` `parseInnerResult`) and the harvest fold
    (`trident/orchestrator.ts` `applyResult`) narrow with `Number.isSafeInteger`, never `isFinite`.
    A checkpoint name and its round can never disagree — SCOPED to the round DOMAIN both parsers
    share (at most nine digits). Outside it the clamp DECLINES rather than lies: a name carrying a
    ten-digit round parses to no round at all in either copy, so the row keeps the round it already
    had instead of adopting a wrong one — the safe direction, and unreachable in production because
    rounds are bounded by `max_rounds`. ONE DOMAIN, THREE COPIES: `terminalRunDisposition`'s
    `OUTER_PUBLISHED` shape test (`trident/run-disposition.ts`) and the offline SQL in
    `docs/AS_BUILT.md` (`LENGTH(tail) - INSTR(tail, ':') <= 9`) carry the SAME nine-digit round
    bound as the two parsers, so a name outside it is "not one of these shapes" in every copy
    rather than salvageable in one and unreadable in the next. The launcher's resume parse
    (`trident/orchestrator.ts`, the `outer-published:` capture feeding `recorded`) stays wider on
    purpose and is not a fourth definition of the domain: it reads the OID out of group 1 to
    compare heads and never consults the round at all.
    Readers follow the RECORDED verdict in both directions — a never-reviewed row is never narrated
    as a rejection AND an APPROVED one never is either (`trident/delivery.ts:217,358-362`).
    Protects: **P10** (Trident checkpoint hardening; cross-ref #20, #112) and the
    trustworthy-rejection-count query recorded in `docs/AS_BUILT.md` (2026-08-31 entry).

## 4. Duplication / consolidation seams (`critic-duplication.md`)

27. Sender-registry semantics DIFFER by design: chat-bridge's send must **propagate** throws
    (engine converts to `send_failed`); app-ws fan-out must **evict** throwing senders and
    continue (one dead socket must not starve another device). A consolidation must be
    policy-parameterized, not naive. `chat-bridge.ts:202-219` vs `app-ws/adapter.ts`.
    Protects: **F5** (Delivery consolidation), **D3** (chat-bridge cluster split).
28. `AppWsAdapter.send` ordering: persist-first → stampDelivered → fan-out; persist failure
    degrades to a no-seq live emit, never drops. `buttonStore.emit` failure likewise must not eat
    the live reply. `adapter.ts:174-199`, `build-live-agent-turn.ts:988-994`.
    Protects: **F5**.
29. Drain loops (post-O8): the ONE consolidated drain is `drainToOutcome`/`drainToText` — on the
    terminal `completion` event it RETURNS the accumulated text as `completed` (there is NO
    keep-draining-past-completion mode), and an `abort` WINS A TIE against a raced
    `completion`/`error`/pending pull (re-check the signal before returning any terminal outcome).
    The scribe/reflection callers no longer keep a local drain loop — they DELEGATE to `drainToText`
    with `keepAliveExempt: true` (their watchdog abort CANCELS the handle / abandon-poisons the warm
    session, whereas the default drain aborts WITHOUT cancelling); the email triage stub throws by design.
    `runtime/substrate-text.ts:~227-320` (the shared drain — the per-chunk
    `onboarding/history-import/substrate-callers.ts` caller was deleted in #216), `scribe/extract.ts:~164-174`,
    `reflection/detector.ts:~141-151`.
    Protects: **O8** (drainToText consolidation), **D5** (email backend split).
30. Sidecar resolvers: mismatch error codes are per-core contracts; init-dedup finally-clears the
    pending map; adding traversal guards to email/code-gen/calendar is a scheduled behavior change,
    not an incidental one. `cores/free/research/src/store-resolver.ts:90-200` (the one with the
    `safeResolveProjectRoot` traversal guard), `cores/free/email/src/cache.ts:279-345`.
    Protects: **X2** (Typed Core module contract), **X4** (cores/runtime shared helpers).
31. Open start-tokens are single-use JTI; the cookie is minted only on first claim; the two
    existing copies of this block must converge on ONE implementation with the same claim
    semantics. `open/composer.ts:1655-1760` (verbatim copies at `:1713-1726` and `:1738-1749`).
    Protects: **S1** (Per-install owner credential).
32. Credential resolver precedence: env OAuth > API key > ambient (Open-only); the `'ambient'`
    tier threads NO token (the child process uses the OS Keychain).
    `gateway/cores/core-credential-resolver.ts:46-61`.
    Protects: **C6** (Credential-resolver unification).
33. leak-gate allowlist is keyed to the literal `docs/AS_BUILT.md` path; Ralph prompts will
    recreate a root `AS-BUILT.md` unless repointed first. `scripts/ci/leak-gate-allowlist.txt:69-80`.
    Protects: **K6** (Changelog consolidation), **K7** (Docs truth pass), **K10** (repoints
    prompts), **G7** (Leak-gate NUL tripwire).
34. `app/` bundle purity: the shared wire-types package must never import node-only modules or it
    bricks the Expo/Metro build — this constraint, not laziness, drove the L6 consolidation into the
    node-free leaf. `wire-types/app-ws-envelope.ts:1-13` (the node-free rationale; the former
    hand-mirror `app/lib/ws-envelope.ts` was consolidated into this leaf and deleted in #270).
    Protects: **L6** (`@neutronai/wire-types` leaf).
35. Open composer's env-mutation-as-DI trick + `open/server.ts` process.env writes are duplicated
    across the two boot paths and must converge to one implementation. `open/server.ts:58-73`.
    (Cross-ref #1.)
    Protects: **C1**.

## 5. Errors & fail-soft/fail-open (`critic-errors-observability.md` §8)

36. Sender registry MUST propagate throws — catching a closed-socket throw here silently
    downgrades to `was_new=false`, `delivered_at` gets stamped wrongly, and reconnect re-emit
    recovery dies. `gateway/http/chat-bridge.ts:202-219`. (Cross-ref #27.)
    Protects: **F5**, **D3**.
37. AppWs persist-failure fails OPEN twice: agent reply falls back to no-seq live emit; user-message
    persist failure reports `was_new:true` on purpose so the turn still dispatches.
    `channels/adapters/app-ws/adapter.ts:184-196,300-356`.
    Protects: **F5**.
38. Substrate error taxonomy strings are API: `isFreezeTimeout` and the 429-regex family mean
    adapter error MESSAGES are contract — any wording change is a behavior change.
    `build-live-agent-turn.ts:1445-1447`.
    Protects: **O3** (Error taxonomy + typed substrate error codes).
39. Binary-ENOENT must stay non-retryable so it can't launder into a 429 cooldown; `all_cooldown`
    must stay `retryable:true`. `build-llm-call-substrate.ts:437-442,515-523`.
    A SUBSTRATE-LOCAL failure must never be reported as a credential fault, on EITHER
    credential-failure lane. `detectBinaryNotFound`, `detectChannelWedged`,
    `detectTurnTimeout` and `detectReplProcessExited` are classified AHEAD of the cooldown
    map in `build-llm-call-substrate.ts` and MUST skip `reportFailure`: none carries an HTTP
    status, so the map can only guess 429, and on a single-credential box (every Open
    install) five guesses park the pool for an hour behind "all Anthropic credentials are in
    cooldown" — a cause that is not true. The dead-REPL member is the one a lane rule cannot
    cover: the strikes that caused the 2026-08-17 chat lockout were the owner's own
    INTERACTIVE retries against a respawning child.
    Because each detector matches PROSE emitted by another module, invariant 38 applies to
    their producer literals: a reword is a behavior change, and
    `__tests__/g6-error-string-conformance.test.ts` pins each one to its producer source.
    Protects: **O3**.
40. Email triage LLM stub THROWS by design so triage renders its deterministic fallback;
    agent-settings fallbacks must report `available:false`, never fake success.
    `gateway/cores/mount-open-cores.ts:177-277`, `gateway/boot-helpers.ts:1163-1180`.
    Protects: **D5**, **X2**.
41. Reminder dispatcher degrades to `literalFallback` on ANY LLM failure so a reminder always
    delivers — but the degrade is BOUNDED: stored intent over `MAX_DEGRADED_INTENT_CHARS`
    (300) is replaced by a generic line naming the reminder id, and a COMPOSED body over
    `MAX_NUDGE_BODY_CHARS` (2000) is refused as a composition failure rather than posted.
    A failed compose must NEVER post `row.message` (#293 defect B). Outbound is
    persist-before-send with swallowed live-push throws.
    `reminders/message-shape.ts` (`literalFallbackResult` / `overBoundNudgeBody`),
    `reminders/dispatcher.ts` (`fallbackBody` / `compose`). (Cross-ref #22.)
    Protects: **F1**.
41b. A FIRED reminder is delivered to the topic that owns the work: `app:<owner>:<project>`
    when its stored destination names an EXISTING project, General otherwise — and EVERY
    downgrade to General is logged with a reason, never silent. The project lister must not
    swallow read errors into "no projects exist" (that reroutes every project reminder), and
    the resolver must never throw (a throw before the post makes the tick loop re-fire
    forever). `open/wiring/reminder-topic.ts`, `open/composer.ts` (`listProjectIds` /
    `resolveAppWsReminderTopic`).
    Protects: **F1**.
42. Engagement gate fails soft to `all_messages` — a DB read error must never drop a chat turn.
    `gateway/http/chat-bridge.ts:2749-2791`.
    Protects: **D3**.
43. **RETIRED (K11d #248).** The wow-push emitter (`gateway/wow-push-emitter.ts`) was deleted with
    the dead wow-push / final-handoff / max_oauth cluster, so the fail-closed-vs-`pushAll` contrast is
    moot. The surviving half of the policy — calendar/email briefs intentionally DO `pushAll` — remains
    correct and lives on in the brief dispatchers.
    Protects: unprotected — covered by review only.
44. GBrain latch + remove-before-add + append-only merge is the fail-soft, exactly-once-logging
    contract; chat turns must never crash on memory writes.
    `GBrainSyncHook.ts:199-256`, `scribe/write-to-gbrain.ts:19-41`. (Cross-ref #21.)
    Protects: **P9**.
45. `InMemoryWebChatSenderRegistry` identity-guarded unregister, recovered-reply drain topic
    gating, and `recordInboundReceived`-before-`advance` are error/ordering invariants a "cleaner"
    async refactor could reorder. `gateway/http/chat-bridge.ts:185` (registry class).
    Protects: **F5**, **D3**.
46. Import honest-failure gate: `attempted>0 && succeeded==0 && projects==0` → `failed`, never a
    blank `completed` wow. `build-synthesis-import-runner.ts:203-220`. (Cross-ref #25.)
    Protects: **P6**.
47. 429 exhaustion routes to `rate_limit_paused` (resumable), never `failed`; the cooling-off
    overlay on `error_message` must be cleared on success. `job-runner.ts:1414-1427,1604-1619`.
    Protects: **O3**.
48. The consolidated substrate drain RETURNS on the terminal `completion` event (it does not keep
    iterating past it) and tears the SETTLED iterator down via a fire-and-forget `iter.return()` —
    that teardown must NEVER be awaited (a poison-flag no-op that could otherwise hang on a
    misbehaving adapter), and `abort` must win a tie against a raced completion.
    `runtime/substrate-text.ts:~290-325` (the O8 drain; the old `substrate-callers.ts`
    `drainSubstrateEvents` loop was deleted in #216 — the import substrate's completion→reportSuccess
    proxy now lives in `gateway/wiring/build-import-substrate.ts:436-455`).
    Protects: **O8**.
49. Cron missed-fire catch-up fires exactly once; unsupported grammar warns + skips — converting
    the warn+skip into a throw bricks boot for Managed-grammar jobs.
    `cron/scheduler.ts:166-234`.
    Protects: **F2** (LoopRegistry + boot inventory).

## 6. Extensibility / registries (`critic-extensibility.md` §6)

50. The `SERVICE_SCOPE` global carve-out for Gmail/Calendar credentials is a deliberate
    no-re-consent policy — per-project context threading must NOT flip those two services to
    per-project scoping. `core-credential-resolver.ts:47-51`.
    Protects: **X6** (`[BEHAVIOR]` Project context to the tool boundary) — explicitly preserves
    this via the kept `SERVICE_SCOPE` policy.
51. Kickoff's dedupe rides the `onboarding_opening:<project_id>` durable slot; a recurring
    dispatcher must keep one-time semantics for already-fired projects.
    `build-project-kickoff.ts:15-19`, `build-onboarding-finalize.ts:416-424`.
    Protects: **C8**.
52. `pickAgentMeta` is additive/incoming-wins (`chat-core/store.ts:147-171`); transcript
    unification must not let a metadata-less replay row clobber richer local state.
    Protects: **W3**.
53. Client stores differ by design: op-sqlite needs explicit columns; OPFS snapshots the whole
    `ChatMessage` as JSON (no columns needed) — "mirror the columns" plans are store-specific.
    `chat-core/stores/opfs-store.ts:23,33`.
    Protects: **W1**, **W3**.
54. Staged/timer-fired sends must target the `app:` registry (PR#105); the durable rail/badge path
    is read from `button_prompts` history regardless of the live registry.
    `channels/adapters/app-ws/adapter.ts:174-199` (app: registry fan-out).
    Protects: **F5**, **W5** (`[BEHAVIOR]` chat-core connection resilience).
55. `hasAnyChainedSurface` and its field mapping must move together — already diverged for 3+
    fields per the gateway-services map; a registry-based fix must encode current order/set as an
    explicit list with a transition test. `gateway/composition.ts:264`.
    Protects: **C4**.

## 7. God-module split safety (`critic-god-modules.md`)

56. `buttonStore.resolve`'s `was_new` idempotency barrier gates the router's `state_delta` merge —
    re-merging replays corrections. `engine.ts:~4111-4136`.
    Protects: **D9a–D9d** (Interview-engine decomposition).
57. `PENDING_INBOUND_WINDOW_MS` (`engine.ts:537`) and `recordInboundReceived` ordering with
    chat-bridge are a matched timing pair.
    Protects: **D9a–D9d**, **D3**.
58. `last_advanced_at` has dual semantics — stall-watchdog preservation vs. source-switch bump.
    `engine.ts:3950-3987`.
    Protects: **D9a–D9d**.
59. `walkAutoSkip` and the resolver's `AUTO_SKIP` null-return are a matched pair; splitting one
    without the other silently changes skip behavior. `engine.ts:~7813-7820`.
    Protects: **D9a–D9d**.
60. **DONE (K4a #219).** The dead `acceptChoice` path was deleted and its coverage migrated per this
    invariant's mandate; only historical name-mentions survive in `onboarding/interview/engine.ts`
    comments (the old `engine.ts:1322` anchor now points at unrelated import-routing code). The K4
    known-divergence — `__cancel__` wrongly advancing signup on the generic route — is pinned by a
    characterization test and owned by a later onboarding-flow fix unit. The general rule still holds:
    many test files pin `engine.ts` behavior, so removing an engine surface must migrate its coverage.
    Protects: **K4** (Engine dead surface: acceptChoice + slug flow) — K4a merged (#219); K4b slug-flow deletion deferred.
61. `sink.register` runs BEFORE `ptyHost.spawn` in the persistent-repl substrate.
    `persistent-repl-substrate.ts:~1678-1694`.
    Protects: **D1** (PoolRuntime reification).
62. Identity-guarded eviction (unregisterIf / compare-delete) everywhere in the substrate — a
    respawn re-attaches the SAME `sessionId`; a split that "simplifies" to blind deletes
    reintroduces a P2/P3 resume race. `persistent-repl-substrate.ts:1005` (`ReplSink.unregisterIf`),
    `:1958` (call site).
    Protects: **D1**.
63. `pendingChildKills` consumption in `spawnResume` is one-owner-per-transcript.
    `persistent-repl-substrate.ts:1431` (decl), `:3288-3305` (consume in spawnResume).
    Protects: **D1**.
64. Ephemeral gate (`options.ephemeral && spec.session === undefined`) and the NEVER-enqueue-to-
    pending-respawns rule for ephemerals — a replayed internal prompt would otherwise land in the
    user's chat. `persistent-repl-substrate.ts:2861-2877`.
    Protects: **D1**, **F6** (Cancellation chokepoint).
65. Watchdog ticks scope the pool by owning `replRegistryPath`; the `rt` (runtime) threading must
    preserve that scoping or one instance respawns another's sessions.
    `persistent-repl-substrate.ts:~3553-3556`.
    Protects: **D1**, **D2** (Substrate banner split).
66. 48 test files under `persistent/__tests__` drive the REAL `ReplSink`/dev-channel seam — a
    split must not fork the sink into per-module instances.
    `persistent-repl-substrate.ts:1005` (the `ReplSink` seam the suites drive).
    Protects: **D1**, **D2**.
67. `open/server.ts:58-73` env mutation happens BEFORE `boot()` — untouched by the composer split
    but adjacent; config reads must not move out of the entrypoint. (Cross-ref #1.)
    Protects: **C1**.
68. Trident fire substrate must be WARM per-repo-cwd and only the `cc-agent-`/`cc-nudge-` pair gets
    `enableToolBridge` — pool-key/instance-id prefixes are semantic.
    `open/wiring/substrates.ts`. (Cross-ref #7, which carries the reasoning for the pair.)
    Protects: **D1**, **D2**.
69. 30 `open/__tests__` wiring tests + gateway `*-production-composer` tests are the composer-split
    lock; a characterization test snapshotting which `CompositionInput` fields Open sets must be
    added BEFORE the split and asserted unchanged after. `open/composer.ts:396-3615` (the
    composition closure the wiring tests lock).
    Protects: **C3a–C3d** (Carve `open/composer.ts` into wiring modules).
70. Registry send must PROPAGATE throws; identity compare-and-delete unregister.
    `gateway/http/chat-bridge.ts:202-219,192-200,1523-1542`. (Cross-ref #27/#36.)
    Protects: **D3**, **F5**.
71. `startSession` runs `engine.start` BEFORE the JTI claim; a duplicate JTI returns `false`, not
    an error. `chat-bridge.ts:~1229-1400`.
    Protects: **D3**, **K11** (One onboarding flow purge).
72. `recordInboundReceived` runs BEFORE `engine.advance`; the typing bracket starts before dispatch
    and ends in a `finally` on every path; `FORBIDDEN_INBOUND_VALUES` rejection happens before any
    resolve branch; the live-agent gate is `phase==='completed'` ONLY (2026-06-20 P0 note).
    `chat-bridge.ts:~1919-2717`.
    Protects: **D3**.
73. `tag_gated` no-mention posts persist the transcript and send a no-render `agent_ack`.
    `gateway/wiring/build-live-agent-turn.ts:1135`,
    `gateway/wiring/build-landing-stack.ts:1473`.
    Protects: **D3**.
74. Backup/restore facade: `last_attempted` written BEFORE the snapshot fires (scheduler contract);
    SNAPSHOT caps constants; sha/path validation errors are typed classes the HTTP surface maps to
    status codes — keep the error classes exported from the same specifier.
    `gateway/git/project-backup-store.ts:410` (facade class), `:210-217` (SNAPSHOT caps),
    `:953-972` (last_attempted read/write).
    Protects: **D4** (project-backup-store split behind facade).
75. `docs.tsx`'s `mutateGate` covering ALL mutations (create/rename/delete/binary) in one gate is
    the invariant — it has been fixed 4 separate times per review history; splitting into
    per-cluster hooks must keep one shared gate. `app/app/projects/[id]/docs.tsx:207`.
    Protects: **D7** (docs.tsx hook extraction).

## 8. Layering / module graph (`critic-layering.md` §10)

76. `connect/api/server.ts` must never gain a static import edge from composition — it is
    dynamic-imported only when `composition.connect_api` is set; converting the shadow types in
    `runtime/connect-handlers.ts` from `import type` to a static `import` would make every Open
    boot load federation code. `gateway/composition.ts:119`, `runtime/platform-adapter-local.ts:140`.
    Protects: **L3** (Remaining DAG edge cuts) — encodes the `connect-is-dynamic-only` rule.
77. The Expo (`app/`) bundle must never transitively import server workspaces (`node:sqlite`
    bricks the RN bundle) — this is WHY the client mirrors (`app/lib/doc-links.ts`,
    `tabs-client.ts`, now L6 re-export shims) and the node-free `@neutronai/wire-types` leaf exist.
    `wire-types/app-ws-envelope.ts:1-13` (the constraint rationale; the former `app/lib/ws-envelope.ts`
    mirror was consolidated into this leaf and deleted in #270). (Cross-ref #34.)
    Protects: **L6**, **W1**.
78. Gateway's export surface is a cross-repo ABI — the Managed deploy-gate keys on 8 literal
    surfaces in `neutron-managed/src/ops/open-contract.ts` (path+substring matched, NOT
    symbol-matched). Renaming/moving `gateway/boot-helpers.ts`, `gateway/index.ts`'s healthz
    handler, or splitting `open/composer.ts` breaks the gate even if every name survives.
    `gateway/index.ts:474-486` (healthz, one of the 8 pinned surfaces);
    contract at `neutron-managed/src/ops/open-contract.ts` (out-of-repo).
    Protects: **M1** (Contract-gate hardening + route-manifest adoption), **C7**
    (`realmode-composer/` → `gateway/wiring/` rename — see resolution below).
    **C7 RESOLUTION (verified 2026-07-15):** the rename needed NO paired `open-contract.ts`
    update. The contract is RELOCATION-TOLERANT (`open-contract.ts:34-40`): most surfaces are
    checked by scanning a PACKAGE DIR (`open/`, `gateway/`, …) for the surface's literals, not by
    pinning a subpath — the assertion is "this surface still exists in that package", not "it lives
    in this file". Renaming a subdir *within* `gateway/` keeps every surface inside the scanned
    `gateway/` package, so the gate is unaffected. Verified against the live contract: its only
    file-PINNED surface is `entrypoint:open/server.ts` (systemd spawns it), and none of the 8
    surfaces references a `realmode-composer` path. (A within-`gateway/` rename is exactly the
    move this tolerance was designed for.)
    **Import-side (INVARIANTS #96) also verified against live neutron-managed:** Managed's OWN
    production code imports ZERO `@neutronai/gateway/realmode-composer/*` paths — every importer of
    that dir lives inside `vendor/neutron/` (the vendored copy of Open itself). Managed consumes
    Open as a git SUBMODULE, so the dir rename and all its in-Open importers move ATOMICALLY in the
    same submodule bump — a Managed deploy never sees a half-renamed tree. The private composer that
    `NEUTRON_GRAPH_COMPOSER_MODULE` loads is not a checked-in Managed module importing these paths.
    Hence NO forwarding shims and NO paired Managed import change are required. (Only stale
    neutron-managed `SPEC.md`/`AS-BUILT.md` docs + one non-load-bearing synthetic `open-contract.test.ts`
    fixture still name the old path — cosmetic, refreshed on re-vendor.)
79. `boot-helpers.ts` must never import `gateway/index.ts` (TLA entry↔composer cycle);
    new "shared boot config" modules must sit below both. `boot-helpers.ts:6-20`.
    Protects: **L3**, **C2** (boot-helpers split).
80. `process.env` is the de-facto DI bus at boot; moving `resolveOpenDbPath` out of
    `open/owner-identity.ts` must preserve the exact DB-path/slug resolution order for both
    entrypoints. `open/owner-identity.ts:61`. (Cross-ref #1/#67.)
    Protects: **C1**.
81. Moving value constants changes module-init graphs (e.g. `collectTokensToString`,
    `TELEGRAM_BIND_TOKEN_TTL_MS`) — several modules read env at module-load time; relocation
    reorders those reads. Prefer re-export shims for one release.
    `gateway/wiring/build-llm-call-substrate.ts:793` (`collectTokensToString`).
    Protects: **L5** (Relative-import autofix sweeps).
82. `slugifyProjectId` (`onboarding/wow-moment/project-identity.ts:41-44`) must stay byte-identical
    to gateway's `defaultProjectIdSlugifier` — already guarded by a drift test; keep the test until
    there is literally one function.
    Protects: **N1–N4** (Identity/vocab rename series) — noted already-fixed in
    `critic-duplication.md` §8.
83. `docs/AS_BUILT.md` leak-gate literal-path coupling — module renames that touch docs or
    allowlisted paths re-arm retired-vocab CI rules; move allowlist entries in the same PR as any
    rename. `scripts/ci/leak-gate-allowlist.txt:69-80`. (Cross-ref #33.)
    Protects: **K6**, **K7**, **G7**.
84. Type-only vs. value edges: two of the layering cuts (edges #10/#11) are type-erased (zero
    runtime risk); the rest move real values and each needs its consumer's existing test suite run.
    `runtime/connect-handlers.ts:1-8` (representative `import type`-only shadow edge; see
    `critic-layering.md:429`).
    Protects: **L3**.
85. `cores/free/research` frozen model constants must NOT be converted to `getBestModel()` thunks
    while "just fixing imports" — that flips runtime model selection, a deliberate, separately
    verified change. `cores/free/research/src/research-orchestrator.ts:177`
    (`DEFAULT_MODEL_PREFERENCE`, imported `SONNET_MODEL`/`FAST_MODEL`).
    Protects: **X4** (cores/runtime shared helpers).

## 9. Lifecycle & concurrency (`critic-lifecycle-concurrency.md` §5)

86. Exactly-once terminal delivery depends on `listNonTerminal`-only sweeps plus save-before-hook;
    any job-table generalization must preserve "changed→terminal implies fresh".
    `trident/tick.ts:154-186`.
    Protects: **F1**, **P10**.
87. Reminder claim-before-dispatch + compare-and-swap revert is the deliberate at-most-once-on-
    crash path. `reminders/tick.ts:130-177` (issue #319). (Cross-ref #22.)
    Protects: **F1**.
88. Orchestrator `fired`/`redispatched` sets are per-process ON PURPOSE — restart triggers orphan
    detection; persisting them changes crash semantics. `orchestrator.ts:198-205`. (Cross-ref #20.)
    Protects: **F1**, **P10**.
89. The warm fire substrate is a singleton; per-fire substrates would kill detached workflows on
    settle. `inner-loop.ts:296-311`. Any kill seam must target the workflow, not the substrate
    session.
    Protects: **D1**, **D2**, **F6**.
90. Cron's `started` flag prevents double-binding between the `start()` sweep and `onRegister`;
    catch-up fires once, never per missed occurrence. `scheduler.ts:87-266`. (Cross-ref #49.)
    Protects: **F2**.
91. Backup scheduler (when wired): `writeLastAttemptedAt` BEFORE the snapshot fires is the
    restart-loop guard. `project-backup-scheduler.ts:176-194`. (Cross-ref #74.)
    Protects: **D4**.
92. Ephemeral one-shots must never enter the pending-respawn queue — replayed internal prompts
    would be redelivered to the user's chat topic. `persistent-repl-substrate.ts:2861-2877`.
    (Cross-ref #64.)
    Protects: **D1**, **F6**.
93. The engine's import hard-timeout anchors on the durable `job.started_at`
    (`engine-import-routing.ts:998-1001`) — a boot orphan-sweep must not race it into
    double-failure UX.
    Protects: **P6**.
113. Harvest before reap: Trident's tick §1 tries `parseInnerResult` on a run row EVEN when
    `subagent_status === 'crashed'` (`trident/orchestrator.ts:1118`) — a workflow that wrote a
    terminal result and only then lost its launcher must still harvest, with zero relaunches
    spent. `trident/crash-before-launch-save.test.ts`.
    Protects: crash-recovery relaunch path (§1a-crash) from regressing the pre-existing
    harvest-before-reap ordering guarantee.
114. Launcher-crash recovery is budget-bounded and the budget is DURABLE: `code_trident_runs
    .crash_recoveries` (migration 0123) is spent only by the atomic
    `TridentRunStore.beginCrashRecovery` claim (`trident/store.ts:499`); the cap is
    `DEFAULT_MAX_CRASH_RECOVERIES = 3` (`trident/orchestrator.ts:290`) and holds across gateway
    restarts because the counter is a column, not process memory. The terminal reason names the
    crash-recovery budget and must NEVER contain the token `exhausted` — `trident/delivery.ts:174`
    classes `crash-recovery budget` as an infra failure AHEAD of the exhausted-budget matcher, so
    it is not misclassified as agent-side spend. `trident/crash-recovery.test.ts`.
    Protects: bounded, restart-proof recovery from spinning forever under a deploy loop.
115. A crash-recovery relaunch is a continuation, not a retry: it never consumes `round` or
    `ralph_round`, and only `beginCrashRecovery` may clear the `crashed` latch / null the
    tombstoned workflow generation — never `update`/`save`/`saveIfActive` (`saveIfActive` vetoes
    non-crashed writes onto a crashed-latched row). `trident/crash-recovery.test.ts` +
    `trident/store.test.ts`.
    Protects: the fix-round budget from being spent on infrastructure failures that are not the
    agent's fault.
116. The Work Board's `inline_active` is DISPLAY-ONLY and EVIDENCE BEATS THE STORED FLAG. Every
    read boundary maps items through the one deriver (`work-board/inline-activity.ts`
    `makeInlineActivityDeriver`, wired in `open/composer.ts`); the stored column is never written
    by a read and is only ever a hint. The flag gets NO exemption from the freshness check — a
    crashed session's stuck flag reads not-active — and the derivation must never grow a branch
    that blocks, denies, delays or gates a tool call (it is the display-only salvage of the
    cancelled PreToolUse-gate plan). Evidence is tier 1 only: ONE O(1) `ActivityInspector` map
    read per board, never per row, never a shell-out. `work-board/inline-activity.test.ts` +
    `open/__tests__/inline-activity-wiring.test.ts`.
    Protects: the board from re-becoming a promise the agent has to remember to keep, and the
    read path from growing per-row I/O.
116. External launcher liveness acts only on positive death evidence: `alive`, `unknown`, or a
    throwing probe does nothing; malformed pids and disagreement between registry homes are
    ambiguous. Every running launcher is probed without the advancement sweep's 50-row cap. A
    detected launcher death uses the same durable crash latch as pushed crash events. The next
    sweep harvests a completed result first or claims bounded continuation; a dead shared launcher
    is never treated as proof that its detached build died. The 90-minute no-advance and 2-hour
    max-inflight backstops remain unchanged.
    `trident/tick.ts`, `trident/liveness.ts`, `trident/liveness-death-e2e.test.ts`.
117. Brief-part receipts are measured from persisted bytes before a manifest can be returned. `trident/brief-parts.ts` (`writeVerified`), protected by the persistent-truncation regression in `trident/brief-parts.test.ts`.

## 10. Naming & vocabulary (`critic-naming-vocab.md` §6)

94. `tenant:` prefix + a raw-NUL hash seed feed task-id determinism — fix the leak-gate-hiding byte,
    freeze the word itself (task IDs are persisted). `tasks/history-import-seeder.ts:63`.
    Protects: **G7** (Leak-gate NUL tripwire + retired-token cleanup).
95. `SecretsStore` identity: the frozen `owner_handle` (renamed from `internal_handle` in N2/N3),
    NOT `url_slug`; the SQL column keeps its old name (`project_slug`) by design. The TS identity is
    the branded `OwnerHandle` type (N1) — passing a raw string is a compile error at this boundary.
    `auth/secrets-store.ts:10-27`, `persistence/owner-handle.ts`.
    Protects: **N1** (Identity glossary + branded handle type). N2/N3 `internal_handle`→`owner_handle`
    rename DONE; the frozen-vs-mutable resolution at the Managed boot seam is the deferred credential-loss
    fix (see #107).
96. Cross-repo ABI property names (`owner_handle` option bags — renamed from `internal_handle` in
    N2/N3; `realmode-composer`/`boot-helpers` export names + paths) are reachable only via
    `NEUTRON_GRAPH_COMPOSER_MODULE` — invisible to in-repo grep. The N2/N3 rename is ABI-safe because
    Open is a vendored submodule in Managed (`vendor/neutron`) so the identifier propagates atomically
    on submodule bump; Managed's own code carries only provenance comments, no concrete impl of the
    renamed interface methods (verified against live neutron-managed). `gateway/index.ts:540` (the
    composer-module resolution seam).
    **MG-3 RESOLVED = KEEP (2026-07-16, owner-approved).** The seam is the C2 OSS-split boundary: it
    lets the PUBLIC Open boot shell dynamic-import Managed's PRIVATE production composer
    (`realmode-composer.ts`, which carries proprietary signup/provisioning/identity/proxy edges that
    can't ship public) at deploy time, without Open naming any Managed path. Verified against live
    neutron-managed (`src/ops/open-contract.ts:51-63`): Managed does NOT env-inject it today (each
    hosted owner boots the stock single-owner `open/server.ts`) but DELIBERATELY retains it so a later
    composer stays possible without an Open change. Deleting it would undo the OSS split — so KEPT,
    not deleted (has fail-fast guards in `gateway/index.ts` `loadGraphComposerFromEnv` + boot-through-seam
    coverage: `open/__tests__/open-boot-shell.test.ts` boots the real shell through the seam, and the
    `gateway/__tests__/open-route-matrix.test.ts` / `managed-route-matrix.test.ts` ratchets pin the composed graph).
    Protects: **M1**, **MG-3** (resolved KEEP).
97. `packageNameToSlug` couples core-package renames to already-installed data — a rename must
    ship a compat/migration path, not a pure rename. `cores/runtime/loader.ts:61-81`.
    Protects: **N4** (project_slug → owner_slug), **N5** (Directory/name hygiene).
98. `ChannelKind` strings are persisted row values — a rename is a data migration, not a
    find-and-replace. `channels/types.ts:12`.
    Protects: **N6** (`[BEHAVIOR]` ChannelKind persisted-value unification).
99. `docs/AS_BUILT.md` leak-gate exemptions are keyed to LITERAL paths — changelog consolidation
    must move allowlist entries in the same commit. `scripts/ci/leak-gate-allowlist.txt:69-80`.
    (Cross-ref #33/#83.)
    Protects: **K6**, **K7**, **G7**.
100. `prompts/*.md` loads are silent-fail-soft; the `KNOWN_PROMPTS`≡disk parity test pins dead
     files in place until deleted deliberately. `prompts/template.ts:140-147`.
     Protects: **K10** (Public in-repo SPEC.md + repoint agent prompts), **K6**.
101. Migration numbers and migration 0074's `tenant_provisioned` string are immutable — never
     renumber a migration file. `migrations/0074_rename_tenant_provisioned_phase.sql:40`.
     Protects: **P2**, **P3**.
102. `.url_slug` file precedence over `NEUTRON_INSTANCE_SLUG` env resolver.
     `gateway/index.ts:147-157`.
     Protects: **C1**, **N4**.
103. Healthz `project_slug` field, start-token dual claims, and JWT `slug` claim are wire contracts
     — renames there are cross-repo breaking changes. `gateway/index.ts:474-486` (healthz),
     `jwt-validator/claims.ts:26` (jwt `slug`).
     Protects: **M1**.
104. `KNOWN_PROMPTS` throws on unknown prompt names — the file and the registry entry must change
     together. `prompts/template.ts:140-147`.
     Protects: **K10**.
105. `deploymentMode`/`isLegalTransition` `'managed'` defaults are pinned by test matrices — rename
     the vocabulary token, do not change the default VALUES.
     `onboarding/interview/engine.ts:~489` (`deploymentMode ?? 'managed'`), `onboarding/interview/phase.ts:~133` (`isLegalTransition`).
     Protects: **N4**.

## 11. Security & config (`critic-security-config.md`)

106. `SecretsStore` encrypted-at-rest model: AES-256-GCM envelope `{v, iv_b64, ct_b64, tag_b64}`,
     keyfile at `<owner_home>/.neutron-aes-key` mode 0600, `expires_at` honored on read,
     `replaceAtomic` wraps delete+insert in one transaction.
     `auth/secrets-store.ts:8-27,208-210,257-302,448-471`.
     Protects: **S3** (Secrets-at-rest hygiene).
107. The `SecretsStore` SQL column is literally named `project_slug` but holds the FROZEN
     `owner_handle` (renamed from `internal_handle` in N2/N3); a caller passing `url_slug` silently
     loses all credentials. Now enforced at the store boundary by the branded `OwnerHandle` type (N1)
     — a raw string is a compile error — NOT prose convention alone. RESIDUAL: on Managed the boot
     seam still brands the *mutable* `url_slug` as the handle (`resolveOwnerSlugFromConfig` reads
     `.url_slug`), so the brand types the boundary without proving frozen-ness there; threading the
     frozen registry handle + the paired Managed boot change is the deferred credential-loss fix
     (**N3-credential DEFERRED 2026-07-16, owner-approved**: with no production and no hosted owners
     that rename, the incident cannot fire or be meaningfully tested, and Open's side already keys on
     `owner_handle`; revisit when Managed hosts live renaming owners — see [[refactor-n3-owner-handle-incident]]).
     `auth/secrets-store.ts:10-27`, `persistence/owner-handle.ts`. (Cross-ref #95.)
     Protects: **N1**, **S3** (branded-type fix belongs to security per the report).
108. Credential-pool threading into spawns explicitly UNSETS `ANTHROPIC_API_KEY`/
     `ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN` before setting ONLY the selected credential;
     `cred_id` (never the secret) is what surfaces on completions. Already done right — preserve
     verbatim. `gateway/wiring/build-llm-call-substrate.ts:184-207`.
     Protects: **C6**, **S1**.
109. Session cookie: HMAC-SHA256, 30-day sliding, `HttpOnly; SameSite=Lax; Path=/`, `Secure` only
     on https, constant-time HMAC compare. `landing/session-cookie.ts`, `open/composer.ts:3630`.
     Protects: **S1**, **C5**.
110. Start tokens are one-shot, single-use JTI, 15-min TTL, minted from the cookie secret.
     `open/composer.ts:1638-1653`. (Cross-ref #5/#31.)
     Protects: **S1**.
111. Bind-loopback-by-default is currently the ONLY real auth gate (app-ws auth is a hardcoded
     dev-bypass with the public constant `dev:owner`) — this must be preserved as the safety net
     until fail-closed auth ships; it is not itself something to "fix" incidentally.
     `gateway/index.ts:308`, `open/composer.ts:1978`.
     Protects: **S2** (WS origin + fail-closed guards) — the unit that replaces this gap, not an
     invariant to keep forever.

## 12. The honesty contract (agent-legible architecture, 2026-08-31)

Sections 1–11 above are per-dimension findings. §12 and §13 are different in kind: they are one
rule and its consequence for actions, added because a 30-day measurement of the build loop showed
the same defect at unrelated sites. The rule:

> **Every recorded fact names the producer that observed it and the evidence it observed. Where
> no producer looked, or looked and could not tell, the fact is `unknown`; `unknown` authorises
> nothing; and every refusal must name the honest row that is written instead.**

The final clause is what makes the contract satisfiable rather than a deadlock, and it is not
theoretical — see #128.

Status convention, unchanged from the rest of this file: a line marked **unprotected — covered by
review only** has no automated guard today. Most of §12–§13 is in that state deliberately; it is
recorded here so a build touching a named site closes the gap rather than widening it. Two lines
(#124, #128) are already enforced in code and are the pattern the rest are moved toward.
Numbering starts at 119 because #118 is claimed by the in-flight trident verdict-honesty change
and is not reused here.

119. EVERY OBSERVATION IS THREE-VALUED and the third value is the whole point. A status is
     OBSERVED (a named probe looked, just now), RECORDED (stored, carrying the time of the
     observation it came from), or UNKNOWN (no probe ran, or one ran and could not conclude). No
     component may return a two-valued answer where the third value is possible — in particular
     "I looked and there was nothing" and "I could not look" are different facts and an EMPTY
     check must never read as a PASSING check. Already typed:
     `trident/run-evidence.ts:44-47` (`observed: 'activity' | 'nothing' | 'unknown'`), with the
     doctrine at `:21-26`. Representative violating site: `gateway/cores/integrations.ts:155`
     (`connected` is a stored presence check for API-key slots — see the note at `:409-413` — so
     a revoked credential reads healthy).
     Protects: `trident/run-evidence.test.ts` (the type and the watchdog's use of it); every
     other consumer is **unprotected — covered by review only**.
120. A recorded fact names its producer. A stored value that cannot say which probe observed it
     is UNKNOWN however confident it looks, and provenance columns are required at the file, not
     offered as optional metadata — an optional provenance field is an empty provenance field.
     The pattern to copy is `migrations/provenance.ts:24-26` (`applied_by_commit` — "NULL
     otherwise, and NULL is a first-class answer") and `:40-45` (a check "returns a REASON rather
     than an empty answer, because 'we cannot check' and 'nothing is tracked' have opposite
     consequences at the call site"). The measured counter-example is
     `work-board/store.ts:70-71`, whose own comment says "Null means undeclared (and later gates
     fail safe)" — it is null on every live card.
     Protects: **unprotected — covered by review only.**
121. A derivation's output grade is the MINIMUM of its inputs' grades: a conclusion drawn from an
     UNKNOWN is UNKNOWN. This is the whole discipline of the derived layer and it is checkable in
     a pure module, which is why derivations must stay pure (`trident/run-evidence.ts` is the
     existing example — no I/O, so its grade arithmetic is testable without a substrate).
     Protects: **unprotected — covered by review only.**
122. UNKNOWN never authorises an irreversible action — merge, deploy, delete, force-push, or
     terminating a run. It may defer or refuse, and nothing else. One site already conforms:
     external launcher liveness acts only on positive death evidence (§9's external-launcher
     liveness invariant, `trident/liveness.ts`).
     Protects: `trident/liveness-death-e2e.test.ts` for that one site; everywhere else
     **unprotected — covered by review only.**
123. A fact is STORED only if it was observed; anything that is a JUDGEMENT about observations is
     DERIVED and names its inputs. Freezing a judgement into a column is how a derived answer
     acquires the authority of an observation. The canonical failure is `last_advanced_at` read
     as liveness: it moves only at checkpoint boundaries and is "stale by construction during a
     long Forge step, so a reaper keyed on it asks 'has a phase ended recently', not 'is anything
     alive'" (`trident/store.ts:618-623`; the same reasoning at `trident/liveness.ts:24`). The
     stored/derived split, per entity: a run stores phase, checkpoint, verdict, built commit,
     published ref and findings and DERIVES is-hung / is-stale / is-mergeable; a credential stores
     the last probe result and when, and DERIVES is-connected; a PR stores its head sha and the
     checks bound to that sha, and DERIVES is-green.
     Protects: `trident/tick-liveness.test.ts` (the stage-event evidence that replaces the column
     for one consumer); the general rule is **unprotected — covered by review only.**
124. Honesty is enforced at the LEDGER WRITE SITE — the narrow waist every path must pass through
     — never by convention at call sites. A guard at a caller is one more guard among many; a
     guard at the waist is the contract. The enforced instance: `inner_verdict='REQUEST_CHANGES'`
     with an empty findings list is a write the store REJECTS
     (`TridentEmptyFindingsRejectionError`, `trident/store.ts:58`, thrown at `:1113`, `:1269`,
     `:1345`). The write site is chosen precisely because it is unavoidable, and the store says so
     about its own residual gap at `trident/store.ts:1106-1108`: the guard "makes findings-free
     rejection structurally unwritable by in-process writers; `checkpoint.sh` remains
     out-of-process SQL and bypasses it by construction". That residue is why #125 exists.
     Protects: `trident/store.test.ts:990` ("empty-findings rejection guard — an empty finding set
     is never a rejection").
125. An enforcement point must be UNWIREABLE-OFF. Only two qualify, and each covers the other's
     blind spot exactly: (a) the TYPE at the construction site — always on, a missing field is a
     compile error, blind to out-of-process writers such as `trident/checkpoint.sh:445`, which
     issues raw `sqlite3 ... UPDATE code_trident_runs` no TypeScript type will ever see; and
     (b) the SCHEMA at the file — always on for every writer including that shell script, blind to
     whether a value was observed rather than typed. A separately-wired runtime gate is NOT an
     enforcement point: `capability_gate` computes a verdict, journals it and throws
     (`mcp/server.ts:123-141`), and has never denied anything, because its default is
     `options.capability_gate ?? (() => true)` (`mcp/server.ts:78`) and the sole production
     construction site passes no gate (`gateway/composition/build-core-modules.ts:360-364`); the
     source states it plainly at `:125-128` ("LOG-ONLY … it does NOT gate dispatch") and `:169`
     ("Allow-all in production today"). Contrast the required-at-the-type half, which works:
     `capability_required` on `ToolRegistration` (`tools/registry.ts:97-112`) is populated on
     every registered surface.
     Protects: **unprotected — covered by review only** (and #125 is the reason the other lines
     name write sites and columns rather than call sites).
126. A TERMINAL RECORD NAMES THE PRODUCER OF ITS TERMINAL JUDGEMENT AND THE ARTEFACT THAT
     JUDGEMENT IS ABOUT. Where it can name neither, the record is UNKNOWN whatever its status
     column says. This is one predicate with two instantiations, and they are the same defect:
     for a build run the producer is a reviewer and the artefact is a findings list (#124); for a
     dispatched agent the producer is a filesystem probe and the artefact is the declared
     deliverable. The dispatch half is not enforced today — `agent-dispatch/service.ts:538-547`
     maps a completed turn to `'finished'` with no reference to any artefact and `:654` supplies
     the fallback summary "Dispatch finished (no summary text returned)", while
     `runtime/subagent/registry.ts:18` defines `finished` as a process-status value. Activity is
     not output: a non-zero cost, a fresh timestamp and a process that replied are proxies for
     aliveness, which is exactly the mistake `last_advanced_at` encodes (#123).
     Protects: `trident/store.test.ts:990` for the run half; the dispatch half is
     **unprotected — covered by review only.**
127. A DERIVED JUDGEMENT PINS THE IDENTITY OF ITS INPUTS. "Is this PR green" is computed only
     from checks bound to the CURRENT head sha, never from a check list that does not say which
     sha it describes — a green reading that belongs to a superseded head is not a stale fact, it
     is a derivation whose input identity was never pinned. Likewise "did this run ship" is
     membership of the run's recorded head in the commit list of a merged PR the run claims,
     never ancestry against `main`: a squash-merge severs ancestry while the work is in `main`.
     The consumed field `mergeable` names the hazard in the other direction — it is
     "no textual conflict when GitHub last computed it" and says nothing about whether the checks
     are still valid (`trident/gh-authed.ts:46-52` documents the read).
     Protects: **unprotected — covered by review only.**
128. SATISFIABILITY IS PART OF THE GUARD. A guard that refuses a dishonest encoding must name the
     honest sibling row that is written instead, and it does not ship until a test enumerates the
     terminal states it constrains and shows each is reachable by a writer that exists. A refusal
     with no writable alternative converts a lie into a deadlock, and this repository has already
     paid that bill: `trident/store.ts:1320-1331` records a run that "retried forever without
     leaving `forge-init`" and states the rule in the source — "A guard that reads a column its
     own writer cannot populate is unsatisfiable by construction." The same obligation applies to
     every check that reports a verdict, and the conforming precedent outside the store is the
     leak gate, which exits **3** with `LEAK GATE: INCOMPLETE` rather than `SILENT ✅` when its
     rule could not run, because "I could not check" must not look like "I checked and it was
     clean" (`CONTRIBUTING.md`, "Git hooks").
     Protects: `trident/store.test.ts:990` (the one guard that shipped with its honest sibling);
     the general obligation is **unprotected — covered by review only**, and no totality test
     exists yet.

## 13. The action contract (agent-legible architecture, 2026-08-31)

§12's rule, applied to the surfaces an agent invokes. An action whose failure is silent is a fact
that was never recorded, so these are the same contract seen from the write side.

129. EVERY STATE CHANGE RETURNS A CLOSED UNION that distinguishes four outcomes: it happened
     (naming what changed), it was already so (nothing written), it was correctly a no-op (naming
     why), or it was REFUSED (naming the precondition). A bare success value that covers more than
     one of those is the defect. `work-board/agent-tool.ts:153-155` is the pattern to eliminate —
     `ok()` returns `{ ok: true }` both when a write landed and when it did not — and `:456-457`
     is the worse case: the reorder path discards `store.reorder()`'s result entirely and returns
     the bare shape unconditionally. An agent that cannot distinguish "reordered" from "did
     nothing" re-fires the call.
     Protects: **unprotected — covered by review only.**
130. NO ACTION MAY SILENTLY DO NOTHING: a call whose precondition is unmet is structurally
     incapable of returning success. The reference implementation already exists in this tree, in
     shell, because its author could not get it from a type — `trident/checkpoint.sh:445-449` runs
     the UPDATE, reads `changes()`, and on zero prints
     `checkpoint.sh: run '<id>' not found — checkpoint NOT applied` and exits **3**, a distinct
     code for a distinct outcome. That is the whole contract in four lines; the job is to make it
     the default rather than a thing each author reinvents.
     Protects: `trident/checkpoint-sh.test.ts` (this one site); everywhere else **unprotected —
     covered by review only.**
131. A REFUSAL NAMES THE LAYER THAT REFUSED AND THE PRECONDITION THAT FAILED, and where the
     refusal followed from an UNKNOWN it names the probe that produced it. A message that
     attributes a refusal to the layer below is worse than no message: it sends the reader to the
     wrong subsystem. `agent-dispatch/tool.ts:127-133` is the shape to copy — the missing
     `board_item_id` refusal names the missing thing and what to do about it.
     `trident/codex-build.sh:1165` is the shape to fix: a refusal that names the holding worktree
     in its prose while its token, `CODEX_BUILD_BRANCH_UNBOUND`, still points the reader at the
     executor.
     Protects: **unprotected — covered by review only.**
132. IDENTITY IS RESOLVED, NEVER TYPED. An action that takes a branch, a card, a project or a PR
     resolves the name to an identity and reports what it resolved to, before acting. A typed
     branch name and a card id belonging to another scope are the same defect — an unresolved
     name accepted as an identity — and one of them force-updates a ref.
     Protects: **unprotected — covered by review only.**
133. PRECONDITIONS AND EFFECT ARE VISIBLE IN THE DECLARATION, BEFORE THE CALL — never discovered
     from the call's silence or its wreckage. If a relaunch derives its branch from a card's
     design-doc slug rather than from the failed run's branch, the declaration says so, because
     the agent has to know that before the call cuts a new branch off `main`.
     Protects: **unprotected — covered by review only.**
134. A COMMISSION DECLARES ITS ARTEFACT, AND ITS GRANT IS RECORDED BY THE SPAWNER. A delegation to
     another agent is a state change like any other, so: (a) the request declares the artefact it
     will produce, and is REFUSED before anything is spawned when the grant cannot satisfy the
     declaration; (b) the granted tool surface is recorded BY THE SPAWNER, as the argv it actually
     constructed — never as the child's own report that it started, which is `last_advanced_at`
     in new clothing (#123); and (c) terminal state is decided by observing the artefact, per
     #126. The live defect: `agent-dispatch/substrate-turn.ts:61-63` maps an absent `tools` input
     to `[]`, deliberately per its comment at `:56-60`, and
     `agent-dispatch/service.ts:122-128` confirms "The dispatch family (Atlas/Sentinel/adhoc)
     passes NOTHING" — while `prompts/atlas.md:16` tells the spawned agent its tools "are exactly
     read, write, edit, bash, grep, glob" and `:25` instructs it to "Write the full deliverable to
     a file (you have write access)". The prompt describes a grant the spawn seam does not make,
     and the record still says `finished`.
     THE REQUIREMENT BINDS TO THE CLASS OF CONSTRUCTION SITE, NEVER TO THE CALLER THAT TAUGHT US.
     The same invariant was already learned once and bound too narrowly:
     `reminders/rituals.ts:257-261` throws on an empty `tool_surface` with the comment
     "#361 toolless-class pin: a ritual with no tools is a silent no-op" — bound to rituals rather
     than to everything that constructs an `AgentSpec`. The class predicate is NOT "no `AgentSpec`
     may have empty tools": `open/composer.ts:7124-7130` legitimately prewarms with `tools: []`.
     It is that EVERY `AgentSpec` construction site must state its grant explicitly, and an empty
     grant is legal only when it is declared empty at the site.
     Protects: `reminders/rituals.test.ts:84` ("empty tool_surface throws (#361 toolless
     class)") for the one ritual site; the class is **unprotected — covered by review only.**

---

## Coverage summary

- **111 invariants** extracted from the 11 critic reports' load-bearing-subtleties /
  fail-soft-invariant / must-not-break sections (`critic-security-config.md` has no dedicated
  section; its "what exists and is fine" items are folded into §11 above). Four further items
  (#112–#115) were added post-synthesis for the gateway-restart crash-recovery build, and #116 for
  the derived-inline-activity build; they are appended at the end of their sections rather than
  renumbered in, so numbering is not strictly sequential within §3 and §9.
  section; its "what exists and is fine" items are folded into §11 above). Five further items
  (#112–#116) were added post-synthesis — #112–#115 for the gateway-restart crash-recovery build,
  #116 for the boot scope direction guard (2026-08-16); they are appended at the end of their
  sections rather than renumbered in, so numbering is not strictly sequential within §3 and §9.
- The vast majority cross-reference a specific refactor-plan unit (G/K/L/C/D/P/F/O/X/W/N/S/M
  series) that either builds a characterization test protecting the behavior or must
  demonstrably preserve it per the unit's own **Accept** criteria.
- Three items are explicitly **unprotected — covered by review only** (#8, #23, #43) — no unit
  in the current plan targets them directly; a build agent touching adjacent code must
  re-verify by hand and Argus/Codex review must call it out.
- `verified-findings.json` (the raw adversarial-verification workflow log) was consulted but not
  separately itemized — its 24/24 confirmed findings are already folded into the critic reports
  this file distills.
- **#119–#134** (2026-08-31) are §12 (the honesty contract) and §13 (the action contract). They
  are different in kind from #1–#117: those distill a point-in-time audit, these state one rule
  and are written to be closed over time. Apart from #124 (the store's empty-findings refusal),
  #122 (one liveness site) and #130 (one shell site), they are **unprotected — covered by review
  only**, and each line says so on its own `Protects:` line so this file never describes the
  target as the present. #118 is claimed by the in-flight trident verdict-honesty change and is
  deliberately not reused. The mechanism that would close them — an executable, numbered
  invariant corpus that CI runs, each entry shipping a must-fail control — does not exist yet;
  today the only CI reference to this file is its appearance in
  `scripts/ci/leak-gate-allowlist.txt`, i.e. CI knows the file exists and evaluates none of it.

This file should be re-run/re-checked at Fable synthesis time for each merged unit: if a unit
closes an "unprotected" item by adding a test, update its line here to name that test.
