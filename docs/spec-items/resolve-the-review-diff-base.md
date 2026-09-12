---
title: "Rev-range base: pinned sha, origin/<base> when it resolves, else bare"
group: trident
status: open
priority: P0
cutover: true
issue_ref: "#546"
---

**Every rev-range base resolves to the launch-pinned sha; else to `origin/<base>` when
`refs/remotes/origin/<base>` resolves to a commit; else to a bare local branch name** — which is
stated, tested, and the one case this change cannot improve on.

That last condition is **"the ref does not resolve"**, not "the repository has no remote". They are
different states and the second is wider than what the code establishes: a repository can have
`origin` configured while `refs/remotes/origin/<base>` is missing, deleted or never fetched, and
there the bare name is taken. The probe is a single `git rev-parse --verify`, so it also answers
"no" when it cannot run at all — fail-closed toward the behaviour this repository had before #546.
Deliberately **no fetch**: a build worktree should not be reaching the network to answer a
diff-base question.

**Three narrower conditions, found by reading the code for states that would falsify the sentence
above rather than by re-reading the sentence.** Each is small; each would have made it wrong:

- an **option-shaped** base name (`-x`) — **REFUSED at the binding**, and the round that merely
  noted it here had a live file-write. `originBaseResolves` answers false without probing, and
  false selects the *bare name*, which reached git unguarded: measured on git 2.43, a base of
  `--output=<path>` made `git diff --name-only` exit 0 and write the file, the artifact diff
  honour both `--output`s, and `git rev-list --count` write it despite exiting 129. `diffBaseRef`
  now throws `TridentOptionShapedBaseError`, and every consumer carries `--end-of-options` as
  defence in depth. Verified by `trident/diff-base-option-shaped.test.ts` per command family,
  with three mutations;
- an **empty** base name — **REFUSED** (`TridentEmptyBaseError`), so the
  "resolves / does not resolve" framing does not apply to it at all. This bullet said
  "returns the input untouched" for two rounds while the acceptance below required refusal;
  `..<head>` is not an error — `git diff --name-only` exits 0 with no output — so returning
  it produced a plausible wrong answer;
- a base name with **surrounding whitespace** — **REFUSED** (`TridentPaddedBaseError`), and the
  reason it is refused rather than trimmed is the point. `diffBaseRef` used to trim before probing
  and returning; the workflow trimmed only to VALIDATE and composed its probe and its fallback from
  the value as given, so `" main "` resolved to `origin/main` on one side and to `" main "` on the
  other — a production input, since `resolveBase()` returns `opts.base_branch` verbatim and hands
  it to the workflow. Two implementations that each remember to normalise is the shape that has
  now diverged three times here (merge-mode fallback, pin/validate ORDER, trimming), each time at
  a different step of one function; with the value refused on both sides, `trim()` is the identity
  on everything that survives and there is no normalisation left to disagree about. Nothing
  legitimate is lost — measured on git 2.43, `git check-ref-format --branch ' main '` is fatal
  (128), and ` main ..HEAD` is a fatal operand that the wrappers' `2>/dev/null || true` turns into
  an empty diff;
- `codex-review.sh`'s **standalone** promotion is *stricter still*: it additionally requires
  `refs/heads/<x>` to resolve and `refs/tags/<x>` not to, so it promotes only a proven,
  unambiguous local branch name. The trident path never reaches it (it passes an already-resolved
  ref); a caller passing a tag does, and that is the regression this round fixed.

An earlier draft of this item said "a bare local branch name is **never** the left-hand side of a
rev-range" and, below, "**no code path** composes a rev-range from a base branch NAME" — while the
same document *required* the bare name in local mode. Two absolutes and their own exception, in one
file. That contradiction survived an audit that corrected four other overstatements, because the
title reads as a name rather than as a claim, and it is in fact the sentence someone quotes when
deciding whether this problem is solved. It is written narrowly and truly above.

`git diff main..<head>`
in a shared build checkout diffs against whatever `refs/heads/main` happens to hold, and that ref
is only as fresh as the last time something on the box pulled it. Every commit merged into the
base since then is then presented as this branch's own work.

