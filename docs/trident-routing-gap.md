# Trident routing today and the ordered replacement — #750 / #545

This is a static routing audit of `ccb4f3155b6774d2fa12c0aecec21736db1d622b`, read on 2026-09-14. It is a dispatch dependency analysis, not a second work queue. Acceptance remains in `docs/spec-items/the-orchestrator-owns-the-build-loop.md:32`; no box is checked by this document.

The build still executes through a separately composed loop. Terminal decisions now run in the project conversation, but the build launcher remains a different substrate (`gateway/composition/build-core-modules.ts:827`, `open/wiring/substrates.ts:545`, `open/composer.ts:4335`). Bounded routing already understands model families and transports; describing it as simply “kind-based” would also be wrong (`trident/inner-workflow.mjs:688`, `trident/inner-workflow.mjs:2326`). **A worker can reach an owner-visible surface today**, through both structured escalation and worker-authored conflict questions delivered without a project-REPL decision first (`trident/delivery.ts:755`, `trident/delivery.ts:1123`, `trident/terminal-observer.ts:36`).

The locked target is the project REPL owning the build and questions, with same-provider bounded work inside that REPL and other-provider work returned from headless harnesses (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:81`, `docs/plans/harness-orchestrator-pivot-2026-09-11.md:90`, `docs/plans/harness-orchestrator-pivot-2026-09-11.md:147`). “Same model” here follows the design's explicit **provider** comparison, not exact model-id equality. §3.3 is settled: headless per call, reusing the thread id (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:109`). Its retained historical alternative does not govern this plan.

## 1. Evidence method and corrections

The enumeration starts with executable entry points and their outgoing boundaries, then follows every member of the worker and sink sets below. It does not infer isolation from names such as “headless”, “subagent”, “read-only”, or “toolless”. Queries include comments, which are distinguished from executable branches. All paths and anchors below were read in this checkout; gate IDs refer to the separate inventory, whose old numerical code anchors are not silently treated as current.

`wc -l trident/inner-workflow.mjs trident/orchestrator.ts trident/inner-loop.ts` returned **9,339 / 6,316 / 1,171 = 16,826**, rather than the brief's 9,315 / 6,316 / 1,167. `parseInnerEscalation` is implemented at `trident/escalation-evidence.ts:49`, re-exported at `trident/inner-loop.ts:828`; the deriver remains `trident/escalation-block.ts:94`. A tree search for `9,315|16,798|9,339|16,826` finds the earlier measurements in `docs/trident-gates-inventory.md:5` and `docs/spec-items/the-orchestrator-owns-the-build-loop.md:20`, plus this current measurement as its positive control. Those earlier measurements remain as filing/baseline evidence; they are not current size claims adopted by this audit. The board import is still `trident/board-reconcile.ts:33`, and the owner-visible distinction test is still `trident/escalation-block.test.ts:173`.

### Reproducible indexes and positive controls

These are the exact scopes/patterns used for the negative observations in this document. A control proves that a search worked for that spelling; it cannot prove that all synonyms or dynamically generated routes were found. Conclusions about behavior also use the branch/body reads below.

| ID | Command | Observed result and control |
| --- | --- | --- |
| E1 | `rg -n 'askOwner\|questionForOwner\|owner_question\|needsOwner\|parseInnerEscalation\|deriveEscalationBlock' trident gateway open runtime agent-dispatch -g '!*.test.ts' -g '!*.test.mjs'` | The first four spellings have no hits. The same search finds the parser at `trident/escalation-evidence.ts:49`, deriver at `trident/escalation-block.ts:94`, delivery at `trident/delivery.ts:755`, and wake at `gateway/proactive/terminal-build-wake.ts:30`. These are the real escalation vocabulary, supplemented by `ESCALATE`, `OWNER_ONLY`, `question`, `input_needed`, and `reply` below. |
| E2 | `rg -n 'projectModel\|replModel\|parentModel\|sameModel\|routeModel\|buildCancellableDispatchTurn' trident/inner-workflow.mjs agent-dispatch/substrate-turn.ts` | No hits for the first four spellings; positive controls are `routeModel` at `trident/inner-workflow.mjs:767` and the runner at `agent-dispatch/substrate-turn.ts:46`. This is a scoped naming result, not “nothing branches on model”. The actual transport and family branches are at `trident/inner-workflow.mjs:2326` and `trident/inner-workflow.mjs:7236`. |
| E3 | `rg -n 'toolBridgeActive\|enableToolBridge\|url.pathname' runtime/adapters/claude-code/persistent/pool-state.ts` | No bridge-grant checks under those names; positive controls enumerate all eight URL arms at lines 561, 564, 599, 636, 641, 647, 653, 657. The entire authenticated handler was read through its 404 at line 678. |
| E4 | `rg -n 'allowedTools\|disallowedTools\|NO_INTERACTIVE_RULE' trident/inner-workflow.mjs` | The permission-name hit is a comment at line 7432, not an option assignment. Positive control: the prompt rule at line 1350 and its interpolations. The `agent()` option objects were separately enumerated below; the comment alone is not a confinement proof. |
| E5 | `rg -n 'exec resume\|thread_id\|codex exec' trident/codex-build.sh trident/codex-review.sh` | No `exec resume` or `thread_id` hits; controls are the actual invocations at `trident/codex-build.sh:1446` and `trident/codex-review.sh:534`. These wrappers do not explicitly implement the decided thread-resume form. This says nothing about arbitrary external CLI configuration. |

In the table, `\|` denotes regex alternation as rendered in Markdown: run each pattern with ordinary `|` inside the shell quotes, not a literal backslash-pipe.

For the positive enumeration, these indexes were followed to their consumers:

```sh
rg -n 'buildWorkflowFirer|buildSubstrateWorkflowFire|fire_workflow|on_terminal' open gateway trident -g '!*.test.ts'
rg -n '\bagent\(' trident/inner-workflow.mjs
rg -n 'build_substrate|makeEphemeralSubstrate|buildCancellableDispatchTurn' open/composer.ts trident agent-dispatch -g '!*.test.ts'
rg -n 'ESCALATE|OWNER_ONLY|question|input_needed|sink.send|deps.post' trident/conflict-resolver.ts trident/arbiter.ts trident/merge.ts trident/orchestrator.ts trident/delivery.ts gateway/proactive/terminal-build-wake.ts
rg -n 'inner_result|inner_checkpoint' --glob '*.ts' --glob '!*.test.ts'
rg -n 'on_run_transition|on_run_terminal|dispatchReport|dispatchStuckAlertSink|systemNoticeSurface' open/composer.ts
```

Controls include the firer at `trident/inner-loop.ts:968`, the builder at `trident/inner-workflow.mjs:2331`, the resolver construction at `open/composer.ts:6078`, the delivery send at `trident/delivery.ts:1353`, the progress decoder at `trident/run-progress.ts:129`, and the transition fan at `open/composer.ts:6933`. This enumerates source-defined boundary families, not every possible text string or side effect a shell-capable process could invent. External CLI internals, installed MCP configuration, credential availability, and live service permissions were not probed; potential routes dependent on them stay explicitly conditional.

## 2. Where the build executes

| Boundary | Current execution and evidence |
| --- | --- |
| Admission | `dispatchBoardBoundBuild` validates the board binding and then creates a claimed run: `trident/board-dispatch.ts:580`, `trident/board-dispatch.ts:1482`. Admission is not execution inside the chat turn. |
| Composition / scheduler | Production constructs `buildWorkflowFirer`, supplies it to `buildTridentOrchestrator`, and gives `orchestrator.step` to `TridentTickLoop`: `gateway/composition/build-core-modules.ts:641`, `gateway/composition/build-core-modules.ts:827`. The ticker invokes the step at `trident/tick.ts:835`. |
| Fire | The firer builds a prompt naming the workflow script and calls its injected fire seam: `trident/inner-loop.ts:968`, `trident/inner-loop.ts:983`. That prompt orders one background `Workflow` invocation and immediate settlement, leaving the database result to the outer loop: `trident/inner-loop.ts:789`. |
| Actual host | Open supplies `makeWarmFireSubstrate` to `buildSubstrateWorkflowFire`: `open/composer.ts:1104`. The factory caches by cwd with a distinct `cc-trident-fire-*` identity and `PROFILE_WARM_FIRE`: `open/wiring/substrates.ts:545`, `open/wiring/substrates.ts:556`. This is a warm launcher per cwd, not the chat's `cc-agent-*` substrate constructed at `open/wiring/substrates.ts:265`. |
| Work / harvest | Workflow agents plan, build, review, re-plan and clean up (`trident/inner-workflow.mjs:8118`, `trident/inner-workflow.mjs:2331`, `trident/inner-workflow.mjs:7193`, `trident/inner-workflow.mjs:8793`, `trident/inner-workflow.mjs:9304`). Terminal JSON is written via another agent invoking the checkpoint script (`trident/inner-workflow.mjs:2962`); the outer `applyResult` begins at `trident/orchestrator.ts:4954`. |
| #716's actual reach | After a terminal result, the wake observer constructs an acting turn, composes it, and posts its answer (`gateway/proactive/terminal-build-wake.ts:102`). Open admits that turn through `appWsChatTurn.composeActingTurn` on the live project conversation (`open/composer.ts:4340`). Its instruction still asks the **outer build loop** to retry via board tools (`gateway/proactive/terminal-build-wake.ts:90`). It has moved terminal investigation/decisions, not Forge→review→merge execution. |

The launcher's completed turn means `fired`, not a completed build (`trident/inner-loop.ts:1094`). A replacement must preserve that distinction as durable work acknowledgement/result state, even though the fire-and-settle workflow mechanism itself is deleted.

## 3. What bounded dispatch branches on

There are three separately composed worker mechanisms to replace, plus the native workflow's own steps. Their complete construction set for this audit is enumerated by the factory/start and `agent()` indexes in §1.

| Mechanism | Branch inputs today | Gap to §3.2 |
| --- | --- | --- |
| Workflow role routing | `routeModel(label, tag)` starts from build complexity or `ROLE_MODEL`; phase overrides can change family and transport (`trident/inner-workflow.mjs:767`, `trident/inner-workflow.mjs:571`, `trident/inner-workflow.mjs:688`). Unsupported family/transport changes are logged and ignored (`trident/inner-workflow.mjs:730`). | Role/phase chooses the work's requested tier. That is useful policy to preserve, but the executor decision must compare the resolved provider with the **current project's REPL provider**. The present function accepts label/tag and resolves against the launcher-oriented table; E2 supplies the bounded negative control. |
| Build executor | `forgeAgent` runs native `agent()` if transport is not `cli`; otherwise it uses a Claude bridge agent that invokes the Codex wrapper and transcribes its result (`trident/inner-workflow.mjs:2324`, `trident/inner-workflow.mjs:2338`). `withModel` deliberately leaves CLI bridge agents on their default model (`trident/inner-workflow.mjs:818`). | Already a model-derived transport split, but relative to the dedicated Claude launcher. A Codex project conversation does not make this build a native Codex subagent; the fire composition remains the same (`open/composer.ts:1106`). |
| Review executors | Adversarial review branches on `transport`; peer review branches on `route.group`, enabled seats and credential availability (`trident/inner-workflow.mjs:7210`, `trident/inner-workflow.mjs:7231`, `trident/inner-workflow.mjs:7235`). A peer moved to Claude uses a real Claude reviewer; CLI peers run through bridge agents (`trident/inner-workflow.mjs:7241`, `trident/inner-workflow.mjs:7260`). | Keep review role, independence and readiness policy; delete bridge-agent shell transcription. Kimi's wrapper ultimately uses a text API request (`trident/kimi-review.ts:207`, `trident/kimi-review.ts:225`), a concrete disagreement with a blanket claim that every other-provider seat is already a headless harness. |
| General dispatch | `DispatchService` maps `req.kind` to the specialist and role, chooses `req.model` or a default, then invokes the same runner (`agent-dispatch/service.ts:351`, `agent-dispatch/service.ts:471`, `agent-dispatch/service.ts:488`). The runner unconditionally builds a substrate per call (`agent-dispatch/substrate-turn.ts:80`); Open supplies an ephemeral `cc-dispatch` factory (`open/composer.ts:1173`). | “Subagent” registry membership is not native in-REPL execution. Requested model changes an `AgentSpec` preference, not same-provider versus other-provider process placement (`agent-dispatch/substrate-turn.ts:74`). |
| Outer helpers | Resolver, arbiter and leak-fixer each start an injected substrate (`trident/conflict-resolver.ts:209`, `trident/arbiter.ts:246`, `trident/leak-fixer.ts:158`). Open supplies three separate ephemeral factories (`open/composer.ts:6078`, `open/composer.ts:6109`, `open/composer.ts:6125`). | Their permission profiles must survive, while execution placement becomes relative to the project REPL. A same-provider arbiter must not acquire the parent conversation's full tool grant. |

