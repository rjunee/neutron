## 2026-09-15 — Launcher cutover investigation, incomplete

### Delivery status

**The launcher cutover is not delivered.** This commit contains this record only.
The composition still constructs the old seam (open/composer.ts:1158), and the
gateway still serializes typed input through the old wrapper
(gateway/composition/build-core-modules.ts:647; trident/inner-loop.ts:997).
The production construction/run regression test and its removal mutation are
also not delivered. This record must not close step 3 acceptance.

The supplied handoffs were read. The current base has the three review
observation sources wired (trident/project-build-host.ts:99), superseding the
prior investigation's missing-source finding. Additional integration work remains
below. These are engineering gaps, not requests for credentials or product-policy
approval. No product decision was changed. The checked-out branch, enumerated by
`git branch --show-current`, was `rebuild/launcher-cutover-2`; it was preserved.
The record location follows the explicit lane instruction.

### Remaining integration requirements

1. **Actual worker observations.** The project decoder requires independently
   observed usage/model/thread metadata keyed by the bounded request
   (runtime/workers/project-runners.ts:37). Even a valid completed trailer becomes
   unknown without it (runtime/workers/project-runners.ts:59). I did not establish
   a production reader for those observations. Parent dispatch-turn usage cannot
   be substituted for the bounded child's usage under that contract.
2. **Bound live sessions.** The acting-turn factory requires a project/topic,
   actual session and observed launch grants (runtime/workers/claude-acting-turn.ts:11).
   It refuses other providers and requires the requested cwd to equal the session
   cwd (runtime/workers/claude-acting-turn.ts:27; runtime/workers/claude-acting-turn.ts:30).
   The worker context instead belongs to the isolated worktree
   (trident/production-host-effects.ts:414). Binding a repo-root conversation to a
   worktree request therefore requires resolving that mismatch, not bypassing the
   guard. The general runner factory still requires an acting-turn callback
   (runtime/workers/project-runners.ts:74); having provider-specific runner
   constructors is not evidence that those live callbacks have been bound.
3. **Effort vocabulary.** Default decomposition uses `max`
   (trident/phase-models.ts:177), while bounded requests accept only low, medium or
   high (runtime/bounded-work.ts:56). A cast or silent reduction would lose the
   selected policy. The integration needs an explicit transport-compatible
   representation. The Codex headless runner supports build/fix, so it also cannot
   simply stand in for the planner or review seats
   (runtime/workers/codex-headless.ts:22).
4. **Durable outcome handoff.** Production checkpoint writes persist mode state
   (trident/production-host-effects.ts:239). A witnessed remote merge returns allow
   (trident/production-host-effects.ts:388), and the project host returns its final
   outcome to its caller (trident/project-build-host.ts:111). The outer harvest
   reads `inner_result` (trident/orchestrator.ts:5549). A detached promise alone
   does not bridge those contracts. The driver explicitly calls unknown a
   nonterminal outcome whose worker and step identity must be preserved
   (trident/build-run.ts:139), while cleanup runs in finally even for that outcome
   (trident/project-build-host.ts:54). Outcome persistence, outer classification,
   and recovery of uncertain runs need to be integrated together.
5. **Suite evidence.** Strategy can come from the typed test strategy
   (trident/inner-loop.ts:169); intermediate Ralph tasks have a distinct strategy
   (trident/inner-loop.ts:171). Actual scope and the independent report still need
   binding. Missing report is unknown, not successful suite evidence
   (trident/project-observation-sources.ts:75). I did not source a report reader.

### Option inventory

Enumerated from every field in `ProjectBuildHostOptions`
(trident/project-build-host.ts:27) and `ProductionHostOptions`
(trident/production-host-effects.ts:21). This table describes inspected sources
and unresolved bindings; it is not a completed production options object.

| Option | Source / remaining binding |
| --- | --- |
| substrate.provider | Resolve the dispatched project explicitly through the project provider resolver; its optional-argument convenience closure otherwise falls back to active chat (open/composer.ts:1053). |
| substrate.inRepl, headless | Factory requires conversation, run identity, retained directory, acting turn, decoder and headless registry (runtime/workers/project-runners.ts:69). Live binding and metadata remain unestablished above. |
| production.store | Canonical board store (open/composer.ts:4259). |
| production.runId, projectSlug, repo, worktree, branch | Typed run before serialization (trident/inner-loop.ts:78); host verifies initialized identity and base (trident/project-build-host.ts:63). |
| production.baseBranch | Typed base_branch (trident/inner-loop.ts:79). |
| production.runHost | Credentialed host runner (open/composer.ts:2197). |
| production.ciWorkflow | Per-repo declaration (trident/project-repos.ts:10); repo selection must bind the dispatched repository. |
| production.ciSource, ciNow | Optional source/clock inputs (trident/production-host-effects.ts:32); project host constructs the default acquisition (trident/project-build-host.ts:80). |
| production.publication | Title and body-file contract (trident/production-host-effects.ts:34); host invocation consumes the body path (trident/production-host-effects.ts:350). Per-run body preparation is unimplemented here. |
| phaseUsage | Existing database-backed store constructor (trident/phase-usage.ts:26); binding remains to be made. |
| policy.boundReview | Optional bound-review run/deps pair (trident/build-host.ts:27); mode selection remains to be integrated. |
| policy.review | Source requires phase models, descriptor-aware runnerFor, evidence directory, environment, budget and signal (trident/project-review-source.ts:13). Missing/mismatched runner becomes unavailable (trident/project-review-source.ts:74). |
| policy.reviewSuite | Strategy, actual scope and independent reader (trident/project-observation-sources.ts:12); missing report remains unknown (trident/project-observation-sources.ts:75). |
| policy.leak | Scratch directory and optional script are caller inputs (trident/project-build-host.ts:38); run identity and host execution are composed at trident/project-build-host.ts:92. |
| policy.mutation | Snapshot claim reader is required (trident/build-host.ts:37); other run fields are composed at trident/project-build-host.ts:93. Reader remains unimplemented here. |
| workers | Four role requests (trident/build-run.ts:88); model, effort, grants, brief, result, thread and budget contract (runtime/bounded-work.ts:61). Production request construction remains unimplemented here. |

