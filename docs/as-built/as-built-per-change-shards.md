## 2026-09-12 — the as-built log is frozen; the record is one file per change

`docs/AS_BUILT.md` was 2.0 MB, 26,597 lines, 405 entries, newest-first, and every
merged change prepended to it. It is now FROZEN: a short note at its top
(`docs/AS_BUILT.md:5`) says so, every one of the 405 entries below that note is
byte-identical to what it was, and new records are one file per change under
`docs/as-built/` (`docs/as-built/README.md`).

FREEZE, NOT CONVERT — AND THAT IS THE DECISION, NOT A SHORTCUT. Splitting the 405
existing entries into 405 files would rewrite text other documents cite by
content, for the sake of uniformity nobody reads the log for. The monolith stays
exactly as it is and stops growing; only what lands after today takes the new
shape. The cost is one seam in the record, and the seam is documented at both
ends.

WHAT CHANGED IN THE MACHINERY. `trident/as-built-appender.ts` used to read
`docs/AS_BUILT.md` out of a detached scratch worktree, fold the staged queue into
it, and commit the rewritten file. It now writes each staged entry as its own
`docs/as-built/<slug>.md`, where the slug is the staged file's own basename —
which is the branch name, and the spec-item slug where the change has one.
Everything that made the fold safe is untouched: one atomically resolved base
tip, a detached scratch worktree, a single commit that both adds the record and
deletes the consumed staging file, and a plain (never forced) push that a moved
base rejects. The exported seam is still `foldStagedAsBuiltEntries` with its
`folded` count, because what is folded is the QUEUE and the orchestrator has no
business knowing where it lands.

THE COLLISION RULE CHANGED SHAPE RATHER THAN MOVING. In one file, two identical
`## ` headings were one ambiguous key, so a colliding entry was RETITLED with a
` (n)` suffix. With one file per change the key is the path, so the title — which
is content — is preserved verbatim and the FILENAME takes the first free `-2`,
`-3`, … suffix (`shardStagedEntry`, `trident/as-built-log.ts:325`). A record is
never edited by the arrival of another one.

THE GUARD IS A VETO AGAIN. `scripts/ci/as-built-write-guard.sh` warned instead of
failing on the strength of a 2026-08-19 measurement: 31 of 45 open PRs touched
the log, 0 of 34 conflicting PRs were blocked solely by it, so a veto cost 31
correct PRs for a benefit of zero. Every one of those 31 was legitimately
appending to an append-only file. There is no legitimate write left, so the count
of correct PRs a veto costs is zero by construction, and the guard fails.

It reads the freeze from the BASE rather than assuming it, and the reading is
done in the shell rather than by piping `git show` into `grep -q`: this script
runs under `set -o pipefail`, grep exits the instant it matches, git dies of
SIGPIPE writing into the closed pipe, and the pipeline reports that as failure —
so the check answered "not frozen" for a log that is. Measured on the real 2.0 MB
file, the veto did not fire; a small fixture passed because git finishes writing
before grep can exit, which is why the regression test pads its log past a
megabyte. A blind veto would red
the only change that can ever make its own message true — this one, whose diff
necessarily writes the freeze note — and would refuse correct work in a governed
repo whose log is still append-only. So the veto fires when the log at the base
already carries the note, and otherwise says out loud that it is passing the diff
that installs it. That cannot rot quietly: a test pins that this repo's real log
carries the note, so dropping it reds the suite rather than disarming the veto.

`merge=union` HAD TO GO, AND ITS GATE HAD TO INVERT. Union is git's take-both-
sides-and-never-report-a-conflict driver. It was right for exactly as long as the
file was append-only. On a frozen file it is worse than useless: it can never
raise, so an edit that should have stopped somebody would be silently doubled —
and two per-change files never conflict with each other, so there is nothing left
for it to resolve. The line is gone from `.gitattributes`, replaced by why.

That made `scripts/ci/check-governed-repo-attributes.ts` — which required the log
to resolve `merge=union` and is run by CI's `layering` job — assert the opposite
of what is now true. Rather than delete a gate (it also hosts the write guard and
the migration-ordinal guard, and CI's workflow file is unreachable from here), its
verdict is INVERTED: no tracked attributes rule may assign the log a merge driver
at all. Every read underneath it is unchanged — the same candidates, the same
isolated `git check-attr` probe, the same committed-tree-not-index discipline —
so the whole poisoned-environment suite still holds, with its fixtures' polarity
swapped: a `merge=union` line is now the broken fixture and an absent rule the
healthy one.

STAGED THE OLD WAY ON PURPOSE. This entry is at
`.trident/as-built/docs/as-built-per-change-shards.md`, which is still the
convention for a branch — it is this change that switches where the queue lands,
so it cannot land its own record any other way. After the merge, the appender
promotes it to `docs/as-built/as-built-per-change-shards.md`.
