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

0. **The bare name is reached only with no remote.** `diffBase`'s unpinned arm asks git
   whether `refs/remotes/origin/<base>` resolves, in either merge mode. Where it does not,
   `refs/heads/<base>` IS the base of record and there is no better answer — that case is
   legitimate, tested, and the only one left.
1. **`codex-build.sh`: unconstructable.** It takes the base as argv `$2`
   (`BASE_DIFF_REF="${2:-}"`), its default is EMPTY, and an empty value skips the
   last-resort diff entirely — so no base branch name can reach a range there at all.
   **`codex-review.sh` is weaker, and an earlier draft of this record overstated it by
   lumping the two together.** Its default is the literal `main`
   (`BASE_REF="${1:-main}"`) — a bare base branch name, in scope — which it promotes to
   `origin/main` when that ref resolves and leaves bare when it does not. So:
   unconstructable on the trident path, which always passes a resolved ref, and merely
   *demoted* in a standalone run against a repo with no `origin/<base>`.
2. **One binding per boundary.** `diffBase` (`inner-workflow.mjs`) and the exported
   `diffBaseRef()` (`merge.ts`) are the only things that turn a base branch NAME into a
   range base, so there is no second spelling to drift from. They are NOT the only
   producers of a range base — `rebased.baseSha`, `localForkPoint()`, `seenPin` and
   `run.base_sha` all reach a range operand directly — and an earlier draft claimed they
   were. Each of those is a **sha**, which is the property that matters. The branch NAME is still in scope in both files for
   prose, so this is a narrowed surface rather than an impossibility.
3. **CHECK 8 is defence in depth.** It makes a regression loud. It does not prove absence,
   and the gate's own header now says so in as many words.

### One binding per language boundary

- `trident/inner-workflow.mjs` — `diffBase`, declared once beside `pinnedBase`, read by
  the forge contract's reviewer diff, the planner's resume inspection hint, the resume
  diff, and the base argv of both codex wrappers. Order: the launch-pinned sha, else
  `origin/<base>` in pr mode, else the bare name in local mode.
- `trident/merge.ts` — `diffBaseRef(base_branch, base_sha, origin_base_resolves)`, exported and
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

### Round eight: the same rule, twice, disagreeing about ORDER

Round seven's refusal went in at MODULE SCOPE in `inner-workflow.mjs` — before
`pinnedBase` was consulted. `diffBaseRef` returns the pin *before* it validates the name.
So a run with a valid 40-hex pin and an option-shaped base branch **threw**, where it
should have used the pin and never looked at the name: a run that worked before the fix
and failed after it, over a value the pin had already superseded.

**That is the mirror of the defect round seven fixed.** There a `-` check refused to
EXAMINE a value and let it through; here it refused the whole call over a value that was
never going to be used. Both are the same error about *where* a guard belongs: validate on
the path where the value is actually read. Fixed by moving the check into
`unpinnedDiffBase()`, the only arm that reads the name.

#### Can the two implementations be made one? No — but they can be held to one answer.

`diffBaseRef` (TS) and `diffBase` (`.mjs`) encode the same rule. They **cannot share a
module**: the workflow script takes no imports — its globals are injected by the Workflow
runtime and its own header states it "is NOT runnable with plain `node`/`bun`". Extracting
the rule would mean either giving that file an import it cannot have, or generating it,
which trades a divergence you can read for one you cannot.

They have now diverged **twice**, and neither time did a test catch it — because each
implementation was only ever tested on its own:

| round | divergence | caught by |
|---|---|---|
| six | `.mjs` kept a merge-mode-keyed fallback the TS side had dropped | review |
| eight | `.mjs` validated the name *before* the pin; TS after | review |

So the answer to "two copies of a rule" here is a **parity table**
(`trident/diff-base-option-shaped.test.ts`): every row asserts BOTH implementations, over
pinned/unpinned, origin-resolves/missing, both merge modes, and the refusal. The `.mjs`
answer is a shell word, so it is evaluated in a real repository to be comparable. Verified
by mutation: reintroducing *either* historical divergence reds a row — the merge-mode one
only after the table was widened to run both modes, which is itself the lesson that a
parity table is only as good as the axes it varies.

That is weaker than one implementation and stronger than two tested separately: the code
is still duplicated, but a change to either alone cannot land.

#### Two stale assertions, one inside a guard

`orchestrator.ts` still said the bare name is reached "only in local mode" — the framing
the round-six fix removed, surviving in the comment above the call it changed. And
`lint.sh` claimed neither wrapper holds a base-branch-name variable while
`codex-review.sh` deliberately defaults `BASE_REF` to bare `main` — **which this very
record documents**. The document asserting the finding and the document asserting the
opposite were in the same PR.

The second is the one that matters: a stale sentence in a comment misleads a reader; a
stale sentence in **a guard's own self-description** tells the next person the guard covers
something it does not, which is how a gap gets left on purpose.

#### The guidance correction, which came out of round seven

