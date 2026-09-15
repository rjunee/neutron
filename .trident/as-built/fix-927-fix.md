## 2026-09-15 — Remove scheduler deadlines from Bun PTY contract tests (#927)

### Change and evidence

Branch: `fix/927-fix`. The filed issue's original helper citation was correct at
`runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts:28`.
The lane explicitly requests this staging record location.

- The real child checks its three standard descriptors with `test -t`, exits with
  status 23, and the test awaits `child.exited` before checking status and liveness:
  `runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts:59`.
  A nonzero status detects a fabricated zero as well as a missing exit code.
- Terminal output, accumulation and line separation now exercise the host's data
  callback with explicit chunks:
  `runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts:73`,
  `runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts:84`,
  `runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts:98`.
- Submission checks the bytes handed to the terminal, including the carriage
  return, and preserves refusal after exit:
  `runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts:113`.
  The fixture captures writes, drives the registered callback, and settles cleanup
  through the existing injected process promise at
  `runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts:28`.

### Decisions and limits

The structural exemplar was read at
`trident/__tests__/cross-model-dispatch.test.ts:857`: its process-group assertion
is at line 908, with the zombie and FIFO traps documented at line 877.
Here the relevant structural facts are terminal descriptors, exit status, callback
chunk handling, and submitted bytes. The existing injection interface is at
`runtime/adapters/claude-code/persistent/bun-terminal-host.ts:235`.

The old output assertion followed process exit, while the host closes the terminal
in its exit handler (`runtime/adapters/claude-code/persistent/bun-terminal-host.ts:431`).
Replacing polling with an unbounded screen promise would leave lost output waiting
forever. The new callback checks fail synchronously on missing output; the finite
real child supplies its own exit. No fixture waits for the broken behavior to
release it. The test runner's existing timeout still bounds a genuinely stuck test;
this change does not claim immunity from the runner's own timeout.

Output and submit assertions now cover the adapter at the terminal seam, rather
than a live shell's echo/read loop. Real descriptor attachment, lifecycle and signal
checks remain (`runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts:59`,
`runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts:127`).
This does not establish Bun's delivery/drain behavior under child-exit races.
Production behavior, product decisions, and the existing outcome vocabulary were
not changed. Assertions use the existing `bun:test` failures; no production error,
state, invariant, flag, backend, or classification was added.

### Mutation evidence

Each row was run separately using `bun test
runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts
--test-name-pattern '<name>'`, then restored and rerun. All failures were named
assertion failures, with reported test durations of 1–4 ms, not timeouts or hangs.
Mutation sites below are in `runtime/adapters/claude-code/persistent/bun-terminal-host.ts`.

| Property / test name fragment | Mutation site and replacement | Mutated | Restored |
| --- | --- | --- | --- |
| `spawns on a real pty` / descriptors | :391 replace terminal attachment with ignored stdio | RED: 1 instead of 23 | GREEN |
| Same / pid | :461 `pid: 0` | RED: pid not positive | GREEN |
| Same / exit status | :456 `exitResolve(0)` | RED: 0 instead of 23 | GREEN |
| Same / exit state | :411 `exited = false` | RED: false instead of true | GREEN |
| `onScreen delivers terminal output` | :380 `opts.onScreen('')` | RED: missing text | GREEN |
| `onScreen delivers an ACCUMULATION` | :374 `const screen = text` | RED: missing first line | GREEN |
| `LINE STRUCTURE` | :374 strip newlines before accumulation | RED: joined lines | GREEN |
| `submitLine SUBMITS` / Enter | :506 omit Enter write | RED: missing carriage return | GREEN |
| Same / text | :505 omit command write | RED: missing command | GREEN |
| Same / refusal after exit | :496 `if (false)` | RED: resolved after exit | GREEN |

The mutation printer initially located the already-existing `exited = false`
initializer, rather than the replacement. That row was rerun with the replacement's
original offset: printed line 411, observed RED, restored, observed GREEN.

### Sibling survey (reported, not changed)

Enumeration: searched `runtime/` and `migrations/` test files with `rg` for
`deadline`, `Date.now`, `Promise.race`, and `until`; intersected with process/spawn
searches, then read the following hits. This is a syntax-based survey, not a claim
that indirect process creation elsewhere has been exhaustively enumerated.
All runtime paths in this table are relative to
`runtime/adapters/claude-code/persistent/__tests__/`.

| File | Real-process evidence | Deadline evidence |
| --- | --- | --- |
| `dev-channel-exit-on-close.test.ts` | :56 spawn | :34 stream marker deadline, :75 10-second budget, :83 exit race against 8 seconds |
| `ensure-claude-trust.test.ts` | :125 and :132 spawn competing seeds | :112 700-ms child overlap window; :128 3-second parent readiness window |
| `sink-restart-survival.test.ts` | :949 spawn racers | :899 15-second injected mutex; :979 15-second readiness barrier |
| `poison-eviction-live-work-guard.test.ts` | :116 spawn real sleep child | :244 2-second helper; :476 quarantine completion poll |
| `shutdown-sink.test.ts` | :27 spawn real sleep child | :59 1-second host-poll shutdown race (the waited event is host shutdown, not process exit) |
| `shutdown-timer-cancellation.test.ts` | :73 spawn in the awaited process helper | :88 lower lifetime bound, :99 and :109 upper lifetime bounds; adjacent timing family rather than polling |

False-positive examples: `repl-supervision.test.ts:97` constructs an injected child
and `repl-supervision.test.ts:244` polls its recorded spawn count;
`pty-host-conformance.test.ts:268` injects a process promise even though its helpers
at lines 54 and 64 poll deadlines. These should not be called real-process probes
merely because they use a method named `spawn`.

The migration search `rg -n 'Date.now|deadline|Promise.race|Bun.spawn' migrations
-g '*test.ts'` returned actual spawns as positive controls, including
`migrations/runner.test.ts:24`, whose helper returns `proc.exited` at line 31;
it returned no `deadline` or `Promise.race` matches. This is a search result about
those spellings, not proof that migrations cannot contain another timing pattern.

### Validation

- Changed suite only: **43 pass, 0 fail**, including after all mutations were restored.
- `bunx tsc --noEmit -p runtime/tsconfig.json`: **passed**.
- `bash scripts/ci/lint.sh`: **passed**.
- `git diff --check`: **passed**.
- `bash scripts/ci/typecheck-all.sh`: **50 of 51 projects passed**, including the
  root and runtime configs. `app/tsconfig.json` failed with TS2688:
  `Cannot find type definition file for '@types'`. An ambient dependency directory
  outside the build worktree contains a nested `@types` entry. Shared dependencies
  were left untouched; the full matrix is **not green**.
- `bash scripts/ci/leak-gate.sh --tree .`: **exit 3, incomplete**. Zero findings
  from executed rules; the private denylist rules could not run.
- The staging record has exactly one `## ` heading; restricted-text checks passed.

Positive-control searches: `rg -n 'deadline|until\(|terminalFixture'` on the changed
suite finds the fixture at line 28 and callers at lines 74, 85, 99, 114, with no
`until(` matches. A whole-tree source/Markdown search for the removed distinctive
header phrases together with `Lifecycle checks spawn real` found only the new
header at line 7. No additional copies required edits.

Deliberately left sibling suites and production code for separate changes; did
not run whole-directory tests, edit `trident/`, raise deadlines, alter spec decisions,
push, open a PR, or merge.
