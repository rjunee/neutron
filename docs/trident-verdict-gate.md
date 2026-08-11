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

    /trident v2 repo=<path-to-your-checkout> branch=<branch> prNumber=<n> review and fix the existing branch, reuse its PR, do not restart from scratch

That is not aspirational. The review loop already takes a `branch` and a
`prNumber`, and when they are present it re-enters that branch **without** `git
switch -c` and **reuses the existing PR rather than opening a duplicate** — the
re-entry path and the reuse instruction are both in the harness's inner
workflow, which is why the printed spelling uses those two argument names rather
than a shorthand. `repo=` is a local path and so is shown as a placeholder; the
harness infers it when the argument is omitted.

The command has exactly one definition, `redeemCommand()` in
`scripts/ci/trident-verdict.ts`. `.githooks/pre-push` prints it by *calling* the
gate with `--redeem-command`. A hand-copied second spelling would drift, and a
drifted redemption path is a gate that only rejects.

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

The **newest** verdict wins, so a re-review supersedes an earlier one. Both the
file list and the comment list are paginated, and a view that would be truncated
is refused rather than judged.

### Mutation evidence

Required whenever the PR changes **executable surface**: any
executable-suffix file (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`,
`.cjs`, `.sh`, `.py`, `.sql`, `.awk`) that is not a `*.test.*` file and not
inside a `__tests__/` or `docs/` subtree; anything under `.github/workflows/` or
`.githooks/` (an edit there can disable gating outright); and repo-root
test-selection config (`package.json`, `bunfig.toml`, `tsconfig.json`,
`eslint.config.mjs`, `.dependency-cruiser.cjs`) — because an edit there can
deselect a suite, and the exemption has to be judged on the file's power rather
than on its typical diff.

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

So before the gate believes any absence, it parses a known-good fixture through
the **same** parser and asserts it clears the bar. If the control fails, the
output says `THE LOOKUP IS BROKEN` and deliberately does **not** say "no verdict
recorded" — a distinct outcome, still red. Run it on its own:

```bash
bun scripts/ci/trident-verdict.ts --self-test
```

## Three failure vocabularies, deliberately distinct

The gate can be red for three different reasons and says which:

| output | means |
|---|---|
| `no trident verdict recorded` | the PR genuinely has no verdict for this head |
| `THE LOOKUP IS BROKEN` | the parser failed its own control; nothing was concluded |
| `could not READ this PR` | the GitHub API call failed; nothing was concluded |

Collapsing any two of these is how "my reader is broken" gets acted on as "your
branch is unreviewed". All three exit 1 — *"I could not check"* must never be
worth more than a failed check — and all three print the redeeming command.

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

Two limits worth naming rather than discovering:

1. **The job runs the PR's own copy of the gate.** A PR that edits
   `scripts/ci/trident-verdict.ts` to `return 0` turns its own check green. This
   is inherent to any self-hosted CI gate — the tests a PR must pass are equally
   editable — so no configuration closes it. It is visible in the diff, the
   gate's own surface rule marks such a PR as owing mutation evidence, and review
   is the backstop.
2. **A direct push to `main` never meets the gate at all.** Closing that needs a
   require-a-pull-request branch-protection rule, which is a repository-settings
   change and not something this tree can make.