Through most of this branch the working rule was *narrow the claim to match the
instrument*. Round seven's falsification pass produced a case where that was the wrong
move: "every consumer carries `--end-of-options`" was false because two `.mjs` prompt sites
lacked it, and the cheap fix was to narrow the sentence to "every consumer except two,
which the binding protects". Adding the marker to those two sites instead made the simple
sentence true.

**The better rule is: match the claim and the instrument — and prefer raising the
instrument whenever the strong claim is achievable.** Narrowing is the fallback for when it
is not. A narrowed claim is honest but it also encodes the gap permanently, and every
future reader has to carry the exception; a raised instrument deletes the exception. The
test is simply which is cheaper *here* — and "add a flag to two call sites" is far cheaper
than "teach everyone forever that there are two call sites where this does not hold".

### Round seven: the mitigation opened a file-write, and a stale signature

**`originBaseResolves` declined to PROBE a name beginning with `-`, and declining to probe
returns `false` — which selects the bare-name branch, the one that reaches git unguarded.**
The option-shaped case was one of the three falsifying states found in round six, before
the gate; it was handled at the wrong end. MEASURED on git 2.43 at every consumer, with a
base of `--output=<path>`:

| consumer | exit | wrote the smuggled file |
|---|---|---|
| `git diff --name-only --no-renames` (publish listing) | **0** | **yes** |
| `git diff --output=<file>` (review artifact) | **0** | **yes — both outputs honoured** |
| `git diff --output=<part> … -- :(literal)…` (grouped) | **0** | **yes** |
| `git rev-list --count` (stranded salvage) | 129 | **yes, despite the error** |

The `rev-list` row is the one worth keeping: checking the exit code and not the filesystem
would have called it safe.

**REFUSING TO EXAMINE A DANGEROUS INPUT IS NOT REFUSING THE INPUT.** That is a third
distinct failure beside the two this branch already names — inferring "no remote" from
"merges locally" and "branch" from "resolves". In those the *signal* was wrong; here the
signal was fine and the guard's **placement** inverted the outcome. A check that reads as a
safety measure and functions as a fast path into the unsafe branch.

**Fixed at the binding, once:** `diffBaseRef` now throws `TridentOptionShapedBaseError`
rather than returning such a name, so it cannot become a rev-range operand at all — the
same principle as narrowing the scope in which a base branch name exists. Nothing
legitimate is lost: `git check-ref-format --branch` rejects a leading `-`. The `.mjs`
binding refuses identically. **Defence in depth:** `--end-of-options` at every consumer —
four in `orchestrator.ts`, three in `inner-workflow.mjs` (the executed resume diff and both
prompt sites), and both shell wrappers. Measured: with the marker every family refuses and
writes nothing to the smuggled path, and ordinary ranges are unaffected.

`trident/diff-base-option-shaped.test.ts` asserts the binding's refusal, that every shipped
consumer carries the marker (extraction with a pinned count, so a consumer added later
fails), and — per command family, against real git — that the marker is what does it.
Three mutations: removing the throw reds the binding test; stripping the marker from the
four orchestrator sites reds one; stripping it from the wrappers reds another.

**The falsification pass, run on the NEW sentences this time.** "Every consumer carries the
marker" was false when written: the two `.mjs` prompt sites did not. Rather than narrow the
claim to "every consumer except two, which are protected by the binding" — the shape this
branch has been wrong in six times — the marker was added there too, so the simple sentence
is the true one.

**P2, same round:** this record documented `diffBaseRef(base_branch, base_sha, merge_mode)`
— the **pre-fix** signature, replaced in round six. The document was written when the claim
was true and nothing re-read it when the code moved. Corrected to `origin_base_resolves`.

### Round six: a regression from round five, and the title one notch wide again

**The regression.** Round five made `codex-review.sh` prefer `origin/<x>` over a stale local
branch `<x>`. It promoted **by string shape** — "does `origin/${BASE_REF}` resolve?" — and its own
comment claimed a tag would be kept verbatim. It would not have been: with a tag `release` at one
commit and a remote branch `origin/release` at another, `codex-review.sh release` reviewed the
wrong commit, silently. The wrapper takes a general `[base-ref]`, so that is a real input; the new
wrapper tests only exercised the already-resolved ref trident passes, so nothing covered it.

Fixed by promoting **by kind**: `refs/heads/<x>` must resolve (the only available evidence that
`<x>` names a branch), `refs/tags/<x>` must not (ambiguity is not guessed at), and
`refs/remotes/origin/<x>` must resolve. `trident/codex-review-base-ref.test.ts` builds one
repository holding both collisions and pins the COMMIT each argument lands on; mutating back to the
string-shaped promotion reddens two tests.

**This is the second over-reaching generalisation on this branch, and they share a shape:** the
merge-mode fallback inferred *"no remote"* from *"merges locally"*; the promotion inferred
*"branch"* from *"resolves"*. Both substituted an available signal for the one that mattered.

