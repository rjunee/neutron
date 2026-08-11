## 2026-08-10 — a merge now needs a review verdict, and the refusal hands the branch back

The rule that code here goes through the build-and-review loop was written down,
and hand-rolled PRs went around it anyway — twice. The second time is the
informative one: the failure mode is not ignorance of the rule, so a third,
sterner wording would have changed nothing about what a merge path can observe.
`trident-verdict` (a job in `.github/workflows/ci.yml`, implemented in
`scripts/ci/trident-verdict.ts`) refuses instead.

**Keyed to the head SHA, never the branch or the PR number.** The verdict names
the 40-hex commit it examined, so a later fix commit invalidates an earlier
approval by construction and a fresh round is forced rather than inherited. Keyed
on the branch, a clean review of an early revision would silently bless whatever
landed after it. The load-bearing consequence is asserted directly: a verdict for
an OLD sha does not satisfy a newer head.

**The refusal is the feature.** A gate that only rejects throws work away — by
the time it fires the branch is written, tested and pushed. So every failure path
prints the exact command that feeds THAT branch into a review lane.
`redeemCommand()` is the single definition; `.githooks/pre-push` prints it by
calling the gate with `--redeem-command` (through
`scripts/ci/trident-redeem-advisory.sh`) rather than carrying a second spelling
that would drift. A drifted redemption path is a gate that only rejects.

**The printed command was WRONG in the first round, in the way that mattered
most.** It read `/trident v2 … branch=<b> prNumber=<n> …`, borrowed from the inner
workflow's argument names — which are real *there* and unreachable from the typed
command. The dispatcher's parse step recognises only the task text plus `repo=`,
`rounds=`, `mode=` and a bare `ralph`; anything else that looks like a flag is
swallowed into the task text, and the task text is what gets slugified into a
branch name. Pasted verbatim, the redeeming command therefore opened a SECOND
branch and a DUPLICATE PR — precisely the waste the whole feature exists to
prevent, printed by the feature itself. The covering test was tautological: it
re-asserted the generated string.

The command now carries the branch and the PR in the task text, where the planner
and the builder read them, and `DISPATCHER_PARSED_FLAGS` names the parsed set. The
replacement test inspects the generated command for flag SHAPES and fails on any
that is not parsed, so re-adding `branch=` reds the suite. The generalisable
lesson: **an argument name being real inside an implementation says nothing about
whether the command line can reach it** — and a test that asserts a generated
string against itself cannot tell the difference.

**The record is not a file in the PR's own diff.** It is the fenced
`review-evidence` PR comment the review loop already posts at the end of a clean
round, reading the head SHA off the remote at post time. Nothing new was invented
on the producing side, and a committed `verdict.json` was rejected as
self-certifying: the author of a change would also be the author of its approval.

**And it must come from an account with write access — this repository is
public.** The first round selected the verdict by BODY ALONE, which made a
required check writable by any GitHub account on the internet: post the block,
turn the check green on a change you never reviewed. The mirror-image abuse is
worse in a quieter way — a malformed newest candidate is fatal by design, so a
stranger could force a REVIEWED PR red at will. `author_association` must now be
`OWNER` or `COLLABORATOR`, and the filter runs BEFORE the parse so an
untrusted comment cannot reach the parser at all. "Someone posted one and it does
not count" is its own message, separate from "nobody posted one"; they call for
opposite next actions. The trade is named rather than hidden: an external
contributor on a fork cannot clear their own gate, and needs a reviewer with write
access to post the verdict.

**The surface classification had three holes, all of them fail-open.** Renames
were judged by DESTINATION path only, so `git mv .github/workflows/ci.yml docs/`
— or a production module renamed to `*.test.ts` — hid the surface it moved off;
`previous_filename` is now consulted too. Extensionless executables were prose:
`bin/neutron`, the CLI entry point, owed no evidence, because a shebang script has
no extension by convention and suffix matching was the only rule. And
`tsconfig.base.json` — the config every other one extends, so the type surface of
the whole tree — was missing from the root allowlist that already listed
`tsconfig.json`.