The failure is silent in both directions that matter: git exits 0, and the extra files are real
code, so nothing downstream can tell an inflated diff from a genuinely large one. It has been
measured twice on this repo:

- **Argus r4, run `25b2327d`** — local `main` was 8 merges behind `origin/main`; the published
  review artifact was 15,154 lines across ~100 files for a branch whose own work was 20 files /
  1,738 lines. ~87% of what a reviewer read was already-merged unrelated code. One reviewer
  vetoed the branch over bugs in files it does not touch and the round was lost.
- **#546** — reviewers read 149 files where the branch changed 30.

**And it had already been fixed twice, as a call site.** When #546 was filed,
`trident/inner-workflow.mjs` was resolving the base correctly in `probeCiBase` (the launch-pinned
sha) and in the plan probe's branch log (`origin/<base>`), while two other sites in the same file
— the resume diff and the forge contract's reviewer diff — still composed the bare name. A
boundary that depends on the next author noticing the right form thirty lines away is the failure
mode `docs/agent-legible-architecture.md` §1 names explicitly. So the unit of the fix is the
**rule**, not the call sites.

**What enforces this is structural, not a grep.** The invariant is *a base branch NAME reaches a
rev-range operand only where no remote-tracking ref for it exists*, and it is carried by two
things:

- **one binding per boundary** — `diffBase` in `trident/inner-workflow.mjs` and the
  exported `diffBaseRef()` in `trident/merge.ts` are the only things that turn a base
  branch NAME into a range base, so there is no second spelling to drift from. They are
  *not* the only producers of a range base and an earlier draft of this said they were:
  `rebased.baseSha`, `localForkPoint()`, `seenPin` and `run.base_sha` all reach a range
  operand directly. Every one of those is a **sha**, which is the property that matters;
- **an argv boundary that carries whatever the composing side resolved** —
  `trident/codex-build.sh` takes the base as argv `$2` and holds no base-branch-name binding at
  all (its default is empty, and empty skips the diff), so the wrapper cannot *invent* a base.
  An earlier draft called a bare-base range there *unconstructable*: **that was false.** The
  legitimate fallback above — no resolving `refs/remotes/origin/<base>` — is a bare NAME, it is
  passed as that argv, and it reaches `git diff --end-of-options "${BASE_DIFF_REF}..HEAD"`
  (`codex-build.sh:809`), which `trident/codex-wrapper-bare-base.test.ts` now exercises through
  the shipped line. **If a claim says something cannot be built, it has to name the mechanism
  that prevents it**; the mechanism here prevents the wrapper *choosing* a base, not a bare name
  arriving at one. `trident/codex-review.sh` is weaker still: its argv default is the literal
  `main`, which it promotes to `origin/main` when that ref resolves and leaves bare when it does
  not — a resolved ref on the trident path, which always passes one, merely demoted in a
  standalone run against a repo with no `origin/<base>`.

`scripts/ci/diff-base-check.mjs` is **defence in depth on top of that** — it exists to
make a regression loud, not to prove absence. A textual matcher over source cannot
enforce "every rev-range"; it can only enforce "every rev-range whose spelling was
enumerated", and this one has been wrong about that twice in the same shape. Its scope
and its blind spots are stated in its own header, and the criteria below say which claim
rests on which instrument.

The resolution order is evidence-first, and is the same at every site:

1. the **launch-pinned base sha** — the commit `origin/<base>` held when the launcher observed it
   and cut the build branch. A sha cannot go stale, and it IS the cut point;
2. **`origin/<base>` whenever that ref resolves, in EITHER merge mode** — the remote-tracking
   ref. In pr mode the launch path fetches `+refs/heads/<base>:refs/remotes/origin/<base>` and
   refuses to start the build if that fetch or its rev-parse fails, so it exists and is as fresh
   as launch; in local mode it is preferred too, whenever the repository has one;
