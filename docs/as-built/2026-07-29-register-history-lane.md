## 2026-07-29 — the history lane is now reachable from `import-legacy`

The conversation-history lane merged in #477 with its own `cli.ts` and was never added to `open/legacy-import/lanes.ts` — so no operator could run it through the unified command. The same built-but-never-wired shape the registry exists to prevent, one PR after the registry landed.

Registered at the end of the array (it joins nothing, so it has no dependency constraint). Two details worth recording:

**Its `main` predates the registry's shape.** History exports `main(argv, write)`; the registry expects `main(argv, env?, write?)`. Adapted at the registration site rather than edited in the lane, because the lane's own tests pin the two-arg form and a registry adapter is the smaller, reversible change.

**Its transcript roots come from the vault's `gateway/topic-map.json`, not from the vault tree.** Each topic runs its session in its own working directory, so the transcripts live under `~/.claude/projects/<encoded-cwd>/` across ~21 directories. The lane exits 2 when the map is absent, which is correct — a missing prerequisite must fail loudly rather than silently import nothing. The registry test's synthetic vault therefore gained an empty `topic-map.json` rather than the lane being softened to tolerate its absence.

Mutation-verified: dropping the `history` entry from `IMPORT_LANES` fails 3 tests (registry shape, its reachability fingerprint, and the end-to-end `all` walk). The `all` banner count now derives from `EXPECTED_LANES` so adding a lane updates one place instead of two.

SYSTEM-OVERVIEW's limitations block updated: history is registered, but its **synthesis step remains unwired** — the messages import and are readable, and nothing has been distilled from them yet. 21 pass / 0 fail.