**The file list can be truncated invisibly.** The files endpoint caps at 3,000
files, and a capped response is a complete-LOOKING short page: it terminates the
paginator exactly like a genuine last page. The list length is now compared
against the PR's own `changed_files`, and a short list reports *could not read*
rather than classifying the surface from whatever the first 3,000 files were.

**Wired to the context that already blocks.** `test` is the required check on this
repo, so `test` `needs:` the verdict job and checks
`needs.trident-verdict.result` on pull-request events specifically. That makes
the gate blocking with no repository-settings change, and it inverts GitHub's
usual hazard — a skipped verdict job FAILS the aggregator instead of satisfying
it. On a push to the default branch the job is skipped by design (there is no PR
to read a verdict for) and the aggregator does not consult it, so a bookkeeping
push does not red the branch.

**`TRIDENT_BYPASS=<reason>` at column 0 in the head commit message** passes the
gate, prints the reason, and emits it as a GitHub notice annotation. The commit
message is the paper trail on purpose: it is bound to the SHA for free, it merges
into permanent history, and unlike a PR body it cannot be edited afterwards. A CI
environment variable would have satisfied the gate while leaving no trace, which
is the one thing an escape hatch must not do. An empty reason, an unfilled
`<...>` placeholder, a value with nothing readable in it, and two markers in one
message all fail.

**The positive control is in the gate, not just in the tests — and it now drives
the REAL lookup.** A lookup that cannot read the format returns a negative
indistinguishable from an answer, so before any absence is believed the gate runs
itself against known inputs: a good verdict for the head SHA must pass, no verdict
must fail, and a verdict for a DIFFERENT SHA must fail. A failure prints `THE
LOOKUP IS BROKEN` and deliberately does not print "no verdict recorded".

The first round's control called `parseVerdict` directly, and that was not a
stylistic shortfall — a mutant emptying the CANDIDATE FILTER passed it while
reporting "no verdict recorded" for every PR in the repository. **A control that
skips the step which broke proves the tool can read a string, not that it can find
an answer.** The control now drives `gate` itself: pagination, API-shape handling,
the author filter, the candidate selection. The same mutant is caught, and it was
caught the moment the control was rewritten — it immediately failed on an endpoint
the control did not model, before any test was written.

Two hazards the parser closes because the sibling implementation was bitten by
them: the gate's own FAIL template is `<...>`-shaped and never fills in
`commit:`, so CI output pasted back into a thread cannot arm the gate (there is a
test that generates the live output and feeds it back); and the evidence fence
must sit at column 0 on both lines, so a comment merely quoting an older block
cannot displace the newest real verdict. The bypass marker is column-0 for the
same reason — the gate's own hint prints it indented and placeholder-shaped.

## Verification

`scripts/ci/trident-verdict.test.ts` — **100 tests**, `bun test`, 0 fail. The
subject is `runGate`, the real call site, with the GitHub API faked at its
`fetchJson` seam. Testing only the pure parser would stay green through the
majority of the mutants below.

**A correction to this entry's first version, which overstated its own
verification.** It claimed 45 tests when the suite ran 51, and it claimed
"seventeen mutants, each caught" on the strength of prose alone — no deterministic
artifact, no re-runnable script. An adversarial pass then reproduced **three
surviving mutants** in that same suite, so "each caught" was not merely unproven,
it was false. The mutants that survived: the pagination terminator, the
negative-count guard, and the empty-mutation-field guard — every one of them a
guard with code and no test. **A coverage claim in prose is a claim, and this is
what it is worth: three holes in the first sentence anyone checked.**