The literal workflow worker-call set is: `trident/inner-workflow.mjs:2331`, `:2338`, `:2367`, `:2374`, `:2386` (build/bridge/collect/wait); `:2854`, `:2962` (checkpoint/result); `:5909`, `:5978`, `:6031`, `:6092`, `:6222`, `:6271`, `:6289`, `:6611` (head/diff/CI/readiness/merge probes); `:7193`, `:7213`, `:7219`, `:7260`, `:7275`, `:7320`, `:7427` (review/synthesis/retry); `:7954`, `:8061`, `:8118`, `:8126`, `:8793` (planning/probe/re-plan); `:9304` (cleanup). These **28 executable call sites** were enumerated with the `agent(` search, excluding comment lines, and their argument neighborhoods read. They share the output boundaries in §4; none is exempted merely because it is a probe or synthesis seat.

## 4. Can a headless worker reach the owner?

**Yes through current application routing. Direct arbitrary tool/HTTP access also needs a boundary proof; it cannot be ruled out by omitting tools from discovery.** Distinguish a mediated worker result, a deterministic message that already asks for input, and a direct capability route. The following is the boundary-family enumeration from all worker constructions in §3, all eight sink handlers, and all terminal observers in production composition. It includes passive visible surfaces so that “not a question” does not become “invisible”.

### 4.1 Worker results and host-generated messages

| Path | Source → boundary → owner-visible surface | Authority / consequence |
| --- | --- | --- |
| Structured review escalation | Reviewer `escalate` claims and deterministic convergence decisions become terminal `blockKind` plus `escalation` (`trident/inner-workflow.mjs:3681`, `trident/inner-workflow.mjs:3776`, `trident/inner-workflow.mjs:9177`). Terminal writer → parser → outer harvest → deriver (`trident/inner-workflow.mjs:2962`, `trident/inner-loop.ts:915`, `trident/orchestrator.ts:4954`, `trident/escalation-block.ts:94`). | The deriver requires failed phase, harvested timestamp and coherent kind/payload. Delivery includes missing-work summary and decision advice, then sends it to the originating channel (`trident/delivery.ts:755`, `trident/delivery.ts:1274`, `trident/delivery.ts:1353`). This is a worker-triggered owner-directed ask before the project REPL decides whether to ask. |
| Ordinary result / failure / diagnostics | Terminal cause, findings and error text flow through the same result and harvest; thrown workflow errors also write failure results (`trident/inner-workflow.mjs:9218`). | All terminal delivery classes must be reviewed, not just `escalated`: `composeTerminalDelivery` includes `input_needed` on infrastructure, published-unreviewed and ordinary failures (`trident/delivery.ts:1262`, `trident/delivery.ts:1279`, `trident/delivery.ts:1282`). Unknown failures can expose short worker-influenced prose (`trident/delivery.ts:1185`). A new spelling falling through does not become silent. |
| Merge resolver / arbiter question | Resolver parses `ESCALATE:` into `question` (`trident/conflict-resolver.ts:247`). Arbiter parses `OWNER_ONLY:` or returns unavailable (`trident/arbiter.ts:285`, `trident/arbiter.ts:323`). Unresolved merge escalates with the resolver question (`trident/merge.ts:3904`); outer harvest places it in `failure_reason` (`trident/orchestrator.ts:5362`). | Authored conflict questions become `input_needed: reason` (`trident/delivery.ts:1123`). The arbiter is another bounded worker, not the project REPL. Its `OWNER_ONLY` classification does not itself satisfy §3.4. Replay conflicts additionally use `TridentRebaseConflict` (`trident/orchestrator.ts:1881`), so their failure delivery must move too. |
| Project REPL decision | Terminal hook separately queues `buildTerminalBuildWakeObserver` → project acting turn → `deliver` (`open/composer.ts:4335`, `open/composer.ts:4350`). | This is the intended decision location. However, `withTerminalObserver` delivers **before** observers (`trident/terminal-observer.ts:36`, `trident/terminal-observer.ts:41`). #716 therefore does not put the REPL in front of the deterministic asks above. |
| Board / project rail | Escalation deriver chooses blocked rather than failed; reconcile is handed `detachRun`, not reorder (`trident/board-reconcile.ts:50`, `trident/board-reconcile.ts:107`, `trident/board-reconcile.ts:122`). Progress includes checkpoint-derived label and failure reason (`trident/run-progress.ts:222`, `trident/run-progress.ts:232`). Open includes that progress in board payloads and fans board/project changes (`open/composer.ts:4161`, `open/composer.ts:6933`). | Passive status is already owner-visible. Keep status and evidence; a worker's payload must not become authority to reorder. The unchanged contract is `docs/spec-items/the-orchestrator-owns-the-build-loop.md:61`. |
| Nexus / later conversational context | Post-commit terminal observer emits handoff/decision events (`open/wiring/trident-nexus-observer.ts:56`, `gateway/nexus/nexus-emit.ts:294`); project chat injects the nexus snapshot (`open/composer.ts:5595`). | Indirect influence on a later owner answer, not an independent question transport. Preserve provenance/data boundaries when moving the writer. |
| Skill proposal | Terminal processing can audit a completed workflow (`skill-forge/trident-adapter.ts:51`, `skill-forge/forge.ts:74`), and its notifier calls durable delivery (`open/composer.ts:1291`, `open/composer.ts:1307`). | A further owner decision surface arising from build output. Route the offer through the project decision authority; retaining the proposal store is not the same as directly asking the owner to act on a worker-triggered offer. |
| General dispatch result / lifecycle | Runner captures text and status (`agent-dispatch/substrate-turn.ts:114`); service calls report (`agent-dispatch/service.ts:628`). Open's production report writes the result markdown to logs (`open/composer.ts:1146`). A separate suspected-stuck notifier journals and pushes an app message (`open/composer.ts:6231`, `open/composer.ts:6250`). | The normal result sink is a log in this composition, not the chat sink its interface comment promises. The watchdog alert is visible host-generated status. Neither justifies a global statement that background agents are invisible. |
| Leak fixer / artifacts / later reports | Fixer returns `CANNOT-FIX` as a capped preflight note (`trident/leak-fixer.ts:197`). Build artifacts pass the publication boundary (`trident/orchestrator.ts:2718`, `trident/orchestrator.ts:2760`). Overnight harvest stores actual run results and writes result docs (`onboarding/overnight/dispatcher.ts:418`, `onboarding/overnight/dispatcher.ts:433`); morning detail includes those results and is delivered (`onboarding/overnight/morning-brief.ts:132`, `onboarding/overnight/morning-brief.ts:207`). | Logs, files, PR text and scheduled summaries are additional visibility channels. They are not proof that a worker can invoke a sanctioned owner-question API, but suppressing terminal chat alone cannot prevent worker text from reaching the owner. |

