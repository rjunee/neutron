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

### What actually guarantees the invariant

The invariant is **no code path composes a rev-range from a base branch NAME**, and it is
carried by the STRUCTURE, not by the gate. Stated in the order of how much it proves:

1. **The shell wrappers: unconstructable.** `codex-build.sh` and `codex-review.sh` receive
   an already-resolved ref as argv (`BASE_DIFF_REF="${2:-}"`, `BASE_REF="${1:-main}"`) and
   no variable holding a base branch name exists in either file — `grep -nE
   'BASE_BRANCH|base_branch|baseBranch'` over both returns nothing. A bare-base range there
   is not detected; there is nothing to build one from.
2. **One binding per boundary.** `diffBase` (`inner-workflow.mjs`) and the exported
   `diffBaseRef()` (`merge.ts`) are the only producers of a range base, so there is no
   second spelling to drift from. The branch NAME is still in scope in both files for
   prose, so this is a narrowed surface rather than an impossibility.
3. **CHECK 8 is defence in depth.** It makes a regression loud. It does not prove absence,
   and the gate's own header now says so in as many words.

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

**It has now been caught missing the bug twice, in the same shape, and that is the
finding worth keeping.**

1. The first draft required `${baseBranch}..` and could not see
   `${shSingleQuote(baseBranch)}..` — the literal #546 line. Found by mutating the fix and
   watching the gate stay green.
2. The second draft required the dots to follow the brace IMMEDIATELY and could not see
   `"${BASE_BRANCH}"..HEAD`, which the shell evaluates as exactly `main..HEAD`. Found by
   the review gate on this PR (P1). Probing for siblings turned up four more: single-quoted
   boundary, a concatenation with no interpolation at all (`'git diff ' + base + '..HEAD'`),
   a range split over two source lines, and an argv-array element.

All are matched now (`RANGE_TAIL`, `RANGE_CONCAT`, `logicalLines`), taint follows aliases
to a fixpoint, and each of the three fixes is independently load-bearing under mutation
(reverting `RANGE_TAIL` reddens 3 tests; dropping `RANGE_CONCAT` 1; disabling the line
join 1). The complement is asserted too, so the widening is not permissiveness: a resolved
base in each of those same positions stays silent.

**The generalisation, because fixing the instance twice is the lesson.** A textual matcher
over source cannot enforce "every X"; it can only enforce "every X I enumerated". Each
time, the instance was fixed and the *claim* was left universal — so the gate went on
implying a proof it could not give. The claim is now narrowed to match the instrument: the
gate's header enumerates what it cannot see (a range assembled across statements, a
computed or runtime-supplied name, a helper taking the base as a `string` parameter, any
unenumerated spelling), and the spec item's criteria say which claim rests on the structure
and which on the grep. The positive control carries all real shapes at pinned lines and
runs before the tree is touched; an empty scan exits 1.

### The gate's own verification had the gate's own bug

CodeQL `js/useless-regexp-character-escape`, HIGH, two alerts, both at
`scripts/ci/diff-base-check.test.ts:176` — *"The escape sequence `\$` is equivalent to
just `$`, so the sequence may still represent a meta-character when it is used in a
regular expression."*

**The escape at that line was harmless, and necessary.** Line 176 is a template literal
whose `\${` emits a literal `${` so the produced string is source text to be scanned;
measured, it produces exactly `` const cmd = `git diff ${diffBase}..${head}` ``, and
removing the escapes does not produce a different string — it fails to evaluate at all.

**CodeQL's dataflow was pointing one hop downstream, and there the defect was real.** That
`$`-bearing string flows into `taintedNames`, which built a regex PER TAINTED NAME by
splicing the name in unescaped:

    new RegExp(String.raw`…(?:await\s+)?` + name + String.raw`\b`)

Names come from `([A-Za-z_$][\w$]*)` captures — a class that includes `$`. So a source
file binding `const $base = await resolveBase(run)` spliced
`…(?:await\s+)?$base\b`, in which `$` is an END-OF-LINE ANCHOR. Measured before the fix:

| source shape | tainted | hits |
|---|---|---|
| `const $base = …` / `const alias = $base` / `` `git diff ${alias}..${head}` `` | `$base` | **none** |
| the identical shape spelled `zbase` | `alias`, `zbase` | line 3 |

The gate was **blind** to a range it was built to catch, and the control passed throughout
— which is what made the broken half look intentional. This is the PR's own subject
reappearing inside its verification: a matcher meaning something other than its author
believed.

**An assertion of mine was weaker than I stated, and I am recording that rather than
quietly correcting it.** The test "taint follows ALIASES to a fixpoint" used `base`/`b`/`c`
— no `$` — so it passed while the claim it stated was false for any `$`-containing name.
The claim was broader than its input. The three mutation counts reported earlier
(`RANGE_TAIL` 3, `RANGE_CONCAT` 1, the line join 1) do not run through that path and were
re-measured after the fix rather than assumed: unchanged, plus a fourth — reverting to the
spliced per-name regex reddens 2.

**The fix is to have no splice, not a better escape.** One static
`BINDING_FROM_IDENTIFIER` pattern captures both sides of a binding and membership is a
literal `Set.has`, so a `$` in an identifier is just a character. A test asserts that the
only `new RegExp(...)` calls in the gate are its two static range constructors, so a future
splice reintroduces a failing test rather than a silent blind spot.

### A green workflow is not a green PR

I reported "CI run conclusion: success, 13/13 jobs" and that was true of the `ci.yml`
workflow — while the PR was `UNSTABLE`, because **CodeQL is a separate workflow** whose
`CodeQL` rollup check is not in `ci.yml`'s job list. The count was the visible tell: 13
against the rollup's 17. The authoritative read is the PR's own rollup —
`gh pr view <n> --json mergeStateStatus,statusCheckRollup` — never one workflow's
conclusion.

### A branded `ResolvedRef` type was considered and rejected

The strongest available fix would be a type only a resolved ref inhabits, so a branch name
could not reach a range operand at all. It is not reachable here, and the reason is
specific rather than a matter of effort:

- **TypeScript cannot forbid template-string assembly.** A brand on `diffBaseRef()`'s
  return plus a `revRange(base: ResolvedRef, head)` constructor would make the *sanctioned*
  constructor reject a branch name at compile time — real, and cheap at the 14 range-operand
  sites across `orchestrator.ts`, `mutation-prover.ts`, `merge.ts` and
  `mutation-claim-artifact.ts`. But nothing forces the next site to call `revRange` instead
  of writing `` `${x}..${head}` `` directly, so the universal claim is no better off.
- **The raw-sha sources need an unchecked constructor anyway.** `rebased.baseSha` comes
  from `ls-remote` stdout and `run.base_sha` from a `string | null` database column, so both
  would enter the brand through an `asResolvedRef(...)` escape hatch — reachable by exactly
  the author the type exists to stop. A brand with a public escape hatch is a convention
  with extra types.
- **Making it genuinely impossible means typing the argv boundary**: every git invocation
  in trident would have to go through a builder that only accepts branded operands. That is
  hundreds of call sites, i.e. a large refactor, and out of scope here.

**The durable fix is the shell wrappers' shape, generalised**: keep narrowing the scope in
which a base branch NAME exists, rather than improving the matcher that hunts for it. Where
the resolved ref is the only thing that crosses a boundary, the defect is unconstructable
and needs no gate at all.

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
