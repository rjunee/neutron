---
title: Avoid repeated build work and measure Trident's time and token costs
group: trident
status: open
priority: P0
cutover: true
---

# Trident build efficiency

Work state: GitHub issue #1196. The owner
made avoidable build latency and repeated work a cutover blocker on 2026-09-23.
This item owns the acceptance criteria; the issue owns priority and progress.

## Governing requirements

- The locked pivot requires same-provider bounded work to run as project REPL
  subagents and cross-provider work to run headless
  (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:94-111`). Its recurring
  cross-provider calls reuse thread IDs (`:113-126`). These are placement and
  continuity requirements, not permission to substitute a cheaper provider.
- `SPEC.md:323-331`, Decisions Log 2026-09-22, directs repair in place while
  preserving the product acceptance. The locked pivot retains the gates
  (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:265-274`).
- Model accounting records the resolved model and separately the reported model,
  never an assumed CLI default
  (`docs/plans/2026-08-09-multi-substrate-build-agent.md:236-262`).
- The existing phase-accounting item owns cumulative storage semantics, explicit
  unknowns, cache counters, provenance, and duplicate-observation refusal
  (`docs/spec-items/trident-phase-accounting.md:11-24`). Its completed storage
  work remains completed; this item supplies collection and attempt attribution.
- Checkpoint continuity and no repeated planning/review spend are already required
  by `docs/spec-items/a-retry-must-resume-from-the-checkpoint.md` § Acceptance.
  This item makes efficiency measurable across the consuming build path.

## Measured starting point

The 2026-09-23 live measurements recorded in #1196 cover three consecutive
governed attempts for one card. The first lasted 2:32:10 and executed five
plan/build pairs for five implementation tasks: 51:09 planning and 1:29:43
building. Those tasks are not duplicate work. A proof-control failure prevented
review. The next attempt lasted 38:53, executed two plan/build pairs, and stopped
on a PR/base conflict. The third spent 8:59 planning and 8:50 building before
review. Time from initial dispatch to first substantive review was 3:41:08.

The later three pairs are recovery/reverification overhead, not proof that every
instruction in them was unnecessary. One base move was caused by the external
orchestrator merging during an active build. Preserve that attribution: a
coordination error does not justify accepting stale review or weakening a gate.
All 27 phase-usage rows for these attempts were unknown; the query's positive
control found all 3,069 rows in the store and likewise found unknown values.
There is no measured token multiplier relative to direct orchestration yet.

Code evidence below was read at `7d5ca4bdae7a983399d7597b50d635793c1e3a26`:

- Review seats dispatch on first read (`trident/project-review-source.ts:193-197`)
  while `trident/gates/review-panel.ts:86-87` awaits each seat sequentially.
  Independent paid reviews therefore serialize on this path.
- The Claude consumer holds `session.acquireTurn()` until the child completes
  (`runtime/workers/claude-acting-turn.ts:199-259`). Concurrent calls to the
  panel alone cannot establish concurrent children through this consumer.
- The build first awaits its standalone review and rechecks CI before entering
  the panel gate (`trident/build-run.ts:602-608`). The panel independently has an
  adversarial seat (`trident/project-review-source.ts:52-54`), and standalone
  review and synthesis retain independent vetoes
  (`trident/gates/review-panel.ts:83-85`). The outer ordering can serialize paid
  review even after the seat loop itself is parallelized.
- Production trailer metadata is undefined (`open/wiring/project-build.ts:293`),
  build failures return before usage accounting (`trident/build-run.ts:367-395`),
  and review observations omit worker usage (`trident/project-review-source.ts:179-181`).
  `runtime/workers/codex-headless.ts:189-191` supplies zero usage and requested
  model/thread fields without observing those values in that return path.
- Plan/build/fix request construction supplies `thread: null`
  (`open/wiring/project-build.ts:438-444`). Review seats already have distinct
  stored thread ownership and writer locks (`trident/project-review-source.ts:79-125`).
- Eligible same-head resume already skips planning/building
  (`trident/build-run.ts:303-313`). Matching full-suite receipt reuse already
  exists (`trident/project-build-host.ts:125-138`). Preserve both and extend the
  existing owners rather than adding a parallel retry or accounting system.
- The continuation reader consumes the root `IMPLEMENTATION_PLAN.md` from the
  measured revision (`trident/production-host-effects.ts:294-315`). The canonical
  doc set calls that plan disposable (`SPEC.md:48`), but publishing different
  cards' plans to the same root path creates shared-base conflicts. Plan ownership
  and continuation must agree without reading another card's ledger as this
  card's completed work.

