## 2026-09-14 — Distinguish blocked workers from slow and unknown work (#754)

### Change and evidence

A current selection cursor plus an explicit Enter instruction reports blocked;
working controls report working; unmatched output reports unknown. The classifier
retains a timestamp and bounded terminal text, and rejects byte history as evidence
of current UI (`runtime/adapters/claude-code/persistent/worker-observation.ts:18`,
`:23`, `:29`, `:38`). Fences are stripped before windowing: the existing scanner
exemplar windows first (`runtime/adapters/claude-code/persistent/output-scan.ts:132`),
which cannot preserve a fence opened above that window. The new classifier uses
its quote stripper before taking the window instead (`runtime/adapters/claude-code/persistent/worker-observation.ts:26`
in the same adapter directory).

The host supplies a fresh read, including unchanged screens, rather than relying
on output-change callbacks (`runtime/adapters/claude-code/persistent/herdr-host.ts:534`).
Malformed responses are unavailable (`runtime/adapters/claude-code/persistent/herdr-host.ts:539` in that directory).
Observation has a two-second capture budget; failure retains the last available
output as unknown (`runtime/adapters/claude-code/persistent/observe-workers.ts:27`).
This is an I/O bound, not a second inactivity deadline.

The existing turn watchdog observes independently of worker replies, allows one
capture at a time, and rejects a capture that finishes after the turn settles
(`runtime/adapters/claude-code/persistent/pool.ts:777`). A positive block settles
with evidence; positive working UI bypasses inactivity and deadline policy
(`runtime/adapters/claude-code/persistent/pool.ts:786`, `:797` in that directory). An unclassified timeout carries the fresh
sample (`runtime/adapters/claude-code/persistent/pool.ts:741` in that directory). The positive and negative paths run
through the real turn driver in
`runtime/adapters/claude-code/persistent/__tests__/stuck-agent-turn-wiring.test.ts:260`.

The production orchestrator observes exact worktree paths, including its resolver
worktree (`gateway/composition/build-core-modules.ts:677`; the resolver path's
existing construction is `trident/orchestrator.ts:2630`).
Matching uses the registered session's cwd, not a shared launcher generation
(`runtime/adapters/claude-code/persistent/observe-workers.ts:13`). A blocked sibling
wins; one working sibling cannot hide an unobservable sibling (`:15`, `:18`).

Harvest remains before classification. Blocked returns an infrastructure failure;
working returns waiting with `changed: true` to renew advancement from run-scoped
evidence (`trident/orchestrator.ts:5486`, `:5491`, `:5497`). The tick saves this
through its existing store path (`trident/tick.ts:849`), which writes the advancement
clock (`trident/store.ts:2037`). This keeps the run-driving consumer of that clock
honest as well as the immediate timeout branch. Unclassified deadline failures
say unknown (`trident/orchestrator.ts:6114`, `:6119`) and carry captured evidence
before salvage (`:6261`). The terminal hook receives the saved outcome through
`trident/tick.ts:914`.

### Why readiness was insufficient, and what remains unproven

The filed readiness citations were valid in the starting checkout:
`runtime/adapters/claude-code/persistent/post-spawn-assertion.ts:100`, `:118`
set/enforce the 30-second channel-ready budget. The call is now at
`runtime/adapters/claude-code/persistent/spawn.ts:538`; the capture precedes
termination at `:557`, `:562`. Warm reuse returns an existing session at `:1427`,
without running that fresh-spawn assertion. The readiness contract establishes a
transport handshake, not the state of subsequent interactive UI.

The existing prompt detector was not a general classifier: it requires a numbered
cursor and three specific footer phrases
(`runtime/adapters/claude-code/persistent/interactive-prompt-deadlock-detector.ts:115`).
Its failed recovery surfaces status without settling the turn
(`runtime/adapters/claude-code/persistent/signatures.ts:536` in the starting checkout).
The new observation does not require those particular menu choices or a numbered
cursor and does not depend on the worker emitting another byte.

A fresh spawn on the starting code should already have failed an absent handshake.
The supplied aggregate does not establish why the installed historical runs did
not take that guard. There is no defensible claim here that all 38 failures were
warm reuse, or that the deployed code was this checkout. Establishing that needs
the incident deployment revision, CLI version, spawn/readiness logs and corresponding
run/session records. That historical attribution remains unresolved; it is not
replaced by a guessed cause. Startup tests prove capture-before-termination and
nonretryable propagation for this implementation
(`runtime/adapters/claude-code/persistent/__tests__/stuck-agent-turn-wiring.test.ts:296`).

### Existing outcome vocabularies and defaults