3. the **bare name whenever `refs/remotes/origin/<base>` does not resolve to a commit** — a
   repository with no remote, one whose `origin` is configured but whose base ref is missing,
   deleted or unfetched, and one where the probe itself could not run. In all of those
   `refs/heads/<base>` is the best available base and there is no better answer without a fetch,
   which this deliberately does not do.

   This step used to read "the bare name in **local mode** only — the one world where it is right
   rather than tolerated: a local-mode run has no origin to be behind". **That was false, and it
   was the last place the defect lived.** `merge_mode: 'local'` means the OUTER LOOP MERGES
   LOCALLY; it says nothing about whether the repository has a remote — and this file's own
   `branchLogBase` comment had said since before #546 that "a plain local base branch may be stale
   in NON-PR mode". Measured in the review-diff fixture: local mode against a `main` four commits
   behind `origin/main` produced **five files where the branch changed one**, exactly as pr mode
   did. Step 2 is therefore not pr-mode-specific, and the question "is there a remote?" is asked of
   the repository at the moment the range is built rather than inferred from the merge mode.

## Acceptance

- [ ] **The stale case is proven against real git, with the correct and buggy answers
      differing.** A fixture whose local base ref is deliberately behind `origin/<base>`, where
      the resolved base names N files and the bare local name names N+K, both asserted as
      VALUES (counts AND file names), not as a relation. Verified by
      `trident/review-diff-base-realgit.test.ts` — "THE BUGGY ANSWER AND THE CORRECT ANSWER
      DIFFER" and "UNPINNED, pr mode". A test that diffs two refs in a freshly cloned fixture
      is satisfied by the broken implementation and does not count.
- [ ] **The workflow's own command is executed, not merely inspected.** The test extracts the
      Bash command the workflow composes and runs it with bash in the fixture, then reads the
      diff file git produced. Verified by the same file — the `resume-diff` seam in
      `runResumeDiff` runs `spawnCapture(['bash', '-c', …])`. Asserting the command STRING
      alone would pass against a command that resolves correctly and produces nothing.
- [ ] **The fresh case shows the two answers AGREE.** With the local ref fast-forwarded, the
      resolved base and the bare local name name exactly the same files. Verified by
      "FRESH local ref: the resolved base and the bare name AGREE, file for file", stated
      without reference to the composed command so it stays green under the mutation — a fix
      that merely always preferred something else would pass the stale case and fail this one.
- [ ] **A pinned base that is the STALE sha is still honoured.** The order is over real inputs,
      not a hard-wired preference for `origin/<base>`. Verified by "A PINNED BASE THAT IS THE
      STALE SHA IS STILL HONOURED" — which a fix that unconditionally reached for
      `origin/<base>` would fail while passing every other stale-case test.
- [ ] **Local mode gets the SAME resolution as pr mode, and the bare name is reached only when
      `refs/remotes/origin/<base>` does not resolve** — not "only with no remote", which this
      criterion carried after the condition it names had already been narrowed, and which its
      own sibling criterion two entries down contradicts. The fallback was `merge_mode`-keyed,
      which is the last place this defect
      lived: local mode against a stale `main` produced five files where the branch changed one.
      Verified by "LOCAL MODE, unpinned, WITH a remote: same stale ref, same ONE file", which
      asserts the resolved base AND the file list AND the five-file contrast measured from git in
      the same repo — the previous version of this test asserted the command *shape* and could
      not see the bug in the fixture it ran against. Mutating the fallback back to the bare name
      reddens it.
- [ ] **The two implementations of the rule agree, row by row.** `diffBaseRef` (TS) and
      `diffBase` (`.mjs`) cannot share a module — the workflow script takes no imports — and
      have diverged twice, on the merge-mode fallback and on whether the pin is read before
      the name. Verified by the parity table in `trident/diff-base-option-shaped.test.ts`,
      which asserts BOTH over pinned/unpinned, origin-resolves/missing, both merge modes and
      the refusal, evaluating the `.mjs` shell word in a real repository so the two are
      comparable. Mutation: reintroducing either historical divergence reds a row. A
      criterion naming only one implementation is how both divergences survived.
