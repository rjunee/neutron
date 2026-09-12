## 2026-09-12 — Every rev-range base resolves to the pinned sha or origin/<base> (#546)

`git diff main..<head>` in a shared build checkout diffs against whatever
`refs/heads/main` happens to hold, and that ref is only as fresh as the last time
something on the box pulled it. Every commit merged into the base since then is
presented as this branch's own work. Git exits 0, the extra files are real code, and
nothing downstream can tell the inflated diff from a genuinely large one.

Measured twice on this repo: Argus r4 / run `25b2327d` — local `main` 8 merges behind
`origin/main`, a 15,154-line / ~100-file review artifact for a branch whose own work was
20 files / 1,738 lines, and a reviewer who vetoed the branch over bugs in files it does
not touch; and #546 — reviewers reading 149 files where the branch changed 30.

### It had already been fixed twice, as a call site

`probeCiBase` (`trident/inner-workflow.mjs:5247` on the tree this branch was cut from)
and the plan probe's `branchLogBase` (`:2229`) were already resolving the base, while the
resume diff (`:5078`) and the forge contract's reviewer diff (`:1426`) in the same file
still composed the bare name. The issue's line numbers matched the box's *stale* local
`main`, four commits behind `origin/main`; on `origin/main` they are `:5078` (issue said
`:4955`), `:1426` (`:1380`) and `:5247` (`:5123`).

So the unit of this change is the rule.

### One binding per language boundary

- `trident/inner-workflow.mjs` — `diffBase`, declared once beside `pinnedBase`, read by
  the forge contract's reviewer diff, the planner's resume inspection hint, the resume
  diff, and the base argv of both codex wrappers. Order: the launch-pinned sha, else
  `origin/<base>` in pr mode, else the bare name in local mode.
- `trident/merge.ts` — `diffBaseRef(base_branch, base_sha, merge_mode)`, exported and
  pure, next to `detectBaseBranch` which produces the name it refuses to let through.
  Used at every `resolveBase()`-fed range in `trident/orchestrator.ts`.
- the shell wrappers compose **no** base at all: `trident/codex-build.sh` and
  `trident/codex-review.sh` receive a resolved ref as argv. `BASE_BRANCH` became
  `BASE_DIFF_REF` so the name stops claiming a branch; `codex-review.sh` also demotes a
  bare name to `origin/<name>` when one resolves, for standalone use.

### And a gate, so the next site cannot forget

`scripts/ci/diff-base-check.mjs` (CHECK 8 of `scripts/ci/lint.sh`) fails on a rev-range
in `trident/` or `tools/` whose left operand names a base BRANCH — by spelling
(`base_branch` in any case) or by the binding it came from (`resolveBase()`,
`detectBaseBranch()`, a `base_branch` field). It does not flag a qualified ref
(`refs/heads/${base}..`, which the launch path's staleness *measurement* needs), a
resolved one, a test, or an argued `DIFF-BASE-OK: <reason>`.

**Its first draft was green against the actual bug.** The #546 line is
`git diff ${shSingleQuote(baseBranch)}..${shSingleQuote(headOid)}` — the name inside a
call — and a matcher requiring `${baseBranch}..` cannot see it. Found by mutating the fix
and watching the gate not care. It now matches the whole interpolated expression and
condemns any base-branch name mentioned in it; the positive control carries all five real
shapes, at pinned lines, and runs before the tree is touched. An empty scan exits 1.

### Dispositions for the rest of the class

Fixed: `inner-workflow.mjs` `:1426`, `:2160`, `:5078`, the two wrapper argvs;
`orchestrator.ts` review diff + `--output` group diffs, the stranded-run ahead count, the
stage-1 test-strategy base, the mutation gate's blast-radius base;
`computeDiffLineCount`'s parameter and `changedFilesWithStatus`/`changedFilesOnBranch`'s
parameter renamed `base_ref` (no production caller was mis-feeding them; the rename is
the fix); `codex-build.sh`, `codex-review.sh`.

Correct as-is, with evidence:

- `inner-workflow.mjs` `probeCiBase` — the ref goes into a GitHub commits API path, which
  resolves server-side, and it already prefers `pinnedBase`.
- `inner-workflow.mjs` `branchLogBase` — deliberately still `origin/<base>`, and this is
  the one site that is not `diffBase`. It asks a different question ("which commits are
  this branch's own, for a *bounded* synthesis window") and wants the widest exclusion in
  either mode; `inner-workflow-plan-next.test.ts` pins both halves of that split. Folding
  it into `diffBase` reddened that test, correctly.
- `orchestrator.ts` `base_behind` — `refs/heads/<base>..refs/remotes/origin/<base>` names
  the local ref on purpose: it exists to measure how stale it is.
- `scripts/ci/leak-gate.sh` — its base candidates are `LEAK_GATE_BASE_SHA`, then
  `origin/${GITHUB_BASE_REF}`, `origin/main`, and only then `main`. Origin-first already.
- `tools/lane_review.sh` — the base defaults to `origin/main`, and `resolve_ref`'s
  local-first precedence is argued in the file (a lane branch usually exists only as
  `origin/trident/<slug>`; three real PRs produced empty output without it) and pinned by
  `tools/lane_review.test.ts`.
- `mutation-prover.ts`'s range itself — a ref-taking function whose doc argues it must
  accept any revision git does; the defect was its caller.

### The test

`trident/review-diff-base-realgit.test.ts`, real git. A consumer clone whose
`refs/heads/main` sits at the commit it cloned while `origin/main` is 4 commits ahead,
each touching its own file; the build branch is cut from current `origin/main` and changes
one file. The correct answer is 1 file, the buggy answer is 5 — both asserted as values
and as file names. The `resume-diff` seam does not fake the diff: it extracts the command
the workflow composed and runs it with bash, then reads the diff file git produced.

The complements, because a fix that always preferred something else would pass the stale
case: the fresh case (both answers agree, stated without reference to the composed
command so it stays green under the mutation); a pin that IS the stale sha (still
honoured — the order is over real inputs, not a preference for `origin/<base>`); and local
mode (the bare name is kept — prefixing `origin/` unconditionally would break every run in
a repo with no remote).

**Mutation:** restoring `${shSingleQuote(baseBranch)}` at `writeResumeDiff` fails 4 of the
7 tests in that file, and the gate reports it at `inner-workflow.mjs:5119`. The two
agreement/complement tests stay green, which is what they are for.

Four existing tests pinned the buggy value and were repointed with their new value stated
as a value: `inner-workflow-assembly.test.ts` (split into a local/pr pair),
`inner-workflow-resume.test.ts` (a new pr-mode + pinned-sha test beside the local one),
`inner-workflow.test.ts` and `__tests__/cross-model-dispatch.test.ts` (the wrapper argvs),
`orchestrator.test.ts` (the mutation-gate range, the test-strategy block, and the
hostile-base-name seam — where the name now cannot reach the prose at all, since a 40-hex
sha displaces it; the fold itself is still covered at its source in
`mutation-claim-artifact.test.ts`).