**The second round said "16 applied, 16 caught, 0 survived". That was false too.**
It described itself as "a script, not a sentence" — but the script was run in a
scratch directory and thrown away, so the number reaching this document was still
a sentence, and an adversarial pass then reproduced **six survivors** in that same
suite: the `codex.blocking` and `adversarial.blocking` comparisons (`> 0` mutated
to `> 1` — every case used 0 or 2, so *one* unresolved P0 passed), the integer
regex (`\d+` → `\d*`, so an EMPTY count read as zero), the file-list truncation
check off by one, the `MAX_PAGES` terminator, and one more. **Two rounds in a row
overstated the same thing, in the same way, while the entry itself lectured about
prose coverage claims — which is the whole reason the battery is now committed
code.**

**Third round: the battery is `scripts/ci/trident-verdict-mutation-battery.ts`.**
It applies each named mutant to `scripts/ci/trident-verdict.ts`, runs the suite,
restores the file, and exits non-zero if anything survived — so the number is
reproduced by running it rather than by trusting this paragraph:

    bun scripts/ci/trident-verdict-mutation-battery.ts
    → baseline: unmutated suite green (exit 0, 0 failing)
    → 42 mutants applied, 42 caught, 0 survived

A stale mutant (one whose pattern no longer matches the source) is reported as
`STALE-PATTERN` and counts as *not caught*, so the battery cannot quietly shrink
while still reporting success. The round-2 survivors each have a test now, named in
the suite's `ROUND 3` section; and the run also caught a seventh the adversarial
pass had not reported — `adversarial.ran` could be deleted outright and the suite
stayed green, because the hedge-value loop covered `codex.ran` only. **A guard that
exists twice needs coverage twice.**

| mutant | the test that went red |
|---|---|
| candidate filter always empty *(round-1 survivor class)* | the positive control — "a known-good verdict for the head sha PASSES — the gate returned 1, expected 0" |
| pagination terminator removed *(round-1 survivor)* | an executable file on page 2 still requires mutation evidence |
| trusted-author filter removed | a stranger cannot green the gate |
| negative-count guard removed *(round-1 survivor)* | a negative blocking count is rejected — including `-0` |
| empty-mutation-field guard removed *(round-1 survivor)* | a blank mutation field is rejected |
| unusable-evidence (`n/a`) guard removed | an `n/a`-shaped mutation field is rejected |
| file-list truncation check removed | a file list capped by the API is refused |
| `previous_filename` ignored | a rename cannot hide the surface it moved off |
| extensionless executable classified as prose | `bin/neutron` is not prose |
| `tsconfig.base.json` dropped from the allowlist | the shared base tsconfig is gated |
| redeem command regrows `branch=` / `prNumber=` | the printed command contains no spelling the dispatcher would swallow |
| redemption dropped from the broken-control path | every failure path prints the command — a broken positive control |
| redemption dropped from the absent-PR path | every failure path prints the command — an absent PR number |
| redemption dropped from the bad-head-SHA path | every failure path prints the command — a partial head SHA |
| redemption dropped from the absent-repository path | every failure path prints the command — an absent repository |
| advisory names the checked-out branch | it names the PUSHED branch, not the checked-out one |

**"Every failure path prints the redeeming command" was false when first written,
in four places.** Missing `GITHUB_REPOSITORY`, a bad PR number, a bad head SHA and
a broken control each returned 1 with no command. The module header, this document
and the reference doc all asserted the universal. The mechanism of the miss is
worth keeping: the covering test was a TABLE of failure shapes with a universal
NAME — `every failure path prints …` — and the table simply did not enumerate
those four. **A universal claim in a test name is only as true as the table under
it**, and the name is what a reader believes. The four shapes are now rows in it,
along with the untrusted-author and truncated-list paths.

**The earlier battery's one honest line is kept**, because it is still the best
illustration of the pattern: placeholder rejection had no test, because the "own
FAIL output pasted back" test could not reach it — the printed template is
indented and dies on the fence check first. Every scalar has a type rule that
catches a placeholder, but **mutation entry values are free text**, so a template
pasted at column 0 would have satisfied the mutation clause with three `<...>`
strings.

**Live positive control against the real producer.** The verdict format is
already emitted by the review loop on another repository, so a real comment was
fetched from the live API and pushed through this parser: it parsed, cleared the
bar against its own SHA, and failed against a different SHA. That sample is
deliberately NOT committed as a fixture — it carries another repository's
internals — so the in-tree control is a structurally equivalent neutral fixture.

