# The `trident-verdict` gate

`trident-verdict` is a job in `.github/workflows/ci.yml`. It fails any pull
request whose **head commit** carries no recorded review verdict, and its failure
message prints the one command that puts that branch through a review lane.

Implementation: `scripts/ci/trident-verdict.ts`. Proof:
`scripts/ci/trident-verdict.test.ts`.

## Why this is a check and not another paragraph

Code in this repo is required to go through the build-and-review loop. That was
already written down, in prose, and hand-rolled PRs went around it anyway —
twice. The second violation is the interesting one: it means the failure mode is
not ignorance of the rule. Writing the rule a third time, more sternly, changes
nothing about what a merge path can observe.

So the rule now refuses. The observable signal — the check rollup that gates a
merge — carries the review, instead of carrying only "the tests passed".

## Why the failure REDEEMS instead of rejecting

A gate that only rejects throws work away. By the time it fires, the branch is
written, tested and pushed; telling its author "start over through the proper
channel" is how a gate acquires a reputation for being expensive and then
acquires a bypass habit.

Every failure path therefore prints the command that reviews **this** branch:

    /trident v2 repo=<path-to-your-checkout> review PR #<n> on the EXISTING branch <branch> — re-enter that branch, reuse that PR, do not restart from scratch and do not open a new PR

The re-entry it asks for is real: the review loop's inner workflow re-enters an
existing branch **without** `git switch -c` and **reuses the existing PR rather
than opening a duplicate**.

**Why the branch and the PR are in the sentence and not in flags.** The
dispatcher's parse step recognises the task text plus `repo=`, `rounds=`, `mode=`
and a bare `ralph`. Anything else that *looks* like a flag is swallowed into the
task text — and the task text is what gets slugified into a branch name. The first
version of this gate printed `branch=<b> prNumber=<n>`, borrowed from the inner
workflow's argument names, which are genuine there and unreachable from the typed
command. Pasted verbatim it therefore minted a fresh branch and a **duplicate
PR** — the exact waste the redeeming message exists to prevent. So the branch and
the PR ride in the task text, where the planner and the builder read them, and
nothing in the printed command is flag-shaped unless the dispatcher parses it.
`DISPATCHER_PARSED_FLAGS` names that set, and a test inspects the generated
command for flag shapes and fails on any that is not in it.

The command has exactly one definition, `redeemCommand()` in
`scripts/ci/trident-verdict.ts`. `.githooks/pre-push` prints it by *calling* the
gate with `--redeem-command`, through
`scripts/ci/trident-redeem-advisory.sh`. A hand-copied second spelling would
drift, and a drifted redemption path is a gate that only rejects.

The advisory takes git's pre-push ref lines on **stdin** and names the branches
actually being **pushed**. Reading the checked-out branch instead — which it did
at first — printed a redemption command for the wrong branch on
`git push origin some-other-branch`, on a multi-ref push, and on a tag push.
Naming the wrong branch is worse than naming none, and being a separate script is
what makes that testable by running it rather than by reading it.

## What counts as a verdict

A PR **comment** containing a fenced `review-evidence` block:

````
```review-evidence
commit: <the full 40-hex head SHA the review examined>
codex.ran: true
codex.blocking: 0
adversarial.ran: true
adversarial.blocking: 0
- mutant: dropped the approver operand from the role union
  red: both-operands test — asserted 403, observed 200
  control: 10/10 green unmutated
```
````

This is not a new format. It is the block the review loop **already posts** at
the end of a clean round, reading the head SHA off the remote at post time — so
extending it costs nothing on the producing side and a parallel record would
have needed a new producer.

**The record deliberately lives outside the PR's own diff.** A committed
`verdict.json` would be self-certifying: the author of the change would also be
the author of its approval.

### …posted by an account with write access

This repository is public, so "a comment containing the block" is not a
sufficient definition of a verdict. Selected by body alone, any GitHub account on
the internet could green a required check on a change it never reviewed — and,
by posting a deliberately malformed block, could equally force a reviewed PR
**red**, because a malformed newest candidate is fatal by design.

So the comment's `author_association` must be `OWNER`, `MEMBER` or
`COLLABORATOR` — the three values that mean write access here. `CONTRIBUTOR`,
`FIRST_TIME_CONTRIBUTOR`, `MANNEQUIN` and `NONE` are outside it. The filter runs
**before** the parse, so an untrusted comment cannot reach the parser and cannot
force a red either.

"Someone posted one and it does not count" is reported as its own message,
separate from "nobody posted one". They call for opposite next actions.

### `commit` is the load-bearing field

The verdict is keyed to the **head SHA**, never to the branch name or the PR
number. Pushing a fix commit invalidates it and the gate goes red again, forcing
a fresh review round. Keyed on the branch, a clean review of an early revision
would silently bless everything that landed after it.

It must be the full 40-hex SHA. A truncation, a placeholder or prose can never
equal the head, and is rejected at parse time rather than compared and missed.

