## 2026-09-17 — Project dispatch persistent-session regression instrument (#1112)

### Change and evidence

The test at `open/__tests__/project-build-wiring.test.ts:715` prepares a project
build, boots the real persistent substrate with a recording PTY host, sends a
wake using the shared live surface, then sends the captured conversation spec
with only a prompt added (`:743`, `:750`). It requires both messages to arrive,
checks every recorded spawn for an empty `--tools` argument, requires one spawn,
and checks the second reply's per-child counter (`:751-758`). The initial argv
assertion at `:747` is the positive control for the live surface.

The shared helper at
`runtime/adapters/claude-code/persistent/__tests__/recording-host.ts:14` is
extracted from the warm-import test. It copies argv at each spawn (`:26`) and
retains the HTTP ready/bound/reply protocol (`:37-62`). The original suite imports
it at `runtime/adapters/claude-code/persistent/__tests__/import-warm-session-reset.test.ts:21`.
This tests the real substrate lifecycle with a simulated CLI; it does not prove
that a live model creates a worker.

The production seams remain `open/wiring/project-build.ts:243` (composed shared
surface), `open/composer.ts:1204` (prewarm shared surface),
`gateway/wiring/build-live-agent-turn.ts:387` (shared definition), and
`runtime/adapters/claude-code/persistent/spawn.ts:302`, `:1550`, `:1640`
(surface derivation, comparison and eviction reason).
`runtime/adapters/claude-code/persistent/build-repl-argv.ts:150-153` maps the
empty surface to an empty tools argument.

### Decisions and scope

Use the existing composition fixture to capture the actual producer's output,
rather than duplicating a dispatch spec. Keep the simulator at the PTY boundary.
Copy every spawn argv so a later mutation of its input cannot erase evidence.
Retain the source-level prewarm check and update its comment to distinguish it
from the lifecycle test (`open/__tests__/project-build-wiring.test.ts:698-705`).
A repository-wide search for `behavioural gap|cannot establish that no` enumerated
the affected comment in this test file; the latter sentence stays because the
prewarm source check still cannot establish a runtime sequence.

This adds a regression instrument, not a new production outcome or invariant.
Existing eviction vocabulary remains `tool-surface mismatch` at `spawn.ts:1640`.
The instrument runs independently of the CLI or a worker succeeding. No product
decision changed, so SPEC.md is not amended. No production file is included in
the change. Do not infer acceptance 2 coverage: the build checkout started at
b7433ae7 (#1113). A current-tree search for `toolSurface|unreadable` in the acting
turn source/test and project-build source found the known unreadable controls
at `runtime/workers/claude-acting-turn.ts:39`, `:58`, but no toolSurface match.
This is not a statement about a freshly fetched main ref; network is unavailable.

### Mutation attempt — not verified

Command for both mutated and restored runs:

```sh
bun test open/__tests__/project-build-wiring.test.ts -t 'project dispatch reuses'
```

| Guard | Mutation and printed line | Mutated observation | Restored observation |
| --- | --- | --- | --- |
| Dispatch retains live tools and one child | `open/wiring/project-build.ts:243`: `spec: { tools: [], model_preference: [], metering_context: { project_id: context.projectId } }` | Exit 1 before spawn: reply sink cannot bind during the wake. **Not a valid mutation red.** | Printed `:243` restored to `tools: PROJECT_REPL_TOOL_DEFS`; exit 1 at the same bind failure. **Not green.** |

The mutation landed at the intended producer, but its effect was unreachable:
the first wake fails at `open/__tests__/project-build-wiring.test.ts:743`.
An independent minimal `Bun.serve` call with port zero also failed to bind.
No test was skipped, loosened, or replaced with a mock channel to obtain green.
Acceptance 3 remains unverified until the named mutation demonstrates a second
spawn with an empty tools argument and restoration passes in an environment
that permits local listeners.

### Validation

- `bun test open/__tests__/project-build-wiring.test.ts runtime/adapters/claude-code/persistent/__tests__/import-warm-session-reset.test.ts`: 23 passed, 5 failed. All five failures were reply-sink bind failures: the new test and four existing warm-import tests.
- `bash scripts/ci/lint.sh`: exit 0.
- `bash scripts/ci/typecheck-all.sh`: exit 0; all 51 configurations passed.
- `git diff --check`: exit 0.

### Deliberately excluded

No live CLI/model invocation, real worker launch, production fixes, full-suite
run, push, PR creation, or merge. The branch record is staged here per the lane
instructions for orchestrator review and publication. This is an unverified
instrument, not a claim that the requested red/green proof has been obtained.


### Mutation VERIFIED on the box (completing the record above)

The lane could not bind a local listener, so it correctly reported the mutation
as unverified rather than claiming a red it had not seen — and proved the cause
was environmental with an independent `Bun.serve` port-zero control. That
verification has now been performed where listeners are permitted.

One fixture gap was fixed first: the test was red on
`persistent-repl: model_preference is empty`. That is not the behaviour under
test — the conversation spec carries `model_preference: []` by design and
`runtime/workers/claude-in-repl.ts` overrides it with `[req.model_id]` on every
dispatch — so both turns now supply a model the way production does.

| Guard | Mutation and printed line | Mutated | Restored |
| --- | --- | --- | --- |
| Dispatch retains live tools and one child | `open/wiring/project-build.ts:243` → `spec: { tools: [], … }` | **RED**: `(fail) project dispatch reuses the wake REPL without a tools-less respawn`, alongside the two source-level guards | **24 pass, 0 fail** |

`import-warm-session-reset.test.ts` still passes (4 pass) after the recording
host was extracted to a shared helper.

**What this establishes and what it does not.** It establishes that a project
dispatch composed by `prepareProjectBuild` reuses the wake REPL and that no spawn
requests an empty tool surface — observed through a real persistent spawn, not a
fake runner. It does not exercise a live Claude binary; the recording host is a
PTY double, and a reply is not evidence that a model created a worker.