**The live run found a real defect the fixtures could not.** Pointed at a real PR
with a head SHA the API does not have, `gh` exited 422, the throw escaped the
entry point, and the gate printed a stack trace with **no redeeming command** —
the one output it must never produce, since a red check whose message an author
cannot act on is how a gate earns a bypass habit. The throw is now caught, named
as "could not READ this PR" rather than "no verdict recorded" (two different
facts, two different messages), reduced to the error's first line, and it still
redeems. Still exit 1: "I could not check" must never be worth more than a failed
check. Two further mutants cover it.

**Both escape paths were exercised LIVE on a real pull request, not only against
fixtures.** The push-time advisory ran on a real `git push` and printed the
redeeming command naming the branch actually being pushed. And the bypass fired in
a real CI run: the gate read the marker off the head commit through the API, named
the SHA it applied to, printed the reason, and emitted the notice annotation —
`trident-verdict: BYPASSED for <sha> — no review verdict was required`. That is the
paper-trail property demonstrated rather than asserted, which matters more for an
escape hatch than for anything else in the change: the failure mode of a bypass is
that it works and leaves no record.

**The push-time advisory named the wrong branch, and only text coverage existed.**
It read `git rev-parse --abbrev-ref HEAD`, so `git push origin some-other-branch`,
a multi-ref push and a tag push all printed a redemption command for whatever
happened to be checked out — and naming the wrong branch in a redemption command
is worse than naming none, because it sends the work somewhere it is not. The
advisory is now `scripts/ci/trident-redeem-advisory.sh`, which takes git's pre-push
ref lines on **stdin** and names the branches actually being pushed; the hook keeps
the lines it consumes and pipes them in. Being a separate script is the point:
it can be RUN in a test with a real ref line and its output checked, which the
in-hook version could not offer. Three probes now do exactly that — a
single-branch push names that branch and not the checked-out one, a multi-ref push
names both, and a tag push and a branch deletion say nothing at all. It still
never blocks: a push is fine, only the merge is gated, and there is nothing to
satisfy at push time because a verdict names a SHA that has to exist first.

## Not covered

The job runs the PR's own copy of the gate, so a PR editing
`scripts/ci/trident-verdict.ts` to return 0 turns its own check green. That is
inherent to any self-hosted CI gate — the tests a PR must pass are equally
editable — and the backstop is review plus the gate's own surface rule, which
marks such a PR as owing mutation evidence. A direct push to the default branch
never meets the gate at all; closing that needs a require-a-pull-request
branch-protection rule, which is a repository setting rather than a tree change.

A verdict posted after a run has finished cannot retro-green it: the gate reads
the comments at the moment it runs, so the run has to be re-triggered. The
failure message says so and names the command.

**A bypass reason can be dropped by the squash merge.** The marker is read from the
head commit's message — bound to the SHA, uneditable after the fact, which is what
makes it a paper trail. But a squash merge composes a new message from the PR title
and body, so the head commit's body is not guaranteed to reach the default branch,
and after branch cleanup the record of an unreviewed merge would be gone while the
merge stayed. The gate cannot write the squash message; when the hatch fires it now
prints the exact line to copy into the PR body, and the limit is written down.

**Two gaps whose fix is in the review-harness repository, not this tree**, named
here so they are not rediscovered as surprises. The harness classifies a PR's
surface by importing a helper this repository does not have; the probe fails, fails
*closed*, and a prose-only PR is therefore treated as owing mutation evidence that
cannot exist — so the gate's own prose exemption is unreachable from the producing
side and a docs-only PR needs the bypass. And the harness's post-verdict re-trigger
targets a workflow this repository does not have (the checks live in `ci.yml`), so
its automatic recovery from the stale-comment race is a no-op here and the re-run
is manual. Neither belongs in this PR: one repository per change.

Docs: `docs/trident-verdict-gate.md`.

---

