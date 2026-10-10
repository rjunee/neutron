## 2026-10-10 — Refuse a fresh planner behind an unresolved retry checkpoint

An ordinary same-card retry could reject the previous run's pending checkpoint
as ineligible, then continue into fresh dispatch. The refusal to import worker
state did not stop a second planner from repeating work or moving the card away
from the original attempt. A live review-blocked task sequence exposed this
fallback; its automatic successor incurred 26,578 measured output tokens before
operator cancellation. That figure is output usage, not total tokens or a
measured saving from this change. Tracked in #1196.

`trident/board-dispatch.ts` now checks the latest authenticated checkpoint when
retry-source admission returns no source. With the same card task and execution
identity, pending planning or review refuses before run creation. Pending build
or fix also refuses there unless an owned publication can enter the existing
handoff verification. That exception creates only a verification candidate:
outer launch and preparation still require original authenticated settlement,
publication ownership and retained-branch checks before buying any planner.
A publication receipt cannot exempt a pending planner or review. Publication
lineage uses the same reader for the candidate check and the created row.

Existing eligible review recovery still carries its completed implementation
and review round into a retry. Failed and stopped predecessors, every pending
phase, a planner with no head, an inherited pending checkpoint and published
planner/review cases are covered. Refusal leaves original events, attempts,
artifacts and budgets intact. No terminal run row or physical process exit is
converted into a completed worker result.

The initial regression cases failed eight times against the original dispatch
path. The final dispatch/checkpoint suites pass 173 tests with 948 assertions.
The retained-publication suite passes 87 tests with 333 assertions. The prepared
build fixture also exercises blocked review refusal and eligible settled-review
continuation; the existing owned-publication dispatch-to-merge and refusal
controls cover the exception: 17 cases passed together, and the strengthened
unowned-sibling case passed separately after moving its expected refusal to
board dispatch. An early all-pending refusal failed its three
owned-publication merge controls, which exposed and prevented that regression.

This delivers a dispatch refusal, not native-task cancellation or a general
recovery implementation. Live autonomous task-sequence acceptance and production
token savings remain unverified for this change. Full local validation and the
publication revision are recorded below after the required gate finishes.
