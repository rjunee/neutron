## 2026-09-25 — Preserve typed review STOP evidence through terminal reconciliation

The typed host correctly stopped on G070/G071 but its launcher transported only
the human terminal cause. The card reader requires a harvested, coherent
`blockKind`/`escalation` pair (`trident/escalation-block.ts:96`), and terminal
reconciliation uses that reader to select BLOCKED (`trident/board-reconcile.ts:110`).
The missing pair made a deliberate stop look like an ordinary failed build.

`trident/gates/review-progress.ts:12` now carries the host's trigger and both review
observations; `trident/build-run.ts:338` adds the actual review round while forwarding
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
when it overrides a panel approval or re-plan. Nomination-repair
arithmetic before review carries no reviewed-head proof and retains `REVIEW_NOT_RUN`.

Scope is the arithmetic STOP transport. Ordinary failures and host blocks without
arithmetic evidence retain their existing classification. Review provenance is
added only for a stop reached after a verified panel, never from its phase label
or reason string. No historical row is rewritten and no automatic recovery is introduced.
The latest rejected typed checkpoint still refuses ordinary cross-run adoption
(`trident/build-mode-state.ts:125`); widening it alone would enter the resume-fix
path without re-running G071 (`trident/build-run.ts:904`). The governed recovery
proposal and real-Git test plan are in
`docs/spec-items/the-review-loop-must-stop-and-re-plan.md` under the follow-up proposal.

Validation:

- 481 host, launcher, arithmetic-gate, disposition, escalation and Nexus tests passed;
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
- Root and Trident TypeScript projects passed `tsc --noEmit`.

This change satisfies the typed-host status subset of the locked review-loop
specification. Explicitly authorized re-planning from a published rejected head,
including a durable decision, one-use consumption and visible retry refusals,
remains the separate proposal; ordinary retry and spend limits are unchanged.
