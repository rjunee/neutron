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