After that baseline, #1195 replaced the shared plan with a branch-owned ledger
(`trident/production-host-effects.ts:22-46`, `:323-355` at
`6caa89aa12dbc4d99227fa32e22133b5a5d4ec80`) and closed the checkpoint item with
its consuming tests. #1193 also delivered the isolated mutation workspace repair.
The preservation criteria below retain that progress. The historical anchors
above deliberately remain pinned to their measured baseline; the remaining
production gaps are still present on this base: missing metadata at
`open/wiring/project-build.ts:317`, null builder threads at `:469`, serial seat
reads at `trident/gates/review-panel.ts:86-87`, and the outer standalone-review
barrier at `trident/build-run.ts:691-697`.

## Acceptance

- [ ] **Every attempted bounded call is attributable, including failures.** The
  durable run evidence identifies run, task, step/attempt, role or review seat,
  measured revision, provider, requested/resolved model, separately reported
  model, placement, outcome, and host observation times. Queue wait, preparation,
  execution, review/synthesis, proof, retry wait, and cleanup are distinguishable
  where those stages occur; overlapping stage durations are not summed and
  presented as elapsed wall time. Provider token/cache/cost measurements retain
  source and observation time; unavailable metrics remain unknown, explicit
  measured zero stays zero, and pricing is not invented. Failed, interrupted,
  blocked and successful calls retain whatever measurements were observed.
  Reconciliation after restart cannot count one call twice or discard earlier
  spend. Verify missing metadata, real zero, partial streaming usage followed by
  failure, duplicate completion, and restart against nonzero successful controls.
  Telemetry does not authorize a result or turn missing usage into a build veto.
  Verify through `trident/phase-usage.test.ts`, the worker adapter tests, and
  `open/__tests__/project-build-e2e.test.ts`, not a storage-only fixture.

- [ ] **Independent reviews run concurrently within admitted capacity.**
  Launch every independently admissible verdict producer, including standalone
  review and panel seats, without waiting for another producer's verdict;
  preserve readiness/CI admission and explicit capacity/rate-limit scheduling,
  and record queue wait. Do not move paid dispatch ahead of a required safety
  precondition merely to overlap work.
  The synthesis that consumes the panel waits for all required observations.
  A barrier-based test with sufficient capacity requires every seat to start
  before any is released, so serial awaits fail without relying on wall-clock
  timing. Delaying or failing one seat cannot let another seat's approval stand
  in for it. Malformed, missing, mismatched and deferred observations preserve
  their existing refusal/retry semantics; no valid verdict is rerun for unanimity.
  Verify in `trident/gates/review-panel.test.ts`,
  `trident/project-review-source.test.ts`, `runtime/workers/claude-acting-turn.test.ts`,
  and the consuming E2E suite. The real consumer's submission/ownership lock must
  still prevent overlapping REPL writes while allowing independently accepted
  children to execute concurrently. Test two accepted children remaining live
  together, and a lost acknowledgement never permitting a duplicate dispatch.
  A mocked runner that ignores the consumer's lock is insufficient evidence.
  The consuming E2E barrier must include the standalone reviewer and panel seats,
  preserve standalone and synthesis vetoes, and assert that unavailable admission
  still prevents dispatch. Parallelizing only the panel loop cannot satisfy this.

- [ ] **Recurring work keeps the intended placement and conversation.**
  Same-provider calls use native project subagents. Recurring cross-provider
  plan/build/fix calls reuse an observed thread with durable ownership scoped to
  the run, project, worker role, provider, model and credential identity. Preserve
  the existing separate review-seat threads. A provider without a supported
  continuity contract returns an explicit capability outcome rather than silently
  substituting a provider or claiming reuse. A first turn may create its thread;
  a follow-up cannot silently create a different thread. Host restart preserves
  the binding, and concurrent writers or mismatched ownership cannot share it.
  Test both placement directions, initial creation, successful resume/recall,
  changed model/credential scope, missing/corrupt receipts and overlapping writers
  through the real adapter request construction. Cache ratios are observational:
  a cold server cache alone cannot fail a correctly resumed call.