| Observation | Existing outcome and default handling |
|---|---|
| Blocked | Adapter error `channel_wedged`, nonretryable in `runtime/errors.ts:110`; an explicitly stamped startup error bypasses the bounded channel-bind respawn wrapper (`runtime/adapters/claude-code/persistent/spawn.ts:564`, `:904`). The orchestrator chooses existing `phase=failed`/`subagent_status=failed`, with delivery class `infra` (`trident/orchestrator.ts:5493`; `trident/delivery.ts:705`). |
| Working | Observation only, not a new database lifecycle status. The turn stays pending and the run uses existing waiting/advancement semantics (`runtime/adapters/claude-code/persistent/pool.ts:797`; `trident/orchestrator.ts:5498`). |
| Unknown | Observation only until existing deadline policy acts. Adapter timeout remains retryable `turn_timeout` (`runtime/errors.ts:115`); run deadline failures have an explicit unknown prefix and delivery class `infra` (`trident/delivery.ts:698`). Unknown is never reported as a positively detected block. |

Consumer enumeration used `rg -n` over production TypeScript for
`channel_wedged`, `observe_run_worker`, `observeWorkers`, `observeSession`,
`worker.state`, `observation.state`, `workerEvidence`, and `channelWedgeMessage`.
The two gateway error translators originally erased the evidence. They now retain
captured worker diagnostics while retaining their existing nonretryable/no-cooldown
handling (`gateway/wiring/build-llm-call-substrate.ts:980`, `:1649`;
`gateway/wiring/build-import-substrate.ts:477`). Legacy errors retain their existing
copy. No new error code, lifecycle enum value, feature flag or selectable product
path was introduced.

### The 73 empty-status rows, separately

The supplied population counts 73 existing rows with empty status. They cannot be
absent rows in that aggregate. The current writer initializes status to null before
inserting the row (`trident/store.ts:864`, `:900`), and crash recovery can explicitly
clear an already-set status (`:1475`). Terminal retraction can also clear it
(`trident/store.ts:1757`, read during investigation). Thus the aggregate alone
cannot distinguish never-set from later-cleared, nor identify a missed subsequent
write. Instance database/event history and deployment access were not provided.
The per-row explanation remains unresolved; no historical rows were rewritten.

### Validation

Mutation results below record the actual changed location at execution time;
line numbers may precede later comment/formatting changes. Each run printed the
mutated source line, required RED, restored the original, and required GREEN.
A first composition mutation removed the entire property and printed an empty
replacement at line 1; it was repeated with a concrete unknown-returning observer
at the actual wiring location. Only that corrected experiment is recorded below.

The slow direction covers both run timeout paths and real turn completion after
both deadlines. The persistence test closes and reopens the database before
asserting the prompt (`trident/worker-observation.test.ts:46`). Late capture and
single-flight observation are covered at
`runtime/adapters/claude-code/persistent/__tests__/stuck-agent-turn-wiring.test.ts:313`.

Local listening sockets are unavailable, including port zero. Turn integration
checks therefore use the committed test-only in-memory HTTP preload,
`tests/support/in-memory-http-preload.ts:1`, routing Request/Response objects through
the real handlers. This is not an installed-CLI or real-socket proof. Existing
assertions were retained; old exact failure-message assertions were updated to
require the new explicit unknown evidence, rather than loosened to partial matches.
Two pre-existing skipped gateway tests were left unchanged.

