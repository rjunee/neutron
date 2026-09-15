## WIRE9 — launcher investigation; cutover NOT delivered

### Status

This is an incomplete lane, not a shipped launcher. The production call remains
`buildSubstrateWorkflowFire` (open/composer.ts:1159), and the gateway still adapts
that prompt seam through `buildWorkflowFirer`
(gateway/composition/build-core-modules.ts:647). The required construction/run
mutation test was not implemented. Step 3 acceptance is not satisfied.

No runtime code, test, spec decision or guard was changed. This record uses the
explicit lane shard location instead of the general docs/as-built location.

### Concrete findings

1. The project host's declared policy contains `boundReview`, `review`, `leak`
   and `mutation` (trident/project-build-host.ts:34). It constructs the host at
   trident/project-build-host.ts:81, but does not expose or supply the three
   sources consumed at trident/build-host.ts:167: `reviewReadiness`, `reviewCi`,
   and `reviewSuite`. Their missing-source defaults are `unknown`, respectively
   at trident/gates/review-readiness.ts:71, trident/gates/review-ci.ts:19 and
   trident/gates/review-suite.ts:32. The driver stops on these answers before
   dispatching review (trident/build-run.ts:443). A panel source alone does not
   supply those observations.
2. The acting adapter requires an existing session and measured launch grants
   (runtime/workers/claude-acting-turn.ts:11), and refuses providers other than
   Anthropic (runtime/workers/claude-acting-turn.ts:27). The runner factory
   separately requires a conversation, durable directory, acting turn, decoder
   and headless registry (runtime/workers/project-runners.ts:67). The decoder
   refuses completed trailers without independently supplied usage/model/thread
   observations (runtime/workers/project-runners.ts:59). Those observations cannot
   be replaced with zeros or copied from a worker's trailer to make launch work.
3. Review transport remains an explicit descriptor-aware callback
   (trident/project-review-source.ts:22). Missing or mismatched bindings are
   `unavailable` (trident/project-review-source.ts:74). The supplied Codex headless
   implementation supports build and fix (runtime/workers/codex-headless.ts:22);
   handing it to a review seat does not add review capability.
4. Checkpoints are durable: the effects call `appendBuildModeState`
   (trident/production-host-effects.ts:227), whose SQL inserts a stage event
   (trident/store.ts:1047). Terminal reconciliation is separate work. A witnessed
   PR merge returns `allow` (trident/production-host-effects.ts:389), and the
   project host returns the build result to its caller
   (trident/project-build-host.ts:103). The store-write census below finds no
   terminal phase or `inner_result` write in those two modules. Dropping the run
   promise would therefore not implement durable terminal handling.

These are implementation gaps; this report does not claim a missing credential
or ask for a product decision. They were not repaired in this lane.

### Option source ledger

Enumerated from ProjectBuildHostOptions (trident/project-build-host.ts:27),
ProductionHostOptions (trident/production-host-effects.ts:21), and the nested
interfaces cited below. This is a source ledger, not a constructed options object.

| Option | Located source or exact remaining binding |
| --- | --- |
| substrate.provider | Explicit project resolver at open/composer.ts:1051; avoid its active-chat convenience fallback at open/composer.ts:1052. |
| substrate.inRepl, headless | Factory at runtime/workers/project-runners.ts:82; live conversation/session, host metadata and provider-specific transport bindings remain required as described above. |
| production.store | boardRunStore at open/composer.ts:4257. |
| production.runId, projectSlug, repo, worktree, branch | Typed input run at trident/inner-loop.ts:78; host identity checks at trident/project-build-host.ts:60. |
| production.baseBranch | Typed base_branch at trident/inner-loop.ts:79. |
| production.runHost | Credentialed runner at open/composer.ts:2196. |
| production.ciWorkflow | Repository declaration at trident/project-repos.ts:10; dispatched-repository selection still needs composition. |
| production.ciSource, ciNow | Optional interfaces at trident/production-host-effects.ts:32; CI acquisition implementation at trident/production-host-effects.ts:52. |
| production.publication | withProjectPublication prepares title/body from the stored request at trident/project-publication-source.ts:17. Its callback must retain the body through publication (trident/project-publication-source.ts:29). |
| phaseUsage | TridentPhaseUsageStore accepts the shared database at trident/phase-usage.ts:27. |
| policy.boundReview | Optional retained execution inputs at trident/build-host.ts:27; no binding was assembled. |
| policy.review | Source constructor at trident/project-review-source.ts:30; needs evidenceRoot, env, phaseModels, runnerFor, wallMs and signal (trident/project-review-source.ts:12). Host supplies run/project/worktree/provider identity at trident/project-build-host.ts:83. |
| policy.leak | Scratch directory/script fields at trident/project-build-host.ts:36; allocated trusted scanner example at trident/project-leak-source.ts:15. Per-run lifetime was not composed. |
| policy.mutation | readClaim at trident/build-host.ts:37; used before running the proof at trident/build-host.ts:174. A production claim reader was not assembled. |
| workers | Four role requests at trident/build-host.ts:30; briefs are verified and rewritten for host context at trident/project-build-host.ts:65. Production role requests and schemas were not assembled. |

### Fire vocabulary and credential-free branches