- [ ] **A valid pin wins before the name is examined, in both implementations.** The
      refusal belongs on the arm that reads the name; a module-scope check failed runs whose
      pin meant the name was never used. Verified by "ORDER: a valid PIN wins before the name
      is examined — in BOTH implementations", which asserts the two together in one test.
- [ ] **A valid pin short-circuits the probe — asserted as an ABSENT side effect.** The
      third parameter of `diffBaseRef` is a THUNK, not a boolean, because every caller of the
      boolean form wrote `diffBaseRef(base, sha, await originBaseResolves(…))` and JavaScript
      evaluates that argument first: the probe ran on every pinned dispatch, and a pinned
      dispatch failed whenever the probe did, having already held everything it needed. The
      result stayed correct, so no value assertion could see it. Verified twice, because
      neither view suffices alone — a unit test cannot see what the caller does and an
      integration test cannot see what the function does: "THE PROBE IS NOT EVEN CALLED when
      the pin is valid" (a spy thunk with zero calls, plus the complement that an unpinned
      call issues exactly one) and "A PINNED dispatch issues NO origin-ref probe" in
      `trident/orchestrator.test.ts` (no probe argv on the host, with a positive control that
      the asserted argv is the one `originBaseResolves` actually builds). Mutation: restoring
      the eager `await` in the caller reds the integration one. **A function cannot enforce an
      ordering over inputs it is handed already-computed** — so the probe arrives as a thunk
      and the eager form no longer type-checks. That is one spelling, not the class: a caller
      can still pass `() => Promise.resolve(r)` around an already-awaited value, which is why
      **the two absent-side-effect assertions are the criterion and the signature is not**.
- [ ] **An empty base is refused at the binding.** `..<head>` is not an error — measured,
      `git diff --name-only` exits 0 with no output and `git rev-list --count` exits 0
      printing `0` — so an empty base yields a plausible wrong answer, not a failure. The
      previous mitigation was a comment asserting the caller would "fail loudly", never
      measured; **a claim about the caller needs measuring like any other.** Verified by
      "AN EMPTY BASE IS REFUSED", which measures both git commands in the fixture BEFORE
      asserting the throw, covers whitespace, asserts a pin still wins, and drives both
      implementations; plus an EMPTY row in the parity table — an axis the option-shaped
      rows held constant. Mutations: restoring the untouched return, or removing the `.mjs`
      check, each reds two tests.
