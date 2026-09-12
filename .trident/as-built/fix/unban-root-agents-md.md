## 2026-09-12 — the root `AGENTS.md` ban was guarding an empty set

`FORBIDDEN_EXACT` in `scripts/ci/leak-gate.sh` reserved four root paths —
`STATUS.md`, `ISSUES.md`, `CLAUDE.md`, `AGENTS.md` — as carve tripwires. This tree
was carved out of a private sibling repository, and the tripwire exists so that a
carve or sync which copied that repository's root docs into the public tree fails
on the PATH, before anyone has to trust the content rules to catch it. That is
sound, and three of the four entries earn their place: all three exist at the
private root today, and one of them is 1.48 MB of issue tracker.

A root `AGENTS.md` has never existed there. `git log --all -- AGENTS.md` in that
repository returns zero commits, ever. The entry was protecting against a file
that has never been written, and the cost was real: `AGENTS.md` is the file a
non-Claude harness reads, so a self-hoster running Codex against a clone of this
tree had no repo-wide instruction file at all. The 32 `AGENTS.md` files already
here are per-directory and only apply once you are inside those directories,
which is exactly when you no longer need the orientation.

The precedent for the fix was already in the same comment block. A root `SPEC.md`
was banned by this list until K10 introduced one deliberately (it flips the repo
into Ralph-governed mode via `detectRalphMode` in `trident/git-mode.ts`), at which
point the entry was removed and the comment rewritten to say why. `AGENTS.md` is
in that position now: it is an intended public file, so the tripwire was inverted
rather than worked around.

What did NOT change is the reasoning that makes the tripwire worth having. The
content rules (Tier 1 private tokens, Tier 2 multi-instance vocabulary, the PII
denylist) are what actually catch a copied private document; the path check is the
cheap first line. Removing one path does not weaken the content scan, and the
comment now records the condition under which the entry must come back — if that
repository ever grows a root `AGENTS.md`, restore it.

The un-ban is pinned in both directions, because an un-ban that nothing asserts is
one careless edit from silently returning. `leak-gate-selftest.test.ts` keeps
pinning each retained entry individually so deleting any of the three fails the
suite, and gains a positive case asserting that an otherwise-clean tree WITH a
root `AGENTS.md` stays SILENT — the same shape as the existing `SPEC.md` case.
That new test was mutation-checked before landing: restoring `AGENTS.md` to
`FORBIDDEN_EXACT` fails it with `[forbidden-path] AGENTS.md:1`, so it is testing
the gate rather than restating it.

This change lands the permission only. The root `AGENTS.md` file itself follows in
the work-tracking standard's change, which is what it needs to point at; landing
the file here would have meant either a dangling reference or a second lane on the
same file.