### Strictness rules, each with a reason

- **`ran` accepts only the literal `true`.** `yes (backgrounded)`, `pending`,
  `probably`, and even `True` all fail. The realistic bad value is a hedge, and a
  hedge read as clean is exactly how an unfinished review passes for a finished
  one.
- **Duplicate keys are an error, not an update.** `codex.blocking: 2` followed by
  `codex.blocking: 0` is a contradiction; last-line-wins is how a 2 becomes a 0.
- **Two blocks in one comment is an error, not a pick.** Choosing one silently is
  how a stale verdict outlives the commit it described.
- **`<...>`-shaped values are rejected, and the gate's own FAIL message never
  fills in `commit:`.** CI output gets pasted back into PR threads; a parseable
  template would arm the gate by accident. A test generates the live FAIL output
  and proves it still fails when fed back in.
- **The fence must sit at column 0 on both lines.** A comment that quotes an
  older block — indented, or `> `-prefixed — is discussion, not a verdict, and
  must not displace the newest real one.

The **newest** verdict wins, so a re-review supersedes an earlier one — across
pages, not only within the first one. Both the file list and the comment list are
paginated, and a view that would be truncated is refused rather than judged.

The file list gets a second check, because the truncation there is invisible: the
files endpoint caps at 3,000 files, and a capped response is a complete-*looking*
short page that terminates the paginator exactly like a genuine last page. So the
list length is compared against the PR's own `changed_files` count, and a short
list is reported as *could not read* rather than classified.

### Mutation evidence

