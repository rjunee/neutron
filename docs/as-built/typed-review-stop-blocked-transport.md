## 2026-09-25 — Preserve typed review STOP evidence through terminal reconciliation

The typed host correctly stopped on G070/G071 but its launcher transported only
the human terminal cause. The card reader requires a harvested, coherent
`blockKind`/`escalation` pair (`trident/escalation-block.ts:96`), and terminal
reconciliation uses that reader to select BLOCKED (`trident/board-reconcile.ts:110`).
The missing pair made a deliberate stop look like an ordinary failed build.

`trident/gates/review-progress.ts:12` now carries the host's trigger and both review
observations; `trident/build-run.ts:341` adds the actual review round while forwarding
the stop. The launcher translates that evidence to the existing canonical escalation
shape (`trident/project-launcher.ts:103`). The original structured outcome retains
all identities/counts, while the bounded owner-facing text starts with the counts.
The existing harvest writes the BLOCKED reason; board and project-chat readers
consume their shared decoder. No English-string match determines classification.
The verified-panel consumer also attaches the reviewed head and actual panel
decision before suite/CI/progress overrides. The launcher records host rejection
as `REQUEST_CHANGES` while preserving the panel's `argus-approved` or
`argus-request-changes` checkpoint, carrying the round/head into harvest. Nexus
attributes the actual reviewer checkpoint to Argus and the final host outcome to
the handoff. Every arithmetic STOP writes a rejected typed checkpoint, including
when it overrides a panel approval or re-plan. The checkpoint also records the
arithmetic veto in that same write (`trident/build-run.ts:1057`): after a crash
before terminal delivery, same-run recovery validates and rechecks it before any
fix or head-moved rebuild (`trident/build-run.ts:491`).
This preserves the original head/round/panel decision and spends no new worker
turn. Nomination-repair
arithmetic before review carries no reviewed-head proof and retains `REVIEW_NOT_RUN`.

Scope is the arithmetic STOP transport. Ordinary failures and host blocks without
arithmetic evidence retain their existing classification. Review provenance is
added only for a stop reached after a verified panel, never from its phase label
or reason string. No historical row is rewritten and no automatic recovery is introduced.
The latest rejected typed checkpoint still refuses ordinary cross-run adoption
(`trident/build-mode-state.ts:125`). Historical rejected checkpoints lack the new
durable veto and are not backfilled; widening ordinary cross-run adoption would
still invent recovery authority. The governed recovery
proposal and real-Git test plan are in
`docs/spec-items/the-review-loop-must-stop-and-re-plan.md` under the follow-up proposal.

Validation:

- 490 host, launcher, arithmetic-gate, disposition, escalation and Nexus tests passed;
  the launcher controls include
  a matching reason without structured evidence, a real failure, an unharvested
  result and a stopped run.
- 190 existing disposition, dispatch, escalation and terminal-wake tests passed.
- The Open consuming harness passed seven new real-Git scenarios (nondecreasing
  counts, repeated identity with decreasing counts, distinct decreasing counts,
  recurrent host-only nomination failure, both arithmetic stops overriding a
  re-plan, and a repeated minor finding overriding panel approval)
  plus the two existing repeat/ceiling cases. The real launcher, harvest and board
  store produce BLOCKED with a retained binding; the project-chat prompt carries
  the trigger. Reviewed blocked runs leave the PR open and base unmoved. The decreasing
  control reaches a merged result and a DONE card. The composed terminal observer
  persists real Nexus rows: reviewed stops produce a host rejection handoff and the
  actual Argus decision; the host-only case runs zero reviewers and produces only the honest
  `REVIEW_NOT_RUN` handoff. The harness simulates provider
  responses and GitHub API observations over real Git repositories.
- Mutation controls: removing launcher escalation transport makes the consuming
  no-progress case fail on the missing BLOCKED reason; changing G071 to reject all
  nonnegative counts makes three arithmetic-gate controls fail. Both mutations
  were restored before the final passing runs.
- Provenance mutations also failed through the Open consumer: suppressing the
  reviewed-head transport produces the wrong terminal verdict/checkpoint; treating
  every arithmetic stop as reviewed fabricates rejection provenance for the
  zero-review nomination case. Both were restored before final validation.
- Restoring the old fix-only rejected-checkpoint condition fails all three
  re-plan/approve consuming cases. Restoring Nexus attribution from the host
  verdict fails the panel-approve/host-veto case. Both were restored.
- Seven additional real-Git consuming cases interrupt immediately after saving
  the round-two rejected checkpoint, then restart through the actual gateway.
  Both arithmetic triggers, re-plan/approval overrides and the zero-review host
  STOP replay without a single new worker dispatch, preserve spend and reach the
  same BLOCKED card/Nexus evidence. The distinct decreasing control resumes its
  permitted fix and merges. Host controls also reject malformed veto evidence
  and preserve STOP even if the branch head moved.
- Crash-boundary mutations: removing veto replay makes the no-progress case
  dispatch a second fix and merge; treating every rejected checkpoint as a veto
  refuses the decreasing control. Both failed and were restored before final
  validation.
- The production host-effects crash fixture now distinguishes equal blocker
  counts from decreasing counts. Its old equal-count expectation demanded another
  fix after G071, reproducing the bypass rather than valid recovery. The real-Git
  persistence controls require 1→1 to retain STOP with no new dispatch and 2→1 to
  resume its fix; the runtime is unchanged by this test correction.
  The complete production-host-effects suite plus the seven host/Nexus suites
  passed 621 tests; the focused Open consumer passed all 16 cases, and both root
  and Trident typechecks passed. Removing veto replay fails the equal-count case
  while decreasing still passes; overapplying the veto to every round-two
  rejection fails decreasing while equal still passes. Both mutations were
  restored before those final runs.
- Root and Trident TypeScript projects passed `tsc --noEmit`.

The simultaneous-guard correction preserves a proven arithmetic STOP before a
nomination round ceiling or another panel block (`trident/build-run.ts:949`,
`trident/build-run.ts:1067`). The real panel refuses a second re-plan before
returning `re-plan`, so handling only the host's re-plan cap would miss the
production path (`trident/gates/review-panel.ts:142`). A verified `blocked`
panel decision now has explicit typed provenance; it does not become a claim
that another re-plan was authorized. Unknown review evidence remains unknown.

The consuming Open matrix covers nomination failure at the round ceiling and
both arithmetic triggers after the one re-plan has been spent, including
checkpoint interruption. The seven added cases also include the negative
sibling: distinct decreasing findings with an exhausted re-plan stay an ordinary
refusal without a fabricated arithmetic veto. Before the correction, five of
the six new overlap cases failed; the existing host-only crash replay was the
one passing case, demonstrating the disagreement between immediate delivery and
recovery. The reverse mutation that treats decreasing counts as no-progress
failed all three decreasing controls while both genuine STOP cases passed.
Both mutations were restored. Final focused validation passed 537 tests across
the host, launcher, progress, production-effects and Nexus suites, 22 Open
consuming cases, 38 spec-index tests, and both root and Trident typechecks.
The host and production re-plan crash fixtures now each exercise distinct and
repeated findings: both refuse another re-plan, and only the repeated case
retains the arithmetic veto.

Full shared-host validation, refreshed exact-head CI and served production
controls remain required before publication/merge and cutover claims.

This change satisfies the typed-host status subset of the locked review-loop
specification. Explicitly authorized re-planning from a published rejected head,
including a durable decision, one-use consumption and visible retry refusals,
remains the separate proposal; ordinary retry and spend limits are unchanged.
