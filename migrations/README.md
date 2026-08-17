# migrations

SQLite schema migrations for Neutron's per-instance SQLite database. Forward-only; one raw `.sql` file per migration; tracked in the `_migrations` table by a tiny custom runner.

## Authoring a migration

1. Pick the next unused 4-digit version. Migrations apply in lexicographic order.
2. Create a file named `NNNN_<slug>.sql` in this directory. `<slug>` is `lower_snake_case` describing the change (`0002_workspace_members.sql`, `0007_add_reminders_table.sql`).
3. Lead with comments + the optional PRAGMA preamble (see "PRAGMAs and transactions" below).
4. Write the schema-mutating SQL: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE`, etc. Use `IF NOT EXISTS` everywhere — applying a migration twice must be a no-op so host-snapshot rollbacks and partial-fail recoveries are safe.
5. Run `bun test migrations/runner.test.ts` to confirm the new migration applies cleanly against a fresh DB.
6. Run `bun run migrations/regen-snapshot.ts` to refresh the snapshot. The `migrations/snapshot.test.ts` test asserts the schema produced by `applyMigrations` matches this file — see "Regenerating expected-schema.txt" below.

## Forward-only contract

- **No `down` migrations.** Locked direction per `docs/engineering-plan.md § B.P0` + § F. Reversing a migration ships as a *new forward* migration that undoes the change (e.g. `0008_drop_reminders_table.sql`).
- **Idempotent statements only.** `IF NOT EXISTS` on `CREATE TABLE`, `CREATE INDEX`, `CREATE TRIGGER`, `CREATE VIRTUAL TABLE`. `INSERT OR IGNORE` for seed rows. Anything that would error on second-apply must not ship.
- **Pre-run snapshots are the rollback story.** Before running migrations against a live instance, the deployment script takes a host volume snapshot. Bad migration → restore the snapshot → fix the SQL → re-deploy.

## Naming convention

`NNNN_<slug>.sql`

- `NNNN` — 4-digit zero-padded version (`0001`, `0002`, ..., `9999`). It fixes apply ORDER, and that is all it is for. **It is not an identity** — see "The ordinal is not an identity" below — so re-using one is untidy rather than fatal, and a merge that renumbers a migration is a non-event.
- `<slug>` — `lower_snake_case` describing the change. Should be short enough to fit on a `git log --oneline` line but specific enough to grep ten months later. **This is the identity, and it must be unique across the tree** — the runner refuses two files sharing a slug, because the ledger could not tell them apart.

The runner enforces the regex `^\d{4}_.+\.sql$`. Files that don't match are silently ignored — keep stray notes / `.bak` files out of the directory.

A file that DOES match and is **not tracked by git** is a different matter: the runner refuses to boot rather than apply it (see "When the runner refuses: an untracked file" below). Until it was committed, a stray `NNNN_*.sql` was applied at boot and recorded in `_migrations` permanently, then vanished with the next checkout — leaving a ledger row naming a migration the repository never contained.

## The ordinal is not an identity

**The runner decides "has this migration run?" from the migration's NAME, never from its ordinal.** That distinction is the difference between a boot and a three-hour outage, and it was learned the hard way three times (ordinals 122, 124 and 125 on the live instance).

The ordinal is allocated by whoever writes the file, so across a fleet it means different things on different databases:

- **Two different migrations legitimately occupy one ordinal.** Two branches both number theirs `0125`. Whichever merges second is renumbered — but an instance that already ran the first keeps `125` recorded under the first one's name. The merged `0125` then has a number that is already spent *on that database only*.
- **One migration legitimately occupies different ordinals.** It ran on an instance as `0125` from a branch and merged as `0124`.

Keying on the ordinal answers a question the ordinal cannot answer, and gets it wrong in both directions. It reports a migration as **applied** when a different one consumed its number — so its statements never run and the schema silently lacks them, which is exactly what happened to `0125_code_trident_runs_base_sha` — and as **pending** when the same migration already ran under another number, which re-runs it and crashes on `duplicate column name`.

So:

- `_migrations.name` is the **primary key**. `version` is data, and two rows may share one — which is simply true of a fleet where two migrations were both written as `0125`.
- A ledger from before this change is keyed on `version`; the runner rekeys it in place on the first boot that has something to apply (`rekeyLedgerOnName`), preserving every migration and everything recorded about it. Nothing pending, nothing reshaped.
- **A ledger holding one NAME at two ordinals is collapsed, not refused** (`collapseLedgerRowsByName`). That shape is legitimate: migrations here are idempotent, and the old ordinal-keyed runner re-applied and re-recorded a file that a merge had renumbered to an ordinal the instance had not spent. Two rows, one name, nothing missing from the schema — so refusing it would brick a healthy instance, which is this same defect one level up. The surviving row is the one applied **earliest** (ties broken by ordinal, then name), and provenance is filled from whichever row in the group recorded it, because the earliest row often predates provenance and dropping a real hash for a `NULL` destroys the only evidence the instance has.
- The rekey is **one transaction, and that includes the provenance `ALTER TABLE`s**. Run outside an explicit transaction those statements commit on their own, so keeping them inside is what lets a failed rekey say — truthfully — that the ledger is unchanged.
- Collapsing is not the same as forgiving. A recorded migration that **no** file in this build corresponds to, by name or by hash, still refuses the boot: one name at two ordinals is a history this build can explain, and an orphan row is not.
- `content_sha256` is a **second, name-independent identity** and is used only to *widen* the answer: a migration whose exact bytes are already recorded has run, whatever it was called then. It never narrows one — see "recorded and reported, not enforced" below.
- Two files sharing a slug are refused, because the name is the key.
- **Renumbering a migration to dodge a collision is not a fix and is not needed.** It repairs the instance where the ordinal was spent and breaks every instance where the migration already applied (measured: `duplicate column name: base_sha`). Under identity reconciliation neither instance notices.

## The `_migrations` ledger

The ledger is owned by the runner, not by any `.sql` file — `runner.ts` both creates it and brings it up to the current shape (`ensureLedgerShape`) on the boot that is about to write a row, and on no other. Nothing in this directory should `ALTER` it: evolving the ledger from inside the ledger is circular, and on a fresh install the ALTER would land *after* the rows it needs to change.

A steady-state boot — every migration already recorded, nothing pending — does **not** reshape the ledger, by design (see "Reading the ledger" below). An instance that upgraded onto a build carrying new ledger columns therefore keeps the old shape until its next pending migration, and that is not a defect: reads are shape-tolerant (absent columns are selected as `NULL`, which is also the honest value for rows written before the columns existed), and the columns are added in the same run as, and before, the first row that has anything to put in them.

| column | meaning |
| --- | --- |
| `version` | the ordinal this instance applied it under. Data, not a key — see above |
| `name` | the `<slug>` half of the filename. **This is the identity, and the PRIMARY KEY.** |
| `applied_at` | unix seconds, as a REAL |
| `content_sha256` | SHA-256 of the migration file's bytes, as applied |
| `applied_by_commit` | the deployed commit SHA, or NULL |
| `tree_provenance` | `tracked-in-index` when the deployed checkout was verified to track the file; `unverifiable:<reason>` when that could not be established; NULL on rows written before this existed |

The last three answer *which build wrote this row*. A live instance once crash-looped on boot because an ordinal was recorded under one name while the deployed code carried another — and the investigation stalled, because at the moment the row was written the running commit contained no migration at that ordinal at all, and nothing on disk recorded what had applied it.

All three are nullable, and NULL is a real answer, not a defect:

- **`content_sha256` is NULL** on rows written before provenance shipped. Nothing more can be learned about them — which is why the unexplained-row refusal below adjudicates only rows that HAVE one. Migration files really do get deleted here on purpose (`0059_syndication_events` with the content-sync mesh rip, `0064`–`0068` in the A2 collapse), so every long-lived database carries rows naming migrations this tree no longer contains, all of them hashless. Refusing on those would take down the oldest instances in the fleet over evidence that is a NULL.
- **`applied_by_commit` is NULL** when the build had no discoverable identity. Neutron Open is self-hostable, so an install may be an unpacked tarball, a zip, or a `COPY` into a container image with no `.git` and no `git` on PATH. The runner reads git metadata as plain files and never spawns a subprocess (a subprocess on the boot path can hang); when there is nothing to read it records NULL rather than a fabricated value. It also refuses to read a `.git` this tree does not own — an install unpacked inside somebody else's checkout would otherwise record *that* repository's HEAD, which is well-formed, plausible and wrong. **Set `NEUTRON_COMMIT_SHA` when packaging a build without git metadata** (or when installing inside another repository) and provenance stays answerable for exactly the install shapes that would otherwise have none.
- **`tree_provenance` is `unverifiable:<reason>`** when the checkout's tracking of the file could not be established, and the reason names why: `no-git-metadata` (a tarball, zip or image install), `directory-not-tracked` (the migration directory itself is not part of any checkout — copied into `node_modules/`, staged in a build directory), `no-index` / `unreadable-index` / `unsupported-index-version` / `split-index` / `sparse-index` (an index shape the runner does not decode), `index-checksum-mismatch` (the index failed its own trailing SHA-1 — corruption, or a repository shape the reader misunderstands), `index-hash-skipped` (`index.skipHash`, which `feature.manyFiles` enables, so git wrote no hash and nothing on disk proves the index is intact), `outside-deployed-tree` (not reachable today — the total-function guard on `resolveDeployedTree`'s own invariant that the checkout root it found is an ancestor of the migration directory; listed so the contract below is complete rather than nearly complete). **The prefix is the contract:** anything that is not exactly `tracked-in-index` is unverified, so a reader never has to enumerate the reasons. This is deliberately not the same state as verified — an install that cannot check is not an install with nothing to check, and the row says which it was.

### What `tracked-in-index` proves, and what it does not

The value names its evidence on purpose. What the runner reads is **git's index — the staged tree**, which is a *superset* of the committed tree. So:

- a file that has been `git add`ed and never committed reads as `tracked-in-index`;
- a file `git add -N`'d (intent-to-add) does **not** — such an entry records a path with no staged content, so it is in no tree at all and the reader excludes it;
- a file nothing ever told git about — every stray in the incidents this guard exists for — does not.

Verifying against HEAD's tree instead would mean reading commit and tree *objects*, which in any clone live in a packfile: an `.idx` search plus delta reconstruction, on the boot path, to close a hole narrower than the one being closed. That is a worse trade than the residual (see `git-index.ts`'s header for the full argument), and the naming is what keeps the residual honest rather than hidden. **A staged-but-uncommitted migration therefore still applies** — and its row says `tracked-in-index`, which is exactly what was checked, so a later investigation is not misled about it.

**The residual has one concrete shape worth naming: a build lane that runs `git add -A`.** Staging alone satisfies this check, so on a machine where something stages the whole worktree before boot, a stray `.sql` is staged along with everything else and then reads as tracked. The guard does not close that case, and the row does not pretend otherwise — `tracked-in-index` says the index, and only the index, is what was checked. Closing it would need HEAD-tree verification, which is the trade rejected above. What the guard does close is the case every one of these incidents actually took: a file nothing ever told git about at all.

**`content_sha256` is recorded and reported, not enforced.** The runner never refuses because a recorded hash differs from the file on disk. That is a decision, not an omission. Migrations are forward-only and already-applied files are edited in place from time to time for entirely benign reasons — a comment, a reflow, a typo in a string literal — none of which change the schema that landed. Turning the hash into a boot gate would convert every one of those into a crash loop resolvable only through `repairs.json`. So the hash is used in exactly two ways, both of them safe: as a *second identity* that can only ever mark a migration as already applied (never as pending), and forensically, printed in the refusals below — it is what lets an operator tell "the same migration, renamed" from "a genuinely different migration", the question the incident that motivated these columns could not answer.

### Reading the ledger

**Deciding costs no write — every refusal, without exception.** `_migrations` is *created* on the path that is about to insert a row and on no other, the provenance columns are added there too, the rekey happens there and nowhere else, and the ledger is read tolerantly of both its absence and its older shapes. A boot that ends in any of the four refusals (a duplicate ordinal, a duplicate name, an unexplained ledger row, an untracked file) leaves the database byte-for-byte as it found it — the guard whose job is to change nothing does not first mutate the schema of the database it just declared untrustworthy. `applyMigrations` against a fully-migrated database is a pure read, which is what makes opening a backup read-only to inspect it work.

That ordering is load-bearing rather than tidy, and it was not always right: the acknowledged-repair write below used to run *before* the untracked check, so on any instance carrying acknowledged repairs — this repository ships two — the refusal's claim that nothing had been written was false, in precisely the incident-recovery state where an operator reads it.

One write is worth knowing about before pointing a read-only connection at a live database: when `repairs.json` carries an entry whose row is present in this ledger, the runner records the acknowledgement in `_migration_repairs`. It happens on the acknowledged-repair path only, whether or not anything is pending, and only *after* every refusal has been decided. A database whose ledger has no acknowledged repairs opens read-only cleanly; one that does needs a writable copy (or an unmatched `repairs.json`) to inspect.

## When the runner refuses: an untracked file

If a pending `NNNN_*.sql` is present in the directory but the deployed checkout does not track it, `applyMigrations` **throws before it writes anything**. Nothing is applied, nothing is recorded, the ledger is not created or reshaped, and no repair is acknowledged.

Resolve it by deciding what the file is:

- a **stray** — a scratch copy, an editor artifact, a leftover from another branch, something another process wrote into the directory → **delete it**. The database is unchanged, so nothing else is needed.
- a **real migration** → **`git add` *and* commit it**, then boot again. Both halves matter: staging is what satisfies the check (it reads the index), and only the commit makes the file outlive the next checkout — which is the failure being prevented.

`repairs.json` is not the tool for this and the message says so: those entries acknowledge a ledger row, not a file. Recording a row for a file the repository does not contain is the disease, not the cure.

**When the ordinal is already recorded, the message names the occupying row as CONTEXT** — because that combination is how ordinals 122 and 124 presented on the live instance, and an operator who sees a taken ordinal beside a bare "not tracked" goes hunting a second problem. There is no second problem: a shared ordinal is not a fault, so there is one finding here and one remedy, deletion. An *acknowledged* repair still wins over the untracked verdict: that entry is an explicit hand-verified decision, and overriding it would turn a documented recovery into an outage with no remedy.

**It takes precedence over the duplicate-ordinal refusal too, and for the same reason.** A stray does not always arrive at a free ordinal — on the live instance it landed on one a real migration already owned, which trips the collision check first and reports "two files claim version N". That message sends you hunting a duplicate you never committed, while the actual remedy goes unsaid. So when the tree can tell the two apart, the collision check stands aside and the untracked refusal speaks instead. Two *tracked* files at one ordinal is a genuine mistake in this repository and still reports as a collision, naming both files; so does a collision on an install where the tree cannot be verified at all. Fail-closed in every case — what changes is only which remedy you are handed.

The check runs only where it can be answered: the checkout's own `.git` index, read as a plain file (no subprocess — `git` may not be installed, and a subprocess on the boot path can hang). Where that is unavailable the runner applies the migration and records `tree_provenance = unverifiable:<reason>` instead, which is why the guard can be fail-closed without breaking tarball, zip or container installs. Only **pending** migrations are checked for the refusal: a row that is already recorded is already permanent, and refusing forever over a file applied long ago would be an outage with no remedy.

## When the runner refuses: an unexplained ledger row

If the ledger records a migration that **no file in this build corresponds to** — neither by name nor by content hash — `applyMigrations` **throws and applies nothing**. An unknown migration ran against this database, so the schema may carry changes this code does not describe, and the next migration to touch the same table can fail in a way nothing on disk explains. It is exactly how ordinals 122, 124 and 125 came to exist. The runner will not guess, auto-apply, or rename the recorded row.

**Only rows carrying a `content_sha256` are adjudicated.** A row without one predates provenance and cannot be checked against anything — and, because migration files are deliberately deleted here from time to time, every long-lived database has some. Refusing on those would be a boot outage whose evidence is a NULL. The guard refuses where it *has* identity evidence, stays silent where it has none, and strengthens by itself as rows gain provenance.

The thrown message is self-diagnosing. It lists **every** unexplained row (one hand-verification pass, one edit — not one refused boot per row) with its ordinal, timestamp, hash and build, and then the exact `repairs.json` entries that resolve them.

Verify by hand *before* writing an entry. Establish what that migration did to this database (`PRAGMA table_info(<table>)`, and include a column you know exists as a positive control, so an empty result proves absence rather than a mistyped query). Then:

- set **`file_name`** to the slug of the migration in *this* build that the row turns out to have already applied — that suppresses re-applying it, which is what keeps an instance whose schema change was applied by hand from running it a second time (ordinal 122's entry does exactly this);
- or set it to `""` when the orphan corresponds to nothing here, which acknowledges the row alone.

Two traps worth naming:

- **`file_name` holds a migration's slug, not a filename on disk** — `trident_checkpoint_head`, not `0122_trident_checkpoint_head.sql`. "Correcting" it stops the entry doing its job, and the failure is invisible.
- **An entry only takes effect where its row exists.** `version` + `recorded_name` must match a real row, which is what keeps these entries inert on every other instance — a fresh install must still run migration 0122, and it does.

Entries are permanent incident records. They are never rewritten or removed.

## PRAGMAs and transactions

The runner wraps each migration's body in `BEGIN ... COMMIT` automatically (and `ROLLBACK` on throw, so a mid-file failure leaves the DB exactly as it was — see `runner.ts`, `splitPragmaPreamble`). Two consequences:

- **Do NOT write `BEGIN`/`COMMIT` in your migration body.** SQLite forbids nested transactions; the runner's wrapper would clash with yours.
- **`PRAGMA journal_mode` and `PRAGMA synchronous` MUST live in the preamble.** SQLite forbids those PRAGMAs inside a transaction. The "preamble" is the leading run of comments + `PRAGMA <name> = <value>;` statements at the top of the file; the runner extracts it and runs it *outside* the transaction. The first statement that isn't a comment or PRAGMA ends the preamble.
- `PRAGMA foreign_keys = ON;` is fine in the preamble (and the runner re-asserts it on every fresh connection regardless — it's per-connection state, not per-DB). Re-asserting it in the preamble keeps the file self-describing for anyone running `sqlite3 < 0001_initial_schema.sql` directly.

In short: every migration that needs to set `journal_mode` / `synchronous` does it via a preamble; everything else (DDL, DML, index creation) goes into the body and is wrapped in BEGIN/COMMIT for you.

## Regenerating `expected-schema.txt`

`expected-schema.txt` is a frozen snapshot of `sqlite_master` (rendered by `migrations/schema-serialize.ts`) after applying every migration in this directory to a fresh in-memory DB. The `migrations/snapshot.test.ts` test asserts the current schema matches it byte-for-byte — drift between the migrations and the snapshot is a build-break. The serializer reads `sqlite_master` directly through `bun:sqlite`, so the snapshot test runs on any clean Bun environment without a host `sqlite3` CLI on PATH.

Whenever you ship a new migration:

```bash
bun run migrations/regen-snapshot.ts
```

Commit the regenerated `expected-schema.txt` alongside your `NNNN_<slug>.sql`. The snapshot test will go green and the diff in your PR shows reviewers exactly what schema shape changed.

If a snapshot diff surprises you (an `idx_*` you didn't add, a column ordering shift, a generated table from FTS5 / a trigger), don't paper over it by regenerating — investigate first. The point of the snapshot test is to catch accidental schema drift.

## Running the runner

```bash
# Apply all pending migrations to <db>
bun run migrations/runner.ts <db>

# Or, via the package script
bun run migrate <db>
```

Output is JSON: `{ "applied": [versions], "skipped": [versions] }`. Exit code 0 on success; non-zero (with stack trace + automatic ROLLBACK) on any migration failure.

## Cross-refs

- `docs/engineering-plan.md § B.P0` — locked direction (raw SQL + custom runner)
- `docs/plans/P0-system-user-data-separation.md § 1.4 + § 1.5` — schema spec + runner shape
- internal design notes — Hermes lift baseline for `0001_initial_schema.sql`