Required whenever the PR changes **executable surface**: any
executable-suffix file (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`,
`.cjs`, `.sh`, `.py`, `.sql`, `.awk`) that is not a `*.test.*` file and not
inside a `__tests__/` or `docs/` subtree; any **extensionless** file directly
under `bin/` or `scripts/` (a shebang script has no extension by convention, so
suffix matching alone classified `bin/neutron` — the CLI entry point — as prose);
anything under `.github/workflows/` or `.githooks/` (an edit there can disable
gating outright); and repo-root test-selection config (`package.json`,
`bunfig.toml`, `tsconfig.json`, `tsconfig.base.json`, `eslint.config.mjs`,
`.dependency-cruiser.cjs`) — because an edit there can deselect a suite, and the
exemption has to be judged on the file's power rather than on its typical diff.
`tsconfig.base.json` is the config every other one extends, so it sets the type
surface for the whole tree.

A **rename** is classified by both ends. GitHub reports one under its destination
path only, so judging the destination alone let
`git mv .github/workflows/ci.yml docs/ci.yml` — or a production module renamed to
`*.test.ts` — read as prose-only while changing exactly the behaviour the
requirement exists for. `previous_filename` is consulted too.

Named residuals, exempt deliberately rather than silently: prose (`**/*.md`,
including normative documents — their overclaims are review's to catch),
lockfiles (they pin versions; they cannot select tests), binary assets, and the
`__tests__/` subtrees themselves — so a tests-only PR, **including one that
weakens a guard test**, owes no mutation evidence under this clause. That one
stays a review duty, and it is written here so nobody rediscovers it as a
surprise.

## The positive control

A lookup that cannot read the format returns a negative that looks exactly like
an answer. "No verdict found" and "my parser is broken" print the same way and
mean opposite things.

So before the gate believes any absence, it runs the **whole lookup** against
known inputs — the same `gate` function, its pagination, its API-shape handling,
its author filter and its candidate selection, not the parser in isolation. Three
cases, because a control that only proves a positive cannot detect a lookup stuck
at "yes": a good verdict for the head SHA must pass, no verdict must fail, and a
verdict for a *different* SHA must fail.

Driving only `parseVerdict` was not enough, and the gap was not theoretical: a
mutant that emptied the **candidate filter** passed a parser-only control while
reporting "no verdict recorded" for every PR in the repository. A control that
skips the step which broke proves the gate can read a string, not that it can find
a verdict.

If the control fails, the output says `THE LOOKUP IS BROKEN` and deliberately does
**not** say "no verdict recorded" — a distinct outcome, still red, and it still
prints the redeeming command, because the branch's author did nothing wrong and
has the same next move either way. Run it on its own:

```bash
bun scripts/ci/trident-verdict.ts --self-test
```

## Three failure vocabularies, deliberately distinct

The gate can be red for three different reasons and says which:

| output | means |
|---|---|
| `no trident verdict recorded` | the PR genuinely has no verdict for this head |
| `none of them is a verdict` | a block was posted, by an account without write access |
| `THE LOOKUP IS BROKEN` | the lookup failed its own control; nothing was concluded |
| `could not READ this PR` | the GitHub API call failed or was truncated; nothing was concluded |

Collapsing any two of these is how "my reader is broken" gets acted on as "your
branch is unreviewed". All of them exit 1 — *"I could not check"* must never be
worth more than a failed check — and all of them print the redeeming command.

## The bypass: `TRIDENT_BYPASS`

Put a line at **column 0** in the head commit's message:

    TRIDENT_BYPASS=<a real reason, written for whoever reads this in six months>

The gate then passes, prints the reason, and emits it as a GitHub notice
annotation so it is visible without opening the log.

**Why the commit message and not an environment variable or a workflow input.**
The point of an escape hatch is that using it is *recorded*, not that it is
convenient. A commit message is bound to the SHA for free (a new commit needs a
new marker, exactly like the verdict), it merges into permanent history, and
unlike a PR body it cannot be edited afterwards. A CI variable would satisfy the
gate and leave no trace at all, which is the one thing a bypass must not do.

**Copy the same line into the PR body.** The gate prints it for you when the hatch
fires, and the reason is: a squash merge composes its message from the PR title and
body rather than from this commit, so the marker can be dropped on the way into
`main` — and once the branch is deleted, the only record that an unreviewed change
merged goes with it. See limit 3 below.

It is **not satisfiable by an empty reason**: an empty or whitespace-only value,
an unfilled `<...>` placeholder, a value with nothing readable in it, or two
markers in one message all fail — the last because two reasons is a
contradiction, not an update. The marker must be at column 0, so a copy of this
document (or of the gate's own hint, which prints it indented and
placeholder-shaped) cannot arm it.

## Operating notes

- **A verdict posted after the run finished cannot retro-green it.** The gate
  reads the PR's comments at the moment it runs. Re-run the workflow
  (`gh run rerun --failed <run-id>` for the `ci.yml` run on the branch) or push
  again, and it re-reads. The failure message says so.
- **The gate rides the existing required `test` context** rather than adding a
  new one: `test` `needs:` it, and checks `needs.trident-verdict.result` on
  pull-request events specifically. That makes it blocking with no
  branch-protection change. A skipped verdict job therefore fails the aggregator
  on a PR instead of satisfying it — the reverse of what a required context does
  with a skipped check.
- **On a push to `main` the job is skipped by design** (there is no PR to read a
  verdict for) and the aggregator does not consult it, so a bookkeeping push does
  not red the branch.
- **The pre-push hook warns and never blocks.** There is nothing to satisfy at
  push time — a verdict names a pushed SHA, so it cannot exist before the push.

## What it does not do

It does not read the findings and judge them; that is the reviewer's job. It
checks that a review happened, against this commit, and reported clean. A
determined author can still write a false block — but that is an explicit lie
about a named SHA, not an omission nobody notices.

Limits worth naming rather than discovering. The first two are inherent; the rest
are open gaps whose fix lives outside this repository, and they are written down
because a gate whose known holes are unrecorded is one people stop trusting for
reasons they cannot articulate.

1. **The job runs the PR's own copy of the gate.** A PR that edits
   `scripts/ci/trident-verdict.ts` to `return 0` turns its own check green. This
   is inherent to any self-hosted CI gate — the tests a PR must pass are equally
   editable — so no configuration closes it. It is visible in the diff, the
   gate's own surface rule marks such a PR as owing mutation evidence, and review
   is the backstop.
2. **A direct push to `main` never meets the gate at all.** Closing that needs a
   require-a-pull-request branch-protection rule, which is a repository-settings
   change and not something this tree can make.
3. **A bypass reason can be dropped by the squash merge.** The marker is read from
   the head commit's message, which is bound to the SHA and cannot be edited after
   the fact — those are the properties that make it a paper trail. But a squash
   merge composes a **new** message from the PR title and body, so the head
   commit's body is not guaranteed to reach `main`, and once the branch is deleted
   the record of an unreviewed merge goes with it. The gate cannot write the squash
   message, so when the hatch fires it prints the line to copy into the PR body.
   Do that; a bypass whose reason is gone is a silent bypass.
4. **A docs-only PR currently needs the bypass.** The review harness classifies the
   PR's surface by importing a helper this repository does not have; the probe
   fails, and it fails *closed*, so a prose-only PR is treated as owing mutation
   evidence, the prover cannot prove a mutation that does not exist, and no verdict
   is posted. The gate's own prose exemption is therefore unreachable from the
   producing side. The fix is in the harness repository, not here.
5. **A verdict posted after the run has finished does not re-trigger anything
   here.** The harness re-runs a workflow this repository does not have (its
   checks live in `ci.yml`), so its automatic recovery from that race is a no-op
   for this tree and the re-run is manual — which is why the failure output prints
   the exact `gh run rerun` command with this run's id already filled in.
6. **An external contributor cannot record a verdict, by design.** Only an account
   with write access can, so a fork PR from outside needs a reviewer with write
   access to post the block (or the bypass). On a public Apache-2.0 repository that
   is the correct trade — an approval anyone can write is not an approval — but it
   means an outside contribution cannot self-clear its own gate.
