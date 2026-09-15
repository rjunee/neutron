## WIRE3 — project runner factory and trailer decoder

### Delivered scope

Factory and decoder delivered; **the production acting-turn bridge and live dispatch
are unbuilt/unproven**. This uses the task's explicitly permitted partial scope.
The factory requires that bridge and an explicit headless registry
(runtime/workers/project-runners.ts:74). It assembles the substrate shape consumed
by the project host (trident/project-build-host.ts:9). It does not make the outer
launcher gates answerable merely by constructing runners.

Read both earlier handoffs from sibling build worktrees, including the WIRE2
ProjectBuildHostOptions inventory (.trident/as-built/rebuild/wire-project-host-2.md:53).
Reused that inventory rather than repeating the launcher investigation.

### Decision 1 — project conversation

The caller supplies project ID, topic ID, canonical provider and conversational
spec as one ProjectConversation (runtime/workers/project-runners.ts:10). The factory
snapshots it, preserving the project scope and tool surface
(runtime/workers/project-runners.ts:83; runtime/workers/project-runners.ts:118).
Selection indexes the constructor table by that provider; canonical Codex is
`openai-codex`, not a guessed alias (runtime/workers/project-runners.ts:94;
runtime/provider.ts:2). The `openai` provider has no constructor in this table,
so its inRepl is undefined (runtime/workers/project-runners.ts:98;
runtime/workers/project-runners.ts:122).

Headless candidates are explicitly supplied, enumerated using PROVIDERS and
filtered by placementFor; mismatched registry identity rejects construction
(runtime/workers/project-runners.ts:144). Availability and role support remain
answers from the actual runners, including in-REPL admission
(runtime/workers/project-runners.ts:107; runtime/workers/project-runners.ts:124).
The run wrapper checks placement, supports and host run ID before invoking a runner
(runtime/workers/project-runners.ts:104; runtime/workers/project-runners.ts:110).
No missing headless implementation is invented. Supplying headless implementations
and their capabilities is still the host composition's responsibility
(runtime/workers/project-runners.ts:76).

Tests exercise all three in-REPL constructors, using provider-specific prompt
assertions, and reconstruct from the same state directory
(runtime/workers/project-runners.test.ts:39). Separate Codex and Pi project fixtures
dispatch concurrently to distinct topics (runtime/workers/project-runners.test.ts:162).
The complete provider selection matrix is enumerated from PROVIDERS in the test
(runtime/workers/project-runners.test.ts:62).

### Decision 2 — durable directory

The host supplies an existing per-run state directory; the factory snapshots its
path and exclusively creates a binding to project/topic/provider/run. Reconstructing
requires identical binding bytes (runtime/workers/project-runners.ts:85).
A different run request is unknown before dispatch
(runtime/workers/project-runners.ts:112). This rejects accidental directory reuse
instead of deleting state to recover. Allocation, retention and stable rediscovery
of this directory across a real gateway restart remain host obligations
(runtime/workers/project-runners.ts:70).

Continuous replay prevention comes from the existing workers' exclusive on-disk
step reservations, not a live child or a process-local set
(runtime/workers/claude-in-repl.ts:43; runtime/workers/codex-in-repl.ts:46;
runtime/workers/pi-in-repl.ts:57). The factory passes the same captured directory
on every invocation (runtime/workers/project-runners.ts:118;
runtime/workers/project-runners.ts:128). Reconstruction tests observe one dispatch,
including after a lost bridge connection (runtime/workers/project-runners.test.ts:56;
runtime/workers/project-runners.test.ts:174). This proves reconstruction using
retained files, not crash/power-loss durability or a production directory allocator.
It does not add replay guarantees to supplied headless implementations.

### Decision 3 — acting-turn bridge

ProjectActingTurn is the exact unfinished seam. It receives the conversation,
original request, generated dispatch spec, remaining timeout and AbortSignal;
Pi also receives the generated definition name
(runtime/workers/project-runners.ts:23; runtime/workers/project-runners.ts:130).
A host implementation must resume this project's existing session, enforce the
request's model/effort/grants, bind Pi's named definition, and provide a trailer
writer outside restricted child grants (runtime/workers/project-runners.ts:17).
These are integration requirements, not enforcement claimed for this factory.

The bridge must observe dispatch-turn end, returning `turn-ended`; it may instead
return `unknown` with missing evidence or throw. Unknown observation stops before
accepting even a valid trailer (runtime/workers/project-runners.ts:131;
runtime/workers/project-runners.test.ts:111). Turn end still is not child completion:
the existing workers subsequently read the file
(runtime/workers/codex-in-repl.ts:86; runtime/workers/pi-in-repl.ts:96).
Missing/unreadable files and thrown bridges remain unknown in the scripted fixtures
(runtime/workers/project-runners.test.ts:122; runtime/workers/project-runners.test.ts:174).
In-REPL liveness is deliberately unknown without a host probe
(runtime/workers/project-runners.ts:141).

