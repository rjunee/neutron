## WIRE2 partial delivery — repository CI declaration

### Status

This commit delivers the repository declaration portion only. **The production
launcher cutover is not delivered.** The requested production-construction/run
mutation test is also not delivered. Do not mark the outer-launcher census gap
closed: the gateway still calls the old wrapper
(gateway/composition/build-core-modules.ts:647). This is a partial handoff, not a
claim that the lane's acceptance passed. No additional product decision is needed
for the two questions answered in the task brief.

The earlier WIRE record was read from the sibling build worktree after the named
branch failed to resolve locally. Its contract analysis was reused: typed input
exists before serialization (trident/inner-loop.ts:77), the old seam accepts
prompt/cwd/timeout (trident/inner-loop.ts:441), and its launch-only contract must
not wait for build completion (trident/inner-loop.ts:454).

### Changed behavior and decisions

- Each repo may declare `ciWorkflow` beside `remote`
  (trident/project-repos.ts:8). Accept a nonblank string, including a human-readable
  workflow name; preserve the supplied bytes. Reject null, numbers, booleans,
  arrays, objects, empty strings and whitespace-only strings at the declaration
  boundary (trident/project-repos.ts:39; trident/project-repos.test.ts:41).
- Omission has no default. Existing single-code fallback also supplies no workflow
  (trident/project-repos.ts:60; trident/project-repos.test.ts:25).
- The effects option explicitly accepts `undefined`
  (trident/production-host-effects.ts:30). Before any CI acquisition, missing or
  blank configuration returns `unreadable`, naming `project-repos.json`
  (trident/production-host-effects.ts:291, trident/production-host-effects.ts:304).
  The existing readiness vocabulary maps this to `cannot-read`, not `no-run`
  (trident/ci-readiness.ts:80). The build host maps `cannot-read` to gate `unknown`
  (trident/build-host.ts:150). There is no new verdict kind or permissive default.
- Maintenance is host-owned: every declaration read validates the parsed data
  (trident/project-repos.ts:62), selection validates again
  (trident/project-repos.ts:66), and every CI observation checks configuration
  (trident/production-host-effects.ts:291). These checks do not require a worker
  to produce output or remain alive.
- The test supplies a valid measured PR and independently successful CI. Removing
  the missing-config guard therefore actually returns completed success; another
  refusal cannot hide it (trident/production-host-effects.test.ts:398,
  trident/production-host-effects.test.ts:413). Configured success is green;
  configured empty rows are no-run (trident/production-host-effects.test.ts:416).

**Remaining CI limitation:** the current effects implementation checks presence
but reads required checks and the PR rollup; it does not use the supplied workflow
name to select an observation (trident/production-host-effects.ts:291,
trident/production-host-effects.ts:293). This commit does not claim named-workflow
acquisition. The declaration-to-effects binding is exercised by the integration
fixture (trident/production-host-effects.test.ts:406), not production composition.

### ProjectBuildHostOptions inventory — sources, not completed wiring

Enumerated from the option interface at trident/project-build-host.ts:26 and its
production interface at trident/production-host-effects.ts:20. No production
ProjectBuildHostOptions object was added in this commit.

| Field | Located source / remaining work |
| --- | --- |
| substrate.provider | Project resolver at open/composer.ts:1047. Pass the dispatched project explicitly; the convenience resolver has active-chat fallback at open/composer.ts:1048. |
| substrate.inRepl, headless | Current wiring exposes substrates (open/wiring/substrates.ts:56, open/wiring/substrates.ts:84). Runner construction still needs the project conversation, durable state directory, acting-turn bridge and trailer decoder (runtime/workers/claude-in-repl.ts:8, runtime/workers/codex-in-repl.ts:8, runtime/workers/pi-in-repl.ts:17). |
| production.store | Canonical boardRunStore at open/composer.ts:4248. |
| production.runId, projectSlug, repo, worktree, branch | Typed run at trident/inner-loop.ts:78; host requires matching initialized row and base pin at trident/project-build-host.ts:41. |
| production.baseBranch | Typed input base_branch at trident/inner-loop.ts:79. |
| production.runHost | Credentialed host runner at open/composer.ts:2192. |
| production.ciWorkflow | New per-repo field at trident/project-repos.ts:10; production binding remains unfinished. |
| production.ciSource, ciNow | Optional acquisition and clock seams at trident/production-host-effects.ts:31. Defaults are constructed at trident/production-host-effects.ts:285. |
| production.publication | Required title/bodyFile at trident/production-host-effects.ts:33; publication body preparation remains unfinished. |
| policy.review | Seat configuration, authoritative seat reads/retry and synthesis reader required by trident/gates/review-panel.ts:27. Production sources remain unfinished. |
| policy.boundReview | Retained executor inputs required by trident/build-host.ts:25. Adapter remains unfinished. |
| policy.leak | Scratch directory and optional script selected at trident/project-build-host.ts:31. Per-run allocation remains unfinished. |
| policy.mutation | Actual claim reader required by trident/build-host.ts:32. Source remains unfinished; no fabricated empty claim was supplied. |
| workers | Four typed role requests at trident/build-host.ts:28. Requests require model, effort, grants, brief, result and budget (runtime/bounded-work.ts:61). Production role request construction remains unfinished. |

