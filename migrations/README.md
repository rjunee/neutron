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

- `NNNN` — 4-digit zero-padded version (`0001`, `0002`, ..., `9999`). Re-using a number is a permanent contract violation; once a version is in `_migrations` somewhere in the wild, that number is consumed forever.
- `<slug>` — `lower_snake_case` describing the change. Should be short enough to fit on a `git log --oneline` line but specific enough to grep ten months later.

The runner enforces the regex `^\d{4}_.+\.sql$`. Files that don't match are silently ignored — keep stray notes / `.bak` files out of the directory.

A file that DOES match and is **not tracked by git** is a different matter: the runner refuses to boot rather than apply it (see "When the runner refuses: an untracked file" below). Until it was committed, a stray `NNNN_*.sql` was applied at boot and recorded in `_migrations` permanently, then vanished with the next checkout — leaving a ledger row naming a migration the repository never contained.

## The `_migrations` ledger

The ledger is owned by the runner, not by any `.sql` file — `runner.ts` both creates it and brings it up to the current shape (`ensureLedgerShape`) on the boot that is about to write a row, and on no other. Nothing in this directory should `ALTER` it: evolving the ledger from inside the ledger is circular, and on a fresh install the ALTER would land *after* the rows it needs to change.

A steady-state boot — every migration already recorded, nothing pending — does **not** reshape the ledger, by design (see "Reading the ledger" below). An instance that upgraded onto a build carrying new ledger columns therefore keeps the old shape until its next pending migration, and that is not a defect: reads are shape-tolerant (absent columns are selected as `NULL`, which is also the honest value for rows written before the columns existed), and the columns are added in the same run as, and before, the first row that has anything to put in them.

| column | meaning |
| --- | --- |
| `version` | the 4-digit ordinal |
| `name` | the `<slug>` half of the filename. **This is the identity the runner compares.** |
| `applied_at` | unix seconds, as a REAL |
| `content_sha256` | SHA-256 of the migration file's bytes, as applied |
| `applied_by_commit` | the deployed commit SHA, or NULL |
| `tree_provenance` | `tracked-in-index` when the deployed checkout was verified to track the file; `unverifiable:<reason>` when that could not be established; NULL on rows written before this existed |

The last three answer *which build wrote this row*. A live instance once crash-looped on boot because an ordinal was recorded under one name while the deployed code carried another — and the investigation stalled, because at the moment the row was written the running commit contained no migration at that ordinal at all, and nothing on disk recorded what had applied it.

All three are nullable, and NULL is a real answer, not a defect:

- **`content_sha256` is NULL** on rows written before provenance shipped. Nothing more can be learned about them.
- **`applied_by_commit` is NULL** when the build had no discoverable identity. Neutron Open is self-hostable, so an install may be an unpacked tarball, a zip, or a `COPY` into a container image with no `.git` and no `git` on PATH. The runner reads git metadata as plain files and never spawns a subprocess (a subprocess on the boot path can hang); when there is nothing to read it records NULL rather than a fabricated value. It also refuses to read a `.git` this tree does not own — an install unpacked inside somebody else's checkout would otherwise record *that* repository's HEAD, which is well-formed, plausible and wrong. **Set `NEUTRON_COMMIT_SHA` when packaging a build without git metadata** (or when installing inside another repository) and provenance stays answerable for exactly the install shapes that would otherwise have none.
- **`tree_provenance` is `unverifiable:<reason>`** when the checkout's tracking of the file could not be established, and the reason names why: `no-git-metadata` (a tarball, zip or image install), `directory-not-tracked` (the migration directory itself is not part of any checkout — copied into `node_modules/`, staged in a build directory), `no-index` / `unreadable-index` / `unsupported-index-version` / `split-index` / `sparse-index` (an index shape the runner does not decode), `index-checksum-mismatch` (the index failed its own trailing SHA-1 — corruption, or a repository shape the reader misunderstands), `index-hash-skipped` (`index.skipHash`, which `feature.manyFiles` enables, so git wrote no hash and nothing on disk proves the index is intact). **The prefix is the contract:** anything that is not exactly `tracked-in-index` is unverified, so a reader never has to enumerate the reasons. This is deliberately not the same state as verified — an install that cannot check is not an install with nothing to check, and the row says which it was.

### What `tracked-in-index` proves, and what it does not

The value names its evidence on purpose. What the runner reads is **git's index — the staged tree**, which is a *superset* of the committed tree. So:

- a file that has been `git add`ed and never committed reads as `tracked-in-index`;
- a file `git add -N`'d (intent-to-add) does **not** — such an entry records a path with no staged content, so it is in no tree at all and the reader excludes it;
- a file nothing ever told git about — every stray in the incidents this guard exists for — does not.

Verifying against HEAD's tree instead would mean reading commit and tree *objects*, which in any clone live in a packfile: an `.idx` search plus delta reconstruction, on the boot path, to close a hole narrower than the one being closed. That is a worse trade than the residual (see `git-index.ts`'s header for the full argument), and the naming is what keeps the residual honest rather than hidden. **A staged-but-uncommitted migration therefore still applies** — and its row says `tracked-in-index`, which is exactly what was checked, so a later investigation is not misled about it.