The existing composeActingTurn returns text from dispatchSpec, which starts the
configured substrate and collects tokens (gateway/wiring/build-live-agent-turn.ts:1094;
gateway/wiring/build-live-agent-turn.ts:1110). This change does not silently cast that
string contract into an observed terminal event. Also, the task brief's unset-host
assertion differs from this checkout: unset selects herdr
(runtime/adapters/claude-code/persistent/configured-pty-host.ts:13). That module is
outside this change.

### Decision 4 — trailer decoding and outcome vocabulary

Host-side JSON envelope: `schema`, `run_id`, `step_id`, `kind`, and either completed
`result` or blocked `on`. Identity and schema must exactly match the original
request; the schema must be registered with the host
(runtime/workers/project-runners.ts:42; runtime/workers/project-runners.ts:48).
Completed payloads pass that registered validator. Blocked envelopes use the common
nonblank-string reason rule; they do not pretend to contain a completed payload
(runtime/workers/project-runners.ts:53; runtime/workers/project-runners.ts:58).
Only completed and blocked are accepted worker claims; unsupported outcomes stay
unknown (runtime/workers/project-runners.ts:57).

Usage, observed model and thread come exclusively from a host callback keyed by
the request. Missing observation is unknown; worker metadata fields are ignored
(runtime/workers/project-runners.ts:59; runtime/workers/project-runners.test.ts:23;
runtime/workers/project-runners.test.ts:130). Domain schema registrations and actual
host observations remain required integration inputs
(runtime/workers/project-runners.ts:33). This delivers the envelope/identity decoder,
not every role's domain schema or a metering implementation.