Production's terminal observer set is explicitly built at `gateway/composition/build-core-modules.ts:567`: board reconciliation, composed run-terminal observer, project wake, reaper wake. Both out-of-band terminator compositions additionally include the hold sweep (`open/composer.ts:6037`, `open/composer.ts:6058`). Reaper/hold processing can lead to further runs and hence the same result paths; it is not another question UI. The run-terminal observer wraps skill-forge and nexus (`open/wiring/trident-nexus-observer.ts:56`, `open/composer.ts:1471`).

### 4.2 Native reply, tools, HTTP and shell boundaries

A native `reply()` is not automatically a chat message. The dev-channel posts it to the local reply sink (`runtime/adapters/claude-code/persistent/dev-channel-impl.ts:201`); `onReply` requires an unfenced active matching turn and emits a token plus completion (`runtime/adapters/claude-code/persistent/repl-session.ts:377`, `runtime/adapters/claude-code/persistent/repl-session.ts:393`, `runtime/adapters/claude-code/persistent/repl-session.ts:406`). The fire consumer treats completion as `fired` (`trident/inner-loop.ts:1094`); the general runner captures it as result text (`agent-dispatch/substrate-turn.ts:114`); the live conversation persists/fans its reply (`gateway/wiring/build-live-agent-turn.ts:1762`, `gateway/wiring/build-live-agent-turn.ts:1785`). The consumer is the authority on visibility.

The complete sink URL set is enumerated by E3, rather than by guessing names for owner questions:

| Sink arm | Current check and destination |
| --- | --- |
| `/tools`, `/tool-call` | Every POST first resolves a live session from its child credential (`runtime/adapters/claude-code/persistent/pool-state.ts:519`). These arms list the global bridge's schemas or dispatch a named tool with the session's project scope (`runtime/adapters/claude-code/persistent/pool-state.ts:561`, `runtime/adapters/claude-code/persistent/pool-state.ts:584`). Downstream MCP checks tool existence and project capability, then runs the handler (`mcp/server.ts:119`, `mcp/server.ts:139`, `mcp/server.ts:150`). |
| `/activity` | Same credential check; records submitted tool arguments/results into the activity tap (`runtime/adapters/claude-code/persistent/pool-state.ts:599`, `runtime/adapters/claude-code/persistent/pool-state.ts:618`). This is an owner-visible diagnostic path, not an ask authorization. |
| `/channel-ready`, `/channel-bound` | Same credential check; update channel readiness/handshake (`runtime/adapters/claude-code/persistent/pool-state.ts:636`, `runtime/adapters/claude-code/persistent/pool-state.ts:641`). Transport control, with subsequent reply handling still separate. |
| `/reply`, `/typing` | Same credential check; call the resolved session, not a caller-selected chat (`runtime/adapters/claude-code/persistent/pool-state.ts:647`, `runtime/adapters/claude-code/persistent/pool-state.ts:653`). Matching-turn semantics above apply to replies. |
| `/todo-sync` | Same credential check; calls board sync with the session's project and submitted todos (`runtime/adapters/claude-code/persistent/pool-state.ts:657`, `runtime/adapters/claude-code/persistent/pool-state.ts:669`). This must be covered by worker authority confinement, independently of `board-reconcile`'s narrow interface. |

**Concrete gap:** bridge attachment is checked during spawn (`runtime/adapters/claude-code/persistent/spawn.ts:195`), but the authenticated sink's tool and todo arms do not check that grant (E3 plus the complete body read). The child dev-channel config carries its own sink credential even when the tools bridge is not attached (`runtime/adapters/claude-code/persistent/spawn.ts:181`, `runtime/adapters/claude-code/persistent/spawn.ts:214`). Thus a caller possessing a registered worker session's credential can reach those handlers without proving conversational authority. Related broad claims were enumerated with `rg -n 'never reach a Core tool' . -g '*.md' -g '*.ts' -g '!*.test.ts'`: `docs/SYSTEM-OVERVIEW.md:727`, `gateway/wiring/build-llm-call-substrate.ts:521`, `runtime/adapters/claude-code/persistent/types.ts:392`, and `runtime/adapters/claude-code/persistent/tools-bridge-impl.ts:40` describe discovery omission as isolation; the historical hit at `docs/research/AS-BUILT-archive-2026-07.md:1779` remains history. Step 2 must update the active claims with its actual enforcement; the active claims remain subjects of this routing audit rather than being endorsed as sandbox proofs, and source-comment edits are outside its documentation-only brief. This is a code-level authorization finding; this audit did not try to obtain a credential or execute a tool. Reachability from a particular restricted worker's shell to its config must be tested, not assumed in either direction.

