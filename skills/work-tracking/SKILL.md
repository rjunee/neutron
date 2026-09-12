---
name: work-tracking
description: How work is captured, specified, built and recorded in a Neutron coding project — the three layers (issues inbox, spec-items queue, as-built records), the four rules, and the one-writer as-built pattern. Use when starting work from an issue or a one-line request, when asked to specify or refine a task, when writing acceptance criteria, when writing an as-built record, when a repo is growing ad-hoc tracking files, or when adopting/auditing the system in a repository.
version: 1.0.0
user-invocable: true
argument-hint: "[adopt|audit|specify|record]"
---

Work tracking for Neutron coding projects. The normative standard is
[`docs/process/work-tracking.md`](../../docs/process/work-tracking.md) — read it
before acting. This skill is the entry point, not a second copy of the rules; if
the two ever disagree, the standard wins.

## When you are here

**Starting work.** Do not build from a bare title. Confirm the issue says what the
change is, where it lands, and how anyone would know it worked. If it does not,
you are in `specify`, not in build.

**`specify`** — turning a thought into something buildable is *your* job, never the
owner's:

1. Investigate the repo first. Most questions are answerable from the code, and
   asking the owner something a search would have answered wastes the one resource
   this system conserves.
2. Interview the owner for the rest — intent, scope, priority, which of two
   readings was meant — in one batch, not a drip.
3. Rewrite the issue body with what you found *and the owner's answers*, so the
   reasoning outlives the conversation.
4. Remove `needs-spec`.

Never remove `needs-spec` by guessing. A fluent invention is worse than a blank
body, because the blank one is visibly unfinished. Blocked on an unavailable owner
is a legitimate resting state: leave the label on and put the open question first.

**Acceptance criteria** go in `docs/spec-items/<slug>.md`, never in the issue — an
issue body changes with no PR, no review and no diff, so a criterion living there
can be weakened without trace. Write them so a broken implementation would fail
them; a criterion a broken build also satisfies is not a criterion. Name the
verifying command where one exists.

**`record`** — one as-built file per change, `docs/as-built/<slug>.md`, shipped in
the PR that earns it. Never append to a shared monolith: every branch prepends at
the same offset, so two open PRs conflict by construction, and the workaround
(bookkeeping-only commits) cost a sibling repo 386 of 1,367 commits.

**`audit`** — the failure signature is a second queue. Look for `TODO.md`,
`POST_DEMO.md`, wave boards, `RESUME-STATE.md`, or a spec section that has become
a task list. One queue: `docs/spec-items/`. GitHub Issues is the inbox, not a
parallel copy.

**`adopt`** — follow §5 of the standard, in order. Migrate the backlog as FILES in
one reviewable diff; never bulk-create issues from it. Build the rollup index in
the same change that splits the monolith, or you get every cost of splitting and
none of the benefit.

## The one thing to carry out of here

One owner per fact. A document doing several jobs — spec, decision log, queue,
status board — makes all of them worse, because they have different lifetimes and
different readers.
