# `docs/as-built/` — one file per entry

**Write new as-built entries HERE, as `YYYY-MM-DD-<short-slug>.md`. Do not append to `../AS_BUILT.md`.**

## Why

`AS_BUILT.md` is a single file that every PR prepends to, at the same offset. Two PRs open at once therefore conflict **by construction** — not because they touched the same subject, but because they both wrote to line 5.

On 2026-07-28 that cost five rebases in one evening across four unrelated PRs (a store fix, a CI change, a root-URL fix, a scribe feature). None of the conflicts were real: every resolution was "keep both entries". A merge conflict that is always resolved the same mechanical way is not telling you anything — it is a toll.

That toll scales with concurrency, and concurrency is the point: the M2 migration fans out across independent lanes (projects, documents, entities, tasks, memory, history) that are meant to run at the same time.

One file per entry makes the conflict impossible rather than easy to resolve. Filenames sort chronologically, so the directory listing IS the index — there is no index file to contend on either, which is the trap a naive "add an index" fix would reintroduce.

## Conventions

- **Filename**: `YYYY-MM-DD-<short-slug>.md` — date first so `ls` is chronological. Add `-2`, `-3` for multiple entries the same day on the same subject.
- **First line**: an `##` heading in the same shape the log has always used, e.g. `## 2026-07-28 — ISSUES #367: the instance ROOT URL 404`.
- **Content is unchanged.** Same bar as before: what changed, WHY, what was measured, what is NOT covered. An as-built entry that only restates the diff is not worth writing — the diff is already in git. Record the reasoning a future reader cannot reconstruct.

## `../AS_BUILT.md`

Kept as-is: it holds the chronological log through 2026-07-28 and is still the place to read history. It is **closed for new entries** — nothing is migrated out of it, because rewriting history to fix a workflow problem would be its own kind of churn.

## What the rule above needed, and did not have (2026-08-15)

This README was written on 2026-07-28 and the closed file then took a new entry on essentially every day through 2026-08-15 — because the rule lived only here, where no build's prompt reads and no gate checks. On 2026-08-15T23:20Z three concurrent builds all failed at publish on `../AS_BUILT.md` and on nothing else: a conflict this document had already forbidden eighteen days earlier. Prose is not an invariant. Three things were added so it holds:

- **The build contract says it.** `trident/inner-workflow.mjs` (`AS_BUILT_ENTRY_RULE`) tells every Forge build that an entry is a NEW FILE here, and the planner's read step names this directory rather than the closed file.
- **CI enforces it.** `scripts/ci/as-built-closed-log-guard.sh` fails a PR that adds a `##` entry heading to `../AS_BUILT.md` (a closure, not a freeze — fixing a typo or a link there is still fine). Its mutation coverage is `scripts/ci/as-built-closed-log-guard.test.ts`.
- **The split log can be read as one document.** `bun scripts/render-as-built.ts` concatenates these entries newest-first — date descending, slug ascending within a day — followed by `../AS_BUILT.md`. The renderer never edits inside an entry, so it cannot splice two together; entries keep whichever heading level their author used.

A `merge=union` driver on the single file was the cheaper-looking alternative and it is worse than the conflict: union merges *line-wise*, so two entries that share any line get spliced into one another and git reports success. `scripts/as-built-concurrent-realgit.test.ts` replays two real builds over a moved base under both layouts and demonstrates that rather than asserting it.
