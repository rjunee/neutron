## WIRE investigation — cutover not delivered

### Status and decision

The requested production wiring is **not implemented**. This record preserves the
source findings, not a claim that step 3 passed. The acceptance remains a dispatched
card reaching merged without human intervention
(docs/plans/harness-orchestrator-pivot-2026-09-11.md:287).

The required configured CI workflow could not be sourced. The new production host
requires a project-configured name (trident/production-host-effects.ts:30) and rejects
an empty name before querying that workflow (trident/production-host-effects.ts:204).
Selecting a name without configuration would invent project policy, expressly
prohibited by this task. Need the intended project configuration source before
shipping a production replacement. No specification decision was changed.

### Consumer contract, before any adapter

The composition input requires `FireInnerWorkflow`
(gateway/composition/input/misc-input.ts:85). The gateway wraps it with
`buildWorkflowFirer` (gateway/composition/build-core-modules.ts:647). That wrapper
receives typed `InnerLoopInput`, writes brief parts and serializes the run into a
prompt, then calls the seam with exactly `prompt`, `cwd`, `settle_timeout_ms`
(trident/inner-loop.ts:987, trident/inner-loop.ts:999).

Its result is `Promise<FireOutcome>` (trident/inner-loop.ts:460), whose vocabulary
is `fired | failed | unconfirmed`, plus error and optional lifecycle evidence
(trident/inner-loop.ts:394, trident/inner-loop.ts:419). A thrown seam error becomes
`failed` in the wrapper (trident/inner-loop.ts:1000). It must return after launch,
not hold the gateway until the build completes (trident/inner-loop.ts:454).

The new factory is async, validates initialized run identity, and returns
`{ runners, workers, deps, run }` (trident/project-build-host.ts:39,
trident/project-build-host.ts:74). Its `run` accepts build mode/resume inputs plus
an AbortSignal, injecting run ID, workers, provider and merge mode itself
(trident/project-build-host.ts:76). Build inputs include `pr`, `ralph`, `wave`,
`bound_pr` and `fresh | resume` (trident/build-run.ts:76).

A direct assignment cannot reconcile these signatures. An engineering follow-up
must carry typed run context before prompt serialization, supervise the detached
host, and reconcile terminal outcomes with the outer store lifecycle. Parsing the
launcher prompt or treating host construction as successful launch is not an
implemented solution. No new outcome or invariant was introduced in this change.

### Host option source inventory

Enumerated from every field of `ProjectBuildHostOptions`
(trident/project-build-host.ts:26) and `ProductionHostOptions`
(trident/production-host-effects.ts:20):

| Field | Located source or unresolved work |
| --- | --- |
| substrate.provider | Project-aware resolver exists at open/composer.ts:1041. Resolve for the dispatched project, not the active chat by accident; the convenience closure includes active-chat fallback at open/composer.ts:1042. |
| substrate.inRepl, headless | Composer receives Substrate values/factories, not bounded workers (open/wiring/substrates.ts:55, open/wiring/substrates.ts:84). Named runner constructors were not found there by the controlled search below. Existing in-REPL constructors additionally require a conversational spec, acting-turn bridge and trailer decoder (runtime/workers/claude-in-repl.ts:8, runtime/workers/codex-in-repl.ts:8, runtime/workers/pi-in-repl.ts:8). |
| production.store | boardRunStore, open/composer.ts:4242. |
| runId, projectSlug, repo, worktree, branch | Typed run is available before serialization (trident/inner-loop.ts:77), but the fire seam receives only prompt/cwd/budget (trident/inner-loop.ts:441). Host requires matching initialized row and base SHA (trident/project-build-host.ts:41). |
| baseBranch | InnerLoopInput.base_branch, trident/inner-loop.ts:79. |
| runHost | tridentHostRunner, open/composer.ts:2186; threaded at open/composer.ts:7094. |
| ciWorkflow | No matching configuration symbol found by the controlled searches below; required at trident/production-host-effects.ts:30. |
| publication.title, bodyFile | Required at trident/production-host-effects.ts:31; no prepared publication object was identified in the inspected composition. A host-owned body writer would be new adapter work. |
| policy.review | Requires seats, readSeat, retrySeat and readSynthesis (trident/gates/review-panel.ts:27). Named observation sources not found in inspected composition. Missing source returns unknown (trident/gates/review-panel.ts:68). |
| policy.boundReview | Bound review requires matching run/deps or returns blocked (trident/build-host.ts:153). No boundReview composition source was identified. |
| policy.leak | scratch_dir and optional gate_script are selected by the new options type (trident/project-build-host.ts:31). Per-run scratch allocation remains adapter work. |
| policy.mutation | Requires readClaim (trident/build-host.ts:33); named source not found in inspected composition. Must read the actual claim, not return a fabricated empty claim. |
| workers | Four role requests in the fixture demonstrate the expected shape (trident/project-build-host.test.ts:41, trident/project-build-host.test.ts:51); these are test data, not production policy. Actual requests require model, effort, grants, brief integrity, result path and budget (runtime/bounded-work.ts:61). |

