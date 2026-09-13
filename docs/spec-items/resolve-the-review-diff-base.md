---
title: "Rev-range base: pinned sha, else the ref verified, never a shorthand"
group: trident
status: open
priority: P0
cutover: true
issue_ref: "#546"
---

**EVERY VALUE THAT REACHES A GIT REV-RANGE IS A FULL OBJECT NAME OR BEGINS WITH `refs/` — AND
THE GATE THAT ENFORCES THIS EXEMPTS NOTHING THAT IS NOT ITSELF ONE OF THOSE TWO FORMS.**
Nothing else — that is the property, and it is about what git RECEIVES rather than about which
caller produced it, which is what makes it exhaustive where four earlier statements of the rule
were enumerations of paths. The second clause is not decoration: `scripts/ci/diff-base-check.mjs`
exempted `origin/` while the runtime path refused it, so **the regression alarm for this exact
class was blind to it**. That clause is checkable by reading `QUALIFIERS` against this sentence —
two lines, not a sweep. **"Contains a slash" is not "fully qualified":** `origin/main` is a
shorthand git disambiguates by its own precedence, which prefers TAGS, so `refs/tags/origin/main`
captures it.

Concretely: every rev-range base resolves to the launch-pinned sha; else to
`refs/remotes/origin/<base>` when that ref resolves to a commit; else to `refs/heads/<base>` when
THAT resolves; else it is REFUSED. No arm hands back a bare name, and the standalone wrapper
asserts the SHAPE at the point where the value meets the command, so a classifier mistake
upstream cannot reach git. Every arm names the ref it verified: a shorthand is a
different thing from the ref it looks like, because git permits `refs/tags/origin/main` and
`refs/tags/main`, prefers tags when disambiguating, and resolves a bare word against every
namespace — so an unqualified base is a base nobody chose.

That last condition is **"the ref does not resolve"**, not "the repository has no remote". They are
different states and the second is wider than what the code establishes: a repository can have
`origin` configured while `refs/remotes/origin/<base>` is missing, deleted or never fetched, and
there `refs/heads/<base>` is taken — the local branch, named in full — and when that does not
resolve either the base is REFUSED rather than guessed. The probe is a single
`git rev-parse --verify`, and it answers three ways rather than two: **resolved**, **absent**
(exit 1, empty stdout — git looked and there is no such ref), and **undetermined** (anything
else: the command could not be spawned, exit 128 outside a repository, or output that is not an
object name). Those two non-resolutions part company **at the remote position**, and the
sentence is about that position specifically: an ABSENT `refs/remotes/origin/<base>` is the
fresh-clone and never-fetched case, so it falls through to `refs/heads/<base>`, while an
UNDETERMINED one refuses there and then rather than reading silence as absence. At the local
position there is nothing left to fall through to, so anything but *resolved* refuses. Both
refusals fail CLOSED; neither falls through to a word git would resolve for us.
Deliberately **no fetch**: a build worktree should not be reaching the network to answer a
diff-base question.

**Three narrower conditions, found by reading the code for states that would falsify the sentence
above rather than by re-reading the sentence.** Each is small; each would have made it wrong:

