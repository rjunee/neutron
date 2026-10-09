## 2026-10-09 — Recover an owned published retry through outer launch and preparation

A card's terminal predecessor can build useful commits and hold the card's
witnessed salvage PR, while its latest checkpoint still records a pending build
or fix. This happens when its native worker wrote the original result after the
driver's acknowledgement was lost, or after a supported stop. The normal card
retry already carried the publication receipt, strategy and task spend, and
started fresh planning. However, the outer launcher refused it as a foreign
wrong-base branch before its first worker. Even past that guard, preparation
could not add a worktree for a branch the predecessor's linked checkout still
held. This implements the `Owned published retry through outer launch` and
`Settled pending predecessor of an owned publication` criteria in
`docs/spec-items/salvage-publication-provenance.md` and
`docs/spec-items/a-retry-must-resume-from-the-checkpoint.md` for #1476.

**Authority.** One read-only authority is composed from existing exact checks
(`trident/published-retry-handoff.ts:52`). It requires all of the following:

- the same-card lineage receipt
- the card's latest terminal predecessor on the same project, repository,
  branch and PR mode
- the original host-saved request, its dispatch journal and its exact armed
  reservation
- one attempt row, whose accounting may be completed, unfinished (`ended_at`
  and `outcome` null) or explicitly `unknown`, and is never rewritten
- a completed result at the canonical path with a valid forge trailer
- no other unfinished worker and no foreign branch reservation

The authority also requires that none of these changed while it was being read.
The Open composition adds the host witness
(`open/wiring/published-retry-settlement.ts`). That witness refuses while any
native-child admission lease names the predecessor, and it checks the trailer
with the live validator. The composed reader is
`readPublishedRetryHandoff` (`trident/published-retry-handoff.ts:127`).

**Outer launch.** Outer launch consumes this authority only for a fresh,
unseeded PR launch whose tip is not contained in the fetched base
(`trident/launch-preparation.ts:758`). Before the launch is allowed, Git must
prove three things:

- the tip equals the settled head
- the tip descends from the predecessor's base pin
- the tip contains the owned PR head, which is observed OPEN on the same
  branches

The authority is then re-read and must be unchanged. If any of this fails, the
existing wrong-base refusal is kept. An unknown observation refuses as UNKNOWN.

**Preparation.** `prepareProjectBuild` re-establishes the same authority under
the branch's existing durable reservation (`open/wiring/project-build.ts:476`,
`trident/published-retry-checkout.ts`). It then hands off the one clean,
unlocked checkout that is exactly the predecessor's recorded worktree at the
settled head. The hand-off goes through `worktree-cleanup.sh keep-branch`, and
the existing branch is attached afterwards. Dirty, locked, moved, ambiguous or
unreadable shapes refuse before any mutation and record the existing
`build-worktree-add-failed` diagnostic.

**Production change found by the consuming E2E.** On the real launch path, the
launcher links the owned PR it discovers through `gh pr list --head <branch>`
onto a launch-local row. The authority's unchanged-row check compares the run it
is given against the stored row, and the stored row still has `pr: null`. Outer
launch therefore refused every owned retry whose PR GitHub reports, which is the
production shape. The direct tests had stubbed discovery to `null` and could not
see this.

Outer launch now reads the authority over the row as stored, not the
launch-local enrichment, for both the first read and the re-read
(`trident/launch-preparation.ts:758`, `:776`). A direct case pins this:
discovery reports the PR, the reader sees `pr: null` twice, and the pinned run
still links the PR (`trident/published-retry-handoff.test.ts:199`). Restoring
the old argument fails that case (0 pass, 1 fail).

**Consuming end-to-end cases.** These are the `owned published retry` cases in
`open/__tests__/project-build-e2e.test.ts:6434`. Each predecessor is driven
through the real project driver:

- **Completed build.** A completed build whose mode-driver acknowledgement is
  lost leaves a pending build checkpoint.
- **Unfinished fix.** The incident shape: a fix stopped through the supported
  terminator whose attempt stays unfinished.
- **Unknown fix.** A fix attempt that ends `unknown`.

Each predecessor publishes through the real guarded `reconcile_stranded`
salvage seam. A Work Board card is bound to it, and the retry runs through
`dispatchBoardBoundBuild`, `buildTridentOrchestrator` with
`createProjectLauncher`, and actual `prepareProjectBuild`. The predecessor's
worktree stays present throughout.

Each shape reaches merged on PR #1, with this evidence:

- fresh planning: one plan and one build
- a current review and a pinned merge
- no `gh pr create`
- the published and settled heads contained in origin main
- the predecessor's base pin kept, and its strategy and 1/4 task spend carried
- no checkout, approval or suite receipt imported
- the predecessor's checkout removed with `keep-branch` and nothing forced
- the predecessor's run, events, attempts and retained artifacts byte-equal
- `retryModeSource` still null

The discovered-but-unowned sibling is refused at outer launch, with no dispatch,
PR #1 still OPEN, and its rows and Git unchanged. Six controls are applied after
dispatch:

- a dirty checkout
- a locked checkout
- a holder at another path
- an unreadable worktree listing (UNKNOWN)
- an active native writer lease
- a branch reservation held by another run

Each control refuses with no worker, no forcing command, no cleanup call, PR #1
OPEN, and rows, Git and reservations unchanged. The missing or altered
request, result, reservation, publication, repository, card and branch
controls, and the concurrent-acquisition controls, stay in the direct tests.

**Paired mutations.** Each mutation was executed through
`bun test open/__tests__/project-build-e2e.test.ts -t <pattern>` and restored
byte-for-byte:

| Mutation | Change | Guard (fails) | Control (passes) |
| --- | --- | --- | --- |
| M1 | Refuse every retry in the composed reader | owned positive: 0 pass, 3 fail | unowned sibling: 1 pass |
| M2 | Grant publication from the observational `prior.pr`, at both the dispatch and authority receipt sites | unowned sibling: 0 pass, 1 fail | owned positive: 3 pass |
| M3 | Bypass the host settlement witness | active native writer: 0 pass, 1 fail | unowned sibling: 1 pass |
| M4 | Bypass the recorded-holder path check | holder at another path: 0 pass, 1 fail | unowned sibling: 1 pass |

**Validation.** All of the following passed:

- the 10 focused consuming E2E cases, and the whole
  `open/__tests__/project-build-e2e.test.ts` (616 pass, 0 fail)
- 369 tests in `trident/published-retry-handoff.test.ts`,
  `trident/build-mode-state.test.ts`, `trident/board-dispatch.test.ts` and
  `trident/store.test.ts`
- `tsc --noEmit -p tsconfig.json` and `-p trident/tsconfig.json`
- `scripts/ci/lint.sh` and `git diff --check`

`scripts/ci/typecheck-all.sh` fails only on
`app/__tests__/support/mount.tsx(17,1)` (an unused `@ts-expect-error`), which
fails identically on main at `84a38afec`. This change touches no `app/` file.
The full host suite is left to the host pipeline.

**Scope of this record.** No live row, lease, receipt, branch, PR or deployment
was changed. This record establishes the repair against the real-Git fixture; it
does not claim that #1476 has been deployed or witnessed live.
