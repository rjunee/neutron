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
(`trident/published-retry-handoff.ts:66`). It requires all of the following:

- the same-card lineage receipt
- the card's newest terminal attempt that holds a host checkpoint, on the same
  project, repository, branch and PR mode. Newer attempts are passed over only
  when each is provably a retry refused before its first worker on that branch:
  no checkpoint, no recovery stage, no `build-retry-source`, no attempt rows, no
  inner checkpoint or result, and no receipt other than this one
  (`trident/store.ts:1228` lists the card's terminal attempts newest first)
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
`readPublishedRetryHandoff` (`trident/published-retry-handoff.ts:162`).

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

**Preparation.** `prepareProjectBuild` re-establishes the same authority while
the hand-off holds its own durable `salvage`-purpose reservation of the branch,
which it acquires itself and releases once the worktree add returns
(`open/wiring/project-build.ts:476`, `trident/published-retry-checkout.ts`). A
reservation already held by another run refuses. The branch tip must equal the
settled head, descend from the base pin and contain the owned PR head observed
OPEN, whether or not a checkout still holds the branch. It then hands off the
one clean, unlocked checkout that is exactly the predecessor's recorded worktree
at the settled head; when no checkout holds the branch any more, nothing is
released. Either way the attached worktree is re-checked at the settled head. The hand-off goes through `worktree-cleanup.sh keep-branch`, and
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

Outer launch now reads the authority over the row it was handed (the tick's
snapshot of the stored row), not the launch-local enrichment, for both the first read and the re-read
(`trident/launch-preparation.ts:758`, `:776`). A direct case pins this:
discovery reports the PR, the reader sees `pr: null` twice, and the pinned run
still links the PR (`trident/published-retry-handoff.test.ts:199`). Restoring
the old argument fails that case (0 pass, 1 fail).

**Consuming end-to-end cases.** These are the `owned published retry` cases in
`open/__tests__/project-build-e2e.test.ts:6426`. Each predecessor is driven
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

**Review fix round.** The first review found four defects, all repaired here:

- **Intermediate refused retry.** The authority took the card's latest terminal
  attempt as the predecessor. A retry refused at outer launch is itself recorded
  as a terminal attempt with no checkpoint, so one refusal (the live #1459 card
  has exactly this shape, and a transient UNKNOWN refusal of this path produces
  it too) ended the card's recovery for good. The authority now walks the
  card's ledger as described under Authority, and re-reads every passed-over
  attempt unchanged. The consuming case `owned published retry survives an
  intermediate retry refused before its first worker`
  (`open/__tests__/project-build-e2e.test.ts:6640`) fails one owned PR read,
  saves the refused run, reconciles it through the real board observer and
  then merges on the next normal retry. Direct cases cover both accounting
  shapes and five refusing intermediates
  (`trident/published-retry-handoff.test.ts:343`).
- **No-holder preparation.** With no checkout holding the branch, the hand-off
  returned `none` before checking the tip, so a branch moved between launch and
  preparation was attached unchecked. It now applies the same tip, ancestry and
  publication checks and returns `handed-off` without a cleanup call, so the
  caller's settled-head check runs after the add
  (`trident/published-retry-handoff.test.ts:470`).
- **Tick snapshot.** The authority compared the whole run row it was handed
  with the stored row, so any unrelated write between the tick's listing and
  the step refused an owned retry permanently. It now compares only the columns
  it reads (`trident/published-retry-handoff.ts:36`); a disagreement in one of
  them still refuses (`trident/published-retry-handoff.test.ts:378`).
- **Rev-range enumeration.** The new base-behind measurement's operand
  `handoff.priorBase` is argued in `trident/diff-base-option-shaped.test.ts`,
  which had failed the host suite and CI shard 3/4.

Paired mutations for the fix round, each restored byte-for-byte afterwards:

| Mutation | Change | Guard (fails) | Control (passes) |
| --- | --- | --- | --- |
| F1 | Refuse every newer intermediate attempt | intermediate direct cases: 2 fail; intermediate e2e case: 1 fail | `trident/build-mode-state.test.ts`: 20 pass |
| F2 | Pass over an intermediate with another receipt | `carries another receipt`: 1 fail | the other 66 direct cases pass |
| F3 | Return `none` when no checkout holds the branch | the three `no remaining holder` cases fail | the other 64 direct cases pass |
| F4 | Compare the whole handed row again | `tick snapshot may lag`: 1 fail | the other 66 direct cases pass |

**Validation.** All of the following passed:

- the 10 focused consuming E2E cases, and the whole
  `open/__tests__/project-build-e2e.test.ts` (616 pass, 0 fail)
- in the fix round: the 11 `owned published retry` and 4 `salvaged
  publication` consuming cases (15 pass), the 67 cases in
  `trident/published-retry-handoff.test.ts`, the 42 cases in
  `trident/diff-base-option-shaped.test.ts`, and 323 cases in
  `trident/store.test.ts`, `trident/build-mode-state.test.ts`,
  `trident/board-dispatch.test.ts` and
  `open/wiring/__tests__/published-retry-settlement.test.ts`
- in the first round: 369 tests in `trident/published-retry-handoff.test.ts`,
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