- an **option-shaped** base name (`-x`) — **REFUSED at the binding**, and the round that merely
  noted it here had a live file-write. `originBaseResolves` answers false without probing, and
  false selects the *bare name*, which reached git unguarded: measured on git 2.43, a base of
  `--output=<path>` made `git diff --name-only` exit 0 and write the file, the artifact diff
  honour both `--output`s, and `git rev-list --count` write it despite exiting 129. `diffBaseRef`
  now throws `TridentOptionShapedBaseError`, and **no TypeScript call site can build a range
  without `--end-of-options`**: every one goes through `gitRangeArgv` (`trident/git-range.ts`),
  which has no parameter for the marker. What remains outside it is two NAMED SETS — commands
  inside prompt strings, which an agent runs, and commands in the shell wrappers, which bash
  runs; **no TypeScript helper can reach either**. They are enumerated by `file:line` with a
  reason each in `OUT_OF_REACH`, and **this item states no count of them on purpose**: it said
  "six — four prompt commands and two shell lines" until a merge from `main` added a prompt
  command, the second time that number went stale while the executable list stayed right. A
  count in prose is a copy of a fact; a named set is the fact, and a new member fails the test
  with its own `file:line` rather than with a number that moved. This bullet
  was FALSE at one head: the coverage test searched for `${baseRef}`, `computeDiffLineCount`
  spells it `base_ref`, and it shipped unshielded. **A completeness claim is only as wide as
  the instrument that checks it** — and after three rounds of widening that instrument, the
  property is now prevented rather than measured;
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
- `codex-review.sh`'s **standalone** handling CLASSIFIES THE INPUT'S KIND ONCE — already
  shaped (40-hex either case, or `refs/…`), `HEAD`-rooted, `origin/`-prefixed, or a bare name —
  and then applies that kind's single rule. A bare name is never probed as `origin/<x>` and an
  `origin/<x>` is never probed as a bare name, **because the rules are unreachable from the
  wrong kind, not because the arms are in a lucky order**. (It was an `if/elif` chain ordered by
  the order the cases were discovered, and three consecutive rounds found the same defect in it:
  an arm probing a CONSTRUCTED ref name running before the arm that would have recognised what
  the input already was. Each fix moved one arm and exposed the one behind it.) Within the
  bare-name kind, promotion additionally requires `refs/tags/<x>` NOT to resolve, so what it
  promotes is a remote-tracking ref **that is not shadowed by a tag of the same name**. That clause is load-bearing and unchanged: it is why a tag `release` sitting
  beside `origin/release` is not rewritten to the remote branch — a different commit, silently.

  > **It also required `refs/heads/<x>` to resolve, and this bullet said so — "a proven,
  > unambiguous local branch name" — until round twenty-six removed that half.** Requiring a
  > local branch rejected the ORDINARY state of a CI checkout (detached or fresh: the
  > remote-tracking ref and no local `main`), so the chain fell through and the shape guard
  > refused the wrapper's own default argument. Promotion now keys on the remote-tracking ref
  > independently of whether a local branch exists. Only that half moved; the tag clause is
  > still exactly as written above.

  The trident path never reaches the promotion (it passes a sha or a fully qualified ref); a
  caller passing a bare name or a tag does.

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

**What enforces this is structural, not a grep.** The invariant is *every value that reaches a
rev-range operand is a full object name or begins with `refs/`* — **a base branch NAME never
reaches one at all.** (This sentence read "a base branch NAME reaches a rev-range operand only
where no remote-tracking ref for it exists" until round twenty-six: that was the rule through
round eighteen, and round nineteen replaced the bare fallback with `refs/heads/<base>` and a
refusal. It contradicted this item's own headline and `trident/merge.ts`'s order list — binding
acceptance text describing a fallback the code no longer has.) It is carried by two things:

- **one binding per boundary** — `diffBase` in `trident/inner-workflow.mjs` and the
  exported `diffBaseRef()` in `trident/merge.ts` are the only things that turn a base
  branch NAME into a range base, so there is no second spelling to drift from. They are
  *not* the only producers of a range base and an earlier draft of this said they were:
  `rebased.baseSha`, `localForkPoint()`, `seenPin` and `run.base_sha` all reach a range
  operand directly. Every one of those is a **sha**, which is the property that matters;
- **an argv boundary that carries whatever the composing side resolved** —
  `trident/codex-build.sh` takes the base as argv `$2` and holds no base-branch-name binding at
  all (its default is empty, and empty skips the diff), so the wrapper cannot *invent* a base.
  **From trident it now receives only a sha or a fully qualified ref**, because `diffBase` has
  no arm that composes a bare name. That is a property of the CALLER, not of the wrapper: argv
  comes from anyone, so `trident/codex-wrapper-range-line.test.ts` still measures what the
  shipped line `git diff --end-of-options "${BASE_DIFF_REF}..HEAD"` (`codex-build.sh:821`) does
  with a bare name, a stale one and a padded one. **If a claim says something cannot be built,
  it has to name the mechanism that prevents it** — an earlier draft called a bare-base range
  there *unconstructable*, and the mechanism it named prevents the wrapper CHOOSING a base, not
  a bare name arriving at one. `trident/codex-review.sh` defends itself independently, because
  its argv default is the literal `main`: it qualifies a bare argument to
  `refs/remotes/origin/<x>` when that resolves and to `refs/heads/<x>` otherwise, and REFUSES
  an ambiguous (branch + tag) or tag-only one.

