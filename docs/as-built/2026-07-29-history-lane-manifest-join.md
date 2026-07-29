## 2026-07-29 — the history lane JOINS the projects manifest instead of re-deriving project ids

### The defect

`open/legacy-import/history/topic-map.ts` derived a topic's destination project id
as `basename(topic.project_path)`, with a comment asserting that this was
authoritative "because Lane A keys `projects.id` on that directory's name".

That is true only when the projects lane binds a FRESH id. It resolves its bind
target through `resolveBindTarget` (`gateway/wiring/project-create.ts`), which
matches an EXISTING row by name-slug and returns THAT row's id — so
`bind_id !== source.project_id` is a normal outcome on an already-onboarded home
(`open/legacy-import/run-import.ts:260-262` logs it explicitly). The manifest
exists precisely to carry the difference.

Same class as the documents-lane defect fixed earlier, with the opposite and
worse failure mode. Documents refuses to run without the manifest and stops
loudly. History would silently bind chat rows to a `projects.id` that may not
exist and report success — an import that looks clean while messages land
against a dangling project.

### The fix

**One manifest reader, shared.** `documents/manifest.ts` moved to
`open/legacy-import/manifest.ts`, taking the four manifest types with it
(`documents/types.ts` now re-exports them from there). It was never a
documents-lane concern: two lanes join the same file on the same key, and a
second reader would be a second place for the join rule to drift. The only
behavioural change to the reader is a `lane` label so the failure message names
the lane the operator typed. `documents/` behaviour is otherwise untouched — its
45 tests pass unchanged.

**The join is enforced by the type checker, not by a comment.**
`parseTopicMap(json, transcriptsRoot, bySlug)` takes the manifest index as a
REQUIRED third argument with no default. A default empty map would have turned
every project topic into an orphan, and a caller that simply forgot the join
would still have compiled. As it is, every call site broke at compile time when
the argument was added — which is how the change was verified to be complete.

`basename(project_path)` survives, but demoted: it is now the JOIN KEY
(`legacy_slug`, the vault `Projects/<dir>` name that `scan-legacy-tree.ts:128`
writes into the manifest), never the destination. The destination is
`record.project_id`.

**`--data-dir` is required on both paths.** A dry run has to read the manifest
too, so the flag is no longer `--apply`-only. `import-legacy all` already passed
it (`lanes.ts`), so nothing downstream changed.

### The orphan decision: EXCLUDE and exit 1, not fatal

A project topic whose `legacy_slug` has no manifest record is reported per-topic
with the number of messages the drop cost, and the run exits 1 on both the dry
and the apply path. Three alternatives were rejected:

- **Guess an id** — the defect being removed.
- **Fall back to `project_id: null`** — WORSE than guessing. Those rows key
  `app:<user>` and would mix one project's private conversation into the
  General thread. Mutation test (c) below produced exactly this output, which is
  what makes the case concrete rather than theoretical.
- **Refuse to run** — one stale map entry (a project archived or deleted after
  its topic was created) would block the entire 4,413-message corpus, and
  `topic-map.json` is a long-lived file that accumulates exactly those.

Excluding matches how this lane already treats every entry it cannot attribute
(`unattributed`, `unknown-thread`) and how the documents lane treats an orphan
directory: visible loss, never silent loss. Orphans are seeded from the
BINDINGS rather than from what the corpus happened to contain, so a
manifest/topic-map disagreement is reported even when it costs zero messages —
the disagreement is the thing the operator has to reconcile.

### Preview/apply rule — unchanged, and now verified from this lane too

`selectManifestPath` still enforces it in one place: an apply reads ONLY the
applied manifest, a preview prefers the dry-run manifest and falls back to the
applied one. A second layer (the `dry_run` flag inside the file) catches a
preview hand-copied onto the applied path. Both layers are now asserted from the
history CLI, and mutation (d) proves the path-split layer is independently
load-bearing rather than shadowed by the flag check.

### Mutation results — all four killed

| # | Mutation | Result |
|---|---|---|
| a | restore `project_id: legacy_slug` (re-derive from basename) | **killed** — 2 failures |
| b | missing manifest returns an empty record set instead of throwing | **killed** — 3 failures |
| c | orphan falls through the guard | **killed** — 4 failures |
| d | apply falls back to the preview manifest | **killed** — 1 failure |

Mutation (c)'s report output is the evidence for the orphan decision above: it
printed `1  app:owner  redwood (no project — user-scoped topic)` — the
project's conversation demoted into General, exactly the silent corruption the
guard prevents.

### Real-vault run (read-only, scratch `--data-dir`)

`projects` (dry) → preview manifest, then `history` (dry):

- 21 transcript directories, 999 session files, 1,927 MiB, 594,833 lines
- 4,413 owner messages; a naive `type → role` parser misattributes 102,438 of
  106,851 `type:"user"` entries (95.9%)
- **53,499 rows to write across 18 topics**; largest `redwood` 17,065,
  `nimbus-coding` 11,708; General 1,910 rows correctly user-scoped on
  `app:owner` with a null project id
- **0 orphan topics** — every project topic joined to a bound id
- 8,347 excluded as unattributable, 0 unparseable lines
- Nothing written but the projects lane's own preview manifest; no `project.db`
  created

`history --apply` against that home correctly REFUSED (exit 2, no database
created): the preview manifest does not satisfy an apply.

### Other lanes

`memory` and `entities` do NOT share the pattern — verified, not assumed.
`entities` is explicitly global/not project-scoped (`entities/types.ts:4`), and
every `project` string in `memory/` refers to `~/.claude/projects` directories,
not `projects.id` (`memory/read-files.ts:58-77`). There is no `tasks` lane in
the registry yet; when it lands it must take the manifest index the same way.
The only `slugifyProjectId` call sites left in `open/legacy-import/` are in the
projects lane's own scanners, where deriving the id is the job.

### Not covered

The history lane's SYNTHESIS step is still unwired — that gap is unchanged.