The existing host policy surface also omits reviewReadiness/reviewCi/reviewSuite
from its explicit Pick (trident/project-build-host.ts:30), while the underlying
host consumes them (trident/build-host.ts:133). Exposing and composing those
sources is unfinished integration work, not a resolved policy default.

### Every fire-variable branch

Enumerated with `rg -n 'tridentFireInnerWorkflow' open/composer.ts`, including
assignment and comments. This commit leaves all these sites as read:

| Location | Credential-free behavior |
| --- | --- |
| open/composer.ts:1153 | Null when liveAgentSubstrate is null; otherwise constructs the old fire seam. |
| open/composer.ts:4549 | boardStartBuild is undefined; false arm at open/composer.ts:4596. |
| open/composer.ts:6244 | Conflict resolver is undefined; false arm at open/composer.ts:6248. |
| open/composer.ts:6274 | Arbiter is undefined; false arm at open/composer.ts:6278. |
| open/composer.ts:6290 | Leak fixer is undefined; false arm at open/composer.ts:6294. |
| open/composer.ts:7050 | Omits the trident composition bag; credentialed arm assigns the old fire at open/composer.ts:7053. |

The comment at open/composer.ts:2262 belongs to the separate llmPool null guard
at open/composer.ts:2266, which returns no code-command context. References at
open/composer.ts:7043 and open/composer.ts:7044 describe the final bag guard.

### Launch outcomes and unfinished consumer

The existing vocabulary remains `fired | failed | unconfirmed`
(trident/inner-loop.ts:394), including a later settled promise
(trident/inner-loop.ts:419). There is no new launch-outcome mapping in this commit.
The existing unconfirmed path's stage-event reader remains wired at
gateway/composition/build-core-modules.ts:662. Starting the typed host without
awaiting completion, witnessing launch, and reconciling its outcomes durably are
all unfinished. A project host exception currently becomes returned `unknown`
(trident/project-build-host.ts:78); a future launcher must not drop that promise
and claim that the store automatically contains every terminal outcome.

### Controlled searches

Working-tree searches only; no claim about a freshly fetched ref is made.

- `rg -n 'createProjectBuildHost|ciWorkflow|readSeat|retrySeat|readSynthesis|readClaim|claudeInReplRunner|codexInReplRunner|piInReplRunner|createCodexHeadlessRunner|providerResolver' open/composer.ts open/wiring/substrates.ts trident/project-build-host.ts`
  matched the factory definition at trident/project-build-host.ts:39 and provider
  resolver references at open/composer.ts:1048, open/composer.ts:1131,
  open/wiring/substrates.ts:125 and open/wiring/substrates.ts:135. These are positive
  controls; no production construction or those named policy/runner sources were
  found in these inspected files by these spellings.
- `rg -n 'reviewReadiness|reviewSuite|reviewCi|createBuildHost' trident/project-build-host.ts`
  matched createBuildHost at lines 4 and 61 (positive control), with no named
  review source match.
- `rg -n 'CI workflow, PR or full head is missing|Repository CI workflow is missing' --glob '!bun.lock' --hidden -g '!node_modules/**' -g '!.git/**' .`
  found only the new diagnostic at trident/production-host-effects.ts:291. The
  replacement is the positive control for the removed combined diagnostic search.

### Mutation table

Each mutation was printed with its actual file and line before running the test.
Files were restored in a finally block, then the focused test was run green.

| Guard | Mutation | Red | Restored green |
| --- | --- | --- | --- |
| trident/project-repos.ts:39 | Replace condition with `if (false)` | `bun test trident/project-repos.test.ts --test-name-pattern 'invalid workflow'`: 7 failed, exit 1 | 7 passed, exit 0 |
| trident/production-host-effects.ts:291 | Remove missing-workflow refusal | `bun test trident/production-host-effects.test.ts --test-name-pattern 'undeclared repo workflow'`: 1 failed; observed completed success, exit 1 | 1 passed, exit 0 |
| Production launch wiring | Not implemented | Not run | Not claimed |

### Validation

- After mutation restoration: `bun test trident/project-build-host.test.ts trident/production-host-effects.test.ts trident/project-repos.test.ts`: 87 passed, 0 failed, 345 assertions.
- `bun test open/__tests__/open-trident-prod-boot-wiring.test.ts open/__tests__/open-boot-shell.test.ts open/__tests__/open-agent-dispatch-wiring.test.ts open/__tests__/open-dispatch-hold-drain-wiring.test.ts`: 7 passed, 5 failed. All failures were open-boot-shell cases with EADDRINUSE at gateway/index.ts:906 while binding port 0. This is the sandbox socket failure described in the task brief; no test was weakened or skipped.
- `bunx --no-install eslint trident/project-repos.ts trident/project-repos.test.ts trident/production-host-effects.ts trident/production-host-effects.test.ts`: passed.
- `bash scripts/ci/typecheck-all.sh`: all 51 configurations passed, exit 0.
- `git diff --check`: passed; this record has exactly one `## ` heading.

### Deliberately not done

No production launch replacement, runtime runner adapter, outcome reconciliation,
policy fabrication, feature flag, spec decision change, protected driver/gate edit,
full test sweep, push, PR creation or merge. The workflow declaration is useful
preparatory work; it does not satisfy the requested production wiring acceptance.