The existing launch vocabulary is `fired | failed | unconfirmed`
(trident/inner-loop.ts:394). The typed boundary already exists as
TridentWorkflowFirer (trident/inner-loop.ts:466). A cutover must replace the gateway
adapter at gateway/composition/build-core-modules.ts:647 and preserve that typed
input. No new outcome mapping was delivered, including no new handling of
unconfirmable launch. The launch-only contract remains documented at
trident/inner-loop.ts:454; it must not await the entire build.

All fire-variable sites were enumerated with
`rg -n 'tridentFireInnerWorkflow' open/composer.ts`. Their behavior remains:

| Site | Credential-free behavior |
| --- | --- |
| open/composer.ts:1157 | null when liveAgentSubstrate is null; otherwise old fire construction. |
| open/composer.ts:2266 | Comment on the independent llmPool guard at open/composer.ts:2270, which returns no code-command context. |
| open/composer.ts:4558 | boardStartBuild undefined; false arm at open/composer.ts:4605. |
| open/composer.ts:6253 | Conflict resolver undefined; false arm at open/composer.ts:6257. |
| open/composer.ts:6283 | Arbiter undefined; false arm at open/composer.ts:6287. |
| open/composer.ts:6299 | Leak fixer undefined; false arm at open/composer.ts:6303. |
| open/composer.ts:7056 and open/composer.ts:7057 | Comments describing the final bag guard. |
| open/composer.ts:7063 and open/composer.ts:7066 | Omit the trident composition bag on null; otherwise pass the old fire function. |

### Controlled searches and runtime probe

All searches concern working-tree contents, not a fetched ref. No network was used.

- `rg --files --hidden --no-ignore ../ -g 'wire-project-host*.md' -g '!node_modules' -g '!.git'`
  found wire-project-host-2.md in the build worktree and sibling worktrees, but
  not the requested wire-project-host.md. The second record is the positive
  control. The other supplied records were read.
- `rg -n 'reviewReadiness|reviewCi|reviewSuite|createBuildHost' trident/project-build-host.ts`
  found createBuildHost at lines 4 and 81, and none of the three source spellings.
- `rg -n 'createClaudeActingTurn|createProjectRunners|createProjectBuildHost|decodeProjectTrailer' open runtime/workers gateway --glob '*.ts' --glob '!*.test.ts'`
  found the acting-turn definition at runtime/workers/claude-acting-turn.ts:21,
  runner definition at runtime/workers/project-runners.ts:82 and decoder
  definition/call at runtime/workers/project-runners.ts:44 and :119. It found no
  construction call by those spellings in open or gateway. This does not claim
  aliases or alternative adapters were exhaustively excluded.
- `rg -n 'store\.|inner_result|phase:' trident/production-host-effects.ts trident/project-build-host.ts`
  enumerated store reads, the checkpoint append at effects:227, PR update at
  effects:356 and event writes at effects:374 and :423, with no inner_result or
  terminal-phase write. `effects` here means trident/production-host-effects.ts.
  The checkpoint append's SQL was also read at trident/store.ts:1047.
- A direct Bun probe called awaitReviewReadiness with a measured snapshot and
  undefined source: returned `unknown`, detail `Review readiness observation
  source is missing`. Positive control supplied matching head, resolved required
  check `ci`, mergeable state and a passed `ci` row: returned `allow`.
  This is diagnostic evidence, not the required production-launch test.

### Mutation table

| Required control | Mutation | Red | Restored green |
| --- | --- | --- | --- |
| Remove production project-host construction/run | Not implemented | Not run | Not claimed |

No new test or guard was added. Existing passing tests below do not establish the
requested launcher acceptance.

### Validation

The bounded command was:

```sh
bun test trident/project-build-host.test.ts trident/production-host-effects.test.ts runtime/workers/ open/__tests__/open-trident-prod-boot-wiring.test.ts open/__tests__/open-boot-shell.test.ts open/__tests__/open-agent-dispatch-wiring.test.ts open/__tests__/open-dispatch-hold-drain-wiring.test.ts
```

Result: 230 passed, 5 failed, 983 assertions, 12 files. The file set is enumerated
by the explicit paths and worker-directory discovery in that command. Every
failure was in open-boot-shell and reported EADDRINUSE at gateway/index.ts:906:

- fresh boot serves /healthz;
- fresh GET /chat mints cookie and start-token;
- no-credential GET /chat?start gates on auth;
- returning visit with resumable session still gates on auth;
- stale cookie with empty DB cold-starts onboarding.

These five cases are not recorded as passing. No test was relaxed or skipped.

- `bash scripts/ci/typecheck-all.sh`: passed, all 51 configurations, exit 0.
- `bash scripts/ci/lint.sh`: passed, exit 0.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, INCOMPLETE. Zero findings from
  executed rules; pii-denylist and pii-denylist-msg could not run. This is not a
  clean leak-gate result.
- `git diff --check`: passed. This record has exactly one `## ` heading.

### Deliberate limits

No production cutover, launch-success claim, fabricated policy observation,
provider fallback, terminal serialization, new guard, mutation proof, live harness
probe, full test sweep, push, PR creation or merge was delivered. The remaining
implementation work is recorded above; baseline validation does not close it.
