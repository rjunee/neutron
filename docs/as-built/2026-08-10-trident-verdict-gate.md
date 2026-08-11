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
prints the exact command that feeds THAT branch into a review lane, and the
command is real rather than aspirational: the review loop already takes `branch`
and `prNumber`, re-enters the branch without `git switch -c`, and reuses the
existing PR instead of opening a duplicate. `redeemCommand()` is the single
definition; `.githooks/pre-push` prints it by calling the gate with
`--redeem-command` rather than carrying a second spelling that would drift. A
drifted redemption path is a gate that only rejects.

**The record is not a file in the PR's own diff.** It is the fenced
`review-evidence` PR comment the review loop already posts at the end of a clean
round, reading the head SHA off the remote at post time. Nothing new was invented
on the producing side, and a committed `verdict.json` was rejected as
self-certifying: the author of a change would also be the author of its approval.

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

**The positive control is in the gate, not just in the tests.** A lookup that
cannot read the format returns a negative indistinguishable from an answer. Before
any absence is believed, the gate parses a known-good fixture through the same
parser and asserts it clears the bar; a failure there prints `THE LOOKUP IS
BROKEN` and deliberately does not print "no verdict recorded". Two outcomes, two
messages.

Two hazards the parser closes because the sibling implementation was bitten by
them: the gate's own FAIL template is `<...>`-shaped and never fills in
`commit:`, so CI output pasted back into a thread cannot arm the gate (there is a
test that generates the live output and feeds it back); and the evidence fence
must sit at column 0 on both lines, so a comment merely quoting an older block
cannot displace the newest real verdict. The bypass marker is column-0 for the
same reason — the gate's own hint prints it indented and placeholder-shaped.

## Verification

`scripts/ci/trident-verdict.test.ts` — 45 tests against `runGate`, the real call
site, with the GitHub API faked at its `fetchJson` seam. Testing only the pure
parser would have stayed green through three of the mutants below.

**Ten mutants applied to the gate, each caught, source restored byte-identical:**
accepting a PR with no verdict · keying the verdict off anything but the head SHA
· reading a hedge (`ran: yes (backgrounded)`) as `true` · last-line-wins on a
duplicate key · dropping the redeeming command from the failure output · letting
an empty bypass reason through · believing a negative from a broken lookup ·
accepting a partial head SHA · failing open when the PR number is absent ·
never requiring mutation evidence.

**Live positive control against the real producer.** The verdict format is
already emitted by the review loop on another repository, so a real comment was
fetched from the live API and pushed through this parser: it parsed, cleared the
bar against its own SHA, and failed against a different SHA. That sample is
deliberately NOT committed as a fixture — it carries another repository's
internals — so the in-tree control is a structurally equivalent neutral fixture.

**Behaviour probe on the hook**, not a text assertion: the hook was run with a
real ref line on stdin. It prints the redeeming command with the live branch name
filled in and exits 0. A push is fine; only the merge is gated, and there is
nothing to satisfy at push time because a verdict names a SHA that has to exist
first.

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

Docs: `docs/trident-verdict-gate.md`.