Additional integration finding: the project's policy type selects only review and
boundReview (trident/project-build-host.ts:30), while BuildHost consumes
reviewReadiness and reviewSuite (trident/build-host.ts:128). Missing readiness
returns unknown (trident/gates/review-readiness.ts:71); missing suite also returns
unknown (trident/gates/review-suite.ts:32). The driver stops on those results before
dispatching review (trident/build-run.ts:393). These sources must be exposed and
supplied in the eventual cutover, not omitted just because the type permits it.

### Controlled searches

All searches refer to this session's working tree; no fetched-ref absence is claimed.

- `rg -n 'createProjectBuildHost' --glob '*.ts' --glob '!node_modules/**' .`
  found only trident/project-build-host.ts:39 and trident/project-build-host.test.ts
  (import at line 9; calls at 59, 77, 86, 89, 94, 97, 100, 105).
  The definition is the positive control for the same exact symbol search.
- `rg -n 'ciWorkflow|ci_workflow|readSeat|retrySeat|readSynthesis|readClaim|claudeInReplRunner|codexInReplRunner|piInReplRunner|createCodexHeadlessRunner|providerResolver' open/composer.ts open/wiring/substrates.ts`
  found only providerResolver at open/composer.ts:1042,1125 and
  open/wiring/substrates.ts:125,129. That is the positive control. This proves
  absence of these named symbols in these two files, not absence of every
  semantically equivalent implementation elsewhere.
- `rg -n 'ci_workflow|ciWorkflow|required_workflow|workflow_file|workflow_name' --glob '*.ts' --glob '!*.test.ts' --glob '!**/__tests__/**' .`
  found only trident/production-host-effects.ts:30,204,205. Its required property
  is the positive control; no configuration source was found by these spellings.
- `rg -n 'reviewReadiness|reviewSuite|createBuildHost' trident/project-build-host.ts`
  found only createBuildHost at lines 4 and 61, the positive control. The explicit
  options type and construction were also read (trident/project-build-host.ts:26,
  trident/project-build-host.ts:61).

### Every fire-variable branch

Enumerated with `rg -n 'tridentFireInnerWorkflow' open/composer.ts`, including
comments and the assignment. All remain unchanged because no adapter shipped.

| Location | Current behavior when unavailable |
| --- | --- |
| open/composer.ts:1147 | Null when liveAgentSubstrate is null; otherwise builds the old fire seam. |
| open/composer.ts:4543 | boardStartBuild is undefined (false arm at open/composer.ts:4590). |
| open/composer.ts:6237 | Conflict resolver is undefined. |
| open/composer.ts:6267 | Arbiter is undefined. |
| open/composer.ts:6283 | Leak fixer is undefined. |
| open/composer.ts:7043 | Omits the trident composition bag, including fire, host runner and observers. |

The comment reference at open/composer.ts:2256 is not another variable branch:
the actual guard uses llmPool at open/composer.ts:2260 and returns null from the
code-command context resolver. The remaining references at open/composer.ts:7036,7037 and 7046 document or
assign the same final composition field.

### Validation and mutation table

No production change, test change or new guard was authored. Consequently there
is no wiring-removal mutation to claim: the requested red-without-wiring test is
**not delivered**. Shipping a passing construction-only test would not satisfy
this lane's acceptance.

| Guard | Mutation | Red | Restored green |
| --- | --- | --- | --- |
| Production project-host wiring | Not implemented | Not run | Not claimed |

Bounded baseline command:

```sh
bun test open/__tests__/open-trident-prod-boot-wiring.test.ts open/__tests__/open-boot-shell.test.ts open/__tests__/open-agent-dispatch-wiring.test.ts open/__tests__/open-dispatch-hold-drain-wiring.test.ts trident/project-build-host.test.ts
```

Result: 15 passed, 5 failed, 228 assertions. All five failures were in
open-boot-shell.test.ts, reporting EADDRINUSE while binding port 0 at
gateway/index.ts:906. Project-host tests: 8 passed; production Trident boot/dispatch:
3 passed; agent dispatch: 2 passed; dispatch-hold drain: 2 passed. No assertion was
relaxed and no test was skipped.

`bash scripts/ci/typecheck-all.sh`: exit 0; all 51 configurations passed.
`git diff --cached --check`: passed. The shard has exactly one `## ` heading.
No code lint was run for this Markdown-only change.

### Deliberately not done

No runtime replacement, prompt-parsing adapter, provider fallback, feature flag,
policy default, new guard, spec amendment or protected-file edit. No full-suite
run. No push, PR creation or merge. This is a findings-only handoff; it must not
be treated as the completed launcher cutover.