## Round 3 — the redemption did not work, and the hatch had no author check

Two blockers from the adversarial pass, both of a kind worth naming.

### The printed command described a mode no code path entered

The failure output claimed the review harness "re-enters an existing branch (no
`git switch -c`) and REUSES this PR — it will not open a duplicate". Read against
the harness rather than assumed, that is false on the path a reader actually takes:

* its inner build/review workflow **does** re-enter and reuse — but only when it is
  handed a branch and a PR number, and only its crash-resume path hands them over;
* its merge step **does** read an adopted branch out of run state, with a comment
  recording why (hand-dispatched PRs on non-trident branches that trident could
  review and then refused to merge) — but nothing on the typed-start path *writes*
  that field;
* a typed start therefore begins with no branch and no PR and mints both from a
  slug of the task text.

So the command, pasted verbatim as instructed, opened a **second branch and a
duplicate PR** — the exact waste the redeeming message exists to prevent. This is
the rule-3a shape from the repo's own guidance: an aspirational docblock describing
intent as though it were implementation, and more dangerous than a stale one because
it is confidently specific.

The fix is not a better sentence about the harness. The output now prints **two
routes in order of what this repository can guarantee**: first *record the verdict*
— wholly in-tree, read by this very file, and the actual bar — and second *hand the
branch to a lane as an ADOPT instruction*, with the failure to watch for named out
loud: *a lane that answers by opening a fresh branch has not redeemed this one.*
`redemption-never-printed` and `adopt-instruction-dropped` are both in the battery,
and the covering test asserts the removed promises do **not** reappear.

📌 **A failure message that promises a mode nothing enters is worse than one that
promises nothing** — the reader follows it, gets a duplicate PR, and concludes the
gate is the problem.

### `TRIDENT_BYPASS` trusted a string in a commit message

The verdict path filtered on write access from the start, because this repository is
public and a verdict is an approval. The hatch beside it checked only that the
marker existed and carried a reason — and **fork authors write their own commit
messages**, so one line would have turned the required check green on a change
nobody reviewed. It is now honoured only when the PR's `author_association` is
`OWNER` or `COLLABORATOR`, the same bar, checked before the reason is even
validated (so an outside author is told the hatch is unavailable rather than invited
to try a better reason). A PR with no marker is untouched by the rule and still gets
the ordinary "no verdict" message.

### The gate was a one-shot read, which made it self-defeating

The gate reads the PR's comments at the moment it runs, and the real sequence is
push → CI red → the review lane posts the verdict. Nothing in GitHub re-triggers a
`pull_request` workflow on a comment, so **every reviewed PR would have needed a
manual re-run** — a mechanism degraded into a chore, and a chore into a bypass
habit. `.github/workflows/trident-verdict-rerun.yml` closes it: an `issue_comment`
workflow that, on a verdict-shaped comment from an account with write access, finds
the `ci.yml` run for the PR's head SHA and re-runs its failed jobs. It grants
nothing — not in the aggregator, no verdict of its own — it only asks CI to look
again. `issue_comment` workflows always run from the default branch, so it is inert
until merged, including on the PR that adds it; that is a property of the event and
is written down rather than discovered.

### A verdict is a public comment, and one had already leaked a path

A live verdict published a home-directory worktree path into a public thread. The
leak gate covers files and commit messages; a PR comment is outside both, and a
comment cannot be un-published. The parser now refuses a verdict carrying a
home-directory absolute path in any of the three shapes a checkout produces —
**without echoing the value**, since the check log is public too. Narrow by design:
`/usr/bin/bun` and `open/composer.ts` pass, and the message says to cite paths
repo-relative.

### Two smaller corrections

* The placeholder regex was greedy — it matched from the first `<` to the last `>`,
  so `TRIDENT_BYPASS=<incident 42> superseded by <p0 fix>` was refused as an
  unfilled template. An unfilled placeholder is by construction one bracketed span
  with no brackets inside it, which is what the narrowed pattern matches.
