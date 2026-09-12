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

## The staging floor: every record directory keeps a `.gitkeep`

`.trident/as-built/` — and every subdirectory of it that holds a staged record —
carries an empty tracked `.gitkeep`. **Do not delete one, and add one alongside a
record staged into a directory that has none.** A CI guard refuses both mistakes
(`scripts/ci/as-built-staging-floor-guard.sh`, run by the `layering` job through
`scripts/ci/check-governed-repo-attributes.ts`), so this section explains a rule
the build already enforces rather than asking you to remember it.

**What the floor prevents.** A promotion moves the last staged record out of a
directory, that directory has no tracked file left, and git stops seeing it at
all. The promotion commit is, file for file, a move out of that directory into
`docs/as-built/` — so git reads the pair as a **directory rename**, and every
open PR that stages a record there acquires:

```
CONFLICT (file location): .trident/as-built/<path>.md added in <sha> inside a
directory that was renamed in origin/main, suggesting it should perhaps be moved
to docs/as-built/<name>.md
```

Accepting that suggestion writes a shard **from a branch**, which is precisely
what the one-writer rule above forbids — promotion happens on the base, after the
merge, or not at all. A conflict that arrives carrying instructions to violate an
invariant is worse than a plain conflict.

Measured 2026-09-12, not predicted: one promotion emptied the directory and two of
the seven then-open PRs immediately acquired that conflict.

**Why it is per-directory and not one file at the top.** Git decides
directory-rename detection one directory at a time, and skips it only for a
directory that still exists. Branch names here carry a slash, so a record is
staged at `.trident/as-built/fix/<name>.md` far more often than at the top — and a
lone `.trident/as-built/.gitkeep` leaves `.trident/as-built/fix/` free to vanish
with the conflict entirely intact. `trident/as-built-staging-floor-realgit.test.ts`
proves this with real merges: the conflict appears with no floor, appears again
with a top-level floor only, and is gone with a floor in the record's own
directory.

Floors ship for the branch-name prefixes in use (`docs/`, `feat/`, `fix/`,
`trident/`). A record staged under a new prefix brings its own `.gitkeep`, and the
guard fails with the exact path to add.

**Why it is not a `.md` file.** Both promoters glob the staging directory for
`*.md` (`trident/as-built-appender.ts:101`), so a `README.md` there would be
consumed and promoted as though it were a record — and the directory would be
empty again. A floor is any tracked file that glob cannot carry away; an empty
`.gitkeep` is the convention.

There is a fitting detail in this fix's own history: the first commit on the
branch failed to create the placeholder with "No such file or directory", because
the directory does not exist in a fresh worktree. The defect demonstrated itself
during its own repair.