`scripts/ci/diff-base-check.mjs` is **defence in depth on top of that** — it exists to
make a regression loud, not to prove absence. A textual matcher over source cannot
enforce "every rev-range"; it can only enforce "every rev-range whose spelling was
enumerated", and this one has been wrong about that twice in the same shape. Its scope
and its blind spots are stated in its own header, and the criteria below say which claim
rests on which instrument.

The resolution order is evidence-first, and is the same at every site:

1. the **launch-pinned base sha** — the commit `origin/<base>` held when the launcher observed it
   and cut the build branch. A sha cannot go stale, and it IS the cut point;
2. **`refs/remotes/origin/<base>` whenever that ref resolves, in EITHER merge mode** — fully
   qualified, because that is the ref the probe verified. The shorthand `origin/<base>` names a
   DIFFERENT thing when a tag of that name exists: git prefers `refs/tags/` over
   `refs/remotes/`, so `origin/main..HEAD` silently resolves to the tag — measured on git 2.43
   as two files where the qualified form gives one, with a stderr warning and exit 0, and both
   wrappers send that stderr to `/dev/null`. **A value verified in one form and returned in
   another has not been verified.** The remote-tracking
   ref. In pr mode the launch path fetches `+refs/heads/<base>:refs/remotes/origin/<base>` and
   refuses to start the build if that fetch or its rev-parse fails, so it exists and is as fresh
   as launch; in local mode it is preferred too, whenever the repository has one;
3. **`refs/heads/<base>` whenever the remote probe answers ABSENT — git looked and there is no
   such remote-tracking ref — and the local branch resolves.** Absent, not merely "did not
   resolve": since round thirty-one a probe that could not ANSWER is a third outcome and takes
   arm 4, because the reason the remote ref is preferred is that the local one may be stale and
   a failed probe says nothing about staleness. Qualified for the same reason arm 2 is, and it matters MORE here, not less:
   the fallback runs when the environment is already unusual (a fresh clone, a missing remote,
   a detached CI checkout), which is where a stray `refs/tags/<base>` is likeliest and least
   noticed. `refs/heads/main` and `refs/tags/main` coexist happily and git prefers the tag, so
   the bare word named something nobody had checked. **A fallback deserves the same rigour as
   the primary path, not less, because it executes in worse conditions.**