The worker's declared native tools and prompt are different boundaries. The fire allowlist includes Bash/Task/TodoWrite but not `AskUserQuestion` (`trident/inner-loop.ts:551`); the workflow repeats a prose prohibition (`trident/inner-workflow.mjs:1350`). E4 and the 28 option-object reads establish no explicit per-seat `allowedTools`/`disallowedTools` assignment in this workflow. They do **not** establish the external harness's inherited tool behavior. General dispatch passes an empty native tool list, while resolver/fixer grant file tools and Bash (`agent-dispatch/substrate-turn.ts:61`, `trident/conflict-resolver.ts:87`, `trident/leak-fixer.ts:86`). Moving native subagents under a bridge-enabled project parent without a child-specific authority boundary would widen their potential access; the parent currently enables the bridge (`open/wiring/substrates.ts:284`).

Two additional external boundaries matter:

- Codex build runs with `--sandbox danger-full-access`; shell-environment filtering targets credential families but is not an owner-contact policy (`trident/codex-build.sh:1388`, `trident/codex-build.sh:1446`). Codex review supplies model/standard input to `codex exec`, with no explicit worker tool surface in that invocation (`trident/codex-review.sh:533`). Kimi's current request carries model/messages and returns text (`trident/kimi-review.ts:207`, `trident/kimi-review.ts:237`). These are three different capability shapes; “headless” proves neither filesystem nor network isolation.
- `POST /api/app/system-notice` delivers caller text to the fixed owner topic after bearer authorization (`gateway/http/system-notice-surface.ts:102`, `gateway/http/system-notice-surface.ts:129`, `open/composer.ts:4828`). A worker with an owner bearer could use it; worker possession is **not established** here. The same applies to arbitrary external message services or installed MCP servers reachable with ambient credentials. This is why the future proof must include raw HTTP and shell attempts, not merely hiding a named ask tool.

The present evidence therefore establishes multiple mediated owner-visible routes and a session-grant gap. It does not certify an exhaustive sandbox against arbitrary shell programs, installed plugins, or credential theft. The enumeration is complete for the **source-defined worker construction and sink boundary families listed here**; those environmental boundaries remain explicit proof obligations, not a confident “no”.

### 4.3 Outcome vocabulary that the replacement must join

The worker's need must remain data until the project REPL decides to ask. Do not introduce an unclassified error that falls into today's defaults:

| Existing vocabulary | Default / preservation requirement |
| --- | --- |
| Inner block kind | Eight values are decoded at `trident/inner-loop.ts:901`; other values become null. Escalation has its own closed kind parser at `trident/escalation-evidence.ts:53`. A transport/permission refusal must not become a code rejection or an invented design gap. |
| Review result | The terminal writer records `REVIEW_NOT_RUN` unless an actual review satisfies its verdict/findings condition (`trident/inner-workflow.mjs:2906`). Preserve server-side review provenance, not just worker strings. |
| Fire result | `fired` acknowledges launch; failed startup/error and unconfirmed settlement are distinct (`trident/inner-loop.ts:1067`, `trident/inner-loop.ts:1099`, `trident/inner-loop.ts:1146`). The replacement needs equivalent launch/result/unknown distinctions without retaining the old fire API as a shim. |
| Resolver / arbiter | Resolver unparseable output escalates (`trident/conflict-resolver.ts:255`); arbiter unknown decision becomes unavailable (`trident/arbiter.ts:302`). Merge catches specifically recognize drift/conflict and otherwise produce a generic merge failure retaining approval (`trident/orchestrator.ts:5351`, `trident/orchestrator.ts:5362`, `trident/orchestrator.ts:5370`). |
| Owner rendering / board | Unknown delivery may display short prose (`trident/delivery.ts:1185`); board defaults to failed unless done or coherent escalation (`trident/board-reconcile.ts:107`). These defaults must not auto-authorize an ask, reorder, retry or merge. |
| Tool/HTTP refusal | Sink unknown credential is 401; unavailable bridge is 503; tool errors are an `ok:false` response (`runtime/adapters/claude-code/persistent/pool-state.ts:527`, `runtime/adapters/claude-code/persistent/pool-state.ts:567`, `runtime/adapters/claude-code/persistent/pool-state.ts:596`). Worker-role refusal should use this existing refusal/result channel with an explicit bounded-work need, not a new owner prompt protocol. |

## 5. Smallest safe ordering

Three serialized changes are proposed. Step 1 buys preservation evidence; step 2 closes owner-authority boundaries while the existing loop is still the sole executor; step 3 replaces that executor in one cutover. Splitting step 3 into “new project orchestrator first” and “remove old loop later” leaves two decision makers and is rejected by the locked design (`docs/spec-items/the-orchestrator-owns-the-build-loop.md:52`). These are proposed implementation territories, not claims that the new files already exist.

### Step 1 — Pin preservation before changing execution

**Production change/deletion:** none. Add behavioral pins around current boundaries; remove no gate, loop or passing test. The inventory identifies **165 entries, 18 without a located pin, 156 silent if lost** (`docs/trident-gates-inventory.md:3`). Its complete unpinned set is G001, G018, G021, G022, G023, G024, G031, G034, G075, G083, G085, G089, G094, G097, G111, G132, G133, G140 (`docs/trident-gates-inventory.md:37`). Those must earn pins before their owning file is replaced; a source-substring assertion alone cannot establish survival through a rewrite.