* The advisory test asserted the checked-out branch name did not appear *anywhere*
  in the output, and the advisory legitimately prints the words `repo=`, `review`,
  `branch` and `PR #` — so a branch literally named `review` would have false-failed,
  invisibly, because CI runs detached. It now anchors on the subject phrase.

### Round 5 — a green check that could not be withdrawn, and two unprovable claims

The re-run workflow was the hole. `types: [created]` meant an edited or deleted
verdict was never re-read; `exit 0` on a `success` conclusion and `gh run rerun
--failed` (which cannot select a verdict job that PASSED) meant a green check could
never go back to red. Together: **"the newest verdict wins" stopped being true the
moment it became green** — the only moment it matters. The trigger now covers
`created, edited, deleted`, matches the pre-edit body as well (editing a verdict into
prose leaves no fence in the new body), re-runs the run WHOLE, and waits out a run
still in progress rather than abandoning it.

The suite could not have caught any of that: it asserted the file *contained the
string* `gh run rerun --failed`. The step's script is now extracted from the YAML and
EXECUTED against a stub `gh` that answers from fixtures and records its calls, so
which run gets re-run is observable. Six workflow mutants ride the battery, because a
workflow is executable surface too.

| mutant | the test that went red |
|---|---|
| `rerun-exits-early-on-a-green-run` | a run that SUCCEEDED is re-run — a newer blocking verdict can still turn it red |
| `rerun-selects-failed-jobs-only` | the whole run is re-run, never only its failed jobs |
| `rerun-triggers-on-creation-only` | posting a verdict re-runs the ci run — the gate is not a one-shot read |
| `rerun-ignores-the-pre-edit-body` | posting a verdict re-runs the ci run — the gate is not a one-shot read |
| `rerun-abandons-an-in-progress-run` | an in-progress run is WAITED for, then re-run — not abandoned |
| `rerun-ignores-which-pr-the-run-belongs-to` | the run that RECORDS this PR number wins, even over a run on this PR's branch name |
| `redemption-dropped-from-one-path` | EVERY red exit SHAPE in the gate prints the redemption |
| `new-red-exit-with-no-redemption` | EVERY red exit SHAPE in the gate prints the redemption |

Two claims were also structurally unprovable. **The battery never ran the unmutated
suite**, and read only the exit code — so an already-red suite, a missing `bun`, or a
signal kill would have certified all 42 mutants as CAUGHT while measuring nothing.
CAUGHT now requires the runner to report failing tests, a measurement that did not
happen is BROKEN, and the green baseline is a precondition (verified: with one test
deliberately broken the battery prints `BASELINE BROKEN` and exits 1 instead of
reporting 42 caught). **And "every failure path prints the redeeming command" was a
universal claim resting on a table that had already missed four paths** — no
enumeration can close that, since adding a `return 1` does not add a row. It is now
checked against the gate's source, walking the enclosing block of each red exit. The
first version of that check used a fixed six-line window, and a mutant that added an
unredeemed red exit SURVIVED it: the window reached over the block opener into the
previous branch and found its `printRedemption`. The indentation walk kills it.

### Round 6 — an association is not a permission, and a log that quotes is a log that leaks

**`MEMBER` was trusted, and `MEMBER` is not write access.** `author_association`
reports a RELATIONSHIP: it means "belongs to the organisation that owns the
repository", which on an org-owned repository is satisfied by a read-only or
triage-only member. The docblock asserted all three trusted values "mean write
access to this repository", two reviewers called it false, and it was. The set is
now `OWNER` and `COLLABORATOR` — exact on a user-owned repository, where a
collaborator has push and `MEMBER` cannot occur at all. That last fact is why this
survived two rounds: the hole was unreachable here, so nothing could ever
demonstrate it. The re-run workflow's trigger list was widened to match the same
two values, because a trigger list wider than the gate is an account that can spend
runner minutes on a check it can never satisfy. The org-owned answer — the
collaborator-permission endpoint, requiring `write`/`maintain`/`admin` — is written
into the docblock and `docs/trident-verdict-gate.md` rather than implemented,
because it costs a token with push access that a fork's `pull_request` run does not
get, and it would fail closed as "could not read this PR" on every fork PR. Trading
a live failure for an unreachable hole is the wrong way round; not writing the
trade down is what leaves the next reader to re-derive it.

