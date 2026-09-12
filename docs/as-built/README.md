# docs/as-built/ — the as-built record, one file per change

This directory is where a record of a merged change lands. It replaces
`docs/AS_BUILT.md`, which is frozen and remains the record for everything up to
2026-09-12 (see the note at its top).

## The format

One change, one file.

- **Filename** — `<slug>.md`. Where the change has a spec item, the slug is the
  spec-item slug, so the record and the item that asked for it share a name and
  are findable from either end. Where it does not, the slug is the branch's own
  name. Only `A-Za-z0-9._-` and no leading `.`, because the name is written by a
  tool and read by a filesystem.
- **First non-blank line** — a single `## YYYY-MM-DD — title` heading. Exactly
  the heading form the frozen log used, so an entry reads the same in either
  place and a record moved between them needs no rewriting. The em dash is
  required; the form is pinned as `AS_BUILT_ENTRY_HEADING` in
  `trident/as-built-log.ts:295`.
- **One entry per file** — a second `## ` heading is refused
  (`shardStagedEntry`, `trident/as-built-log.ts:325`). `###` and deeper are an
  entry's own structure and are fine.
- **Everything below the heading** is the body: what changed, why, and what was
  measured. Prose, not a changelog line.

## How a file gets here

A branch does not write this directory. It stages exactly one entry at
`.trident/as-built/<branch>.md` (branch name mirrored as directories), and the
record is shipped in the PR that earns it. After that PR merges, the outer loop
promotes the staged file to `docs/as-built/<slug>.md` in a single commit on the
base and deletes the staging file (`promoteInScratch`,
`trident/as-built-appender.ts:161`).

If `docs/as-built/<slug>.md` is already taken, the promoted file gets the first
free `-2`, `-3`, … suffix rather than overwriting or merging into what is there
— a record is never edited by the arrival of another one.

## Why the monolith was frozen rather than split

Splitting the 405 existing entries would have rewritten text that other
documents cite by content. The frozen file keeps every one of those entries
byte-for-byte; only new records take the new shape.
