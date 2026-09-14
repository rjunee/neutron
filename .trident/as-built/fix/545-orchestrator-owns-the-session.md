## 2026-09-14 — Terminal decisions join the project conversation (#545)

### Slice and decision

Terminal build decisions now enter the existing chat runner, using its project
conversation substrate and admission queue (`open/composer.ts:4341`,
`gateway/wiring/build-live-agent-turn.ts:1062`). This replaces the terminal wake's
background composition route. It is a bounded continuation of #697 and #707,
not completion of the project-session rebuild.

The runner exposes a host acting-turn entry alongside its callable chat entry
(`gateway/wiring/build-live-agent-turn.ts:834`). Both use the same queue and
queued-turn count (:1041), so an acting turn waits behind chat, later chat waits
behind it, and a queued wake prevents injection past it (:978). Different topic
keys can advance independently. The acting entry returns text to the existing
wake delivery contract instead of fabricating an owner message (:1063).
The dispatch helper is extracted from the chat path, including activity events,
start/finish observation and timeout cleanup (:1069, :1597). A wake's budget
starts only when admitted (:1064); chat keeps its existing timeout and retry policy.

The production terminal callback must return without awaiting that queued turn
(`open/composer.ts:4362`). A chat tool can terminate a run; termination awaits its
observer (`trident/terminate.ts:168`), and the observer chain awaits each member
(`trident/terminal-observer.ts:73`). Waiting for a decision queued behind the
calling chat turn would deadlock. The existing logged `fireAndForget` mechanism
owns the promise; the three registrations share this callback
(`open/composer.ts:6037`, :6058, :6887).

The scope was recorded before code in the external lane progress file. The staged
issue is an umbrella summary. Its named implementation-plan file was unavailable:
`rg --files docs | rg 'trident-autonomy-implementation-plan|harness-orchestrator-pivot-2026-09-11'`
found only the latter, the positive control. The target remains the project REPL
at `docs/plans/harness-orchestrator-pivot-2026-09-11.md:81`. No product decision was
invented or changed. The task explicitly requires this as-built staging path.

### Authority, maintenance and outcomes

The RUN still reports; the ORCHESTRATOR decides. The run reconciler's entire
board capability is `detachRun` (`trident/board-reconcile.ts:49`, :116). The
protected `trident/escalation-block.test.ts` has no diff and its 29 tests pass,
including the hostile reorder and single-verb cases (:537, :579).

Admission is maintained on every entry by the host queue, independently of the
failed run. Its settled tail releases successors after rejection
(`gateway/wiring/build-live-agent-turn.ts:1045`). The shared dispatcher finishes
activity observation in `finally` (:1085). The database claim still permits one
wake per terminal run (`trident/store.ts:1456`); the observer still selects the
same escalation prompt, tools, model, budget and loud/quiet delivery
(`gateway/proactive/terminal-build-wake.ts:81`, :112, :122).

No new error/verdict/state vocabulary was added. Acting-turn failures reject into
`terminal_build_wake_failed_after_claim`, the existing observer error category
(`gateway/proactive/terminal-build-wake.ts:124`). Pre-claim rejection now reaches
the existing non-fatal logged promise mechanism (`open/composer.ts:4363`,
`logger/fire-and-forget.ts:132`). Neither category reports a completed decision.
Claimed wakes still lack durable retry: a crash or failed turn can lose the wake.
This change does not claim that the in-memory queue survives restart.

### Gates retained