4. **REFUSED, in two distinct states with two distinct exceptions.** (a) NEITHER ref resolves —
   git answered "no such ref" for both — and `diffBaseRef` throws `TridentUnresolvableBaseError`
   while the workflow composes `refs/heads/<base>` anyway, which git rejects (fatal, 128).
   (b) The REMOTE probe could not answer at all: not exit 1 with empty stdout, but a rejected
   spawn, exit 128, or output that is not an object name. `diffBaseRef` throws
   `TridentUndeterminedBaseError` **without asking the second question**, and the workflow emits
   the all-zero object id. Keeping (b) out of (a) is the round-thirty-one fix: they were one
   value, and that value selected the local branch. The
   bare word is NOT inert, which is what "git errors loudly on an unknown revision" missed: git
   resolves it against every namespace, and a same-named TAG answers to it. **This repository
   holds a live instance** — `archive/agent-replies-prior-iter-3b35767` exists as a tag and as
   no branch, so the bare name resolved happily, exit 0. A tag that shares a branch's name is
   the least likely thing an operator meant by "the base branch".

   The two implementations differ here and only here, stated rather than papered over: a shell
   substitution is composed in one process and evaluated in another, so it cannot refuse — it
   can only emit a word the other process will reject. For state (a) that word is
   `refs/heads/<base>`; for state (b) it is the ALL-ZERO OBJECT ID **at the repository's own
   hash width** — 40 zeros under SHA-1, 64 under `--object-format=sha256` — which is why that
   arm is a shell expression rather than a literal: the width is a property of the repository
   asking the question, not of this process. Measured on git 2.43.0: `fatal: Invalid revision
   range`, exit 128, no output, and it stays that way with a tag AND a branch of that name
   present, because git ignores a ref whose name is exactly the hash width in hex — **and
   nothing else**.

   **This sentinel's guarantee has been overstated twice, the same way both times.** It was
   `refs/trident-probe-failed/<base>` for one round: that namespace is ordinary and writable,
   so `git update-ref` on it makes the range resolve and return a wrong diff at exit 0. It was
   then a fixed 40 zeros for one round: in a SHA-256 repository that is an ordinary ref NAME,
   and a branch of that name makes the range resolve at exit 0 — with the mirror hole in SHA-1,
   where a branch named 64 zeros does the same. Each time the qualifier left out was the one
   that made the measurement true — "while nobody has created that ref", then "in a SHA-1
   repository" — so the property was stated of the VALUE when it had been measured of one
   repository's CONFIGURATION.

   The qualifier that remains is named rather than argued away: if `git rev-parse
   --show-object-format` cannot answer, the arm falls back to 40 zeros. In every failure mode
   measured — outside a repository, and `.git/objects` unreadable — the probe, the format read
   and `git diff <x>..HEAD` all fail together (128, 128, 129), so where the fallback is reached
   git refuses the range on its own account. Both halves are asserted, including that the
   emitted word is one git rejects AFTER every ref that could shadow it has been created, in
   BOTH object formats.

   Arm 3 is what a repository with no remote gets, what a worktree whose `origin` is configured
   but whose base ref is missing, deleted or unfetched gets, and what a fresh clone gets: the
   local branch IS the base of record there, and there is no better answer without a fetch,
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
- [ ] **Local mode gets the SAME resolution as pr mode, and `refs/heads/<base>` is reached only
      when `refs/remotes/origin/<base>` does not resolve** — not "only with no remote", which
      this criterion carried after the condition it names had already been narrowed, and not
      "the bare name", which it said until round nineteen replaced that answer with a qualified
      ref. The fallback was `merge_mode`-keyed,
      which is the last place this defect
      lived: local mode against a stale `main` produced five files where the branch changed one.
      Verified by "LOCAL MODE, unpinned, WITH a remote: same stale ref, same ONE file", which
      asserts the resolved base AND the file list AND the five-file contrast measured from git in
      the same repo — the previous version of this test asserted the command *shape* and could
      not see the bug in the fixture it ran against. Mutating the fallback back to its
      MERGE-MODE-KEYED form reddens it.
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
      call issues exactly one) and, in `trident/orchestrator.test.ts`, a PAIR of dispatches:
      "A PINNED dispatch issues NO origin-ref probe" (no probe argv on the host, with a
      positive control that the asserted argv is the one `originBaseResolves` actually
      builds) and "an UNPINNED dispatch issues EXACTLY ONE origin-ref probe", which runs a
      local-mode dispatch whose base pin read FAILS — so `base_sha` stays null, asserted as
      null rather than assumed — and counts the probes on the host for that one tick.
      **The unpinned half used to call `originBaseResolves` directly**, which tests the
      helper's argv and cannot see an orchestrator that skips the probe, issues it twice, or
      computes it eagerly — the whole content of this criterion. Mutations, both directions
      because both are regressions this names: dropping `diffBaseRef` from the dispatch
      (ZERO probes) reds it, and making the binding invoke the thunk twice (TWO) reds it;
      restoring the eager `await` in the caller reds the pinned one. **A function cannot enforce an
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
- [ ] **An option-shaped base is refused at the binding, and EVERY interpolated git rev-range
      in the shipped modules is shielded — enumerated by the `..` operator, not by a variable
      name.** A name beginning with `-` is read by git as a FLAG, not a revision:
      `--output=<path>..<head>` writes that file, and two of the four command families exit 0
      while doing it. `diffBaseRef` throws rather than returning such a name — refusing to
      *probe* it (an earlier round's mitigation) only routed it to the unguarded branch.
      Verified by `trident/diff-base-option-shaped.test.ts`: the binding refuses under both
      probe answers; **every TypeScript range is built by `gitRangeArgv` and cannot omit
      the marker** (asserted as a property over the five argv shapes the tree uses — present
      exactly once, after every flag, before the operand, with `-c` ahead of the subcommand);
      **`orchestrator.ts`, `merge.ts` and `mutation-prover.ts` now contain NO range of their
      own**, asserted as zero and named file by file; and the ones that remain — prompt commands
      in `inner-workflow.mjs` and two shell lines in the wrappers, which a helper cannot reach
      because they are executed by an agent or by bash — each carry the marker in their own
      command. **The list is `OUT_OF_REACH` in that test, compared against what the scan found,
      and this criterion deliberately states no count of its own**: the count changed on a merge
      from `main` (a new re-plan prompt arrived carrying a bare-name range, repointed here), and
      a number retyped in prose is a second copy of a fact that drifts. Plus,
      per command family against real git, the marker is shown to be what stops the write while
      ordinary ranges still work.
      **The count this replaces was wrong, and the test was right.** It read "21 hits, 18
      shielded, 3 notes plus one shell label" — 22 from a population of 21. Re-derived on the
      tree: 21 hits were 17 shielded COMMANDS plus 4 argued non-invocations (3 operator-facing
      notes and `codex-review.sh`'s `DIFF_SRC` label, which is attributed to the command above
      it and so looked shielded while not being a consumer at all). The prose had counted that
      label twice — once as shielded, once as excused.
      **"Its own command" is parsed, not guessed from proximity.** The first version of this
      instrument called a range shielded if the marker appeared anywhere in the twelve
      preceding lines, so a protected command one to twelve lines above an unprotected one
      shielded it and the criterion was unenforced again. Attribution now runs from the
      nearest preceding `git` TOKEN in the comment-blanked source to the range operand — the
      argv array (including the multi-line form) or the shell command — and a range with no
      `git` token within 600 characters is **UNATTRIBUTABLE, which fails rather than passes**.
      Controls, both halves: a fixture whose protected command precedes an unprotected one
      must report exactly one offender, and the same fixture with the second command shielded
      must report none — driven through the real detector, not a second per-line filter, which
      is what the previous control did (it proved *a* detector worked, not *this* one).
      **The instrument this replaces was keyed to `${baseRef}` and therefore blind to
      `computeDiffLineCount`'s `base_ref` and to `mutation-prover.ts`'s three-dot range spread
      over its own argv lines — both of which shipped unshielded.** Mutations, each measured:
      unshield `computeDiffLineCount`, unshield the three-dot argv, drop the marker from a
      prompt-string range, or plant a consumer under a name that appears nowhere in the tree —
      each reds this criterion. A first attempt at the fixed instrument passed all of them,
      because the statement window included the COMMENTS that name the marker; it now strips
      comments, string-aware.
      **Residual gap, stated rather than left implicit:** a range assembled without an
      interpolation adjacent to the operator (a fully computed operand string, or `..` reached
      by concatenation across statements) is outside this matcher, as is any module not in the
      list above. Attribution is textual rather than a real AST parse, so a `git` token inside
      a string literal that is not a command could in principle attribute a range to itself;
      the 600-character bound and the pinned per-file counts are what keep that loud. Adding a module is a one-line change to `MODULES`; the list is pinned by the
      per-file counts so a new consumer inside those files is a hard failure.
- [ ] **The wrapper promotes BY KIND, not by string shape.** `codex-review.sh` takes a general
      `[base-ref]`. Promoting whenever `origin/<x>` resolved meant a **tag** `release` was
      silently rewritten to the remote branch `origin/release` — a different commit — because
      `origin/<x>` resolving proves a remote-tracking ref exists, not that the argument was a
      branch. Verified by `trident/codex-review-base-ref.test.ts`, which builds one repository
      holding both collisions at once and pins the COMMIT each argument resolves to: a
      remote-tracking ref is promoted **whether or not a local branch of that name exists**
      (the detached CI checkout is the ordinary case, and requiring a local branch rejected it
      until round twenty-six), a tag is not promoted, an ambiguous branch+tag name is REFUSED,
      a tag-only name is REFUSED, and an unresolvable name is REFUSED. What is kept VERBATIM is
      now only what already satisfies the shape property: a 40-hex object name that resolves,
      and an explicit `refs/…` path. (`origin/<x>` is QUALIFIED to `refs/remotes/origin/<x>`
      and `HEAD~1` is RESOLVED to an object name — this criterion listed both, plus an unknown
      name, as "kept verbatim" until rounds twenty-two and twenty-three.) The block under test
      is extracted from the shipped script rather than retyped; mutating it back to the
      string-shaped form reddens two tests.
      **The PRECEDENCE is pinned as a table, not as one test per collision.** One fixture holds
      every competing ref at a DIFFERENT commit — `refs/heads/main`,
      `refs/remotes/origin/main`, `refs/remotes/origin/origin/main`, `refs/tags/origin/main` —
      and asserts which COMMIT each input form resolves to, run twice (tag present and absent,
      because the tag masks the arm order that the nested ref exposes). A test per collision
      only fails on the collision someone thought of; the table fails on any future reordering.
- [ ] **The fallback is reached whenever the REF does not resolve — not only when the repository
      has no remote.** Two fixtures, because they are different states and an earlier draft of
      this criterion named only the first: "NO REMOTE: the fallback is refs/heads/<base>" removes
      the remote and every `refs/remotes/` ref; "CONFIGURED ORIGIN, MISSING BASE REF" keeps
      `origin` configured and deletes only `refs/remotes/origin/main`, which is the ordinary
      state of a fresh worktree that has not fetched. Both assert the substitution resolves to
      **`refs/heads/main`** — it was `main` until round nineteen — and that a real diff is still
      produced. A third fixture covers the world where the local branch is gone too and only a
      TAG answers to the name: there the composed word is still `refs/heads/main`, git refuses
      it, and no diff is produced at all. Without the first the fix would be "always prefer
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
- [ ] **What each wrapper's range line does with the value it is handed is exercised, not just
      argued.** Trident no longer hands either wrapper a bare name — every `diffBase` arm is a
      sha or a qualified ref — but argv comes from anyone, and the wrapper's own behaviour is
      what makes the composing side's choice load-bearing. Verified by
      `trident/codex-wrapper-range-line.test.ts`, which extracts both shipped lines by text and
      RUNS them: in a no-remote repository a bare `main` yields the branch's own work (pinned
      file list and count); in a repository whose local base is stale the same line handed that
      bare name yields the inflated answer while the resolved ref yields the correct one — so
      the wrapper is shown to be incapable of repairing a bad base, which is why the composing
      side must never guess one. It also measures what a padded name does there (an empty diff,
      because `2>/dev/null || true` swallows git's fatal), which is why the binding refuses one.
      **This criterion read "the fallback is legitimate, so the bare name does reach …" until
      round nineteen removed that fallback** — an acceptance criterion demanding behaviour the
      code had deliberately deleted, which is the citation-sweep lesson one level up: the code
      moved three times and the account moved once.
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
      `codex-review.sh` starts weaker — its argv default is the literal `main` — and closes
      it itself: the argument is qualified to `refs/remotes/origin/<x>` when that ref resolves
      and to `refs/heads/<x>` otherwise, with an ambiguous or tag-only argument REFUSED. (This
      criterion said "demoted to `origin/main`", a shorthand production stopped returning in
      round seventeen.) Verified by `trident/inner-workflow.test.ts` and
      `trident/__tests__/cross-model-dispatch.test.ts` (the wrapper argv carries the
      resolved ref, per merge mode), by `trident/codex-wrapper-range-line.test.ts` (what each
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
      gate's own `runControls()` — **its `wantPositive` list is the count and the positions,
      and this criterion deliberately does not restate them**: a number retyped here is a
      second copy of a fact, and the copy in this item had already drifted from the list (it
      said five, at positions the control does not use). Plus a negative control whose only hit
      is an un-argued exemption. Both run before the tree is touched, and the same property is
      asserted by "an empty scan set is a FAILURE, not a pass" and by the planted-offender
      mutation test.
      **Every near-miss in the silent lists carries the variant that must be REPORTED**, because
      a control that passes for the wrong reason occupies the slot: one of them was
      `'git diff refs/tags/' + baseBranch` with no `..` at all, so the matcher never examined
      it and its silence proved nothing.
- [ ] **A probe that CANNOT ANSWER is a different input from one that answers NO, and the two
      reach different results.** `refResolves` returned a boolean and folded every exception,
      every non-1 exit and every unparseable stdout into `false` — and `false` SELECTS THE NEXT,
      LESS QUALIFIED ARM, which is the #546 defect one level down. It is now tri-state:
      `'absent'` is exactly exit 1 with empty stdout (measured on git 2.43.0; `rev-parse`
      outside a repository exits 128), everything else that is not a resolved object name is
      `'unknown'`, and an `'unknown'` at the REMOTE position refuses with
      `TridentUndeterminedBaseError` without asking the second question. Verified by "THE PAIR:
      a REJECTING probe and an ABSENT probe reach different results, on the same base", which
      compares the two OUTCOMES rather than asserting them separately, and by "AT THE SOURCE".
      **Both directions, because each alone is satisfiable by the wrong fix**: reading a failed
      probe as absence passes any test that only asks for "handles probe failure", so the pair
      must be unequal; and refusing on EVERY non-resolution passes the pair while breaking the
      fresh-clone path repaired in round twenty-six, so "THE COMPLEMENT: an ABSENT remote probe
      still selects `refs/heads/<base>`" pins the other side. Mutation-verified: returning
      `'absent'` from the catch reds two tests, dropping the `'unknown'` throw reds two, and
      widening it to `remote !== 'resolved'` reds seven. The `.mjs` cannot throw — it composes a
      word for another process — so it emits the ALL-ZERO OBJECT ID, which satisfies the shape
      property on its other limb (a full object name) and which git cannot resolve; verified by
      "THE .mjs SIDE", which drives all
      three arms with real git (ref present, ref absent, and outside a repository) and shows the
      refusing word producing exit non-zero and no output in a repository where
      `refs/heads/<base>` does exist, so the refusal is the word's doing and not the world's.
- [ ] **The refusing word cannot be MADE to resolve, and the test tries.** For one round that
      word was `refs/trident-probe-failed/<base>`, and its guarantee was a fact about the
      fixture: the namespace is ordinary and writable, `git update-ref` on it succeeds, and the
      range then returns a wrong diff at **exit 0** — the defect this item exists to remove,
      reintroduced by the mechanism meant to prevent it, reachable by anyone who can write a ref
      in the build checkout. The word is now the all-zero object id AT THE REPOSITORY'S OWN
      HASH WIDTH, which git cannot resolve because it ignores a ref whose name is exactly the
      hash width in hex — 40 under SHA-1, 64 under `--object-format=sha256`, which is why that
      arm is a shell expression rather than a literal. Verified by "THE .mjs SIDE", which **creates the old poison ref and asserts
      the range against it SUCCEEDS** (so the change is necessary, not cosmetic), then creates a
      tag AND a branch named 40 zeros and asserts the emitted word still fails both as a range
      operand and as a `rev-parse --verify` probe. A rejection asserted without first trying to
      make the word resolve is a claim about the test's environment, not about the word.
- [ ] **THE RESOLUTION PATH does not assume SHA-1 — and the LAUNCH path still does, stated here
      rather than implied.** `git init --object-format=sha256` names objects in 64 hex. The
      40-only recognisers refused a legitimate pinned base outright (`diffBaseRef`, the `.mjs`
      twin, the wrapper's KIND-1 test and its shape assertion) and read a legitimate probe answer
      as `'unknown'`; the refusing word, a fixed 40 zeros, was an ordinary ref NAME there, so a
      branch of that name made the range resolve at exit 0. `diffBaseRef` and its `.mjs` twin now
      accept EITHER width, because each is handed a value and has no repository to ask;
      `codex-review.sh` accepts exactly the width `git rev-parse --show-object-format` reports,
      because it HAS one and accepting both there lets a wrong-width REF capture the base; and
      the refusing word is derived from the same question where it is evaluated.
      **WHAT THIS CRITERION DOES NOT CLAIM.** The launch path pins the base sha behind a 40-only
      test (`orchestrator.ts:4143`, which fails the run, and `:4174`, which silently declines to
      pin), so in a SHA-256 repository a valid base tip does not pin. That is a NON-GOAL here
      rather than an oversight: `FULL_OID` and the persisted `outer-published:<40hex>:…`
      checkpoint vocabulary assume SHA-1 as well, so widening the launch recognisers alone would
      produce a configuration that pins correctly and then fails at resume — support that looks
      like support. The whole chain is #667. This repository is SHA-1 (measured with
      `git rev-parse --show-object-format`), so none of it is live either way. **And the test
      proves what it claims and no more**: it exercises the binding, the `.mjs` twin and the
      wrapper directly, and says in its own text that it does not fire a launch, so nobody reads
      it as evidence about a path it never touches. Verified
      by "THE HASH FUNCTION IS NOT A PROPERTY OF THE VALUE — SHA-1 and SHA-256" in
      `trident/diff-base-option-shaped.test.ts`, which runs the fixture in BOTH formats and, in
      each, creates a branch AND a tag at both widths before asserting the emitted word still
      refuses — **and asserts that the OTHER width RESOLVES, exit 0, with a file list**, which
      is what makes the derivation necessary rather than tidy; and by "A SHA-256 OBJECT NAME IS
      A VALID ONE TOO" in `trident/codex-review-base-ref.test.ts`, whose complement is that 40
      hex in a SHA-256 repository is NOT accepted as an object name, so this is not "accept any
      hex". Mutations: pinning the sentinel to 40 zeros reds the sha256 case; narrowing either
      implementation's recogniser reds the pin parity case; narrowing the wrapper's reds the
      wrapper case. The fixture axis is the point — **a fixture that only ever supplies one hash
      width cannot fail on a hash-width assumption**, which is why this survived thirty-two
      rounds of review.
      **What is NOT closed, named rather than implied**: `FULL_OID` in `trident/merge.ts` and
      `trident/inner-workflow.mjs`, and the `outer-published:<40hex>:…` checkpoint vocabulary,
      still assume SHA-1. They are outside this item's rule (they are about run heads and
      persisted checkpoint text, not about a rev-range base), and a persisted format is not
      something to widen in passing — filed as #667, with the exposure stated: every repository
      trident builds today is SHA-1, so it is latent rather than live.
- [ ] **An operand that enters through `gitRangeArgv` is a resolved value or an argued one.**
      The constructor guarantees the MARKER and asks nothing about the OPERAND, so a bare base
      branch name passed through it is invisible to a gate that enumerates `..` in source text —
      which is how a site could be "fixed" into silence. Verified by "B · every operand that
      enters through `gitRangeArgv`", which reads each call site's operand out of the call and
      requires it in a table with a reason; and, because mutation showed a change at the CALLER
      of a forwarding helper left that green, by the same enumeration over the forwarder's call
      sites. **Both directions**: an unenumerated operand fails, and a table entry with no call
      site fails, so a removed site cannot leave a stale argument behind.
      **The one operand that is deliberately NOT a resolved base** is the arbiter's conflict
      history (`merge.ts`, `sideHistory`): those two ranges must denote the revisions
      `git rebase <base>` was actually given, because the conflict being judged is the one THAT
      produced — resolving them differently would describe a comparison that never happened.
      That is argued in place with `DIFF-BASE-OK:` and carries the marker like every other.
- [ ] **Every site in the class is either fixed or has evidence that it is correct.** The
      dispositions are recorded in the as-built record for the branch that ships this.
