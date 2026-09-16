## 2026-09-16 — Bound dispatch acceptance without shortening worker observation

### Change and evidence

The inherited branch shortened `composeActingTurn.timeout_ms`, but that value
bounds trailer observation. Restored its full remaining wall at
`runtime/workers/claude-in-repl.ts:75`; replaced the incorrect tests that asserted
a short observation budget with integration cases through the real acting turn.
No branch reset or history rewrite was performed.

`runtime/workers/claude-acting-turn.ts:82` starts a 35,000ms acceptance deadline
after acknowledged submission, capped by the original wall. The host polls the
trailer first (`:86`), then metadata (`:92`). Exact creation evidence latches
acceptance; a late trailer retains the original deadline (`:65`, `:96`). Without
either signal, the result remains `unknown`, with a distinct detail (`:93-94`).
The existing interrupted-observation detail remains at
`runtime/workers/claude-in-repl.ts:97`.

A local recursive measurement enumerated 9,191 `agent-*.meta.json` files. Its
positive control found `agent-a84e6dbb0d06c04fb.meta.json`, with description
`build: 5a69ae54-6695-407f-b9ba-af209c37317b:task:0:build:0`; the same scan found
zero build descriptions containing `fcf12cc7`. Observed layout:
`<projects>/<encoded-cwd>/<session>/subagents/agent-<id>.meta.json`.
The opaque agent ID cannot be predicted, but the description is the exact
role/step pair dispatched at `runtime/workers/claude-in-repl.ts:54`.
The probe enumerates only the bound session and matches filename plus description
(`runtime/workers/claude-acting-turn.ts:30-50`). Partial/unreadable metadata does
not establish acceptance. This measurement does not claim that all possible
storage roots were enumerated.

Launch configuration supplies the transcript root at
`open/wiring/project-build.ts:249`. The existing resolver honors explicit projects
roots and isolated Claude configuration (`runtime/adapters/claude-code/persistent/signatures.ts:547`).
The session path convention is read at
`runtime/adapters/claude-code/persistent/jsonl-resumability.ts:66-72`.

### Decisions and vocabulary

Use the filed 35-second bound, replacing the inherited three-minute proposal.
The deadline belongs after `submitLine`, inside trailer observation, rather than
around the entire acting turn. Host polling and its existing outer wall timer
maintain the bound; neither requires a response from the failing model
(`runtime/workers/claude-acting-turn.ts:82-108`).

Creation is not current liveness. The new metadata probe directly establishes
creation; it does not call or misrepresent the `unknown` liveness stub at
`runtime/workers/project-runners.ts:148`. A disappeared metadata file cannot
revoke previously observed creation (`claude-acting-turn.ts:92`).

The result joins the existing `BoundedWorkOutcome.unknown` vocabulary
(`runtime/bounded-work.ts:103-109`), not a new error class.
`runtime/workers/project-runners.ts:138-146` preserves its detail; the existing
consumer explicitly stops with unknown at `trident/build-run.ts:339-343`, rather
than falling into the failed/refused branches.

### Acceptance and mutation evidence

`runtime/workers/claude-acting-turn.test.ts:309-370` uses an injected logical
observation clock, real metadata/trailer files, and the real project runner.
It asserts late valid trailer completion at logical 50,000ms, no acceptance at
35,000ms, accepted/no-trailer observation through the full offered wall, the
unchanged throw detail, and trailer completion without metadata. The valid
metadata is deleted after observation to prove acceptance remains latched.
Wrong-step, wrong-filename, wrong-session and malformed rows are decoys.

Each following mutation was applied separately, its actual changed source line
printed, and the five acceptance cases run with
`bun test runtime/workers/claude-acting-turn.test.ts --test-name-pattern 'dispatch evidence:'`.
All eleven were RED; restoring the implementation made all five GREEN.

| Guard / source line | Mutation | Mutated / restored |
| --- | --- | --- |
| Acting turn :82 | Dispatch deadline becomes whole wall | RED / GREEN |
| Acting turn :93 | Remove accepted exemption | RED / GREEN |
| Acting turn :92 | Suppress creation proof | RED / GREEN |
| Acting turn :92 | Replace latched acceptance with each fresh probe | RED / GREEN |
| Acting turn :36 | Accept any string description | RED / GREEN |
| Acting turn :33 | Remove filename filter | RED / GREEN |
| Acting turn :50 | Observe the decoy session | RED / GREEN |
| Acting turn :65 | Cap trailer deadline at dispatch bound | RED / GREEN |
| Acting turn :94 | Return refused instead of unknown | RED / GREEN |
| Acting turn :94 | Reuse interrupted detail for unaccepted dispatch | RED / GREEN |
| In-REPL runner :97 | Reuse unaccepted detail for thrown observation | RED / GREEN |

An initial inner-outcome mutation remained green because the project wrapper
normalizes non-completion observations (`project-runners.ts:138`). Its execution
was reachable, but the wrapper hid the changed kind. Added a direct acting-turn
outcome assertion (`claude-acting-turn.test.ts:358`) and reran successfully.

### Validation and scope

`bun run typecheck` reports that no such script exists. Equivalent direct
`bunx tsc --noEmit -p runtime/tsconfig.json` and `-p open/tsconfig.json` passed.
`bash scripts/ci/lint.sh` passed, including its wall-clock assertion gate.
Scoped worker, project-runner, Open wiring and Open end-to-end tests passed:
137 tests across five files, zero failures, 675 assertions.

Searched the whole working tree for the removed dispatch-budget commentary and
`dispatch_timeout_ms`, with `DISPATCH_TIMEOUT_MS` as a positive control; only the
new constant and its references matched. No elapsed-time assertions were added.
No SPEC product decision changed. Did not add retries, worker cancellation,
current-liveness claims, feature flags, or a second dispatch path. Mutex and
submission waits keep their existing wall/cancellation behavior. No network
access, push, PR creation, merge, or full-suite test run was attempted.

This record uses the explicitly requested lane staging location rather than the
default permanent shard location; the orchestrator owns publication.
