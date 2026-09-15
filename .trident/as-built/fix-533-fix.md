## Issue #533 — start the comments AgentWatcher loop

### What changed

The Open composer now builds the watcher over the existing comment store, document reader, canonical active-project store, shared anchor-walker lock, chat-session project registry, and conversational substrate (`open/composer.ts:3665-3693`). It registers the watcher before starting it and installs a shutdown cleanup (`open/composer.ts:3694-3696`). The watcher now exposes the live descriptor required by the shared loop inventory, including cadence, start time, health, and active state (`gateway/comments/agent-watcher.ts:344-355`).

The dormant-loop registry now retains only the project backup scheduler (`gateway/composition.ts:62-70`). The exact Open running-loop set includes `agent-watcher`, while both loop-inventory tests expect only the backup scheduler to remain dormant (`open/__tests__/loop-inventory-open-composer.test.ts:45-92`, `gateway/__tests__/loop-inventory-production-composer.test.ts:54-69`).

### Decisions

The existing `LoopRegistry` is the vocabulary for long-lived loop outcomes: the new descriptor makes `agent-watcher` visible as running, and the registry's duplicate-name default remains a boot-time throw (`loop/registry.ts:91-106`). Registration happens before `start()`, so a collision cannot arm the timer (`open/composer.ts:3694-3695`). The invariant is maintained continuously by the live descriptor and does not rely on the watcher tick succeeding; shutdown is owned by the composition's cleanup list (`open/composer.ts:3696`).

No model credential means `buildAgentWatcherLlmCall` returns null, so the watcher is not constructed (`gateway/wiring/build-agent-watcher-llm-call.ts:100-107`). This preserves the existing explicit no-substrate classification rather than adding a timer that can only skip work.

### Test evidence

The production-composition test seeds a canonical active project, uses the composed HTTP handler, posts a real comment, and waits for an agent-authored reply (`open/__tests__/doc-comments-wiring.test.ts:151-181`, `open/__tests__/doc-comments-wiring.test.ts:359-381`). The restored focused test passed: 1 passed, 0 failed. The complete touched suites passed separately: `open/__tests__/doc-comments-wiring.test.ts` 7/7, `open/__tests__/loop-inventory-open-composer.test.ts` 6/6, and `gateway/__tests__/loop-inventory-production-composer.test.ts` 8/8.

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Open composition starts the watcher (`open/composer.ts:3695`) | Replaced `agentWatcher.start()` with `agentWatcher.stop()` at that exact line | `a new comment wakes the production-composed AgentWatcher and receives an agent reply` failed after its two-second deadline | Same focused test passed, 1/1 |

The repository typecheck matrix checked 51 configurations. The changed Open and root configurations pass; the matrix also reported an unrelated missing implicit `@types` library in `app/tsconfig.json`. `scripts/ci/lint.sh` passed every gate.

The construction search was enumerated with `rg -n "new AgentWatcher" --glob '!**/*.test.ts'`; it finds the production site at `open/composer.ts:3674` (and the spec's verification command). The dormant-name absence was checked with one alternation whose positive control is the retained backup scheduler: `rg -n "name: '(agent-watcher|project-backup-scheduler)'" gateway/composition.ts` finds only `project-backup-scheduler` at `gateway/composition.ts:65`.

### Deliberately not changed

The project backup scheduler remains deferred and dormant (`gateway/composition.ts:64-69`). The watcher retains its fixed 30-second production cadence (`gateway/comments/agent-watcher.ts:91-96`); the shorter cadence is an explicit composer test seam used only to make the reachability test bounded (`open/composer.ts:638-639`, `open/__tests__/doc-comments-wiring.test.ts:168`). No feature flag or alternate production path was added.
