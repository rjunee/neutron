# docs/as-built/ — the as-built record, one file per change

This directory is where a record of a merged change lands. It replaces
`docs/AS_BUILT.md`, which is frozen and remains the record for everything up to
2026-09-12 (see the note at its top).

## The format

One change, one file.

- **Filename** — `<slug>.md`. Choose a stable, descriptive slug. Reusing the
  spec-item slug where one exists, or the branch name otherwise, is a convention
  that makes provenance easier to follow; it is not an identity guarantee. Only
  `A-Za-z0-9._-` and no leading `.`, because the name is read by a filesystem.
- **First non-blank line** — a single `## YYYY-MM-DD — title` heading. Exactly
  the heading form the frozen log used, so an entry reads the same in either
  place and a record moved between them needs no rewriting. The em dash is
  required; the form is enforced by `scripts/ci/as-built-write-guard.sh`.
- **One entry per file** — a second `## ` heading is refused
  by that guard. `###` and deeper are an entry's own structure and are fine;
  quoted headings inside fenced examples do not count as entries.
- **Everything below the heading** is the body: what changed, why, and what was
  measured. Prose, not a changelog line.

## How a file gets here

The PR that earns a record writes `docs/as-built/<slug>.md` directly. Prefer the
spec-item slug where one exists; otherwise choose a stable, descriptive slug for
the change. The write guard validates the path and record shape, but does not
infer a relationship between a change and a spec item. There is no staging queue
or post-merge publisher.

Once merged, a record is immutable. A later change writes its own shard and
links to the earlier record when needed; it does not revise another change’s
account. The CI write guard enforces this boundary while allowing newly added,
well-formed shards.

## Why the monolith was frozen rather than split

Splitting the 405 existing entries would have rewritten text that other documents
cite by content. The frozen file keeps every one of those entries byte-for-byte;
only new records take the new shape.