### Every fire-variable branch

Enumerated with `rg -n 'tridentFireInnerWorkflow' open/composer.ts`.
No branch was changed.

| Location | Current credential-free behavior |
| --- | --- |
| open/composer.ts:1158 | Null without liveAgentSubstrate; otherwise constructs the old fire. |
| open/composer.ts:4560 | boardStartBuild undefined; false arm at open/composer.ts:4607. |
| open/composer.ts:6256 | Conflict resolver undefined; false arm at open/composer.ts:6260. |
| open/composer.ts:6286 | Arbiter undefined; false arm at open/composer.ts:6290. |
| open/composer.ts:6302 | Leak fixer undefined; false arm at open/composer.ts:6306. |
| open/composer.ts:7066 | Omits the trident composition bag; credentialed arm passes the fire at open/composer.ts:7069. |

The reference at open/composer.ts:2267 is explanatory; the actual guard there
uses llmPool at open/composer.ts:2271 and returns null. The references at
open/composer.ts:7059 and open/composer.ts:7060 describe the final bag guard.

### Outcome vocabulary and mutation evidence

Existing fire outcomes are fired, failed and unconfirmed
(trident/inner-loop.ts:394). The old wrapper maps thrown launch errors to failed
(trident/inner-loop.ts:1000). Its unconfirmed contract includes a later settled
promise (trident/inner-loop.ts:419). No new mapping was implemented, and no
unconfirmable launch was represented as fired by this change.

Worker unknown stops the driver as unknown; refused stops it blocked
(trident/build-run.ts:295). The driver's complete outcome union is enumerated at
trident/build-run.ts:132: merged, blocked, built, continued, refused, failed and
unknown. That vocabulary cannot be collapsed into a terminal failure without
losing its explicit unknown semantics (trident/build-run.ts:139).

| Required guard | Mutation | Red | Restored green |
| --- | --- | --- | --- |
| Production composition constructs host and starts run | Not delivered | Not run | Not claimed |

No code, test, guard or continuously maintained invariant was added. Baseline
passes below do not substitute for the requested wiring-removal mutation.

### Controlled searches

Working-tree content checks only; no fetched-ref absence claim is made.

- `rg -n 'suiteOutcome|suiteEvidence|saveCheckpoint|terminalTransition|inner_result|recordStageEvent' trident/production-host-effects.ts trident/build-run.ts`
  found the positive controls saveCheckpoint at trident/production-host-effects.ts:239
  and trident/build-run.ts:267, plus recordStageEvent at
  trident/production-host-effects.ts:374 and trident/production-host-effects.ts:423.
  It found none of the named suite-report or terminal-write spellings in these
  two files. This is scoped textual evidence, not a claim about all persistence.
- `rg -n 'createClaudeActingTurn|createProjectRunners|metadata\(request|supervisedBySessionKey' open runtime/workers runtime/adapters/claude-code/persistent/pool-state.ts --glob '*.ts' --glob '!*.test.ts'`
  found the factory definitions at runtime/workers/claude-acting-turn.ts:21 and
  runtime/workers/project-runners.ts:82, the metadata contract/read at
  runtime/workers/project-runners.ts:37 and runtime/workers/project-runners.ts:59,
  and the registry control at runtime/adapters/claude-code/persistent/pool-state.ts:741.
  It found no matching factory calls under open. This does not establish that
  some differently named integration could not exist elsewhere.

### Validation and deliberate limits

Bounded command:

```sh
bun test trident/project-build-host.test.ts trident/production-host-effects.test.ts runtime/workers/ open/__tests__/open-trident-prod-boot-wiring.test.ts open/__tests__/open-boot-shell.test.ts open/__tests__/open-agent-dispatch-wiring.test.ts open/__tests__/open-dispatch-hold-drain-wiring.test.ts
```

235 passed, five failed, 240 tests across 12 files, enumerated by that command's
explicit paths and worker-directory discovery. All five failures occurred in
open/__tests__/open-boot-shell.test.ts at the loopback listener bind
(gateway/index.ts:906), with EADDRINUSE:

- fresh boot serves healthz;
- fresh chat GET mints cookie/start token;
- no-credential chat start gates on authentication;
- returning visit with resumable session gates on authentication;
- stale cookie over empty database cold-starts onboarding.

These failures are not passes. No assertions were weakened or skipped.

No launcher cutover, detached lifetime supervisor, terminal handoff, worker
metadata acquisition, provider fallback, suite evidence fabrication, feature
flag, protected-file edit or specification change was delivered. No full-suite
sweep, push, PR or merge was performed. The missing implementation remains the
lane's unfinished work, not a completed acceptance with optional follow-ups.

Final baseline checks: `bash scripts/ci/typecheck-all.sh` passed all 51
configurations (exit 0); `bash scripts/ci/lint.sh` passed (exit 0).
`bash scripts/ci/leak-gate.sh --tree .` returned exit 3, INCOMPLETE: zero findings
from executed rules, but pii-denylist and pii-denylist-msg could not run.
This is not a clean leak result. `git diff --check` passed, and the shard has
exactly one top-level `## ` heading.
