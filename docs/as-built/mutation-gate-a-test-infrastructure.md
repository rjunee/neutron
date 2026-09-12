## 2026-09-12 — mutation gate: targets are classified by what DECLARES a test, and a no-production-file diff exempts with its own reason

The mutation-proof gate had no reachable outcome for a diff whose only changed
source files are tests. Every such file was rejected as a mutation target by a
path-prefix rule (`tests/`, `__tests__/` anywhere in the path) while the gate
still demanded a proof, so the build was told to nominate a target that did not
exist and was blamed for an omission it could not avoid. PR #489 — approved,
every check green — could never merge.

**Classification is now by DECLARATION, not by path.** `isDeclaredTestFile`
(`trident/mutation-prover.ts:295`) says a file declares a test when its BASENAME
is one a runner really collects — `*.test.*` / `*.spec.*` for the JS/TS
extensions a runner actually loads, `*_test.go`, `*_test.py` — or when it is a
DIRECT child of `__tests__/`. Nothing else. A support library under `tests/`, or
nested below `__tests__/<subdir>/`, is an ordinary legal mutation target whose
behaviour a separate declared test asserts. `classifyMutationTarget`
(`:304`) turns that into the three-way `test` / `prose` / `production` the rest
of the gate reasons over. `_test.rs` is deliberately NOT a declaration — cargo
has no such convention, and the arm was selling `src/pricing_test.rs`, ordinary
production logic, an exemption for a suffix the build chose.

**The anti-tautology rule is stated directly instead of being approximated.**
The path rule was only ever standing in for "a guard may not run the mutated
file as its own test"; that is now `guardRunsTheMutatedFile`, checked on the
GUARD argv, which is where the tautology actually happens.

**A diff with no production file exempts itself, and says so.** When every
changed file classifies `test` or `prose`, the set of nominations that could
pass is empty and requiring a proof asks for one with no referent. That diff now
returns `exempt: true` with its OWN reason — `no production file in this diff —
nothing to mutate: all N changed files are declared tests or documentation
(…names…)` — distinct from the prose-only exemption, so the run record shows
WHICH one fired, bound to the pinned commit exactly like every other outcome,
and naming every file that bought it (capped by total length, with the elision
counted, not by count).

**The refusal stopped blaming the build.** `missingClaimRefusalReason` splits
one sentence into the cases it was hiding: a legal target existed and none was
named (it names the target, preferring one an allowlisted runner can execute);
the diff could not be read; the diff is empty; the only production changes are
DELETIONS, which no mutation can apply to — a real deadlock that now says so
instead of naming a file the prover would refuse; and the gate-defect case where
nothing is legal yet no exemption fired.

**The diff reader now reads status, not just names.** `changedFilesWithStatus`
asks git for `-z --no-renames --name-status`. `-z` keeps byte-exact paths (no
C-quoting, no line splitting), `--no-renames` keeps the SOURCE of a
`git mv src/limit.ts src/limit.test.ts` visible instead of letting the rename
carry a production change into the exemption, the leading status letter protects
the first path from the host seam's `stdout.trim()`, and the status itself tells
a deletion from a modification. An EMPTY diff is now `[]` rather than `null`, so
"the branch changes nothing" and "git failed" stop being the same answer —
`readCommittedMutationClaim` says which.

Rebased onto `origin/main` after twelve days: main's hostile-base guard (a base
spelled `--output=<path>` makes `git diff` CREATE that file) moved into
`changedFilesWithStatus`, and the orchestrator's committed-nomination note now
matches `NO_NOMINATION_REFUSAL` as a PREFIX, because the refusal it explains now
carries the legal target it could have named.
