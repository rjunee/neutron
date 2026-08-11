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
`OWNER`, `MEMBER` or `COLLABORATOR`, and the filter runs BEFORE the parse so an
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

`scripts/ci/trident-verdict.test.ts` — **79 tests**, `bun test`, 0 fail. The
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

**The second-round battery is a script, not a sentence.** Sixteen mutants applied
one at a time, suite run per mutant, source restored and verified byte-identical
by SHA-256 after each. Result: **16 applied, 16 caught, 0 survived.**

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
