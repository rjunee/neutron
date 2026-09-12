## 2026-09-12 — Rev-range base: pinned sha, else the ref verified, never a shorthand (#546)

`git diff main..<head>` in a shared build checkout diffs against whatever
`refs/heads/main` happens to hold, and that ref is only as fresh as the last time
something on the box pulled it. Every commit merged into the base since then is
presented as this branch's own work. Git exits 0, the extra files are real code, and
nothing downstream can tell the inflated diff from a genuinely large one.

> **RECONCILED AGAINST THE FINAL CODE, AND THE SWEEP RUNS LAST** — first in round nine,
> after three separate rounds found this file lagging a correction (a stale `diffBaseRef`
> signature, a superseded title, a superseded fallback condition), and re-run as the final
> act of every round since. Each earlier round fixed the artefact its finding pointed at, and
> this file was never the artefact pointed at.
>
> **The "reconciled" claim is the expensive part, so it has a rule now.** Round sixteen found
> three final-tree citations wrong by a uniform six lines — they had been derived once and
> carried forward while this banner said they had not, and a claim of reconciliation is
> exactly what stops the next reader checking. Every final-tree `file:line` here is
> re-derived BY CONTENT (grep the construct, take the line the tree reports) at the end of the
> round that last touched the code, never by adjusting an old number: a uniform offset is a
> hypothesis, and these files take unrelated edits. A round that adds or deletes lines
> invalidates a line number exactly as it invalidates a behavioural claim.
>
> Citations labelled *"on the tree this branch was cut from"*, *"as filed"* or *"round nine
> measured"* are historical by design and are NOT re-derived; they were verified once against
> that tree (`git show 0db9e922:trident/inner-workflow.mjs`) and are kept because the drift
> they record is part of the story.
>
> The narrative sections below are kept in round order because the sequence is the point;
> where a round's text asserted something a later round replaced, the correction is marked
> inline rather than silently rewritten.

Measured twice on this repo: Argus r4 / run `25b2327d` — local `main` 8 merges behind
`origin/main`, a 15,154-line / ~100-file review artifact for a branch whose own work was
20 files / 1,738 lines, and a reviewer who vetoed the branch over bugs in files it does
not touch; and #546 — reviewers reading 149 files where the branch changed 30.

### It had already been fixed twice, as a call site