**Files to change:** `trident/inner-loop.test.ts`, `trident/inner-workflow.test.ts`, `trident/inner-workflow-plan-next.test.ts`, `trident/inner-workflow-assembly.test.ts`, `trident/orchestrator.test.ts`, `trident/__tests__/escalation-gate.test.ts`, `trident/__tests__/cross-model-dispatch.test.ts`, and `docs/trident-gates-inventory.md`. New concentrated behavioral fixtures may instead live at `trident/routing-preservation.test.ts`; this file belongs to this same territory, not a parallel lane. Existing gate test files remain preservation obligations, including the table's delegated merge, proof and cleanup tests.

**Proof / risk:** mutation-check each newly pinned condition at a reachable production boundary: print the changed line, show its refusal fixture red with the guard removed, restore green, and show the legitimate complement. Treat G132/G133 as prompt-boundary preservation, and G140 as a warning, not a hard refusal (inventory rows at `docs/trident-gates-inventory.md:222`, `docs/trident-gates-inventory.md:230`). Leave any unproven pin marked unproven; do not relabel it to unblock deletion. This step changes test evidence, so direct runtime gate-loss risk is zero; the cost of a weak pin is that step 3 can lose its corresponding Silent entry unnoticed.

### Step 2 — Make worker output incapable of authorizing owner action