**`content_sha256` is recorded and reported, not enforced.** The runner compares *names* and refuses on a mismatch; it does not compare the recorded hash against the file on disk. That is a decision, not an omission. Migrations are forward-only and already-applied files are edited in place from time to time for entirely benign reasons — a comment, a reflow, a typo in a string literal — none of which change the schema that landed. Turning the hash into a boot gate would convert every one of those into a crash loop resolvable only through `repairs.json`, and the failure it would catch (a *different* migration silently occupying an applied ordinal) already produces a name mismatch in every case where the slug differs. So the hash's job is forensic: it is printed in the refusal below, and it is what lets an operator tell "the same migration, renamed" from "a genuinely different migration that claimed this ordinal" — the question the incident that motivated these columns could not answer.

### Reading the ledger

**Deciding costs no write — every refusal, without exception.** `_migrations` is *created* on the path that is about to insert a row and on no other, the provenance columns are added there too, and the ledger is read tolerantly of both its absence and its older shapes. A boot that ends in any of the three refusals (a duplicate ordinal, a name mismatch, an untracked file) leaves the database byte-for-byte as it found it — the guard whose job is to change nothing does not first mutate the schema of the database it just declared untrustworthy. `applyMigrations` against a fully-migrated database is a pure read, which is what makes opening a backup read-only to inspect it work.

That ordering is load-bearing rather than tidy, and it was not always right: the acknowledged-repair write below used to run *before* the untracked check, so on any instance carrying acknowledged repairs — this repository ships two — the refusal's claim that nothing had been written was false, in precisely the incident-recovery state where an operator reads it.

One write is worth knowing about before pointing a read-only connection at a live database: when `repairs.json` carries an entry that matches a mismatch in this ledger, the runner records the acknowledgement in `_migration_repairs`. It happens on the acknowledged-repair path only, whether or not anything is pending, and only *after* every refusal has been decided. A database whose ledger has no acknowledged repairs opens read-only cleanly; one that does needs a writable copy (or an unmatched `repairs.json`) to inspect.

## When the runner refuses: an untracked file

If a pending `NNNN_*.sql` is present in the directory but the deployed checkout does not track it, `applyMigrations` **throws before it writes anything**. Nothing is applied, nothing is recorded, the ledger is not created or reshaped, and no repair is acknowledged.

Resolve it by deciding what the file is:

- a **stray** — a scratch copy, an editor artifact, a leftover from another branch, something another process wrote into the directory → **delete it**. The database is unchanged, so nothing else is needed.
- a **real migration** → **`git add` *and* commit it**, then boot again. Both halves matter: staging is what satisfies the check (it reads the index), and only the commit makes the file outlive the next checkout — which is the failure being prevented.

`repairs.json` is not the tool for this and the message says so: those entries acknowledge a name mismatch on a row whose file the tree *does* contain. Recording a row for a file the repository does not contain is the disease, not the cure.

**When the ordinal is already recorded, this refusal takes precedence over the name mismatch** — and that combination is not hypothetical: it is how ordinals 122 and 124 presented on the live instance. A stray landing on a recorded ordinal reads as a rename, whose remedy would be a `repairs.json` entry naming a file the tree does not track. The runner now diagnoses it as the stray it is, tells you what the mismatch would have been, and points at deletion, which clears both at once. An *acknowledged* repair still wins: that entry is an explicit hand-verified decision about one ordinal, and overriding it would turn a documented recovery into an outage with no remedy.

The check runs only where it can be answered: the checkout's own `.git` index, read as a plain file (no subprocess — `git` may not be installed, and a subprocess on the boot path can hang). Where that is unavailable the runner applies the migration and records `tree_provenance = unverifiable:<reason>` instead, which is why the guard can be fail-closed without breaking tarball, zip or container installs. Only **pending** migrations are checked for the refusal: a row that is already recorded is already permanent, and refusing forever over a file applied long ago would be an outage with no remedy.

## When the runner refuses: `repairs.json`

If a version is recorded under one name and this code contains another, `applyMigrations` **throws and applies nothing**. That is deliberate and fail-closed: the schema may not match the code, and the runner will not guess, auto-apply, or rename the recorded row.

The thrown message is self-diagnosing. It prints what is on disk (file + hash) against what was recorded (name, timestamp, hash, build), and then the exact `repairs.json` entry that resolves it. Copy that entry, **replace the `note` with what you actually verified**, and append it to `migrations/repairs.json`.

Verify by hand *before* writing the entry — an entry is an assertion that the live schema already matches this code. Check that the migration's objects are really present (`PRAGMA table_info(<table>)`, and include a column you know exists as a positive control, so an empty result proves absence rather than a mistyped query).

One trap worth naming: the entry's **`file_name` field holds the migration's slug, not the filename on disk** — `trident_checkpoint_head`, not `0122_trident_checkpoint_head.sql`. That is what the runner keys on. "Correcting" it to the real filename stops the entry matching, and the failure is invisible: the ledger looks repaired while the runner keeps refusing to boot.

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