**And the title was still a notch wide.** Round five's retitle promised the bare name "only when
the repository has no remote"; the code tests whether **one ref currently resolves**. A repository
can have `origin` configured while `refs/remotes/origin/<base>` is missing, deleted or never
fetched — an ordinary state — and there the code takes the bare name while the spec said it should
not. The no-remote fixture stepped over exactly that gap by removing the remote *and* its refs.

Narrowed to the probe in all five places (title, normative section, gate header, `merge.ts`,
`inner-workflow.mjs`), and a `CONFIGURED ORIGIN, MISSING BASE REF` fixture now covers the gap —
asserting the remote is still configured, so it cannot quietly decay into a second no-remote case.
No fetch was added: a build worktree should not reach the network to answer a diff-base question.

**The discipline that finally worked, applied before the push rather than after the gate:** for the
sentence as newly written, name the state that would falsify it and go look for that state *in the
code*. Doing that turned up three more conditions, each small and each enough to make it wrong — an
option-shaped name (refused without probing), an empty name (returned ahead of the flag entirely),
and `codex-review.sh`'s stricter standalone promotion. All three are now in the spec item.

Six rounds, six overclaims, each narrower than the last. The pattern was never carelessness:
**narrowing a claim is itself a claim, and it gets made with the same optimism as the original.**

### The headline claim was the title, and the audit walked past it

A fifth round found the largest overclaim of the five, in the one place the audit had not
looked: **the spec item's title**. It promised every base resolves to a pinned sha or
`origin/<base>`; the body then said "a bare local branch name is **never** the left-hand
side of a rev-range" and "**no code path** composes a rev-range from a base branch NAME" —
while two sections further down *requiring* the bare name in local mode. Two absolutes and
their own exception in one document.

It survived because a title reads as a name rather than as an assertion, and it is exactly
the sentence someone quotes when deciding whether a problem is solved. **The claim most
likely to be wrong is the one nobody files as a claim.**

And the contradiction was not only editorial — the defect was still live under it:

* `diffBase` keyed its fallback on the MERGE MODE, handing local mode the bare name
  outright. `merge_mode: 'local'` means the outer loop merges locally; it says nothing
  about whether the repository has a remote — and this file's own `branchLogBase` comment
  had said since before #546 that "a plain local base branch may be stale in NON-PR mode".
* Measured in the review-diff fixture: local mode against a `main` four commits behind
  `origin/main` produced **five files where the branch changed one** — the same number the
  pr-mode test proves, in the same fixture, eight lines away.
* The local-mode test could not see it because it asserted the **command shape**
  (`toContain("git diff 'main'..")`) and never the files. Proxy versus claim, surviving in
  the last place the defect lived.

Fixed by making the unpinned arm a **shell substitution**: ask the repository whether
`refs/remotes/origin/<base>` resolves, prefer it when it does, and fall back to the bare
name only when it does not — the same in both modes, decided per repository at the moment
the range is built rather than inferred from the merge mode. That is the branch's own
principle applied once more: one fewer place where a base branch name can be a range
operand at all. Local mode now yields one file; mutating the fallback back to the bare name
reddens the test, and a separate no-remote fixture proves the fallback is still reached.

### Three claims outran their instrument, and the audit is the lesson

The review gate found the same habit three times on this branch: a claim stated
universally, delivered by a bounded instrument. **"every rev-range"** from a pattern match
over source text; **"taint follows aliases to a fixpoint"** asserted with `base`/`b`/`c`,
so false for any `$`-containing name; and **"fixpoint"** from a loop capped at four
rounds — invisible in dependency order, because a forward chain of any length propagates
in one scan, which is exactly how the first alias test was written.

Fixing those one at a time meant the next gate found the next one, so the fourth round was
spent auditing every claim in the gate and the spec item against the code that delivers
it. That turned up three more, all confirmed by measurement rather than by reading:

| claim | status | what was true |
|---|---|---|
| "`diffBase`/`diffBaseRef()` are the **only producers of a range base**" | **false** | four sha-valued producers reach a range operand directly; the true claim is "the only things that turn a base branch NAME into one" |
| "**no variable holding a base branch name exists in their scope**" (both wrappers) | **false for one** | `codex-review.sh`'s argv default *is* the literal `main`; only `codex-build.sh` reaches the strong property |
| "`[^{}]*` … **every real site** is one call or one ternary deep" | **overstated** | a nested interpolation escapes the class entirely — measured at zero hits; now listed as a blind spot |

A fourth, smaller one went the other way: the loop's early-exit break was described as the
termination guarantee. Deleting it leaves the suite green and takes the file's tests from
0.9s to 4.6s — it is a performance guard, and `bindingCount` is what terminates.

**The rule this leaves behind:** a word asserting completeness or termination — *every*,
*all*, *any*, *always*, *never*, *only*, *fixpoint* — is a universal quantifier over an
instrument that is almost certainly bounded. Name the lines that deliver it and the input
that would falsify it, or narrow it before writing it down.

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