- [ ] **Recovery reconciles before buying more work.** A lost acknowledgement or
  host restart resolves the persisted pending step through its original identity
  before any new dispatch; uncertainty remains explicit and bounded. A completed,
  eligible step on unchanged task, brief, head, model and policy inputs is reused
  without another planner/builder/reviewer call. Changed inputs invalidate the
  affected result. A moved head cannot inherit approval, mutation proof, or a suite
  receipt for the previous head. Recoverable publication/proof infrastructure
  failure does not automatically discard a measured completed build. Tests count
  dispatches and assert both reuse and required re-execution, including changed
  task text, moved heads, lost acknowledgements, and missing legacy evidence.
  Preserve the terminal-task checkpoint work tracked by #1191 and suite-scope fix
  #1192. Verify through `trident/cross-run-retry-checkpoint.test.ts`,
  `trident/build-run.test.ts`, and `open/__tests__/project-build-e2e.test.ts`.

- [ ] **Continuation consumes this card's verified plan.** The plan ledger's
  ownership survives task handoff and eligible retry and is verified alongside
  its committed bytes and counts. A valid owned plan enables the continuation
  planner; another card's plan, stale identity, malformed counts or changed bytes
  cannot be adopted as completed work. Preserve G026's scheduled full refresh
  even with a valid ledger. Two cards with disjoint code changes cannot overwrite
  each other's plan or introduce a merge conflict solely by publishing their
  disposable planning state. Test the real committed-plan reader and consuming
  task handoff in both directions. Keep the canonical plan contract in
  `SPEC.md` consistent with the implementation; this criterion does not authorize
  bypassing G027/G028's committed-plan evidence or the full-refresh cadence.

- [ ] **Preparation and proof reuse is tied to measured inputs.** Reuse validated
  setup or suite evidence only under its existing identity contract, including
  dependency manifests/lockfile, runtime/toolchain, workspace isolation, revision
  and suite strategy where relevant. Changed dependencies or a mismatched receipt
  require preparation/proof again. A valid subset receipt cannot become full-suite
  evidence. Preserve the isolated mutation workspace repair tracked by #1189;
  dependencies found in an ancestor directory cannot establish a valid workspace.
  Paired consuming tests demonstrate a saved preparation/suite invocation and
  a required invocation when each relevant identity input changes.

- [ ] **Efficiency cannot reset budgets or bypass a gate.** Review rounds, one
  bounded re-plan, infrastructure retry ceilings/backoff and atomic claims retain
  their existing durable limits across recovery. Changed scheduling preserves
  review independence, seat rotation, provenance, every veto, arbitration, full
  suite, mutation proof, leak preflight and pinned merge. In particular preserve
  G059, G063-G065, G070-G082 and every other affected row of
  `docs/trident-gates-inventory.md`. Test repeated findings escalating and genuinely
  improving rounds continuing; exhausted retries stopping and a permitted retry
  proceeding; timeouts remaining typed rather than silently starting a fresh run.
  Every touched guard needs semantic mutations in both directions: a forbidden
  action is refused and its legitimate sibling still succeeds. A parser error is
  not a semantic mutation result.

- [ ] **The improvement is measured through the deployed path.** A deterministic
  benchmark covers fresh build, a code-fix round, unchanged-head recovery,
  moved-head recovery and infrastructure interruption using fixed task inputs
  and scripted provider outcomes. Record dispatch/setup/proof counts, stage
  timing and identical gate decisions before/after. It must detect deliberately
  serialized review and unnecessary redispatch while accepting required fresh
  work. Then deploy the reviewed revision, prove served new behavior with a
  positive and negative control, and dispatch a fresh Work Board card through the
  adopted project chat REPL to an unattended merge. Retain run-owned artifacts,
  code/deployment SHAs, models, stage times, known token/cache/cost measurements
  and unknown coverage. The live evidence must demonstrate concurrent independent
  review and attributable usage where the providers supply it. Compare equivalent
  task/gate/model scopes when contrasting direct orchestration; report unmatched
  cases as unmatched. An arbitrary percentage saving or one fast unrelated task
  is not acceptance. Unknown usage cannot establish a token saving.

Every implementation slice names `open/__tests__/project-build-e2e.test.ts`
explicitly and runs it when touching publication, admission or review, alongside
its focused checks and both `tsc -p tsconfig.json` and
`tsc -p trident/tsconfig.json`. CI green alone does not satisfy the live criterion.
The retry and orchestrator items retain their own criteria and completion state;
satisfying this item never changes their status by implication. The checkpoint
item's completion in #1195 is preserved; this item's broader efficiency criteria
remain open.
