---
title: "Rev-range base: pinned sha, origin/<base>, bare only when no remote"
group: trident
status: open
priority: P0
cutover: true
issue_ref: "#546"
---

**Every rev-range base resolves to the launch-pinned sha, or to `origin/<base>` when that ref
resolves, and to a bare local branch name only when the repository has no remote** — which is
stated, tested, and the one case this change cannot improve on.

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
- **an argv boundary that carries a resolved ref** — `trident/codex-build.sh` takes the
  base as argv `$2` and holds no base-branch-name binding at all (its default is empty,
  and empty skips the diff), so there a bare-base range is genuinely *unconstructable*.
  `trident/codex-review.sh` is **weaker**, and an earlier draft overstated it: its argv
  default is the literal `main`, which it promotes to `origin/main` when that ref
  resolves and leaves bare when it does not. Unconstructable on the trident path, which
  always passes a resolved ref; merely demoted in a standalone run against a repo with
  no `origin/<base>`.

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
3. the **bare name only when `refs/remotes/origin/<base>` does not resolve** — a repository with
   no remote, where `refs/heads/<base>` is the base of record and there is no better answer.

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
- [ ] **Local mode gets the SAME resolution as pr mode, and the bare name is reached only with
      no remote.** The fallback was `merge_mode`-keyed, which is the last place this defect
      lived: local mode against a stale `main` produced five files where the branch changed one.
      Verified by "LOCAL MODE, unpinned, WITH a remote: same stale ref, same ONE file", which
      asserts the resolved base AND the file list AND the five-file contrast measured from git in
      the same repo — the previous version of this test asserted the command *shape* and could
      not see the bug in the fixture it ran against. Mutating the fallback back to the bare name
      reddens it.
- [ ] **The no-remote fallback is reached, and is the only case the bare name is used in.**
      Verified by "NO REMOTE: the bare name is the fallback", which removes the remote and every
      `refs/remotes/` ref from the fixture, asserts the substitution resolves to `main`, and
      asserts it still produces a real diff. Without it the fix would be "always prefer
      `origin/`", which breaks every repository that has none and which no with-remote test can
      detect.
- [ ] **Reverting the fix reddens the suite.** Restoring `${shSingleQuote(baseBranch)}` at
      `writeResumeDiff` must turn `trident/review-diff-base-realgit.test.ts` red. Measured:
      4 of 7 tests fail, and the two agreement/complement tests stay green.
- [ ] **No base branch NAME is in scope where a rev-range is built, at the boundaries
      where that is achievable — and the criterion says where it is not.** This is what
      carries the invariant, and it is structural: `diffBase` and `diffBaseRef()` are the
      only things that turn a base branch name into a range base, and `codex-build.sh`
      holds no base-branch-name binding at all (default empty, and empty skips the diff).
      `codex-review.sh` reaches only the weaker property — its argv default is the literal
      `main`, demoted to `origin/main` when that ref resolves — and this criterion claims
      only that. Verified by `trident/inner-workflow.test.ts` and
      `trident/__tests__/cross-model-dispatch.test.ts` (the wrapper argv carries the
      resolved ref, per merge mode) and by reading both scripts' base bindings. A criterion
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
      parameter, the legitimate no-remote fallback, any unenumerated
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
