## 2026-09-27 — Recover the published checkout for a pending same-run review

An interrupted review could leave a durable pending checkpoint while the host's
mandatory final cleanup removed its clean, remotely preserved branch and worktree.
Preparation restored cross-run retries from their source checkpoint, but a same-run
refire without that source recreated the branch at its launch base. The unchanged
read-only recovery check then correctly refused the mismatched review input.

`trident/pending-review-checkout.ts:9` now reads the latest identity-validated
same-run checkpoint and requires an active run, read-only review request, matching
checkpoint/PR heads and the run's recorded publication ownership. A fresh PR read
must confirm its number, open state, head, branch, base and repository relationship.
`open/wiring/project-build.ts:368` uses that head before consulting an inherited
retry source, then fetches and verifies the exact remote branch and commit before
creating the checkout. Missing or changed evidence throws without falling back to
the launch base. Existing checkouts remain subject to the driver's complete
snapshot corroboration at `trident/build-run.ts:457`.

This implements same-run continuity under
`docs/spec-items/planner-selected-execution-strategy.md:66` and deferred-review
semantics under `docs/spec-items/trident-build-efficiency.md:127`. It preserves
G125–G127 (`docs/trident-gates-inventory.md:232`): final cleanup still runs and
deletion remains the cleanup script's decision. The change does not retain an
extra worktree, import approval across heads, or authorize the separate rejected-run
re-plan proposal in `docs/spec-items/the-review-loop-must-stop-and-re-plan.md:116`.

Verification includes unit controls for fresh/plan/build/fix preparation, invalid
checkpoint/ownership evidence, and all PR identity fields. The real-Git consuming
test in `open/__tests__/project-build-e2e.test.ts` removes the checkout through the
actual host cleanup, restores the exact published input, recovers the original
review, and merges without another worker dispatch. Siblings refuse remote
movement (including movement after PR observation), closed/unowned/unreadable
PRs, and a checkout changed after restoration. Final cleanup is also asserted.

Semantic mutants restoring launch-base reconstruction, bypassing checkpoint
ownership, bypassing PR identity, or bypassing fetched-head equality fail the
corresponding behavioral tests. An always-refuse PR mutant fails the legitimate
exact-head control. The complete consuming E2E suite passes 374 tests; the targeted
host/checkpoint suites pass 88 tests. Both root and Trident TypeScript checks and
lint pass. The five changed files pass the leak scan with the required license
control; the local whole-worktree scan also reports unrelated baseline matches
and the local worktree pointer, so it is not claimed as clean.