Enumerated from the six-item keep-list at
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:261`, read in this session:

- Leak preflight: `trident/orchestrator.ts:2669`.
- Pinned merge refusal: `trident/merge.ts:1764`.
- Cross-model deferral: `trident/inner-workflow.mjs:7079`.
- Seat rotation storage: `trident/codex-rotation-store.ts:138`.
- Mutation prover invocation/refusal: `trident/orchestrator.ts:5268`, :5310.
- Arbiter forbidden options: `trident/arbiter.ts:99`.

These files have no diff, as enumerated by `git diff --name-only`. This is
preservation by scope, not a claim that all six gate suites were executed. The
prior slice's leak and mutation citations had moved; the references above name
the current call sites.

### Tests and mutation table

Q = `gateway/wiring/__tests__/build-live-agent-turn-overlap.test.ts` (4 tests).
P = the socket-free production case in
`open/__tests__/open-terminal-build-wake-wiring.test.ts` (1 selected test).
Every experiment printed a unified mutation diff and landing line before running,
then restored the file and ran the same test green. The failure-tail experiment
was repeated with a corrected printer naming the changed line rather than its
unchanged neighboring callback. The table enumerates all 12 distinct experiments.

| Property / landing | Mutation | Red | Restored |
| --- | --- | --- | --- |
| Wake admission, gateway/wiring/build-live-agent-turn.ts:1064 | Dispatch immediately | Q: 1 fail | 4 pass |
| Shared topic, gateway/wiring/build-live-agent-turn.ts:1064 | Use another queue key | Q: 1 fail | 4 pass |
| Chat admission, gateway/wiring/build-live-agent-turn.ts:1027 | Execute body immediately | Q: 2 fail | 4 pass |
| Activity start, gateway/wiring/build-live-agent-turn.ts:1082 | Disable observation | Q: 1 fail | 4 pass |
| Activity finish, gateway/wiring/build-live-agent-turn.ts:1086 | Disable observation | Q: 2 fail | 4 pass |
| Activity events, gateway/wiring/build-live-agent-turn.ts:1078 | Drop event tee | Q: 1 fail | 4 pass |
| Acting budget, gateway/wiring/build-live-agent-turn.ts:1065 | Set budget to zero | Q: 1 fail | 4 pass |
| Project substrate, open/composer.ts:4341 | Restore background composition | P: 1 fail | 1 pass |
| Queued wake excludes injection, gateway/wiring/build-live-agent-turn.ts:978 | Accept injection with queued successors | Q: 1 fail | 4 pass |
| Failure release, gateway/wiring/build-live-agent-turn.ts:1047 | Rethrow from queue tail | Q: 1 fail | 4 pass |
| Budget after admission, gateway/wiring/build-live-agent-turn.ts:1064 | Spend budget while queued | Q: 1 fail | 4 pass |
| Terminal callback release, open/composer.ts:4363 | Await the held wake | P: timeout/fail | 1 pass |

Q uses the real chat runner with controlled substrate output to prove both
admission directions, no injection during or past a wake, independent projects,
activity lifetime and failure release (:192, :255, :278). Its history assertion
has positive controls for both chat messages before excluding wake text (:249).
P uses the production composer, real database claim and a held fake substrate:
the terminal callback returns before output is released, then exactly one wake
uses the live conversation identity, project and tool bridge (:260), with one
durable reply on the original chat (:282). It does not
exercise a live model or prove model judgement. The original socket delivery
case remains intact apart from expecting the new substrate prefix (:252).

### Documentation and remaining work

The existing sequencing acceptance box stays checked; its explanatory scope now
records this terminal handoff (`docs/spec-items/the-review-loop-must-stop-and-re-plan.md:126`).
No additional completion box was ticked. The invariant and system overview name
the admission rule (`docs/INVARIANTS.md:61`, `docs/SYSTEM-OVERVIEW.md:714`).

A tree-wide search for `existing background wake seam`, `separate background
substrate`, and `Registered LAST in each chain` found the current spec/comment and
the prior as-built records as positive controls. The current statements were
updated; prior as-built records remain immutable historical descriptions. The
background reminder and periodic continuation descriptions remain applicable
(`open/composer.ts:2914`, :6424); terminal decision composition is the route moved.

Remaining: launch and workflow control, checkpoint/result transport, durable wake
retry, harness switching, and the broader project-session replacement. Generic
proactive continuation is outside this slice. No worker board authority, new
board operation, alternate loop, feature flag, push, PR or merge was added.
The inherited four-minute wake ceiling now applies to a turn in the shared
conversation; a substrate failure can require that conversation to recover.

### Validation

- 101 tests passed across these seven explicit files: the overlap, base runner,
  activity-inspector and coldstart tests under `gateway/wiring/__tests__/`,
  `gateway/proactive/__tests__/terminal-build-wake.test.ts`,
  `work-board/dependency-sequencing.test.ts`, and `trident/escalation-block.test.ts`.
- The full `open/__tests__/open-terminal-build-wake-wiring.test.ts` run has two
  passes and one failure: the existing socket fixture cannot bind port 0
  (`Bun.serve`, :143, EADDRINUSE). No test was skipped or relaxed. The socket-free
  production case and construction check pass, including durable reply delivery
  (:282). This is not a fully green Open test file; the socket case needs an
  environment that permits listening.
- All 51 configurations passed `bash scripts/ci/typecheck-all.sh`. The first
  matrix caught missing pagination fields in the new history fixture; the fixture
  now supplies them and verifies real chat rows before its negative assertion
  (`gateway/wiring/__tests__/build-live-agent-turn-overlap.test.ts:249`).
- Repository lint (`bash scripts/ci/lint.sh`) passed. `git diff --check` passed.
  The record has exactly one top-level second-level heading.
- The leak gate reports zero findings from available rules but INCOMPLETE because
  the out-of-band PII denylist is unavailable. This is not a clean purity result.

No whole-suite run, live model invocation or deployment was performed.