**Re-scoped 2026-09-14 (#796):** this step changes routing. The earlier per-child identity and credential enforcement framing is withdrawn; it is not an acceptance condition for this step.

**Change:** keep the build loop executing. Terminal failure questions, including resolver results and arbiter owner-only outcomes, become evidence for the project conversation. Try the arbiter before the project decision; only that conversation decides whether to ask the owner. Keep `interpretFailure` and `composeTerminalDelivery` as the sole evidence/advice formatters. Passive terminal status remains deliverable. Skill proposals persist for the project conversation to inspect through `skill_forge_list`, without automatic owner offers.

**Acceptance:**
- Worker failure advice and resolver questions do not reach deterministic owner delivery; the project conversation receives the formatted evidence and can still ask in the originating chat.
- Arbitration precedes the failed-result project turn. Decisions, owner-only answers, and unavailable outcomes remain evidence; none authorizes an automatic owner send.
- Pending terminal rows survive unavailable conversation admission, failed delivery, and gateway restart. Completion is recorded only after durable posting. A gateway-owned retry loop continuously revisits pending rows.
- Passive status and successful completion survive. `trident/escalation-block.test.ts` passes unmodified.
- Exercise both directions through discovered tests and mutation-check the routing, completion and retry guards.

**Maintainer:** the persisted terminal run is the inbox; `agent_waked_at` records completed delivery. A supervised gateway loop scans pending rows every minute and is woken by terminal hooks. A crash between posting and completion can replay a decision (at-least-once delivery); it cannot erase the pending result. No second executor, child credential protocol, or feature flag is introduced.

### Step 3 — Atomically replace orchestration and model-relative dispatch

**Change:** the project's existing conversation executes build decisions and dispatches bounded work through one provider-relative function. Role/phase still chooses requested model/effort and review policy; provider equality chooses native child versus another harness. Include build, review, planner, resolver, arbiter, fixer and general dispatch. Preserve deterministic publication, merge/proof, cleanup, admission and recovery gates as host-owned services that the REPL invokes; those services must refuse an invalid action even if the REPL asks for it. Keep external supervision as a liveness/fencing service, not a second planner/retry decision maker.

**Delete in the same change:** `trident/inner-workflow.mjs`, the fire-and-settle launcher and its argument protocol in `trident/inner-loop.ts`, and `trident/orchestrator.ts`'s independent launch/harvest/re-fire decision loop. Keep the sole implementations of the pure result parsers and verdict/failure derivation in their existing modules; move host operations only where needed, deleting each moved original. The unchanged escalation test imports those pure functions from `trident/inner-loop.ts` and `trident/orchestrator.ts` (`trident/escalation-block.test.ts:31`). Their continued presence is data interpretation, not a surviving executor or compatibility wrapper. Delete the `cc-trident-fire-*` factory/cache and production fire wiring; replace the ticker's `orchestrator.step` authority. Delete Claude bridge agents used only to launch/transcribe Codex/Kimi commands, per-kind ephemeral dispatch placement, and workflow-agent checkpoint/result/cleanup transcription. Select and prove a Kimi-capable headless harness before activating the replacement for configured Kimi seats; delete the direct text-API review executor when that harness replaces it. Do not quietly drop a configured reviewer or retain the API as a fallback. The current API request is not evidence that such a harness integration already exists; failure to establish one blocks this cutover, not the audit. §3.3's per-call thread reuse is part of the other-provider path; delete the wrappers' fresh-call-only invocation ownership when replacing it.

**Existing implementation files to change/delete:** `trident/inner-workflow.mjs`, `trident/inner-loop.ts`, `trident/orchestrator.ts`, `trident/tick.ts`, `trident/review-run.ts`, `trident/index.ts`, `trident/store.ts`, `trident/board-dispatch.ts`, `trident/board-reconcile.ts`, `trident/dispatch-holds.ts`, `trident/terminate.ts`, `trident/terminal-observer.ts`, `trident/delivery.ts`, `trident/escalation-evidence.ts`, `trident/escalation-block.ts`, `trident/terminal-cause.ts`, `trident/phase-models.ts`, `trident/checkpoint.sh`, `trident/codex-build.sh`, `trident/codex-review.sh`, `trident/kimi-review.ts`, `trident/merge.ts`, `trident/mutation-prover.ts`, `trident/worktree-cleanup.sh`, `trident/conflict-resolver.ts`, `trident/arbiter.ts`, `trident/leak-fixer.ts`, `agent-dispatch/service.ts`, `agent-dispatch/substrate-turn.ts`, `open/composer.ts`, `open/wiring/substrates.ts`, `open/wiring/trident-child-crash-sink.ts`, `open/wiring/trident-launcher-liveness.ts`, `gateway/composition/build-core-modules.ts`, `gateway/composition/input/misc-input.ts`, `gateway/proactive/terminal-build-wake.ts`, `gateway/wiring/build-live-agent-turn.ts`, `runtime/substrate.ts`, `runtime/models.ts`, `runtime/adapters/claude-code/index.ts`, `runtime/adapters/codex-cli/index.ts`, and `docs/trident-gates-inventory.md`. These are the reserved change territory, not an instruction to rewrite untouched gate implementations gratuitously.

**Proposed new sole owners:** `trident/project-build.ts` (project-conversation build integration), `trident/build-actions.ts` (host-gated deterministic operations), `runtime/bounded-work.ts` (provider comparison and result boundary). Bind them at the existing composition and chat queue sites cited in §2. New tests: `trident/project-build.test.ts`, `runtime/bounded-work.test.ts`, `open/__tests__/project-build-routing.test.ts`. Step 1's test territory and the consumer candidates in §6 belong to this integration lane. Migrate tests of replaced execution to the sole replacement boundary without weakening their behavioral assertions; leave `trident/escalation-block.test.ts` unmodified and keep its pure-function imports live. This is one integration territory, not parallel ownership of the same tests.

**Gate risk:** all G001–G165, because both decision loops and their delegation sites change. Assign every inventory ID to a replacement enforcement site and a red/green proof before deleting its old owner. In particular:

| Cutover operation | Inventory IDs at risk | Unpinned members to resolve in step 1 |
| --- | --- | --- |
| Fire, identity, result decoding, initial launch | G001–G019 | G001, G018 |
| Planner, build, resume, lost work | G020–G043 | G021, G022, G023, G024, G031, G034 |
| Review readiness, seats, verdicts | G044–G067, G160, G164, G165 | None marked NO TEST in the inventory; existing pins still need relocation/reachability proof. |
| Escalation and budgets | G068–G082 | G075 |
| Publication/replay and harvest/merge/recovery | G083–G124 | G083, G085, G089, G094, G097, G111 |
| Cleanup, board, prompts, advisory boundaries | G125–G140, G159 | G132, G133, G140 |
| Delegated mutation/cleanup proof | G141–G158, G161–G163 | None marked NO TEST; calling the same helper without reaching its refusal is insufficient. |

The groups cover the IDs by inclusive range, with G159/G160/G164/G165 and G161–G163 explicitly assigned. They preserve the inventory's classification rather than claiming all rows are hard gates: G139 is preflight logging and G140 a warning (`docs/trident-gates-inventory.md:229`). The 156 Silent rows mean “CI would probably stay green on loss” is precisely the default risk, not reassuring evidence.

**Cutover protocol:** stop new build admission, drain current runs under the old executor, and verify every old launcher and detached worker has exited before starting the replacement release. An unconfirmed launch, a live detached build, or unknown process evidence prevents activation; a terminal database row alone is insufficient (`trident/orchestrator.ts:5569`, `trident/orchestrator.ts:5833`, `trident/orchestrator.ts:6183`). Deliver a host-enforced admission/startup guard, backed by durable drain state, so a restart cannot admit new work or start the new executor midway. Every host mutation must validate the current project/run generation; a stale completion cannot revive its prior authority. This guard belongs to `trident/project-build.ts`, `trident/build-actions.ts`, `trident/store.ts` and the composition boundary, and must be mutation-tested independently of the old or new REPL cooperating. Then start the release containing only the new executor and resume admission. This is a bounded deployment transition, not a runtime routing flag or compatibility mode. If zero overlapping processes cannot be established, keep admission stopped and investigate; do not start a second orchestrator to recover the first.

**Proof:** a served integration fixture dispatches a board card and records that its decision turn belongs to the existing project conversation. Assert both providers in both directions (Claude parent/Claude child; Codex parent/Codex child; Claude→Codex; Codex→Claude), model switching before the next bounded call, and other-provider thread reuse across calls/restart. Assert same-provider work starts no headless process and different-provider work cannot execute as a native child. Exercise each helper role and a configured Kimi review seat, not just Forge. Re-run step 2's worker/owner complements under the native-child path. Kill the decision REPL and kill a worker separately: the host preserves run identity, enforces caps, and resumes only the sole owner without depending on the killed agent. Race restart/admission with a delayed old result and prove it cannot obtain write authority. Finish with one card reaching MERGED without human intervention, as required at `docs/spec-items/the-orchestrator-owns-the-build-loop.md:65`.

After deletion, use an old-symbol/new-symbol search over production source (for example `buildWorkflowFirer|buildSubstrateWorkflowFire|makeWarmFireSubstrate|project-build`) with the new wired `project-build` import as the positive control. Inspect remaining documentation/test/history hits separately. Also enumerate consumers with the compiler and import graph; a literal grep cannot detect every alias. The proof of REPL execution is the served behavioral test, not the absence search.

### Serialization and lane ownership

Steps 1→2→3 are dependencies, not three parallel build lanes. Steps 2 and 3 both own `open/composer.ts`, `open/wiring/substrates.ts`, the delivery/wake path, and helper dispatch files. Steps 1 and 3 both own the old loop's test territory and inventory. Within step 3, the three proposed sole-owner modules can be developed separately only after their interfaces and file ownership are fixed; production activation/deletion is one integrated change. Do not dispatch two lanes to edit the shared composition, old loop, inventory, or migrated tests concurrently.

This ordering leaves the existing executor live through steps 1 and 2, then replaces it once. It deliberately does not claim that moving terminal questions alone satisfies §3.1, that headless implies isolation, or that a persistent other-provider process is still under consideration. No code, tests, acceptance criteria or product decisions are changed by this audit.

## 6. Consumer territory enumerated for the cutover

The following is the sorted output of this executed lexical index, split by test filename. It finds **140 candidate files** (80 test files and 60 other source/helper files). It includes comments and references to pure helpers that will remain: inclusion reserves review/edit ownership, not a claim that every file must change. The same search finds the real production wiring at `gateway/composition/build-core-modules.ts:641` and the mandated unchanged test imports at `trident/escalation-block.test.ts:31`, providing positive controls. Historical prose references can remain with their historical meaning. Step 3 owns this entire candidate set alongside its explicit new files; the list prevents an unlisted consumer from being dispatched concurrently.

```sh
rg -l 'inner-workflow\.mjs|inner-loop\.ts|orchestrator\.ts|buildTridentOrchestrator|buildWorkflowFirer|buildSubstrateWorkflowFire' trident gateway open runtime agent-dispatch work-board -g '*.ts' -g '*.mjs' -g '*.sh' -g '*.tsx'
```

### Source and helper candidates

```text
gateway/boot-chat-command-filters.ts
gateway/composition/build-core-modules.ts
gateway/composition/input/misc-input.ts
gateway/nexus/nexus-emit.ts
gateway/proactive/terminal-build-wake.ts
gateway/proactive/work-wakeup-selection.ts
gateway/storage/owner-metadata.ts
open/composer.ts
open/wiring/substrates.ts
open/wiring/trident-nexus-observer.ts
runtime/adapters/claude-code/index.ts
runtime/subagent/boot-sweep.ts
runtime/subagent/store.ts
runtime/substrate-text.ts
trident/active-runs.ts
trident/board-dispatch.ts
trident/brief-parts.ts
trident/checkpoint-phase.ts
trident/checkpoint-round.ts
trident/checkpoint.sh
trident/code-command.ts
trident/codex-build.sh
trident/codex-credential.ts
trident/codex-review.sh
trident/conflict-resolver.ts
trident/delivery.ts
trident/escalation-block.ts
trident/escalation-evidence.ts
trident/fire-evidence.ts
trident/gh-authed.ts
trident/index.ts
trident/infra-block.ts
trident/inner-loop-sim.ts
trident/inner-loop.ts
trident/inner-workflow.mjs
trident/kimi-review.ts
trident/leak-preflight.ts
trident/liveness.ts
trident/merge.ts
trident/mutation-claim-artifact.ts
trident/mutation-prover.ts
trident/orchestrator.ts
trident/phase-models.ts
trident/prompts.ts
trident/ralph-budget.ts
trident/reflection-guidance.ts
trident/review-run.ts
trident/run-disposition.ts
trident/run-driving.ts
trident/run-evidence-probes.ts
trident/run-progress.ts
trident/stage-attribution.ts
trident/state-machine.ts
trident/store.ts
trident/terminal-cause.ts
trident/test-strategy.ts
trident/testing/load-escalation-gate.ts
trident/tick.ts
trident/worktree-reaper.ts
trident/wrong-base-remedy.ts
```

### Test candidates

```text
gateway/__tests__/trident-active-runs-wiring.test.ts
gateway/__tests__/trident-phase-models-producer.test.ts
gateway/composition/build-core-modules-trident-arbiter-wiring.test.ts
gateway/composition/build-core-modules-trident-liveness-wiring.test.ts
gateway/composition/build-core-modules-trident-shutdown.test.ts
gateway/composition/build-core-modules-trident-stranded-sweep.test.ts
gateway/proactive/__tests__/work-wakeup-selection.test.ts
open/__tests__/open-trident-prod-boot-wiring.test.ts
open/__tests__/open-wiring-substrates.test.ts
trident/__tests__/ci-gate.test.ts
trident/__tests__/cross-model-dispatch.test.ts
trident/__tests__/cross-model-rate-limited.test.ts
trident/__tests__/dead-core-seat-e2e.test.ts
trident/__tests__/delta-classifier.test.ts
trident/__tests__/dying-reviewer-e2e.test.ts
trident/__tests__/escalation-e2e.test.ts
trident/__tests__/escalation-gate.test.ts
trident/__tests__/gh-read-command.test.ts
trident/__tests__/model-tiers.test.ts
trident/__tests__/phase-model-coverage.test.ts
trident/__tests__/severity-gate.test.ts
trident/__tests__/synthesis-unavailable.test.ts
trident/abandon-poison-e2e.test.ts
trident/arbiter-wiring.test.ts
trident/as-built-publish-wiring-realgit.test.ts
trident/board-dispatch.test.ts
trident/board-reconcile.test.ts
trident/brief-parts.test.ts
trident/checkpoint-phase.test.ts
trident/checkpoint-sh.test.ts
trident/claimed-paths.test.ts
trident/code-command.test.ts
trident/codex-brief-chunking.test.ts
trident/codex-build-arrival.test.ts
trident/codex-build.test.ts
trident/codex-review.test.ts
trident/crash-before-launch-save.test.ts
trident/crash-recovery.test.ts
trident/delivery.test.ts
trident/diff-base-option-shaped.test.ts
trident/escalation-block.test.ts
trident/infra-retry.test.ts
trident/inner-loop.test.ts
trident/inner-workflow-assembly.test.ts
trident/inner-workflow-built-head.test.ts
trident/inner-workflow-mutation-claim.test.ts
trident/inner-workflow-plan-next.test.ts
trident/inner-workflow-publish-handoff.test.ts
trident/inner-workflow-ralph-refire.test.ts
trident/inner-workflow-resume.test.ts
trident/inner-workflow-terminal-cause.test.ts
trident/inner-workflow.test.ts
trident/lane-retry.test.ts
trident/launch-throw-bounded.test.ts
trident/liveness-death-e2e.test.ts
trident/mutation-prover.test.ts
trident/orchestrator.test.ts
trident/ported-fixes.test.ts
trident/prompts-disk-source.test.ts
trident/publish-rebase-realgit.test.ts
trident/ralph.test.ts
trident/reflection-guidance.test.ts
trident/restart-resume.test.ts
trident/retry-resumes-checkpoint.test.ts
trident/review-diff-base-realgit.test.ts
trident/review-round-cap.test.ts
trident/review-run.test.ts
trident/round-landed.test.ts
trident/run-disposition.test.ts
trident/run-driving.test.ts
trident/run-head-width.test.ts
trident/run-progress.test.ts
trident/stage-attribution.test.ts
trident/store.test.ts
trident/stranded-salvage-realgit.test.ts
trident/terminal-cause.test.ts
trident/terminal-failure-reason.test.ts
trident/terminate-on-merge.test.ts
trident/worktree-cleanup-sh.test.ts
trident/wrong-base-remedy.test.ts
```
