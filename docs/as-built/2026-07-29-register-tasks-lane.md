## 2026-07-29 — the tasks lane is reachable, visible, and joins the ONE manifest reader

The tasks lane merged with its own `cli.ts` and no entry in `open/legacy-import/lanes.ts` — the same built-but-never-wired shape the registry exists to prevent, and the second lane in two PRs to arrive that way. Registering it surfaced two further defects that a registry entry alone would have shipped past.

**1. Registration.** One `ImportLane` entry at the end of the array (6th), plus `tasks` in `EXPECTED_LANES` and a `/the legacy harness → Neutron TASKS import/` fingerprint in `open/__tests__/legacy-import-cli-registry.test.ts`. The lane reads `<vault>/tasks.md` and exits 2 without it, so the registry test's synthetic vault gained one rather than the lane being softened — same call as the history lane and its topic map.

**2. Its report was INVISIBLE under `all`.** `main` was `(argv, env)` writing straight to `process.stdout` / `process.stderr`. In a terminal that still prints; to the registry, which composes every lane's output into one captured stream, the `[6/6] tasks` banner was followed by nothing at all. It is now `main(argv, env, out?, writeErr?)` with defaults to the real streams, and the registration site passes its writer for BOTH — a usage error sent only to stderr is exactly as invisible as a report. The error writer is deliberately named `writeErr`, not `err`: `catch (err)` binds the Error and shadows it, so every `err(...)` inside a catch calls the Error as a function. That rename also left one live reference at module scope (`import.meta.main`'s rejection handler, where `writeErr` is not in scope at all) — a ReferenceError that would have swallowed any real rejection. Fixed to `process.stderr.write`.

**3. The real defect: a THIRD manifest reader.** `open/legacy-import/tasks/manifest.ts` was a private, single-argument copy of the projects-lane manifest join. It knew only the applied path. PR #482 taught the shared reader about the projects lane's PREVIEW manifest (`legacy-import-manifest.dry-run.json`, `"dry_run": true`) and #483 moved that reader to `open/legacy-import/manifest.ts` where `documents` and `history` both consume it — the tasks copy predates both. So under `import-legacy all --dry-run`, which is the DEFAULT verb, the tasks lane could not see the manifest the projects lane had written seconds earlier, exited 2, and STOPPED the walk at the last lane. The end-to-end preview — the artifact the owner reads before authorising a one-time, irreversible cutover — could not be produced.

Consolidated: `tasks/manifest.ts` is DELETED and the lane joins `../manifest.ts`. What that required, beyond the import swap:

- `buildImportPlan` gained `apply?: boolean` and passes `{ forApply, lane: 'tasks' }`. The signatures differ — the shared reader is `readManifest(ownerHome, selector)` / `manifestPathFor(ownerHome, kind)` — and `apply` is what carries the one-directional rule down from the CLI verb. Both `cli.ts` call sites now state it explicitly.
- `plan.manifestPath` is now `manifest.path`, the file ACTUALLY read, not a re-derived path. There are two candidates; a report that names the wrong one is a lie about which ids a run joined.
- The lane pushes the same PREVIEW warning `documents` and `history` do when it joins a dry-run manifest, so the report says its project ids are predictions.
- `tasks/types.ts` re-exports `ImportOutcome` / `Manifest` / `ManifestRecord` / `LoadedManifest` from `../manifest.ts` instead of redeclaring them. `BOUND_OUTCOMES` stays local and now also excludes the shared vocabulary's legacy `skipped` spelling, which is correct: every outcome not in that set is excluded as `unbound-project`.

**The one-directional rule is preserved and now pinned for this lane too.** A preview MAY read a real manifest; an `--apply` may NEVER read a preview, because a preview's `project_id`s are predictions about rows that may not exist. Five new tests: a dry run joins the preview and says so; `--apply` against a preview-only home throws and the CLI exits 2 with nothing written; `--apply` refuses a `dry_run: true` file MOVED onto the applied path; `--apply` is satisfied by the applied manifest whether or not a preview sits beside it. The missing-manifest guard and the refusal to re-derive ids from `[project:<slug>]` tags are unchanged — those are correct and stay loud.

**Stale argv fixed.** The tasks lane's missing-manifest error told the operator to run `neutron import-legacy --dry-run` / bare `neutron import-legacy` — the pre-#478 surface, which no longer exists. Deleting the file took the last of it: a repo-wide grep of `open/legacy-import/tasks/` now finds no pre-unification command string. The shared reader's message already names the current argv (`neutron import-legacy projects` / `… projects --apply`).

**`open/__tests__/legacy-import-all-dry-run.test.ts` needed its fixture.** Registering a 6th lane made that file's vault incomplete (no `tasks.md`), which broke 3 of its tests. Fixture gained a `tasks.md` whose `[project:]` tags name the two vault projects, so the walk exercises the real join — and a new test scopes to the tasks lane's own section and asserts it joined the PREVIEW manifest path with 2 writable rows and 0 exclusions. That test is the direct regression guard: a lane with a private applied-only reader cannot pass it.

### Mutation results — 4 mutants, 4 killed

| # | Mutation | Result |
|---|---|---|
| a | drop the `tasks` entry from `IMPORT_LANES` | KILLED — 3 registry tests (contractual lane list, `import-legacy tasks` reachability, the end-to-end `all` walk) |
| b | `cli.ts --apply` path passes `apply: false` (an apply would accept a preview) | KILLED — 1 test (`the CLI --apply path exits 2 against a preview-only home`) |
| b2 | `plan.ts` hard-codes `forApply: false` (the same defect one level down) | KILLED — 4 tests |
| c | remove the missing-manifest guard in the shared reader | KILLED — 2 tasks tests, 1 documents test, 3 `all --dry-run` tests |

No mutant survived; no test needed strengthening after the fact. (b) killing only one test is expected — the plan-level tests set `apply` directly and are blind to a CLI-only mutation, which is why (b2) was run as well.

### The real vault, end to end

`./bin/neutron import-legacy all --dry-run --legacy-home ~/legacy --data-dir <fresh>` — **exit 1**, all SIX lanes previewed, no `STOPPED`:

| # | Lane | Total |
|---|---|---|
| 1 | `projects` | 25 active + 19 archived to import, 0 slug-identity failures |
| 2 | `entities` | 1310 pages to write, 0 skipped |
| 3 | `documents` | 808 files to write, 0 identical, 3 dangling symlinks excluded |
| 4 | `memory` | 875 pages, 0 typed edges (no `--chroma-db` / `--kg-db` snapshot given) |
| 5 | `history` | 53 520 rows to write out of 595 063 entries; 8350 excluded for no topic in scope, 0 excluded for no manifest record |
| 6 | `tasks` | 78 bullets parsed → 66 writable, 12 excluded (11 orphan `[project:gateway]`, 1 empty title) |

Exit 1 is the correct real-vault code: `documents` and `tasks` each reported exclusions and the final banner names both. Afterwards the data dir contained EXACTLY one file — `migration/legacy-import-manifest.dry-run.json`. No `project.db`, no doc folders, no pages, no chat rows.

Test totals: registry 24/24, tasks 42/42 (was 37), documents 45/45, history 58/58, `all --dry-run` 17/17. `bunx tsc -p open/tsconfig.json --noEmit` clean.

**The lane count is SIX, not seven** — `projects`, `entities`, `documents`, `memory`, `history`, `tasks`.