**A syntax error published what the home-path rule existed to suppress.**
`rejectHomePath` runs after a line has parsed. An UNPARSEABLE line is quoted back
before that, and it has to be — the author cannot find the line otherwise — so the
one refusal that had to echo was also the one the redaction never reached. It was
the ordering, not a missing check. Every refusal that quotes a value now goes
through `quoteRedacted`, which keeps the diagnostic and replaces the account
segment: the reader still sees the offending line, and `/Users/<name>/…` leaves as
`/Users/<redacted>/…`.

**Mutation evidence had to be non-empty, unbracketed and not `n/a` — and could
still be one sentence pasted three times.** The three fields name three different
observations (what broke, which test went RED, which stayed GREEN), so repeating
one across them names no observation at all; it is the same "nothing was run" the
`n/a` rule refuses, wearing a longer disguise. `finishMutation` now refuses a
self-identical entry, and the gate's own control fixture was rewritten to clear its
own bar. This does not make a verdict provable — the gate cannot observe a run that
happened on a reviewer's machine, and the module header now says so in those words,
alongside the other limit it cannot close (a review lane's dispatcher is not in this
repository, so no test here can make branch adoption deterministic). Both were
raised as defects; both are boundaries, and naming them is the only honest form.

**Three smaller corrections, all latent rather than live, all fixed as
classifier bugs rather than deferred until reachable.** `docs` was exempted at any
depth, so an executable module under a nested `docs/` directory owed no evidence —
the exemption is now anchored to the root prose tree, while `__tests__` keeps its
any-depth exemption because test scaffolding is scaffolding wherever it sits. The
re-run workflow selected a CI run by head SHA with the branch name as tie-break;
a branch name is not a PR identity, so it now prefers the run whose own
`pull_requests` records this PR number, falling back to the branch (empty on
`push`-triggered runs) and then to the newest. And "EVERY red exit prints the
redemption" scanned only literal `return 1`; it now also sees `return <n>` and
`process.exit(<n>)`, and its name says "every red exit SHAPE" because a computed
return value is invisible to a source scan and always will be.

| mutant | test that goes RED |
| --- | --- |
| `member-association-trusted` | MEMBER is NOT write access — it is org membership, and it does not count |
| `error-quoting-unredacted` | a SYNTAX error on a line carrying a home path is quoted REDACTED, not verbatim |
| `self-identical-mutation-accepted` | one sentence in all three mutation fields is not evidence |
| `nested-docs-dir-exempted` | a `docs` directory NESTED somewhere else is not prose |
| `rerun-selects-by-branch-name-alone` | the run that RECORDS this PR number wins |
| `rerun-trusts-a-read-only-org-member` | posting a verdict re-runs the ci run |

The battery itself was the last of it: it reported CAUGHT/SURVIVED counts and threw
away WHICH tests went red, so the per-guard claims in this table were prose sitting
on an aggregate. It prints the failing test names with each mutant now, which is how
the six rows above were read off the run rather than recalled.

### Verification

* `bun test scripts/ci/trident-verdict.test.ts` — **118 pass, 0 fail**.
* `bun scripts/ci/trident-verdict-mutation-battery.ts` — **48 applied, 48 caught, 0
  survived**, reproducible by running it, refusing to report at all unless the
  unmutated suite is green, and naming the tests each mutant reds.
* `bash scripts/ci/typecheck-all.sh` — 51 tsconfigs, all pass. `bash
  scripts/ci/lint.sh` — 0 found across every gate.
* Still open, and unchanged by this round: the codex cross-model lane did not
  complete on round 2 (capacity), so that lane's verdict is owed rather than clean.

**Managed needs the same gate**, and that is a separate PR in that repository —
never one change spanning both trees.