- [ ] **An option-shaped base is refused at the binding, and every consumer is shielded.**
      A name beginning with `-` is read by git as a FLAG, not a revision: `--output=<path>..<head>`
      writes that file, and two of the four consumers exit 0 while doing it. `diffBaseRef` throws
      rather than returning such a name — refusing to *probe* it (the previous round's mitigation)
      only routed it to the unguarded branch. Verified by
      `trident/diff-base-option-shaped.test.ts`: the binding refuses under both probe answers; the
      shipped consumers each carry `--end-of-options` (extraction with pinned counts, so one added
      later fails); and per command family, against real git, the marker is shown to be what stops
      the write while ordinary ranges still work. Mutations: remove the throw, strip the marker
      from the orchestrator sites, strip it from the wrappers — one test reds for each.
- [ ] **The wrapper promotes BY KIND, not by string shape.** `codex-review.sh` takes a general
      `[base-ref]`. Promoting whenever `origin/<x>` resolved meant a **tag** `release` was
      silently rewritten to the remote branch `origin/release` — a different commit — because
      `origin/<x>` resolving proves a remote-tracking ref exists, not that the argument was a
      branch. Verified by `trident/codex-review-base-ref.test.ts`, which builds one repository
      holding both collisions at once and pins the COMMIT each argument resolves to: a local
      branch is promoted, a tag is not, an ambiguous branch+tag name is not, and a sha,
      `origin/<x>`, `HEAD~1` and an unknown name are kept verbatim. The block under test is
      extracted from the shipped script rather than retyped; mutating it back to the
      string-shaped form reddens two tests.
- [ ] **The fallback is reached whenever the REF does not resolve — not only when the repository
      has no remote.** Two fixtures, because they are different states and an earlier draft of
      this criterion named only the first: "NO REMOTE: the bare name is the fallback" removes the
      remote and every `refs/remotes/` ref; "CONFIGURED ORIGIN, MISSING BASE REF" keeps `origin`
      configured and deletes only `refs/remotes/origin/main`, which is the ordinary state of a
      fresh worktree that has not fetched. Both assert the substitution resolves to `main` and
      that a real diff is still produced. Without the first the fix would be "always prefer
      `origin/`", which breaks every repository that has none; without the second the spec would
      go on claiming a condition wider than the probe establishes.
- [ ] **The two implementations do not NORMALISE differently — asserted on the whitespace axis.**
      `diffBaseRef` trimmed before probing and returning; the `.mjs` trimmed only to validate and
      built both its probe and its fallback from the value as given, so `" main "` — a value
      `resolveBase()` passes through verbatim — resolved to `origin/main` on one side and to
      `" main "` on the other. Refused on both sides rather than trimmed on both, so the axis is
      removed instead of agreed upon. Verified by the parity table's "unpinned, SURROUNDING
      WHITESPACE: both REFUSE" row, which drives five padded spellings through both
      implementations under both probe answers and both merge modes, and asserts the complement
      (the same name unpadded is answered `origin/main` by both, in the same fixture) and that a
      pin still wins. Mutations: restoring `const name = base_branch.trim()` in `diffBaseRef`
      reds it; deleting the `.mjs` guard reds it — 2 tests each, measured. **The table that
      exists to catch divergence held this axis constant for eleven rounds**, which is the same
      blind spot as the code it audits.
- [ ] **The bare name actually reaching a wrapper's range is exercised, not just argued.** The
      fallback is legitimate, so the bare name does reach `codex-build.sh`'s
      `git diff --end-of-options "${BASE_DIFF_REF}..HEAD"` and `codex-review.sh`'s
      `FULL_DIFF=$(git diff --end-of-options "${BASE_REF}..HEAD")`. Verified by
      `trident/codex-wrapper-bare-base.test.ts`, which extracts both shipped lines by text and
      RUNS them: in a no-remote repository the bare name yields the branch's own work (pinned
      file list and count), and in a repository whose local base is stale the same line handed the
      bare name yields the inflated answer while the resolved ref yields the correct one — so the
      argv is shown to be load-bearing at the wrapper, which is the reason the wrapper must never
      improve or guess it. It also measures what a padded name does there (an empty diff, because
      `2>/dev/null || true` swallows git's fatal), which is why the binding refuses one.
      The previous wrapper criteria inspected argv and source text only.
- [ ] **Reverting the fix reddens the suite.** Restoring `${shSingleQuote(baseBranch)}` at
      `writeResumeDiff` must turn `trident/review-diff-base-realgit.test.ts` red. Measured:
      **5 of 9** tests fail, and the agreement/complement tests stay green. (Written as
      "4 of 7" and corrected here: the as-built's re-measurement last round did not reach
      this document, so the normative acceptance described verification that no longer
      existed. A count is a claim about the code, and correcting it in one artefact moves
      the lag rather than closing it.)
- [ ] **No base branch NAME is in scope where a rev-range is built, at the boundaries
      where that is achievable — and the criterion says where it is not.** This is what
      carries the invariant, and it is structural: `diffBase` and `diffBaseRef()` are the
      only things that turn a base branch name into a range base, and `codex-build.sh`
      holds no base-branch-name binding at all (default empty, and empty skips the diff).
      `codex-review.sh` reaches only the weaker property — its argv default is the literal
      `main`, demoted to `origin/main` when that ref resolves — and this criterion claims
      only that. Verified by `trident/inner-workflow.test.ts` and
      `trident/__tests__/cross-model-dispatch.test.ts` (the wrapper argv carries the
      resolved ref, per merge mode), by `trident/codex-wrapper-bare-base.test.ts` (what each
      wrapper's shipped range line does with the value it is handed, including the legitimate
      bare one) and by reading both scripts' base bindings. A criterion
      that said only "CHECK 8 is
      green" would be satisfied by a tree whose bare-base range is merely spelled in a way
      the matcher does not enumerate.
- [ ] **CHECK 8 makes a regression LOUD, with an honest scope.**
      `scripts/ci/diff-base-check.mjs` (CHECK 8 of `scripts/ci/lint.sh`) fails on a
      rev-range in `trident/`, `tools/` or `scripts/` whose left operand names a base
      BRANCH — by spelling (`baseBranch`, `base_branch`, `BASE_BRANCH`), by the binding it
      came from (`resolveBase()`, `detectBaseBranch()`, a `base_branch` field), or through
      an alias chain to a fixpoint. **This criterion does NOT claim every rev-range**, and
      the gate's header enumerates what it cannot see (a range assembled across statements,
      a computed name, a nested interpolation, a helper taking the base as a `string`
      parameter, the legitimate unresolvable-ref fallback, any unenumerated
      spelling). A pass means "none of the enumerated spellings is present".