| Guard | Mutation | Actual location | Mutated | Restored |
|---|---|---|---|---|
| byte history | Disable the rendered-screen requirement | `runtime/adapters/claude-code/persistent/worker-observation.ts:23` | RED | GREEN |
| working veto | Disable working-chrome recognition | `runtime/adapters/claude-code/persistent/worker-observation.ts:27` | RED | GREEN |
| idle cursor | Remove the normal-input-cursor veto | `runtime/adapters/claude-code/persistent/worker-observation.ts:31` | RED | GREEN |
| selection cursor | Accept missing selection cursor | `runtime/adapters/claude-code/persistent/worker-observation.ts:36` | RED | GREEN |
| input instruction | Accept missing Enter instruction | `runtime/adapters/claude-code/persistent/worker-observation.ts:36` | RED | GREEN |
| quote rejection | Remove quote filtering | `runtime/adapters/claude-code/persistent/worker-observation.ts:18` | RED | GREEN |
| worktree identity | Include unrelated worktree sessions | `runtime/adapters/claude-code/persistent/observe-workers.ts:13` | RED | GREEN |
| blocked sibling | Ignore the blocked sibling | `runtime/adapters/claude-code/persistent/observe-workers.ts:16` | RED | GREEN |
| blind sibling | Accept one working sibling instead of requiring all | `runtime/adapters/claude-code/persistent/observe-workers.ts:18` | RED | GREEN |
| capture deadline | Extend the capture bound beyond the test deadline | `runtime/adapters/claude-code/persistent/observe-workers.ts:36` | RED | GREEN |
| orchestrator blocked | Disable the early blocked branch | `trident/orchestrator.ts:5491` | RED | GREEN |
| orchestrator working | Disable the working branch | `trident/orchestrator.ts:5497` | RED | GREEN |
| working renewal | Return changed=false for positive work | `trident/orchestrator.ts:5498` | RED | GREEN |
| durable screen | Drop the persisted evidence suffix | `trident/orchestrator.ts:6262` | RED | GREEN |
| unknown vocabulary | Replace unknown deadline text with suspected hang | `trident/orchestrator.ts:6114` | RED | GREEN |
| delivery classification | Disable the anchored blocked class | `trident/delivery.ts:705` | RED | GREEN |
| turn blocked | Disable the turn blocked branch | `runtime/adapters/claude-code/persistent/pool.ts:786` | RED | GREEN |
| slow turn | Disable the positive-working timeout exemption | `runtime/adapters/claude-code/persistent/pool.ts:797` | RED | GREEN |
| late capture | Remove the settled/current-turn fence | `runtime/adapters/claude-code/persistent/pool.ts:785` | RED | GREEN |
| typed spawn refusal | Remove the stamped nonretryable error class | `runtime/adapters/claude-code/persistent/spawn.ts:564` | RED | GREEN |
| capture before termination | Terminate before capturing | `runtime/adapters/claude-code/persistent/spawn.ts:557` | RED | GREEN |
| host fresh capture | Return an empty screen instead of the fresh read | `runtime/adapters/claude-code/persistent/herdr-host.ts:540` | RED | GREEN |
| registered workers | Return an empty registered-session set | `runtime/adapters/claude-code/persistent/pool-state.ts:187` | RED | GREEN |
| composition observer | Wire an always-unknown observer | `gateway/composition/build-core-modules.ts:677` | RED | GREEN |
| gateway evidence translation | Always return generic channel copy | `gateway/wiring/build-llm-call-substrate.ts:1650` | RED | GREEN |
| llm consumer wiring | Bypass evidence-preserving translation | `gateway/wiring/build-llm-call-substrate.ts:980` | RED | GREEN |
| import consumer wiring | Replace evidence with generic copy | `gateway/wiring/build-import-substrate.ts:477` | RED | GREEN |
| single capture | Allow overlapping captures | `runtime/adapters/claude-code/persistent/pool.ts:779` | RED | GREEN |
| timeout screen | Drop the fresh screen from timeout errors | `runtime/adapters/claude-code/persistent/pool.ts:741` | RED | GREEN |
| dead child | Read a dead child as current UI | `runtime/adapters/claude-code/persistent/observe-workers.ts:32` | RED | GREEN |
| malformed screen | Accept a response without usable text | `runtime/adapters/claude-code/persistent/herdr-host.ts:539` | RED | GREEN |
| fence boundary | Window before stripping a long fence | `runtime/adapters/claude-code/persistent/worker-observation.ts:26` | RED | GREEN |
| empty worker set | Let empty.every count as working | `runtime/adapters/claude-code/persistent/observe-workers.ts:18` | RED | GREEN |

Final results:

- Targeted tests: **490 passed, 2 pre-existing skips, 0 failed** across the eight
  touched test files plus `scripts/__tests__/spec-items-index.test.ts`. The touched
  tests were enumerated from the final git diff, including newly added files.
  Command: `bun test --preload ./tests/support/in-memory-http-preload.ts` followed
  by those files. The eight are the three adapter tests named above, the two
  trident tests, the composition wiring test, and the two gateway translator tests.
- Typechecks: the complete `bash scripts/ci/typecheck-all.sh` matrix ran all 51
  configurations. Fifty passed; root caught typing mistakes in the test preload.
  After correcting its Bun server cast and Request input type, the root recheck
  `bunx tsc --noEmit -p tsconfig.json` passed. All 51 configurations are therefore
  validated; the initial failed invocation is not described as a passing run.
- `bash scripts/ci/depcruise.sh`: passed, no new dependency violations.
- `git diff --check`: passed.
- Leak gate: **INCOMPLETE (exit 3)**, zero findings in available rules. Both private
  denylist rules were unavailable. This is not a clean gate and was not bypassed.
- 33 distinct guard/wiring mutations: RED; each restored implementation: GREEN.

The remaining blocker is access to the historical instance records and private
leak denylist. Real CLI/socket validation was not performed in this lane.

### Deliberate scope and remaining limits

The cwd/trust seeding fix and `trident/inner-workflow.mjs` were not changed. Diff
scope was checked with `git diff --name-only -- trident/inner-workflow.mjs
trident/orchestrator.ts`; the second path is the positive control.

Positive classification requires a current rendered terminal. The byte-stream
backend and unregistered workers report unknown rather than treating historical
text as current UI. Unrecognized future prompts retain their text but remain
unknown; the classifier does not claim to understand every possible CLI dialog.

The spec item remains open for historical attribution. Its P1 priority follows
the repository rule reserving P0 for declared cutover blockers; this change does
not invent an additional product cutover gate. The Decisions Log records the
working-evidence override. The task's staging instruction selects this as-built
path rather than the general docs/as-built location.

A whole-tree phrase search for the old unconditional ceiling/hang claims used the
new `worker state unknown: no checkpoint` sentence as positive control. Current
API/timing comments were corrected. The old sentence in `trident/delivery.test.ts:304`
stays as a legacy-row compatibility fixture; the completed historical plan at
`.trident/plans/trident/2-the-90-min-hang-watchdog-kills-li.md:7` describes its named
prior commit and was not rewritten.