`probeCiBase` (`trident/inner-workflow.mjs:5247` on the tree this branch was cut from; `:5453` on this branch's final tree — this record outlives the branch, so both are given, each with the tree it was measured on, because every round that edits this file moves them: round twelve moved this one by 39 lines)
and the plan probe's `branchLogBase` (`:2229`) were already resolving the base, while the
resume diff (`:5078`) and the forge contract's reviewer diff (`:1426`) in the same file
still composed the bare name. The issue's line numbers matched the box's *stale* local
`main`, four commits behind `origin/main`; on `origin/main` they are `:5078` (issue said
`:4955`), `:1426` (`:1380`) and `:5247` (`:5123`).

So the unit of this change is the rule.

### What actually guarantees the invariant

The invariant is **a base branch NAME reaches a rev-range operand only where no
remote-tracking ref for it exists**, and it is carried by the STRUCTURE, not by the gate.

> **This sentence read "no code path composes a rev-range from a base branch NAME" until
> round twelve,** with item 0 immediately below it permitting exactly that. Two absolutes and
> their own exception had already been corrected in the title and in the spec item; the
> headline invariant of this record, a shell comment in `codex-build.sh` and an
> "unconstructable" claim below survived, because each earlier round fixed the artefact its
> finding pointed at. The narrow sentence is the true one and is now stated everywhere.

Stated in the order of how much it proves:

0. **`refs/heads/<base>` is reached whenever `refs/remotes/origin/<base>` does not resolve to
   a commit, and a base that resolves to NEITHER is refused.** `diffBase`'s unpinned arm asks
   git, in either merge mode; where the answer is no, the LOCAL BRANCH NAMED IN FULL is the
   best available base and there is no better one without a fetch, which is deliberately not
   attempted. That case is legitimate, tested by two fixtures (no remote at all, and a
   configured origin with the base ref deleted). Where neither ref resolves, `diffBaseRef`
   throws and the workflow composes `refs/heads/<base>` anyway for git to reject.

   > **This item read "the bare name is reached whenever …" through round eighteen**, and the
   > condition it argued about — "not only with no remote", the round-six framing — was the
   > right correction to the wrong half. The NAME was the problem: a bare word is not inert,
   > and a same-named tag answers to it (round nineteen). Kept here because the narrowing of
   > the CONDITION is still the load-bearing part; the ANSWER it names is superseded.
1. **`codex-build.sh` cannot CHOOSE a base — which is not the same as nothing bad reaching
   its range, and this item once claimed the second.** It takes the base as argv `$2`
   (`BASE_DIFF_REF="${2:-}"`), its default is EMPTY, and an empty value skips the
   last-resort diff entirely, so the wrapper never invents or improves a base. **As of round
   nineteen the trident path hands it only a sha or a fully qualified ref** — `diffBase` has
   no arm that composes a bare name. What the wrapper does with whatever it IS handed is
   still measured through the shipped line in `trident/codex-wrapper-range-line.test.ts`,
   because the wrapper takes argv from anyone: with no remote a bare `main` yields the
   branch's own single file, and handed a stale `main` where `origin/main` is 4
   commits ahead it yields five files — the wrapper is incapable of repairing a bad base,
   which is exactly why the composing side must not hand it one. **If a claim says something
   cannot be built, name the mechanism that prevents it**; the mechanism here prevents a
   choice, not an arrival, and the word "unconstructable" is worth distrusting for that
   reason — another lane retracted the same word on the same day for the same shape of
   error.
   **`codex-review.sh` is weaker still, and an earlier draft of this record overstated it by
   lumping the two together.** Its default is the literal `main`
   (`BASE_REF="${1:-main}"`) — a bare base branch name, in scope — which it QUALIFIES:
   `refs/remotes/origin/main` when that ref resolves, else `refs/heads/main`, refusing an
   ambiguous or tag-only argument. (Through round eighteen it "left bare when it does not",
   which is the arm round nineteen removed.) So: a sha or a qualified ref on the trident
   path, and a qualified local ref in a standalone run against a repo with no
   `origin/<base>`. Its own range line has no opinion either, which
   the same new test measures: the promotion above it is load-bearing precisely because the
   range line is not.
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
  `refs/remotes/origin/<base>` whenever that ref resolves to a commit — in EITHER merge mode —
  else `refs/heads/<base>`, which it composes whether or not THAT resolves so git rejects it
  out loud. No arm composes a bare name. (Two corrections live here: it said "in pr mode, else
  the bare name in local mode" until round twelve — the merge-mode fallback round six removed,
  surviving in the record's own inventory of the thing that replaced it — and it said "else the
  bare name" until round nineteen.) It also refuses an empty, whitespace-padded or
  option-shaped name.
- `trident/merge.ts` — `diffBaseRef(base_branch, base_sha, ref_resolves)` where the third
  argument is a **thunk** `(ref: string) => Promise<boolean>`, invoked only on the arms that
  need it — once for `refs/remotes/origin/<base>`, then for `refs/heads/<base>` — next to
  `detectBaseBranch` which produces the name it refuses to let through. (It took no argument
  and asked only about origin until round eighteen; the signature is in the round-eighteen
  section.) Every exit is the pin, a qualified ref, or a throw. It was
  a plain `boolean` and "pure" for most of this branch; round eleven found that every caller
  then wrote `await originBaseResolves(…)` in the argument position, which JavaScript
  evaluates *before* the pin can be returned — so the ordering had to become a property of
  the signature. See the round-eleven section.
  Used at every `resolveBase()`-fed range in `trident/orchestrator.ts`.
- the shell wrappers compose **no** base at all: `trident/codex-build.sh` and
  `trident/codex-review.sh` receive whatever the composing side resolved as argv — from
  trident, a sha or a fully qualified ref, never a bare name (round nineteen);
  `trident/codex-wrapper-range-line.test.ts` runs both shipped range lines to measure what they
  do with whatever they are handed, because argv comes from anyone. `BASE_BRANCH` became
  `BASE_DIFF_REF` so the name stops claiming a branch; `codex-review.sh` independently
  qualifies a bare argument for standalone use — `refs/remotes/origin/<x>` when that resolves,
  else `refs/heads/<x>` — and REFUSES an ambiguous or tag-only one.

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
`scripts/ci/diff-base-check.test.ts:176` as filed (the same construct is `:261` on the final tree) — *"The escape sequence `\$` is equivalent to
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

### Round twenty-two: a review that cannot see approves everything

**The first behavioural finding in six rounds, and the worst one.** `codex-review.sh` left an
unresolvable argument unchanged, then read its diff as `FULL_DIFF=$(git diff … 2>/dev/null)`
with no status check — under `set -uo pipefail`, **not** `set -e`. Measured:

    set -uo pipefail; FULL_DIFF=$(git diff --end-of-options no-such-branch..HEAD 2>/dev/null)
    → continued:[]  exit=0

So a standalone review against a base that names nothing ran codex on an EMPTY diff, found
nothing, and returned clean. **A REVIEW THAT CANNOT SEE APPROVES EVERYTHING** — an empty diff
is indistinguishable from a diff with no findings. It is the same shape as a gate whose disk
fills up returning empty output with no error: a check that could not run reads exactly like a
check that passed, and both fail in the safe-looking direction.

**`2>/dev/null` on a command whose failure IS the signal is the specific mistake.** git's
stderr was the only thing that knew. Two guards now:

* the base-ref block's result must name a commit (`rev-parse --verify`), or exit 3 — placed
  beside the DIFF rather than beside the qualification chain, because up there it preempted
  the documented graceful exit 10/11 for "no codex configured";
* the diff captures its own status, with stderr to a file so a warning can never be mistaken
  for diff text; a failure is exit 3, quoting what git said.

Both refusals carry `CODEX_REVIEW_EMPTY_DIFF`, which is the marker the workflow already greps
for — this IS that case, caught earlier, where the cause can still be named.

**And a test ENSHRINED it**: `'no-such-branch'` sat in the "kept VERBATIM" list. Its extractor
stopped at the first `fi`, so whatever refused an unresolvable base was never in the slice —
**an extraction boundary is a claim about what is under test**, and that one was quietly
narrower than the behaviour it was named for. Fixed, and the new boundary is asserted to
contain the guard.

The new guard also caught **my own fixture** supplying an unresolvable `HEAD~1` (the seed
leaves HEAD at the root commit) while the old assertion called it "kept verbatim" — the
fixture-supplies-the-claim pattern again, this time found by the code rather than by review.

**TESTS ARE DOCUMENTS TOO, and they are the ones that assert.** Three sweeps have each widened
the domain — the documents I was named, then the tree by phrase, then by the thing — and each
time the next instalment was the domain rather than the terms. This one found four stale test
comments and, worse, a bridge test INJECTING `'origin/main'` and asserting it flowed through
while its comment described it as "the base `diffBase` CHOSE". Production stopped producing
shorthands in round seventeen. The value is now production-shaped, and the comment says plainly
that the test supplies it and measures the SPLICE, not the resolution.

Verified for the extended domain: every asserted base value in the suite — argv, composed
shell word, `resolvedBase`, `promote` — is a sha or a fully qualified ref. The only bare `main`
left in an assertion is `detectBaseBranch`'s OUTPUT, which is the binding's input, not its
answer.

### Round twenty-one: a claim can be restated in words the grep does not contain

Round twenty's sweep read 137 hits and changed 22, and still missed three live sites — because
its terms were about the WORD: `bare name`, `shorthand`, `else the name`. The survivors said the
same thing without any of them:

* "leaves the argument bare **without** `origin/<base>`" (the gate's account of the wrapper);
* "demoted … to shorthand `origin/main`" (a normative acceptance criterion);
* a TEST NAME asserting the fallback — `'NO REMOTE: the bare name is what arrives'` — inside a
  file whose own NAME was `codex-wrapper-bare-base.test.ts`.

**A claim can be restated in words the grep does not contain.** So the closing sweep was run by
THE THING rather than the phrase: every prose mention of `diffBase`/`diffBaseRef`/`BASE_REF`
(121, all read) and every prose mention of a shorthand `origin/<base>` in the eight files that
carry the contract. Five more live claims fell out that no word list would have caught, each
naming the shorthand rather than the bare name: `git-range.ts`'s parameter doc,
`orchestrator.ts`'s dispatch comment, two of `inner-workflow.mjs`'s order bullets, and
`lint.sh`'s wrapper summary.

**The file name was itself a survivor**, and renaming it is the point: `codex-wrapper-bare-base`
asserted the deleted contract in the one place nobody re-reads. It is now
`codex-wrapper-range-line.test.ts`, which says what it actually does.

**And what it actually does is worth stating, because it is why the stale claims inside it read
as true.** It drives the wrappers' shipped range lines with values THE TEST SUPPLIES. **A test
that supplies the value it claims the system produces is measuring the fixture, not the
system** — the same family as an instrument that enumerates by syntax and a matrix that holds an
axis constant. Nothing in that file shows what `diffBase` composes; the real-git fixture and the
parity table do that, and the file now says so in its header.

### Round twenty: the sweep's DENOMINATOR was "documents I was pointed at"

Round nineteen changed the contract; the reconciliation that followed it reached the spec item
and the as-built — the two documents named in the finding — and stopped there. **Five live
operational comments still described the removed fallback**, including the gate's own stated
INVARIANT, `lint.sh`'s summary of it, both wrappers' argv contracts, and a line sitting beside
production orchestration. Those are not narrative: they govern a security-sensitive boundary,
and the root `AGENTS.md` rule is explicit that a change narrowing a guard must fix every
document asserting the old rule **in the same change**.

**This is round eighteen's lesson with the denominator wrong again.** The fallback inherits the
defect the primary path was fixed for; a sweep inherits the blind spot of its DOMAIN. "The
documents I was pointed at" is a list, and a list cannot be complete about a claim that lives
wherever anyone happened to restate it.

So this one was run as a grep over the whole tree — `bare name`, `bare NAME`, `shorthand`,
`else the name`, `or a bare` — and every hit READ rather than pattern-replaced, because some
are correctly historical:

| | |
|---|---|
| grep hits tree-wide | **293** across 97 files |
| hits in files that touch the #546 contract, all read | **137** |
| passages changed | **22**, across 10 files |
| left as-is | the rest — unrelated uses (`env`'s bare binary name), the defect's own description, and retractions that already name the round they were true in |

The terminating condition was stated before the work and verified by grep after it: **no live
comment or doc in the tree describes a bare or unqualified name as a value `diffBaseRef` or the
workflow can produce.** Every survivor is an explicit retraction, a description of the defect,
or about something else entirely.

### Round nineteen: the sequence ends when the last fallback stops returning a value

The tag-only case. `diffBaseRef` probed remote, then heads, and on neither returned the bare
name — which passes both negative probes and then **resolves as a TAG**. Not hypothetical:
**this repository holds a live instance.** `archive/agent-replies-prior-iter-3b35767` exists as
`refs/tags/...` and as no branch, so the bare word answered to it, exit 0, and a review diff
would have been computed against a base nobody chose. Measured on git 2.43:

    git diff --name-only --end-of-options 'archive/thing..HEAD'            → exit 0, a diff
    git diff --name-only --end-of-options 'refs/heads/archive/thing..HEAD' → FATAL, exit 128

So "the bare name is fine because git errors loudly on an unknown revision" was false in the
same way "the caller's diff will fail loudly" was false about an empty base, two rounds
earlier: **a bare word is not inert — git resolves it against every namespace.**

**THREE ROUNDS, THREE POSITIONS OF ONE DEFECT** — the qualified path (seventeen), the
`refs/heads` fallback (eighteen), the no-ref fallback (nineteen). Each fix was correct and each
left the next-worse path holding the original behaviour. The sharper form of round eighteen's
lesson: **a fallback inherits the defect the primary path was fixed for unless it is fixed in
the same change — and the sequence terminates only when the last fallback stops returning a
value at all.**

So it does. `diffBaseRef` now throws `TridentUnresolvableBaseError` instead of handing back a
word; every one of its returns is a 40-hex pin or a fully qualified ref. The `.mjs` composes
`refs/heads/<base>` unconditionally on the second arm — **the one place the two implementations
cannot agree**, because a shell substitution is composed in one process and evaluated in
another, so it cannot refuse; it can only name a ref the other process rejects. Both halves are
asserted, and the composed word is measured to be one git actually refuses. `codex-review.sh`
refuses a bare tag-only argument (exit 3, its DEFERRED), while an explicit `refs/tags/<x>` is
still accepted — the refusal is of the AMBIGUITY, not of the intent.

**The terminating condition is now checkable by a test rather than by a promise.** "NO RETURN
STATEMENT HANDS BACK AN UNQUALIFIED NAME" reads `diffBaseRef`'s own source, extracts every
`return`/`throw`, and requires each to be the pin, a qualified ref, or a refusal — and asserts
that `return name` appears in no spelling. That is the condition stated as something a reader
can confirm before pushing, not something review confirms afterwards.

Mutations: restoring the bare return reds 4; restoring the bare `printf` reds 6; letting the
wrapper keep a tag-only name reds 1; and hiding a bare `return name` inside a single-line
`if (…) return …` reds 3, including the structural test itself.

**That last mutation exists because the structural test had the code's own blind spot.** Its
first version anchored the pattern at the start of a line, so it never saw the two returns
written as `if (await ref_resolves(…)) return \`refs/…\`` — it examined five statements and
declared seven correct, and would have walked past `if (x) return name`. Widened to match a
`return` anywhere on the line and to pin the COUNT at 7, so a new arm cannot slip in unexamined.

**AN INSTRUMENT THAT ENUMERATES BY SYNTAX INHERITS THE BLIND SPOTS OF ITS PATTERN**, and this
is the third instrument on this PR to fail that way — the coverage scanner keyed to one
identifier spelling, the same scanner examining one range per physical line, and now a
structural check anchored at line start. Each was written to enforce a rule the code had just
broken, and each encoded the same assumption the code had broken it with. The durable answers
are the two this branch reached by other means: **prevent the shape instead of enumerating it**
(`gitRangeArgv`, and a binding with no bare-name exit), and **pin a COUNT alongside the
predicate**, so a pattern that stops matching fails instead of going quiet.

**And one more fixture that could not fail for its stated reason.** The ambiguous branch/tag
case seeded `refs/heads/release` and `refs/tags/release` at the SAME commit and then asserted
both equalled it — so the comment claiming "the two refs disagree about the commit" was false,
and the fixture could not show that git's choice changes the reviewed commit, which is the only
reason the refusal exists. Now seeded at different commits, with the bare name measured
resolving to the TAG while the branch the operator named sits elsewhere. **A test whose two arms
are the same value cannot fail for the reason it exists** — the same shape as a matrix holding
an axis constant, one level down.

### Round eighteen: the degraded path is the one that runs when things are already wrong

Round seventeen qualified the RESOLVING arm and left the FALLBACK unqualified — `diffBaseRef`
returned the bare `name`, the workflow printed the bare `${baseBranch}`, and
`codex-review.sh` deliberately left an ambiguous branch/tag argument alone. The same defect,
in the arm that is reached precisely when something is already unusual.

**That is the general shape and it is worth stating plainly: a fallback executes in worse
conditions than the primary path, so it deserves the same rigour, not less.** A fresh clone, a
missing remote, a detached CI checkout — the worlds that reach a fallback are the worlds where
a stray tag is most likely to exist and least likely to be noticed. `refs/heads/main` and
`refs/tags/main` coexist happily, git prefers the tag, and `main..HEAD` then resolves to it —
exit 0, warning on a stderr both wrappers send to `/dev/null`.

Three fixes, one rule — **name the ref you verified, at every arm**:

| site | was | is |
|---|---|---|
| `diffBaseRef` | `name` | `refs/heads/<name>` when it resolves, `name` only when neither ref does |
| the `.mjs` substitution | `printf %s '<base>'` | a THREE-arm word: remote → `refs/heads/` → bare |
| `codex-review.sh` | ambiguous name passed through; a branch with no remote "kept" | ambiguous **REFUSED** (exit 3, its DEFERRED); branch-only → `refs/heads/<x>` |

**The probe had to grow a parameter for this.** `originBaseResolves(host, repo, base)` composed
the origin ref itself, so the second question could not be asked through it at all; it is now
`refResolves(host, repo, ref)` and `diffBaseRef` asks it twice, in order, still never at all
when the pin is valid. The order is asserted as the SEQUENCE of refs asked
(`['refs/remotes/origin/main', 'refs/heads/main']`) rather than as a call count — "exactly one
call" stopped being the right shape the moment the fallback gained its own question, and a
count would have hidden which question was asked.

**Leaving the ambiguous argument alone was also a guess.** The wrapper refused to promote it on
the reasoning that promotion would guess — but not promoting hands the guess to git, which
picks the tag. Exit 3 is this wrapper's DEFERRED ("configured, but the review could not run"),
which is never a silent APPROVE, and the message names both refs and the way out.

**Coverage**, each pinning the ref NAMED rather than a file count, because in the collision the
two names can agree on the commit: a real-git fallback fixture with `refs/heads/main` and
`refs/tags/main` both present; a parity row for origin-missing/branch-present on both
implementations; a new third row for the world where NEITHER resolves; and a wrapper fixture
where a tag planted AFTER the qualification changes nothing, while the bare word it used to
return now resolves to a different commit. Mutations: dropping the TS fallback arm reds 3,
dropping the `.mjs` arm reds 4, letting the wrapper pass an ambiguous name through reds 1.

**Unexplained, and noted rather than buried:** `trident/publish-rebase-realgit.test.ts`'s
blank-line-context case failed ONCE during round seventeen's full-suite run, and five cases in
`trident/mutation-prover-realgit.test.ts` failed ONCE during round twenty's — each passing in
isolation and on the immediate re-run (4888/0). Both are REAL-GIT suites this branch does not
touch, and both flaked only under a full-suite run on a shared box, which points at contention
rather than at either file. Not chased here, and not dressed up: **"it passed on re-run" is a
weaker claim than it sounds**, and two independent instances in one session is the kind of
thing the next person deserves to find written down rather than rediscover.

### Round seventeen: the resolution was correct and then discarded at the return statement

`diffBaseRef` verified `refs/remotes/origin/<name>^{commit}` and returned the shorthand
`origin/<name>`. The workflow substitution rev-parsed the qualified ref and `printf`'d the
short one. `codex-review.sh` verified qualified and stored short. Three places, one shape:
**a value verified in one form and returned in another has not been verified**, and the gap
between the two forms is exactly where the ambiguity lives.

Git permits a tag named `origin/main`, and its disambiguation order prefers `refs/tags/` over
`refs/remotes/`. MEASURED on git 2.43 with both refs present and pointing at different commits:

    git diff --name-only origin/main..HEAD               → warning on stderr, EXIT 0, 2 files
    git rev-list --count origin/main..HEAD               → warning on stderr, EXIT 0, "2"
    git diff --name-only refs/remotes/origin/main..HEAD  → exit 0, 1 file

**It does not fail — it silently resolves to the TAG and inflates the diff**, which is #546's
own defect arriving through the return form at the last mile of the PR that fixes it. The
warning goes to stderr, and both wrappers send stderr to `/dev/null`.

All four sites now return the qualified ref: `diffBaseRef`, the `.mjs` substitution,
`codex-review.sh`'s promotion, and `branchLogBase` — the last of which never verified anything
(it is unconditional by design) but carried the same ambiguity for free, and an unresolvable
`refs/remotes/origin/<base>` degrades its `|| true` log exactly as an unresolvable
`origin/<base>` did.

**The collision tests had the wrong end of the name.** `codex-review-base-ref.test.ts` covered
a tag named `release` — a collision against the ARGUMENT. The collision that mattered here is
against the RETURNED form, `refs/tags/origin/main`, and nothing covered it. Both ends are
covered now, each pinning the COMMIT: a workflow-level fixture where the tag sits at the stale
base (shorthand → five files, qualified → one) and a wrapper-level one where the promoted ref
must resolve to the remote tip with the tag present. Mutations: restoring the shorthand in the
TS binding reds 3, in the `.mjs` reds 4 including the new tag test, in the wrapper reds 5.

**And the sweep earned its place the same round it was written into the banner**: this
round's comments moved `probeCiBase` from `:5416` to `:5428` and the resume range from
`:5249` to `:5261`. Running the sweep LAST caught both — six lines of new comment is all it
takes, and the round that writes the comment is the round that invalidates the number.

**Eighteen assertions pinned the old value and were repointed with the new one stated as a
value** — the substitution's `printf`, the parity table, the realgit resolutions, the plan
probe, the wrapper promotion, the cross-model argv. And `OUT_OF_REACH`'s six `file:line`
entries moved with the comments this round added; the test caught that itself, which is the
whole argument for citations that live inside assertions.

### Round sixteen: a claim of reconciliation is what stops the next reader checking

Three final-tree citations in this record were wrong by a **uniform six lines**, in a document
whose own banner said its final-tree locations had been reconciled. The uniformity was the
tell: something earlier in each file had grown by six lines after the numbers were taken,
which means they were **derived once and carried forward**, not re-derived. That is worse than
an unreconciled record — the assertion of reconciliation is precisely what stops the next
reader checking.

Swept all **22** `file:line` citations across the record and the spec item, by content rather
than by adjusting each number by six (a uniform offset is a hypothesis, and both files had
taken unrelated edits). **Five had moved**, one more than the three reported:

| citation | was | is | how it was re-derived |
|---|---|---|---|
| `probeCiBase`, final tree | `:5410` | **`:5416`** | `grep -n 'async function probeCiBase'` |
| the wrapper range (as-built) | `codex-build.sh:809` | **`:819`** | `grep -nF 'git diff --end-of-options "${BASE_DIFF_REF}..HEAD"'` |
| the wrapper range (spec item) | `codex-build.sh:809` | **`:819`** | same |

(Those two rows record what round sixteen measured. Both moved again when later rounds edited
`codex-build.sh`; the live citations are re-derived at the end of every round, and the banner
above says so — a table of past corrections is not a source of current line numbers.)
| the mutated resume range | `inner-workflow.mjs:5243` | **`:5249`** | `grep -nF` on the composed `cmd` |
| the CodeQL escape, "as merged" | `:260` | **`:261`**, and relabelled | `grep -n '\${'` for the construct |

The other **17** are historical by design — *"on the tree this branch was cut from"*, *"as
filed"*, *"round nine measured"* — and every one of them verifies against the tree it names:
`git show 0db9e922:trident/inner-workflow.mjs` puts the resume diff at `:5078`, the forge
contract at `:1426`, `branchLogBase` at `:2229`, the planner hint at `:2160` and
`probeCiBase`'s pinned-ref line at `:5247`, exactly as written.

The banner now says the sweep runs LAST, because that is the only time the claim can be true.

**And one citation shape that cannot drift**: `diff-base-option-shaped.test.ts`'s
`OUT_OF_REACH` list carries the six surviving ranges as `file:line` entries and then asserts
them against what the scan actually found. **A `file:line` in an executable assertion is
re-derived on every run; one in prose is re-derived when someone remembers.** That is the
durable form of this whole class, and round seventeen demonstrated it within one round: the
comments added to `inner-workflow.mjs` moved four of those six lines, and the test failed
immediately and named them — while the five prose citations of the round before had drifted
silently for six rounds.

### Round sixteen (b): the instrument under suspicion got fixed; the one written beside it did not

The unpinned half of the ordering criterion was a fixture shortcut.
`orchestrator.test.ts`'s "A PINNED dispatch issues NO origin-ref probe" asserted the absence
correctly and then "complemented" it by calling `originBaseResolves` **directly**. That is a
positive control for the ARGV SHAPE — worth keeping, and kept — but it reaches past the
orchestrator to the helper it wants to observe, so it could not have failed on an orchestrator
that skips the probe, issues it twice, or computes it eagerly, which is the entire content of
the criterion it was standing in for.

Replaced with a real dispatch: a **local-mode** run whose `rev-parse --verify
refs/heads/main^{commit}` FAILS, which is the arm where `orchestrator.ts` leaves `base_sha`
null. The pin's absence is asserted (`pin: null`) rather than assumed — the first draft used
an empty-but-ok answer, which the harness deliberately overrides for `^{commit}` probes, so
the run quietly carried a pin and the test would have been a second copy of the pinned case.
One tick, so "exactly one" is a claim about the DISPATCH and not a tally over a whole run.
Mutations in both directions, because both are regressions the criterion names: dropping
`diffBaseRef` from the dispatch (ZERO) reds it; making the binding invoke the thunk twice
(TWO) reds it.

**The lesson is where it was found.** This survived a round spent explicitly hunting
instrument defects — three were found in the scanner and closed structurally, and the test
written alongside that work took the shortcut. **The instrument you are auditing is rarely the
one that fails next.** Suspicion is aimed, and what it is aimed at gets the careful treatment;
everything written beside it inherits the attention that was left over.

### Round fifteen: three rounds on one instrument means the property should be prevented

The scan had a third defect — `RANGE.exec(line)` ran **once per physical line**
(`diff-base-option-shaped.test.ts`), so a shielded command followed by an unshielded one on
the same line reported clean. Three defects, three mechanisms, in the same instrument:

| # | mechanism | what it could not see |
|---|---|---|
| 1 | keyed to one identifier SPELLING (`${baseRef}..`) | `computeDiffLineCount`'s `base_ref` — which shipped unshielded — and `mutation-prover.ts`'s three-dot argv |
| 2 | a TWELVE-LINE proximity window, reading the round's own `--end-of-options` comments as evidence | any command within twelve lines of a shielded one; every mutation passed |
| 3 | one `exec` per line | a second command sharing a physical line |

**So the fourth fix was not a wider scanner.** The eleven TypeScript ranges now go through
`gitRangeArgv` (`trident/git-range.ts`), whose signature has **no parameter for the marker** —
`-c` settings, subcommand, flags, base, head, dots, pathspec, and the marker welded between
the last flag and the operand. An unshielded range is not something a call site must remember
not to write; it is something it cannot express. The scanned population fell from **21 to 10**,
`orchestrator.ts`/`merge.ts`/`mutation-prover.ts` hold **zero** ranges, and every survivor is
somewhere a TypeScript helper cannot reach: four commands inside PROMPT strings and two lines
of shell, each enumerated by `file:line` with its reason.

The iteration defect is fixed too (`matchAll`, with a two-commands-on-one-line control),
because the scan still carries the six survivors. But it now asserts two enumerable claims
instead of a universal one over an open population.

**Mutations, all measured:** single-`exec` reds 2 tests; a raw unshielded argv put back in
`orchestrator.ts` reds 2 and names the site; **removing the marker from the helper reds 19
tests**, because nineteen existing assertions pin those argv arrays — the prevention and the
pins reinforce each other.

**And a count that was wrong while the test was right.** The prose said "21 hits, 18 shielded,
3 notes plus one shell label" — 22 from a population of 21. Re-derived: 17 shielded COMMANDS
plus 4 argued non-invocations, the fourth being `codex-review.sh`'s `DIFF_SRC` label, which is
attributed to the command above it and therefore *looked* shielded while not being a consumer
at all. The prose had counted it twice. Both numbers were re-derived from the tree rather than
one adjusted to match the other, because the two failure modes differ: a wrong number is a
typo, a wrong population is a coverage gap.

**The generalisable lesson, and it is the lane's own, one level up.** *A check can only refuse
what it can still see.* Three rounds spent making one instrument adequate is the signal that
the property is being measured where it should be prevented — the same shape as a lock opened
`O_TRUNC` and then validated, where no ordering of checks can fix a truncation that already
happened at open.

### Round fourteen: the sweep turned on the instruments — and both were wrong

Round thirteen read 467 added lines of prose for absolutes. **The absolute that was actually
load-bearing lived in a test's search string**, and no amount of reading prose would have
found it. Two P1s, one shape: *a completeness claim is only as wide as the instrument that
checks it.*

**1 · An exported consumer was still option-injectable.** `computeDiffLineCount`
(`orchestrator.ts`) passed `${base_ref}..HEAD` with no `--end-of-options`, so an operand of
`--output=/tmp/pwn` made git write that file and exit 0 — the behaviour this branch's own
real-git tests measure for the sites it *did* shield. The spec's "every consumer carries the
marker" was therefore false at that head.

**Why it survived thirteen rounds of review: the coverage test searched for `${baseRef}` and
pinned four call sites.** This consumer spells the same value `base_ref`.
`mutation-prover.ts`'s blast-radius range escaped twice over — a THREE-dot range, spread
across its own argv lines, so neither half of the pattern reached it. A coverage test keyed
to one spelling of an identifier proves nothing about the others, and would have missed the
next consumer for whatever third spelling it used.

Fixed by shielding every remaining range — `computeDiffLineCount`, the publish fork-point
diff, the `seenPin` unseen-files diff, the launch `base_behind` count, the stranded ahead
count, `merge.ts`'s `commitsTouching`, `mutation-prover.ts`'s three-dot range and the
planner's branch-log prompt — so the rule has **no exceptions left to reason about**: 18
shielded ranges, 3 operator-facing notes and 1 shell label, all enumerated. And by replacing
the instrument with one keyed to BEHAVIOUR: every hit of `/\}\.\.|\.\.\$\{/` — an
interpolation adjacent to the range operator, which cannot see identifier names at all —
across seven shipped modules, with per-file counts pinned and every non-invocation argued.
Controls: a planted consumer named `whicheverNameIFeelLike` (a spelling that appears nowhere
in the tree) reds the test; removing it goes clean again.

**Then the replacement instrument could pass falsely too, for a second reason.** It called a
range shielded if `--end-of-options` appeared anywhere in the TWELVE PRECEDING LINES, so a
protected command one to twelve lines above an unprotected one shielded it — the marker
attributed to a command it does not belong to. **A coverage test that infers structure from
line proximity is measuring LAYOUT, not syntax**: twelve lines is a guess about formatting,
and formatting is not a property of the call. Its positive control could not catch this,
because the control used a SEPARATE per-line filter and never ran the detector at all — it
proved that *a* detector works, not that *this* one does. Two code paths, one guard.

Attribution is now parsed: from the nearest preceding `git` TOKEN in the comment-blanked
source to the range operand — the argv array (multi-line included) or the shell command. The
real maximum distance in the tree is 468 characters (`mutation-prover.ts`'s multi-line argv),
and the three operator-facing notes that merely *describe* a range sit 1205-1587 characters
from any `git`, so the 600-character bound separates prose from commands on measurement rather
than by assertion. **A range the detector cannot attribute is a FAILURE, not a pass.** The
controls run through the detector itself, both halves: protected-then-unprotected must report
exactly one offender, the same fixture with the second shielded must report none, a `git`
token inside a comment must attribute and shield nothing, and a range with no command near it
must come back unattributable. Mutation: restoring the twelve-line window reds two of them.

**Three times now the code was fixed and the completeness claim rested on an instrument that
could not see the gap** — a search keyed to one spelling of an identifier, then a proximity
window, and in between a window that read its own documentation. Each was a narrower claim
than it appeared, and none of the prose sweeps could have found any of them.

**And the first version of that fix passed every mutation.** The statement window it searched
for the marker included the COMMENTS this round added above each shielded site, and those
comments say `--end-of-options`. **An instrument that reads its own documentation as evidence
measures nothing.** Found by mutating, not by reading; the window now strips comments,
string-aware.

**2 · The gate's exemption marker could be smuggled inside a string.** `isExempt` tested
`/(^|\s)(\/\/|#|\*)/` against the text before the marker — "is there a comment opener
anywhere to the left", never "is that opener itself data". So one line could carry a fake
comment in a string AND the real offence, and report nothing:

    const note = " // DIFF-BASE-OK: <twenty characters>"; const cmd = `git diff ${baseBranch}..${head}`

The gate's own test covered a marker inside a string *without* a comment token — the easy
half of the same idea, a near-miss control that could not fail on the adversarial case.
Fixed with `commentOpenerIndex`, a quote-tracking scanner (`'`, `"`, backtick, `\` escapes,
`//`/`#` at a boundary, `/*`, and a leading `*` for jsdoc). Tested on all three quote
flavours, on `#` in a shell line, with complements (a real trailing comment beside a string
containing `//` still exempts; jsdoc and block comments still exempt) and a mutation:
restoring the naive search reds the exemption test.

**Nineteen existing assertions pinned the old argv and were repointed with the new value
stated as a value** — `mutation-claim-artifact.test.ts`'s shared `diffArgv` builder,
`mutation-prover.test.ts`'s pinned blast-radius argv, and `orchestrator.test.ts`'s
`DIFF_ARTIFACT` constant plus eleven harness matchers (`rev-list --count …`, the already-seen
`--name-only …` listing). That is a side benefit worth naming: those matchers now require the
marker to be present for the mock to answer at all, so dropping it in production reds them
too — a second, independent alarm that nobody had to design.

**And the rebase that arrived with the same shape attached.** `origin/main` moved three times
during this round (#636, #650, #628) and the PR went DIRTY. Two of the three conflicts were
instructive:

* `docs/spec-items/README.md` is a GENERATED rollup whose test asserts the committed file is
  byte-identical to the renderer's output, so a hand-merge would look resolved and fail CI.
  Regenerated after every merge, drift re-checked at 0.
* **A file-location conflict resolved AGAINST git's suggestion.** Promoting the previously
  staged as-built records to `docs/as-built/` shards had DRAINED `.trident/as-built/`, so git
  inferred a directory rename from an absence and proposed moving this branch's staged record
  into `docs/as-built/`. Refused: a branch never writes into `docs/as-built/` — the base
  promotes after the merge — and origin/main's own `AGENTS.md` still says to stage at
  `.trident/as-built/<branch>.md`. The second merge was reported CLEAN, which is the case
  worth naming: a silent rename would have moved the file with no conflict to notice, so the
  merged TREE was checked for both paths rather than the merge's exit status trusted. **A
  conflict is not a claim about the branch; it is an inference, and an inference from an
  absence can be confidently wrong** — round thirteen's lesson at a different altitude.

**The lesson, one level out from round thirteen.** Four sweeps had looked at prose — rules,
numbers, completeness words, absolutes. None looked at the *checkers*. A search pattern is a
claim too, and it is the one claim that silently narrows everything built on top of it:
"every consumer" meant "every consumer spelled the way I typed it", and the spec, the
as-built and the PR body all inherited that boundary without naming it.

### Round thirteen: the fourth sweep — absolutes, checked against the code they introduce

`merge.ts` said a bare local branch name is the wrong answer **"ALWAYS"** twenty lines above
the step that returns it, and above a spec item that *requires* that fallback. **Twenty
lines is the informative distance.** A comment is read as context FOR the code beneath it,
not as a claim to be checked AGAINST it, so proximity hid the contradiction rather than
exposing it — the fourth audit question with the roles swapped: not prose contradicted by
neighbouring prose, but prose contradicted by the code it introduces. Six manual passes over
this same claim (the title, the spec's rule, this record's invariant, `codex-build.sh`'s argv
comment, the gate header, the spec's argv bullet) had not exhausted it, which is why it was
closed with a sweep instead of an edit.

**The sweep, and its result.** Mechanical scope: every line this branch ADDS across its 22
touched files, grepped for `always|never|every|all|only|cannot|impossible|unconstructab|no
code path`. **467 lines carry one.** Discarding retractions that quote a superseded claim,
general principles that are not about this code, and test-design prose leaves **41 claims
about what this code does.** Each was read against the code it sits above:

- **23 corrected.** `merge.ts`'s "ALWAYS"; four "the refused value cannot become a rev-range
  operand **at all**" (`merge.ts` ×2, this record, the option-shaped test) — true only
  *through that binding*, which is why every consumer also carries `--end-of-options`; two
  gate-reach claims ("the next site cannot re-introduce the class by forgetting", "fails CI
  on a rev-range whose base bypasses this") narrowed to the spellings the gate enumerates;
  six "A RESOLVED REF, never the bare local branch name" (three in `orchestrator.ts`, one in
  `codex-review.sh`, one in `lint.sh`, one in `inner-workflow.test.ts`) — **at that round** the
  fallback was a bare name, so what must never happen is a call site naming a base of its own.
  (Round nineteen then removed the bare fallback, which made the original absolutes true again
  and these corrections themselves stale — every one was re-reconciled in round twenty.); `inner-workflow.mjs`'s "the ONLY
  place the base branch NAME is read" (`probeCiBase`, `branchLogBase` and the prompts read it
  too); two in `orchestrator.test.ts` and one in `cross-model-dispatch.test.ts`; this record's
  "a change to either alone cannot land" — **falsified by the very round that added the
  whitespace axis**, so it now reads "along an axis the table varies"; and a test NAME,
  `'NO REMOTE: … it is the only case left'`, contradicted by the test twenty lines below it
  that reaches the same fallback with `origin` configured. And three sites still called the
  probe ordering **"a property of the signature"** — the claim the coordinator and I had
  already agreed was wrong (the type prevents one spelling; `() => Promise.resolve(r)` still
  slips through), including one in `merge.ts` contradicted by its own next four lines and one
  in the PR body. **A correction agreed in conversation is not a correction made in the
  tree.**
- **18 held**, and they are what make the sweep worth trusting: a sha cannot go stale;
  `refs/heads/<base>` is the best available base in every no-resolving-ref state; the only
  source of a padded name is configuration (`detectBaseBranch` trims its own output at
  `merge.ts:191-195`); only trimmed values reach the return; `diffBase` is the only name this
  file gives a *merge-base* diff — and that heading names its own exception two lines later;
  `--end-of-options` really does stop every measured family; a `0` from the gate means
  "none of the enumerated spellings", never "no bare-base range exists"; `bindingCount`
  cannot cut the fixpoint short; the two implementations cannot share a module.

**So the class is now four sweeps deep**: rules (round eleven), numbers (round nine), claim
shapes (round nine's completeness words), and now absolutes **against the code they
introduce**. Each sweep found what the previous ones were not looking for. The generalisable
part is the scope, not the tokens: *sweep the lines this change adds, not the sentences you
remember writing.*

### Round twelve: the parity table held an axis constant, and an absolute survived in three more places

**THE TWO IMPLEMENTATIONS DISAGREED ON WHITESPACE.** `diffBaseRef` opened with
`const name = base_branch.trim()` and used the trimmed value for its probe and for both
returns; `inner-workflow.mjs` trimmed only to VALIDATE and composed its probe and its
fallback from `baseBranch` AS GIVEN. So `" main "` resolved to `origin/main` on the TS side
while the workflow probed `refs/remotes/origin/ main ^{commit}`, got nothing, and fell back
to `" main "`. Reachable from configuration, not only from a test: `resolveBase()` returns
`opts.base_branch` verbatim and the launcher hands that value straight to the workflow.

**The instrument built to prevent divergence had the same blind spot as the code.** The
parity table varies pinned/unpinned, origin-resolves/missing, both merge modes, empty and
option-shaped — **and holds whitespace constant.** That is this branch's own axes lesson
landing on the audit rather than the audited: *a matrix proves nothing about an axis it holds
constant, and the axis you hold constant is usually the one you did not notice you were
choosing.*

**Fixed by removing the axis, not by normalising twice.** Both sides now REFUSE a name whose
`trim()` is not the identity (`TridentPaddedBaseError`; a matching `throw` in the workflow),
and neither trims the value path at all — so there is no normalisation step left for them to
disagree about. Two implementations that each remember to trim is precisely the shape that
has now diverged three times here, each at a different step of one function: the merge-mode
fallback (round six), the pin/validate ORDER (round eight), the trim (round twelve).
Nothing legitimate is lost, measured on git 2.43: `git check-ref-format --branch ' main '`
is fatal (128), so no branch is named this way; and ` main ..HEAD` is itself a fatal
operand — which the wrappers' `2>/dev/null || true` turns into an EMPTY diff, so git's own
loudness would not have saved anyone. The `.mjs` substitution also moved INSIDE the
validated function, since as a module-scope `const` it composed shell text from a value
nothing had yet examined.

**The absolute had been corrected in two places and survived in three more** — the headline
invariant above, `codex-build.sh`'s argv comment, the "unconstructable" claim in the
rejected-alternatives section, and (found in the same sweep) the gate header and the spec's
argv bullet. Each earlier round fixed the artefact its finding pointed at; nothing had ever
swept the *class*. Two more "unconstructable" claims in `orchestrator.ts` and
`inner-workflow.mjs` were narrowed to "the binding throws", and `merge.ts`'s claim that the
eager-boolean form "no longer exists to be written" now states its limit: the compiler
prevents one spelling, and a caller can still pass `() => Promise.resolve(r)` around an
already-awaited value, which is why the absent-side-effect tests are what actually hold the
ordering.

**And a test written during round ten already carried the superseded rule.**
`review-diff-base-realgit.test.ts`'s header said local mode "has no origin to be behind" and
"must still compose the bare name" — the merge-mode rule the code had abandoned four rounds
earlier — while its own later case asserts `origin/main` and one file in local mode. Not a
stale comment left behind but **a new narrative written from a mental model the code had
already dropped**: when a design changes mid-branch, the prose written *after* the change is
not automatically written *from* it.

### Round eleven: the caller defeated the ordering, and a rule sweep the number sweep missed

**`resolvedDiffBase` computed the probe in the ARGUMENT POSITION** —
`diffBaseRef(base, run.base_sha, await originBaseResolves(…))` — and JavaScript evaluates
that before the function can return the pin. So the origin-ref probe fired on every pinned
dispatch, and **a pinned dispatch failed whenever the probe failed**, having already held
everything it needed. The pin exists precisely so a run does not depend on ref resolution.

This is round eight's ordering defect one layer out: there the `.mjs` binding validated the
name before consulting the pin; here the CALLER computed the probe before the pin could be
consulted. **A function cannot enforce an ordering over inputs it is handed
already-computed** — so the third parameter is now a THUNK, invoked on exactly the arm that
needs it, and the eager-boolean form no longer type-checks. The rule stopped being the
NATURAL spelling for a caller to get wrong — but **not a property of the signature**, which
is how this paragraph read until the round-thirteen sweep: a caller can still hand over
`() => Promise.resolve(r)` around an already-awaited value, and the type cannot see inside a
thunk. What actually holds the ordering is the pair of absent-side-effect tests below. The
branch's principle applies to the SPELLING here, not to the value.

**The test gap is the instructive half.** The result was correct throughout, so no value
assertion could see it — and the parity tests call `diffBaseRef` directly, so the caller's
ordering was invisible to them. An ordering over already-computed inputs is visible from
outside only as **a side effect that did not happen**: `run_host` receives no probe argv on a
pinned dispatch. Both views are now asserted, because neither suffices — a unit test cannot
see what the caller does, and an integration test cannot see what the function does. Each
carries its complement (an unpinned call issues exactly one probe) and the integration one
carries a positive control that the argv it asserts absent is the argv `originBaseResolves`
actually builds.

**And a RULE sweep, which the round-nine NUMBER sweep did not cover.** That sweep checked
counts, line numbers and tallies across four documents and did it thoroughly; these were
normative sentences, a different class of claim in the same files. Two were still describing
designs this branch replaced: the spec said an empty base is "returned untouched" while its
own acceptance required refusal, and a criterion still said the bare fallback happens "only
with no remote" while its sibling two entries down said otherwise. Both corrected, plus the
purity claims this round's thunk invalidated here and in `merge.ts`. **Sweeping one class of
claim does not sweep the others** — a document can be numerically exact and normatively
stale at the same time.

### Round ten: a mitigation asserted instead of measured, and a lag that moved

**An empty base produced a silent empty review.** `diffBaseRef` returned an empty
`base_branch` untouched, above a comment asserting the caller's diff would "fail loudly".
That sentence was never measured. On git 2.43:

    git diff --name-only --no-renames --end-of-options '..HEAD'   → exit 0, NO OUTPUT
    git rev-list --count --end-of-options '..HEAD'                → exit 0, prints "0"

Nothing fails. Per consumer, read from the code rather than assumed: the review-diff
listing is already guarded (an empty listing throws "refused to dispatch reviewers for an
empty diff"), so a zero-file review cannot be dispatched from there — but the stranded-run
ahead count reads `0` as "nothing worth salvaging", the mutation gate reports "this branch
changes no file", and the stage-1 test set comes back empty. One guard contains the worst
case; three consumers get a plausible wrong answer.

**"THE CALLER WILL FAIL" IS A CLAIM ABOUT THE CALLER, and it needs measuring like any
other.** That is now the second mitigation on this branch that was asserted rather than
tested, and the pair is instructive because the mistakes are different: round seven put a
*correct check in the wrong place* (`originBaseResolves` declining to probe an
option-shaped name, which routed it to the unguarded branch); this one made a *correct
check unnecessary* by believing something about git. Both were found in a falsification
pass, recorded as known, and shipped wrong — so finding a case is not the same as handling
it, and the handling deserves the same measurement the finding got.

Refused at the binding now, in both implementations, with the pin still winning first; and
the parity table gained an EMPTY axis, which the option-shaped rows had held constant while
varying hostile-vs-ordinary. That is the axes lesson landing on this very file.

**And the count lag MOVED rather than closed.** Round nine re-measured the mutation figures
in the as-built and wrote a standing note about why that file kept lagging. The spec item
still said "4 of 7" — so the *normative acceptance* described verification that no longer
existed, one round after the rule was stated. The artefact being looked at got fixed and
the one that was not inherited the staleness, which is the standing note's own sentence
applied to the correction rather than the original. Every numeric claim across all four
documents that make them — spec item, as-built, gate header, `lint.sh` — has now been
measured against the final tree in one pass: the mutation counts, the positive control's
size (3 → 5 as shapes were found), the consumer tallies, and the line numbers, which are
given as-cut AND as-merged because this record outlives the branch.

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
`unpinnedDiffBase()`, the only arm of `diffBase` that reads the name — the file reads it
elsewhere (`probeCiBase`'s unpinned fallback, `branchLogBase`, the prompts), each argued
where it sits.

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
| twelve | TS trimmed the value it probed and returned; `.mjs` trimmed only to validate | review |

So the answer to "two copies of a rule" here is a **parity table**
(`trident/diff-base-option-shaped.test.ts`): every row asserts BOTH implementations, over
pinned/unpinned, origin-resolves/missing, both merge modes, the refusals, AND surrounding
whitespace. The `.mjs` answer is a shell word, so it is evaluated in a real repository to be
comparable. Verified by mutation: reintroducing *any* of the three historical divergences
reds a row — the merge-mode one only after the table was widened to run both modes, and the
trim one only after round twelve added the whitespace axis, **which the table had held
constant through eleven rounds of auditing divergence.** A parity table is only as good as
the axes it varies, and the axis it holds constant is usually the one nobody noticed
choosing.

That is weaker than one implementation and stronger than two tested separately: the code
is still duplicated, but a change to either alone cannot land **along an axis the table
varies**. That qualifier is not decoration — round twelve's trim divergence landed and sat
green for eleven rounds precisely because the table did not vary whitespace, so the
unqualified sentence this replaces was falsified by the very round that added the axis.

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
rather than returning such a name, so it cannot become a rev-range operand **through that
binding** — not "at all", which is what this said: a value that never passed through it
still can, which is exactly why the consumers carry `--end-of-options` too. The principle
is narrowing the scope in which a base branch name exists, not abolishing it. Nothing
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
`refs/remotes/origin/<base>` resolves, prefer it when it does, and fall back only when it
does not — the same in both modes, decided per repository at the moment the range is built
rather than inferred from the merge mode. (At this round the fallback was the bare name;
round nineteen made it `refs/heads/<base>`.) That is the branch's own principle applied once
more: one fewer place where a base branch name can be a range operand at all. Local mode now
yields one file; mutating the fallback back to the MERGE-MODE-KEYED form reddens the test, and
a separate no-remote fixture proves the fallback is still reached.

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
the resolved ref is the only thing that crosses a boundary, the defect needs no gate —
though "unconstructable" is the wrong word even there, as round twelve found: an argv
boundary constrains what the RECEIVER can choose, and says nothing about what the sender
hands it. What it buys is that there is one place to get right instead of N.

### Dispositions for the rest of the class

Fixed (line numbers as of the tree this branch was cut from — the file has grown by ~200
lines since, so treat them as provenance rather than as a map): `inner-workflow.mjs`
`:1426`, `:2160`, `:5078`, the two wrapper argvs;
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
honoured — the order is over real inputs, not a preference for `origin/<base>`); and the
fallback (`refs/heads/<base>` when `refs/remotes/origin/<base>` does not resolve — prefixing
`origin/` unconditionally would break every repository that has no such ref).

> **That last clause has now been corrected twice.** As first written it said "local mode (the
> bare name is kept)": the fallback was keyed on merge mode for the first five rounds, and
> round six replaced it with a per-repository probe — corrected in the round-nine
> reconciliation pass. It then said "the bare name is kept" until round nineteen replaced that
> answer with `refs/heads/<base>`, because a bare word is not inert and a same-named tag
> answers to it. The CONDITION was right both times; the ANSWER was wrong both times.

**Mutation, re-measured in the round-twelve pass:** restoring `${shSingleQuote(baseBranch)}`
at `writeResumeDiff` fails **5 of the 9** tests in that file, and the gate reports it at
`inner-workflow.mjs:5286`. The agreement/complement tests stay green, which is what they
are for.

> Round nine measured the same mutation at `:5202` and round eight at `:5119`; each was true
> when written. Round twelve's own edit to this file moved the line again, which is the point
> of re-measuring rather than carrying a number forward: **the round that changes the code is
> the round that invalidates the counts, including its own record's.**

> Written at the time as "4 of the 7 … at `:5119`". Both numbers were true then and neither
> is now: later rounds added two fixtures to that file and moved the line. **A count and a
> line number are claims about the code like any other** — which is exactly how this record
> came to hold a stale signature, a stale title and a stale fallback condition, so they are
> re-measured here rather than trusted.

Four existing tests pinned the buggy value and were repointed with their new value stated
as a value: `inner-workflow-assembly.test.ts` (split into a local/pr pair),
`inner-workflow-resume.test.ts` (a new pr-mode + pinned-sha test beside the local one),
`inner-workflow.test.ts` and `__tests__/cross-model-dispatch.test.ts` (the wrapper argvs),
`orchestrator.test.ts` (the mutation-gate range, the test-strategy block, and the
hostile-base-name seam — where the name now cannot reach the prose at all, since a 40-hex
sha displaces it; the fold itself is still covered at its source in
`mutation-claim-artifact.test.ts`).
