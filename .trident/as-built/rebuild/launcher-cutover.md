## 2026-09-15 — Typed project launcher cutover

### Delivered and acceptance boundary

The production composer constructs the typed launcher when a live credential is
available (`open/composer.ts:1159`). The gateway forwards `InnerLoopInput` directly
(`gateway/composition/build-core-modules.ts:633`). The launcher constructs the
project host and invokes its driver without awaiting the build
(`trident/project-launcher.ts:54`, `trident/project-launcher.ts:56`). This follows
the existing ownership decision at
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:170`.

The deciding test boots the real composer, sets an explicit project provider,
creates a real local Git repository, constructs the real project host, and observes
its actual run call (`open/__tests__/open-trident-prod-boot-wiring.test.ts:102`,
`open/__tests__/open-trident-prod-boot-wiring.test.ts:113`). Host commands after
construction are fake unreadable observations; this is a construction/start test,
not a live provider or merge test. Removing the driver invocation fails its start
assertion (`open/__tests__/open-trident-prod-boot-wiring.test.ts:134`).

**Live card-to-merged acceptance remains unproven.** Suite checkpoint reports and
several provider transports remain unavailable, explicitly described below. The
acceptance at `docs/plans/harness-orchestrator-pivot-2026-09-11.md:287` is unchanged.

The actual checked-out branch is `rebuild/launcher-cutover-3`, observed with
`git branch --show-current`; it was retained. This record uses the lane's explicit
requested shard path. The general tracking rule was reread before writing it
(`docs/process/work-tracking.md:129`).

### Complete option inventory

Enumerated from `ProjectBuildHostOptions` at `trident/project-build-host.ts:28`
and `ProductionHostOptions` at `trident/production-host-effects.ts:20`.

| Field | Production source and decision |
| --- | --- |
| substrate.provider | Resolve the dispatched project's stored provider, explicitly passing its project ID (`open/composer.ts:1164`, `open/composer.ts:1169`); never use active-chat fallback. Both Anthropic and Pi project selections are exercised (`open/__tests__/open-trident-prod-boot-wiring.test.ts:120`, `open/__tests__/open-trident-prod-boot-wiring.test.ts:136`). |
| substrate.inRepl | `createProjectRunners` with project ID, dispatch chat topic, provider, conversational spec and durable per-run directory (`open/wiring/project-build.ts:51`). Its acting turn selects the retained project conversation from host session registrations and verifies readiness, child liveness and launch grants before calling `createClaudeActingTurn` (`open/wiring/project-build.ts:56`). Non-Claude providers are explicitly refused; they are not redirected. |
| substrate.headless | Explicit Codex runner, with dispatched Codex credential directory when supplied (`open/wiring/project-build.ts:77`). Other headless bindings remain unavailable. |
| phaseUsage | New `TridentPhaseUsageStore` over the same project database (`open/composer.ts:1166`). |
| production.store | Canonical board run store (`open/composer.ts:4257`), passed at `open/composer.ts:1166`. |
| production.runId, projectSlug, repo, worktree, branch | Typed dispatched row (`open/wiring/project-build.ts:30`, `open/wiring/project-build.ts:112`). The outer launch supplies matching branch/worktree defaults (`trident/orchestrator.ts:4174`); preparation persists the base pin and verifies or creates the isolated worktree (`open/wiring/project-build.ts:34`). |
| production.baseBranch | Typed `input.base_branch` (`open/wiring/project-build.ts:113`). |
| production.runHost | Existing lazy credentialed host runner (`open/composer.ts:2210`), injected at `open/composer.ts:1166`. |
| production.ciWorkflow | Read the declaration under the dispatched board scope's project directory; match the actual repo path (`open/composer.ts:1168`, `open/wiring/project-build.ts:108`). This follows the workspace owner's directory convention (`trident/build-workspace.ts:73`). Missing declaration values remain undefined. |
| production.ciSource, ciNow | Omitted optional seams: project host constructs production CI acquisition (`trident/project-build-host.ts:80`); the clock defaults to Date.now (`trident/production-host-effects.ts:293`). |
| production.publication | Task first line as title; task body written to a per-run file (`open/wiring/project-build.ts:106`, `open/wiring/project-build.ts:115`). |
| workers | Enumerate plan/build/review/fix, resolve their existing phase settings, model descriptors and efforts; write role briefs with task, test strategy, reflection and result schema (`open/wiring/project-build.ts:79`, `open/wiring/project-build.ts:89`). Requests carry model, effort, worktree, grants, integrity receipt, result path, null thread and a 45-minute turn budget (`open/wiring/project-build.ts:97`). Driver assigns run/step/role identity (`trident/build-run.ts:274`). Missing telemetry yields no invented usage (`open/wiring/project-build.ts:76`). |
| policy.review | Existing project review source receives phase settings, environment, evidence directory, budget, signal and descriptor-aware runner lookup (`open/wiring/project-build.ts:124`). API/Kimi bindings are explicitly unavailable; a matching in-REPL or supplied headless runner is used for other seats. |
| policy.reviewSuite | The actual brief dispatch uses the full test strategy (`open/wiring/project-build.ts:88`); source declares full-suite scope and the same strategy (`open/wiring/project-build.ts:123`). The independent reader returns null because the required report is unavailable. Intermediate subset strategy is deliberately not dispatched. |
| policy.leak | Per-run scratch directory (`open/wiring/project-build.ts:117`); the project host supplies host runner/repo/branch/base (`trident/project-build-host.ts:92`). |
| policy.mutation | Read and validate the build trailer's mutation nomination (`open/wiring/project-build.ts:118`). This is a claim, not proof; the existing host publication gates remain responsible for proving it. |
| policy.boundReview | Omitted: production bound-PR runs already return through the outer review-only executor before reaching this launcher (`trident/orchestrator.ts:3751`, `trident/orchestrator.ts:3790`). A direct unsupported bound-review host call retains the existing blocked answer (`trident/build-host.ts:194`). |

Preparation persists the previously in-memory base pin before host admission;
without that step the host's initialized-row check rejects the launch
(`trident/orchestrator.ts:4629`, `trident/project-build-host.ts:62`). Existing
worktrees are verified without reset; new worktrees use the pinned base when the
branch is absent (`open/wiring/project-build.ts:39`). Setup failures may retain a
prepared worktree; no destructive recovery was added.

### Launch, result vocabulary and continuous maintenance

| Observation | Answer and consumer |
| --- | --- |
| Host constructed, run method invoked | `fired`, immediately (`trident/project-launcher.ts:54`, `trident/project-launcher.ts:64`). |
| Existing uncertain result or lost reservation | `unconfirmed`, with a named reason (`trident/project-launcher.ts:47`, `trident/project-launcher.ts:52`). |
| Launch setup exceeds ten seconds | `unconfirmed`, including elapsed budget, uncancelled status and late settlement promise (`trident/project-launcher.ts:71`). It never claims optimistic start. |
| Preparation/construction throws | `failed`; preserve the error in the canonical result field when this launcher owns the reservation (`trident/project-launcher.ts:65`). |
| Driver merged | Existing `prMerged` harvest flag, so outer harvest records done without another merge (`trident/project-launcher.ts:17`, `trident/orchestrator.ts:5006`). |
| Driver built/continued | Existing built-commit/Ralph handoff fields and named checkpoints (`trident/project-launcher.ts:18`, `trident/project-launcher.ts:25`). |
| Driver blocked/refused/failed | Original driver outcome remains in the stored envelope; legacy failure fields carry its detail and available cause (`trident/project-launcher.ts:15`, `trident/project-launcher.ts:26`). Existing infrastructure classification/retry still applies by default (`trident/orchestrator.ts:5155`). |
| Driver unknown | Store the complete outcome including phase and step; intercept it before legacy parsing or worker reaping (`trident/project-launcher.ts:12`, `trident/orchestrator.ts:6342`). Preserve the worker slot. |

The existing launch vocabulary is `fired | failed | unconfirmed`
(`trident/inner-loop.ts:394`). The existing driver vocabulary makes unknown
nonterminal (`trident/build-run.ts:139`). No extra terminal verdict was introduced.

The store is the handoff: a conditional SQLite update reserves `inner_result`
before preparation; another conditional update replaces that reservation with the
outcome (`trident/store.ts:1043`, `trident/project-launcher.ts:60`). Both operations
check expected bytes and active phase. This rejects competing launchers, stale
writers and completion after cancellation independently of worker cooperation.
The initial durable unknown reservation survives a process death; the driver's
mode checkpoint separately retains pending step identity (`trident/build-run.ts:279`).
The outer unknown check survives reconstruction because it reads the row, not an
in-memory promise (`trident/orchestrator.ts:6342`).

A failed completion write is logged by the repository's fire-and-forget wrapper
and leaves the reservation uncertain (`trident/project-launcher.ts:60`). Automatic
reconciliation of such unknown outcomes is not implemented here; they are held,
not silently reaped or re-fired. The restart/blocked-observer test verifies that
behavior (`trident/project-launcher.test.ts:58`).

### Every credential-free branch

Enumerated with `rg -n 'tridentFireInnerWorkflow' open/composer.ts`. The complete
set of executable branches and their null behavior is:

| Site | No-credential behavior |
| --- | --- |
| `open/composer.ts:1159` | Null launcher; no preparation or host construction. |
| `open/composer.ts:4558` | boardStartBuild undefined; false arm at `open/composer.ts:4605`. |
| `open/composer.ts:6254` | Conflict resolver undefined. |
| `open/composer.ts:6284` | Arbiter undefined. |
| `open/composer.ts:6300` | Leak fixer undefined. |
| `open/composer.ts:7055` | Omit the trident composition bag. |

The remaining line-2280 match is a comment on the separate LLM pool check. The
credential-free boot test remains green in the production boot suite. Old factory
code is retained at `open/wiring/substrates.ts:531`; production no longer calls it.

### Named limits and controlled searches

The suite checkpoint report cannot be read from production mode checkpoints.
Controlled search:

```sh
rg -n 'suiteOutcome|suiteEvidence|saveCheckpoint|recordStageEvent' trident/production-host-effects.ts trident/build-run.ts
```

It finds the positive controls at `trident/build-run.ts:267`,
`trident/production-host-effects.ts:239` and `trident/production-host-effects.ts:423`,
but neither suite field. The supplied null reader produces the existing unknown
observation (`trident/project-observation-sources.ts:75`). It cannot establish a
clean suite even when the strategy is empty.

Non-Claude acting-turn bindings are explicitly refused (`open/wiring/project-build.ts:57`).
Missing headless/review transports remain unavailable, including API/Kimi lookup
(`open/wiring/project-build.ts:125`); the existing review source classifies missing
runners and unsupported roles as unavailable (`trident/project-review-source.ts:72`).
The Pi production fixture therefore stops at worker admission as refused
(`trident/build-run.ts:182`), not at a dispatched worker's blocked outcome. The
initial test expectation confused those two stages; it was corrected to assert
refused exactly, without relaxing the assertion.

Production selection search:

```sh
rg -n 'buildWorkflowFirer|buildSubstrateWorkflowFire|createProjectLauncher' open/composer.ts gateway/composition/build-core-modules.ts gateway/composition/input/misc-input.ts
```

Only the new import/call at `open/composer.ts:1` and `open/composer.ts:1161` match;
they are the positive control. Old/new phrase searches also found the dated static
audit `docs/trident-routing-gap.md:3` and archived as-built records. Those historical
records remain unchanged. Current production comments and the system overview
were corrected; retained substrate documentation is labelled legacy.

`git diff --name-only -- trident/inner-loop.ts trident/inner-workflow.mjs trident/review-run.ts trident/orchestrator.ts`
returns only the positive-control `trident/orchestrator.ts`. The three protected
old-path files were not edited. These are working-tree checks, not claims about a
freshly fetched remote ref. No network, push, PR creation, merge, feature flag or
old-path deletion was part of this delivery.

### Mutation evidence

Every mutation printed its actual landed line, executed the named test file red
(exit 1), restored the source in a finally block, then executed that test file
green (exit 0). Enumeration: 34 executions, 33 distinct scenarios; driver-call
removal was repeated against the strengthened two-provider production test.
These are runtime mutation results; no per-mutant typecheck is claimed.

Test keys: **P** = `open/__tests__/open-trident-prod-boot-wiring.test.ts:102`;
**L** = `trident/project-launcher.test.ts:42` and following launcher tests;
**O** = `open/__tests__/project-build-wiring.test.ts:46` and following option tests;
**G** = `gateway/composition/build-core-modules-trident-shutdown.test.ts:71`.
Gateway wiring's printed line was 646 before comment cleanup; its final location
is 633. All other table locations retain the printed source line.

| Property / source | Mutation | Test | Mutated → restored |
| driver invocation: `trident/project-launcher.ts:56` | Replace host.run with a resolved unknown promise | P | RED → GREEN |
| unknown envelope: `trident/project-launcher.ts:12` | Change stored unknown kind to failed | L | RED → GREEN |
| outer unknown hold: `trident/orchestrator.ts:6342` | Disable the hold | L | RED → GREEN |
| atomic expected result: `trident/store.ts:1046` | Ignore expected result bytes | L | RED → GREEN |
| atomic active run: `trident/store.ts:1046` | Remove the active-phase predicate | L | RED → GREEN |
| reservation rejection: `trident/project-launcher.ts:52` | Ignore a lost reservation | L | RED → GREEN |
| completion write acknowledgement: `trident/project-launcher.ts:62` | Ignore a lost completion write | L | RED → GREEN |
| launch base: `open/wiring/project-build.ts:32` | Remove the pin refusal | O | RED → GREEN |
| initialized row: `open/wiring/project-build.ts:35` | Remove the missing-row refusal | O | RED → GREEN |
| branch observation: `open/wiring/project-build.ts:41` | Accept an unreadable branch probe | O | RED → GREEN |
| worktree add: `open/wiring/project-build.ts:45` | Accept failed creation | O | RED → GREEN |
| worktree identity: `open/wiring/project-build.ts:48` | Accept the wrong checked-out branch | O | RED → GREEN |
| phase settings: `open/wiring/project-build.ts:80` | Ignore rejected settings | O | RED → GREEN |
| provider binding: `open/wiring/project-build.ts:57` | Claim turn-ended for an unsupported provider | O | RED → GREEN |
| session identity: `open/wiring/project-build.ts:60` | Claim turn-ended for missing/ambiguous sessions | O | RED → GREEN |
| ready session: `open/wiring/project-build.ts:63` | Claim turn-ended for an unready session | O | RED → GREEN |
| live session: `open/wiring/project-build.ts:65` | Claim turn-ended for a dead session | O | RED → GREEN |
| launch grants: `open/wiring/project-build.ts:67` | Claim turn-ended with insufficient grants | O | RED → GREEN |
| snapshot schema: `open/wiring/project-build.ts:134` | Accept invalid snapshot fields/payload | O | RED → GREEN |
| snapshot object: `open/wiring/project-build.ts:132` | Accept nonobjects | O | RED → GREEN |
| model resolution: `open/wiring/project-build.ts:87` | Invert model admission, rejecting valid models | O | RED → GREEN |
| gateway typed call: `gateway/composition/build-core-modules.ts:633` | Replace the supplied firer with a no-op fired result | G | RED → GREEN |
| existing reservation classification: `trident/project-launcher.ts:47` | Remove the existing-unknown check | L | RED → GREEN |
| preparation failure persistence: `trident/project-launcher.ts:66` | Invert reservation ownership check | L | RED → GREEN |
| filesystem observation: `open/wiring/project-build.ts:38` | Swallow ENOTDIR as absence | O | RED → GREEN |
| existing worktree: `open/wiring/project-build.ts:39` | Always attempt worktree add | O | RED → GREEN |
| project provider selection: `open/composer.ts:1169` | Hardcode Anthropic | P | RED → GREEN |
| project repository declaration: `open/composer.ts:1168` | Read the wrong directory | P | RED → GREEN |
| review transport binding: `open/wiring/project-build.ts:125` | Use an unrelated runner for API/Kimi | O | RED → GREEN |
| mutation claim validation: `open/wiring/project-build.ts:121` | Return nomination from a malformed forge payload | O | RED → GREEN |
| launch timeout classification: `trident/project-launcher.ts:74` | Report fired on timeout | L | RED → GREEN |
| outer worktree identity: `trident/orchestrator.ts:4176` | Drop the worktree default | G | RED → GREEN |
| outer branch identity: `trident/orchestrator.ts:4175` | Drop the branch default | G | RED → GREEN |

### Validation and deliberate exclusions

Bounded validation command:

```sh
bun test trident/project-build-host.test.ts trident/production-host-effects.test.ts runtime/workers/ trident/project-launcher.test.ts open/__tests__/project-build-wiring.test.ts open/__tests__/open-trident-prod-boot-wiring.test.ts open/__tests__/open-boot-shell.test.ts open/__tests__/open-agent-dispatch-wiring.test.ts open/__tests__/open-dispatch-hold-drain-wiring.test.ts open/__tests__/open-wiring-substrates.test.ts gateway/composition/build-core-modules-trident-shutdown.test.ts
```

Result: **305 pass, 5 fail**, 310 tests across 16 discovered files. All five
failures were `EADDRINUSE` binding port 0 at `gateway/index.ts:906`, in
`open/__tests__/open-boot-shell.test.ts`:

- Fresh healthz boot, line 123.
- Fresh chat redirect/cookie, line 138.
- Credential-free chat auth gate, line 150.
- Returning resumable-session auth gate, line 171.
- Stale-cookie/empty-database boot, line 200.

Those cases are not counted as passing. No whole-suite command or
`scripts/run-tests.sh` was run.

After strengthening the production test to two project providers and adding the
last option/mapper assertions, final affected tests were **15 pass, 0 fail**:

```sh
bun test trident/project-launcher.test.ts open/__tests__/project-build-wiring.test.ts open/__tests__/open-trident-prod-boot-wiring.test.ts gateway/composition/build-core-modules-trident-shutdown.test.ts
```

Additional validation:

- `bash scripts/ci/typecheck-all.sh`: all 51 configurations passed. The initial
  run found the gateway shutdown fixture's obsolete fire type; the final matrix
  passed after changing it to the typed firer.
- Final `bunx --no-install tsc -p open/tsconfig.json --noEmit` and the equivalent
  trident command: exit 0 after the last functional changes.
- `bash scripts/ci/lint.sh`: exit 0. Final ESLint over the 12 changed TypeScript
  files: exit 0. Three obsolete suppression comments named an unavailable ESLint
  rule; removing those comments fixed the targeted lint invocation. No test
  assertion was skipped or loosened.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, **INCOMPLETE**, zero findings
  from executed rules; `pii-denylist` and `pii-denylist-msg` could not run. This is
  not a clean leak-gate result.
- `git diff --check`: clean; this shard has exactly one level-two heading.

Deliberate exclusions are live provider validation, missing provider transports,
suite-report persistence, automatic recovery of unknown driver outcomes, old-path
deletion, product-policy changes and remote publication. The requested local
commit is the review handoff; the live merged acceptance remains open.