Runtime results join BoundedWorkOutcome's existing `completed | blocked | refused |
failed | unknown` taxonomy (runtime/bounded-work.ts:103). The driver stops on unknown,
blocks on blocked/refused, fails on failed, and proceeds to measurement only on
completed (trident/build-run.ts:283). No permissive default was added. Bridge
`turn-ended` is an observation internal to the new seam, not a new worker result;
unknown maps back to the existing unknown result (runtime/workers/project-runners.ts:139).

Configuration errors (unreadable state, conflicting durable binding, wrong headless
identity) reject the async factory with Error before returning the substrate
(runtime/workers/project-runners.ts:88; runtime/workers/project-runners.ts:148).
These are construction failures, not worker refusal values. The later launcher
must handle that rejected construction promise; this module supplies no automatic
launch-success mapping. Validation runs host-side independently of child liveness
(runtime/workers/project-runners.ts:44; runtime/workers/project-runners.ts:141).

### Controlled selection search

Working-tree evidence only; no freshly fetched-ref absence claim is made.

`rg -n "constructors\\[|construct = .*anthropic|provider: 'anthropic'|placementFor\\(.*'anthropic'" runtime/workers/project-runners.ts`

Matched only runtime/workers/project-runners.ts:100,
`const construct = constructors[conversation.provider]` (positive control).
No hardcoded Anthropic selection matched those patterns in this module. Explicit
provider names belong to the constructor registry at runtime/workers/project-runners.ts:94.
The constructor-selection mutation below additionally redirects Codex/Pi to Claude
and must fail the provider-specific prompt assertions.

### Mutation checks

Every row used `bun build runtime/workers/project-runners.ts --target=bun`, then
`bunx --no-install tsc --noEmit -p runtime/tsconfig.json`, then
`bun test runtime/workers/project-runners.test.ts`. Every counted mutation compiled
and typechecked successfully, failed runtime tests (exit 1), was restored in a
finally block, then passed all 19 tests (exit 0). The actual changed line was
printed before each run. Removed guards left a blank at the cited line.

| Guard / property | Printed mutated location and line | RED tests | Restored GREEN |
| --- | --- | --- | --- |
| object | runtime/workers/project-runners.ts:47: `if (!(value === null \|\| typeof value !== 'object' \|\| Array.isArray(value))) return unknown('Trailer object missing.')` | 11 failed; exit 1 | 19 passed; exit 0 |
| run identity | runtime/workers/project-runners.ts:48: `[guard removed at this line]` | 1 failed; exit 1 | 19 passed; exit 0 |
| step identity | runtime/workers/project-runners.ts:49: `[guard removed at this line]` | 1 failed; exit 1 | 19 passed; exit 0 |
| schema identity | runtime/workers/project-runners.ts:50: `[guard removed at this line]` | 1 failed; exit 1 | 19 passed; exit 0 |
| registered schema | runtime/workers/project-runners.ts:51: `const validate = host.schemas.get(request.result.schema) ?? (() => true)` | 1 failed; exit 1 | 19 passed; exit 0 |
| blocked reason | runtime/workers/project-runners.ts:54: `if (false) return unknown('Trailer blocked reason missing.')` | 1 failed; exit 1 | 19 passed; exit 0 |
| outcome kind | runtime/workers/project-runners.ts:57: `[guard removed at this line]` | 1 failed; exit 1 | 19 passed; exit 0 |
| payload schema | runtime/workers/project-runners.ts:58: `[guard removed at this line]` | 1 failed; exit 1 | 19 passed; exit 0 |
| host metadata | runtime/workers/project-runners.ts:59: `const metadata = host.metadata(request) ?? { usage: { input_tokens: 0, output_tokens: 0 }, model_reported: request.model_id, thread_id: null }` | 1 failed; exit 1 | 19 passed; exit 0 |
| exclusive binding | runtime/workers/project-runners.ts:88: `try { await writeFile(path, binding, { flag: 'w', mode: 0o600 }) }` | 1 failed; exit 1 | 19 passed; exit 0 |
| existing binding recovery | runtime/workers/project-runners.ts:90: `if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error` | 8 failed; exit 1 | 19 passed; exit 0 |
| binding identity | runtime/workers/project-runners.ts:91: `[guard removed at this line]` | 1 failed; exit 1 | 19 passed; exit 0 |
| provider selection | runtime/workers/project-runners.ts:100: `const construct = constructors[conversation.provider === 'openai' ? 'openai' : 'anthropic']` | 2 failed; exit 1 | 19 passed; exit 0 |
| placement | runtime/workers/project-runners.ts:104: `if (false) {` | 1 failed; exit 1 | 19 passed; exit 0 |
| supports | runtime/workers/project-runners.ts:111: `[guard removed at this line]` | 1 failed; exit 1 | 19 passed; exit 0 |
| host run | runtime/workers/project-runners.ts:112: `[guard removed at this line]` | 1 failed; exit 1 | 19 passed; exit 0 |
| turn completion | runtime/workers/project-runners.ts:131: `if (observation.kind !== 'turn-ended' && observation.detail === '__never__') {` | 1 failed; exit 1 | 19 passed; exit 0 |
| headless placement | runtime/workers/project-runners.ts:145: `[guard removed at this line]` | 1 failed; exit 1 | 19 passed; exit 0 |
| missing headless | runtime/workers/project-runners.ts:147: `if (!runner) throw new Error('Missing runner')` | 10 failed; exit 1 | 19 passed; exit 0 |
| headless identity | runtime/workers/project-runners.ts:148: `[guard removed at this line]` | 1 failed; exit 1 | 19 passed; exit 0 |

The object guard was inverted: valid envelopes wrongly became unknown. Binding
recovery was inverted: a valid reconstruction wrongly rejected with EEXIST.
Missing headless handling was inverted: optional absence wrongly rejected construction.
The remaining identity/schema/placement removals admit the wrong input, and bypassing
turn-end observation accepts a valid file despite unknown dispatch completion
(runtime/workers/project-runners.test.ts:111). Fixtures retain valid payload and host
metadata, so the identity tests reach the guard under test
(runtime/workers/project-runners.test.ts:22; runtime/workers/project-runners.test.ts:136).

Two instrumentation corrections are excluded from the counted rows: the first
exclusive-binding run was already red but the reporting script did not recognize
Bun's `Expected promise that rejects / Received promise that resolved` format; it
was rerun with corrected reporting. The first selection mutation assigned the
constructor directly, causing TS2774; that proves nothing and is excluded. The
counted conditional selection remains optional for `openai`, compiles, and actually
sends Codex/Pi to Claude: both prompt assertions fail
(runtime/workers/project-runners.test.ts:49). No test assertion was loosened or skipped.


### Validation and deliberate limits

- `bun test runtime/workers/`: 131 passed, 0 failed, 418 assertions across five files.
  Files are enumerated by that command's worker-directory discovery; no broader sweep.
- Own file after every counted restoration: 19 passed, 0 failed, 139 assertions.
- `bash scripts/ci/typecheck-all.sh`: all 51 configurations passed, exit 0.
- `bunx --no-install eslint runtime/workers/project-runners.ts runtime/workers/project-runners.test.ts`: passed.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, INCOMPLETE. Zero findings from
  executed rules; PII file/message rules could not run because the local denylist
  was unavailable. This is not a clean leak-gate result. Credentialed publication
  validation remains the orchestrator's responsibility.
- `git diff --check`: passed. The shard has exactly one `## ` heading.

No launcher wiring, protected worker/driver/gate edits, old-path deletion, feature
flag, spec decision change, live REPL execution, full-suite sweep, push, PR creation
or merge was performed in this lane. This record uses the task-mandated shard path.

Required follow-up live proof command: `bun test runtime/workers/project-runners.live.test.ts`.
That is the proposed acceptance test command, **not a delivered or currently runnable
live test**. Its implementation must use a real ProjectActingTurn, dispatch a bounded
request into each live project provider, observe terminal evidence and a validated
file, reconstruct with retained state, and assert no second dispatch. A scripted
host or the standalone Pi extension probe cannot prove this factory's live integration.
