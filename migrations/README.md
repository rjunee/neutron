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

## The `_migrations` ledger

The ledger is owned by the runner, not by any `.sql` file — `runner.ts` creates it and evolves it on every boot (`ensureProvenanceColumns`). Nothing in this directory should `ALTER` it: evolving the ledger from inside the ledger is circular, and on a fresh install the ALTER would land *after* the rows it needs to change.

| column | meaning |
| --- | --- |
| `version` | the 4-digit ordinal |
| `name` | the `<slug>` half of the filename. **This is the identity the runner compares.** |
| `applied_at` | unix seconds, as a REAL |
| `content_sha256` | SHA-256 of the migration file's bytes, as applied |
| `applied_by_commit` | the deployed commit SHA, or NULL |

The last two answer *which build wrote this row*. A live instance once crash-looped on boot because an ordinal was recorded under one name while the deployed code carried another — and the investigation stalled, because at the moment the row was written the running commit contained no migration at that ordinal at all, and nothing on disk recorded what had applied it.

Both are nullable, and NULL is a real answer, not a defect:

- **`content_sha256` is NULL** on rows written before provenance shipped. Nothing more can be learned about them.
- **`applied_by_commit` is NULL** when the build had no discoverable identity. Neutron Open is self-hostable, so an install may be an unpacked tarball, a zip, or a `COPY` into a container image with no `.git` and no `git` on PATH. The runner reads git metadata as plain files and never spawns a subprocess (a subprocess on the boot path can hang); when there is nothing to read it records NULL rather than a fabricated value. **Set `NEUTRON_COMMIT_SHA` when packaging a build without git metadata** and provenance stays answerable for exactly the install shape that would otherwise have none.

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