- [ ] **Every spelling the gate has been caught missing is now matched, and each fix is
      independently load-bearing.** The four known ones: the name inside a call
      (`${shSingleQuote(baseBranch)}..`, the literal #546 line); a closing quote between
      the operand and its dots (`"${BASE_BRANCH}"..HEAD`, which the shell evaluates as
      exactly `main..HEAD`); a concatenation with no interpolation at all
      (`'git diff ' + base + '..HEAD'`); and a range split over two source lines. Verified
      by the four named tests in `scripts/ci/diff-base-check.test.ts`, and by mutation —
      reverting `RANGE_TAIL`, dropping `RANGE_CONCAT`, or disabling the `logicalLines`
      join each reddens the suite (3, 1 and 1 test respectively).
- [ ] **The alias propagation reaches an actual fixpoint, not a fixed number of passes.**
      The loop was capped at four rounds while calling itself a fixpoint; the cap is
      invisible in dependency order, because a forward chain of any length propagates
      end-to-end in one scan — which is how the first alias test was written, so the
      iteration boundary was never exercised. Verified by "the alias fixpoint is a
      FIXPOINT", which uses a REVERSE-ordered chain (one hop per round) at 6 and at 40
      hops, plus the complement that an equally long chain rooted in a resolved value
      stays clean. Mutating the bound back to 4 reddens it. The bound is now the binding
      count — a real bound derived from the input — and the early-exit break is a
      performance guard, measured, not the termination guarantee.
- [ ] **No regex is BUILT from scanned source.** The alias hop spliced a captured
      identifier into a `new RegExp` unescaped, and identifiers may contain `$` — an
      end-of-line anchor — so aliasing through `$base` silently matched nothing and the
      gate returned no hits for a range it was built to catch (CodeQL
      `js/useless-regexp-character-escape`, high). Verified by "an identifier containing
      `$` aliases like any other", asserted against an identical `z`-named control in one
      comparison because the control passed throughout while the other half was broken;
      and by "no regex is BUILT from scanned source at all", which pins the gate's only
      `new RegExp` calls to its two static range constructors so a future splice fails a
      test rather than going quiet.
- [ ] **The widening did not merely make the matcher permissive.** A resolved base in each
      of those same positions — quoted boundary, concatenation, line break — is silent, as
      is a non-base operand on the left of a concat and an alias of a *resolved* value.
      Verified by "THE COMPLEMENT of the quote/concat/line-break widening". Without this,
      the fix for a blind spot trades it for a muted gate.
- [ ] **The gate has a positive control and refuses an empty scan.** A grep that finds nothing
      proves nothing until the same grep has been shown finding something. Verified by the
      gate's own `runControls()` (5 pinned offenses at pinned lines, plus a negative control
      whose only hit is an un-argued exemption), which runs before the tree is touched, and by
      "an empty scan set is a FAILURE, not a pass" and by the planted-offender mutation test.
- [ ] **Every site in the class is either fixed or has evidence that it is correct.** The
      dispositions are recorded in the as-built record for the branch that ships this.
