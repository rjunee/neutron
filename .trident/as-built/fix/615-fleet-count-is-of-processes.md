## 2026-09-14 — Enumerate the local build fleet from processes

### Change and evidence

Issue #615. The former phase-row counter is replaced by a process census:
`trident/active-runs.ts:41` now consumes the helper, and
`trident/lane-processes.py:161` enumerates the local same-user process table.
Each claim counts once; every confirmed process remains in its lane inventory
(`trident/lane-processes.py:201`). Unclaimed Codex shell wrappers are included
(`trident/lane-processes.py:192`). Zombies and exited pidfds are excluded
(`trident/lane-processes.py:187`, `trident/lane-processes.py:199`). A dead owner
cannot hide surviving children: owner status is metadata, not an inclusion gate
(`trident/lane-processes.py:203`).

`/code fleet` parses and executes at `trident/code-command.ts:81` and
`trident/code-command.ts:203`. Its response includes process start times, PIDs,
working directories, matching run/PR metadata and explicitly unavailable cost
(`trident/active-runs.ts:48`). Unknown joins the existing `backend_error`
vocabulary (`trident/code-command.ts:45`); the gateway forwards both text and
error unchanged (`gateway/boot-chat-command-filters.ts:176`). Metadata failure
is reported separately from process uncertainty (`trident/active-runs.ts:62`).

The sole production count caller was enumerated before editing with
`rg -n 'countActiveBuildRuns|resolve_active_runs|active_runs ===|active_runs:' --glob '*.ts'`.
The definition and composer were positive controls. The caller is now
`gateway/composition/build-core-modules.ts:790`. The consumer adds the build
about to launch to its budget, because it is not a live process yet
(`trident/orchestrator.ts:4594`). Zero therefore budgets one launching slot;
unknown throws into the existing planned-fan-out fallback
(`trident/orchestrator.ts:4595`). The arithmetic retains its planned floor
(`trident/test-strategy.ts:424`). This fallback is a budget assumption, not a
successful census result.

Every request and launch reprobes the kernel; no cached row or heartbeat needs
cooperation from the failed build (`trident/active-runs.ts:20`,
`trident/active-runs.ts:42`). This is a snapshot, not an ongoing reservation.

### Decisions and scope

Count lanes by claims, not their descendant shell/test process count, while
listing all PIDs. Include surviving orphan children and unmatched lanes. Match
PR metadata by the checkpoint run ID published in the process environment
(`trident/lane-processes.py:196`, `trident/active-runs.ts:56`). Missing matches
remain explicitly unknown. No new stored state or dual counting path.

The former tests asserting stale phase rows should count were incorrect for this
issue and were replaced with process-backed acceptance. Real four-live then
zero-dead evidence is in `trident/lane-processes-test.py:321`; the final pidfd
race fixture keeps later reads reachable so an earlier missing-file exit cannot
mask the guard (`trident/lane-processes-test.py:357`). An initial fixture race was
fixed by waiting for child readiness (`trident/lane-processes-test.py:312`).

Searched the tree for the distinctive old counter prose using
`rg -n 'runs somewhere in their build lifetime|ONLY THE BUILD PHASES COUNT|known over-count|active-lane budget|Local Linux build census'`.
The new census header was the positive control. Corrected the checkpoint budget
claim (`trident/checkpoint.sh:695`), historical reader list
(`trident/checkpoint-phase.ts:21`), composer comments and resolver contract
(`trident/orchestrator.ts:253`). Acceptance lives in
`docs/spec-items/build-fleet-process-census.md:19`; its index was regenerated.

### Mutation evidence

Each mutation below was applied alone, its actual changed line printed, the
specific test run RED, then the original restored and the same test GREEN.
Python cases run `python3 -B trident/lane-processes-test.py Census`; TypeScript
cases run `bun test trident/active-runs.test.ts`.

| Guard / computation | Actual mutated line | Mutation | Result | Restored |
|---|---|---|---|---|
| Final pidfd check | trident/lane-processes.py:199 | condition false | RED | GREEN |
| Zombie exclusion | trident/lane-processes.py:187 | condition false | RED | GREEN |
| User scope | trident/lane-processes.py:183 | skip all processes | RED | GREEN |
| Claim/wrapper selection | trident/lane-processes.py:193 | condition false | RED | GREEN |
| Wrapper recognition | trident/lane-processes.py:192 | wrapper false | RED | GREEN |
| Unreadable evidence | trident/lane-processes.py:210 | discard error | RED | GREEN |
| Unavailable process table | trident/lane-processes.py:176 | report known | RED | GREEN |
| Disappeared process | trident/lane-processes.py:208 | report error | RED | GREEN |
| Helper exit failure | trident/active-runs.ts:29 | condition false | RED | GREEN |
| Response validation | trident/active-runs.ts:31 | condition false | RED | GREEN |
| Unknown count refusal | trident/active-runs.ts:43 | condition false | RED | GREEN |
| Live count | trident/active-runs.ts:44 | return zero | RED | GREEN |
| Unknown display | trident/active-runs.ts:50 | always show known | RED | GREEN |
| Unknown classification | trident/active-runs.ts:67 | omit error | RED | GREEN |
| Metadata classification | trident/active-runs.ts:64 | return malformed | RED | GREEN |
| Launch budget slot | trident/orchestrator.ts:4594 | remove plus one | RED | GREEN |

The last row runs `bun test trident/orchestrator.test.ts --test-name-pattern 'process census budget'`;
its zero/four/eight cases assert the rendered count and divisor
(`trident/orchestrator.test.ts:6891`).

### Validation and deliberate exclusions

Validation: `bash scripts/ci/typecheck-all.sh` passed all 51 configurations;
`bunx tsc -p trident/tsconfig.json --noEmit` passed again after the consumer change.
`bash scripts/ci/lint.sh` passed. The targeted six-file run passed 127 tests:
`trident/active-runs.test.ts`, `trident/lane-processes.test.ts`,
`trident/code-command.test.ts`, `gateway/__tests__/trident-active-runs-wiring.test.ts`,
`trident/checkpoint-phase.test.ts`, `scripts/__tests__/spec-items-index.test.ts`.
The separately run `trident/orchestrator.test.ts` passed all 283 tests.
`git diff --check` passed. The leak gate reported zero findings but exit 3,
INCOMPLETE, because its private PII denylist was unavailable; this is not a clean
leak-gate result. No full test suite was run.

Review-lane corrections (2026-09-14). The launch-budget consumer gated on
`n >= 1`, so a census result of ZERO — a legitimate answer, since the census
counts the builds already running and the one launching is not among them —
was routed to the same default as a census FAILURE. It landed on the same
number today only because `computeTestJobs` takes `max(DEFAULT_BUILD_FANOUT,
active)`. The gate is now `n >= 0` (`trident/orchestrator.ts:4601`), which also
makes the zero arm of `process census budget` non-vacuous: with `n >= 1`,
removing the `+ 1` reddened only the four- and eight-lane arms; with `n >= 0` it
reddens the zero arm first. The `does not count stale rows` case had a decorative
store that was never passed to anything; it now drives `describeBuildFleet` with
that store so the seven stale rows are genuinely reachable and genuinely ignored
(`trident/active-runs.test.ts:29`). `/code fleet` moved from above the help
title into the cheatsheet's bullet list (`trident/code-command.ts:361`).

Cost accounting remains #554. Scope excludes remote machines, other users and arbitrary unmarked
agent sessions. No process is signalled by the census. No push, PR or merge was
performed. This branch shard location follows the build-lane instruction.
