## 2026-10-09 — Completed task-sequence trace decoder, validator and CLI fixture

Test-only change. It adds a synthetic task-sequence trace fixture under
`tests/fixtures/trident-sequence-trace/`. No production runtime code, dependency,
lockfile, package script, shared governance document or other fixture changed.

It is planned as a three-task `task_sequence`: T1 the structural decoder (this
record's first section), T2 the completed-sequence validator, and T3 the CLI plus
the consuming assertions in the build E2E crash test. T2 and T3 extend this shard
with their own sections.

### T1 decoder

- `tests/fixtures/trident-sequence-trace/decode.ts` — pure
  `decodeSequenceTrace(input: unknown)` (`decode.ts:90`) returning
  `{ ok: true, trace: { runId, taskCount, events } }` or `{ ok: false, reason }`
  (`TraceDecodeResult`, `decode.ts:43`). Exported types `SequenceEventKind`
  (`:29`), `SequenceEvent` (`:31`) and `SequenceTrace` (`:37`) are the surface T2
  and T3 consume. It imports nothing.
- Rules, first violation wins: input is a non-null, non-array object (`:56`);
  `runId` a nonempty string equal to its own trim, retained byte-for-byte (`:59`);
  `taskCount` a safe integer of at least two (`:63`); `events` an array, empty
  allowed (`:67`); then per event by zero-based index: a non-null, non-array
  object, sparse holes refused (`:72`); `task` a safe integer from one through
  `taskCount` (`:75`); `kind` exactly `continued` or `merged` (`:79`);
  `remainingTasks` a nonnegative safe integer (`:83`).
- STRUCTURE ONLY: merged-first, repeated, reordered, after-merge and
  remaining-vs-task-inconsistent traces all decode. Sequence order is the
  validator's job (T2).
- Each field is read once; extra properties are dropped. The output is built from
  fresh objects (`:85`), so the input is never mutated and the output never aliases
  it. A throwing getter or Proxy trap is caught and reported as
  `input could not be read` (`:93-94`). Reasons carry a field name or event index,
  never input bytes.
- `decode.test.ts` — 86 tests: exact accepts (two- and three-task traces, empty
  events, boundary values including `taskCount = Number.MAX_SAFE_INTEGER`),
  structure-not-order pins, extra-property dropping, every refusal with its exact
  reason, first-violation ordering, a no-echo sentinel check against a fixed
  reason grammar, never-throws cases, and immutability and freshness.

Validation measured for T1:

- `bun test tests/fixtures/trident-sequence-trace/decode.test.ts`: 86 pass, 0 fail.
- `bunx tsc -p tsconfig.json --noEmit`: clean. `bunx tsc -p trident/tsconfig.json
  --noEmit`: clean.
- `bash scripts/ci/typecheck-all.sh`: 50 of 51 tsconfigs pass. The one failure is
  `app/tsconfig.json`, reporting an unused `@ts-expect-error` in
  `app/__tests__/support/mount.tsx:17`. That is outside this diff and outside the
  root include scope this fixture is checked under.
- `bunx eslint tests/fixtures/trident-sequence-trace/` and `git diff --check`:
  clean.
- Hand semantic mutants of `decode.ts`, each typechecked clean under strict `tsc`
  and restored byte-identical afterwards (sha256 verified):
  - M1, task lower bound `< 1` to `< 0`: 2 tests fail.
  - M2, taskCount minimum `< 2` to `< 1`: 2 tests fail.
  - M3, kind accepts any string: 6 tests fail.
  - M4, output reuses the input event object: 5 tests fail.
- The full suite is deferred for this intermediate task. The terminal task runs it
  over the cumulative branch.

### T2 validator

- `tests/fixtures/trident-sequence-trace/validate.ts` — pure
  `validateCompletedSequence(trace: SequenceTrace)` (`validate.ts:69`) consuming
  T1's decoded `SequenceTrace` through a type-only import from `./decode.ts`
  (`:31`). It returns the `SequenceValidation` union (`:33`):
  `{ status: 'accepted', runId, taskCount }`,
  `{ status: 'incomplete', runId, taskCount, completedTasks, nextTask }` or
  `{ status: 'rejected', reason }`. The card brief names only the three statuses
  and no export or field names, so the prepared contract was kept unchanged.
- For N = `taskCount`, event i (task k = i + 1) must be
  `{ task: k, kind: 'continued', remainingTasks: N - k }` for k < N and
  `{ task: N, kind: 'merged', remainingTasks: 0 }` for k = N. All N events give
  `accepted` (`:65`). A proper prefix of 0 to N - 1 events, empty included, gives
  `incomplete` with `completedTasks` = length and `nextTask` = length + 1 (`:66`).
  Anything else is `rejected`.
- Rules per event, first violation wins: an event at index N or later is
  `follows the merge` (`:54`); a task other than index + 1 is
  `task is not the next task`, covering repeats, skips, reordering and a start
  past task one (`:57`); a final task that did not merge (`:59`) or a non-final
  task that merged (`:60`); `remainingTasks` other than N - k (`:61-63`).
- It never throws: a throwing getter or Proxy trap is reported as
  `trace could not be read` (`:72-73`). Reasons carry a zero-based event index
  only, never input bytes. Results are fresh objects and the trace is only read.
- `validate.test.ts` — 41 tests, all fixtures built through the real
  `decodeSequenceTrace`: exact accepts for N = 2, 3 and 5 plus the literal
  2/1/0 three-task trace with `runId` kept byte-for-byte; every proper prefix for
  N = 2, 3 and 5 as `incomplete`, plus an empty trace at
  `Number.MAX_SAFE_INTEGER`; 14 rejection rows with exact reasons (merged first or
  mid-sequence, repeat, skip, reorder, start at task two, final task continued,
  remaining off by one in each direction, a mid-task zero, a merge with work
  remaining, one and two events after the merge); the decoder's structure-only
  traces all rejected; first-violation ordering; a no-echo sentinel check against
  a fixed reason grammar; unreadable getter and Proxy traces; and purity
  (deep-frozen input, unchanged input, equal but distinct results).

Validation measured for T2:

- `bun test tests/fixtures/trident-sequence-trace/validate.test.ts
  tests/fixtures/trident-sequence-trace/decode.test.ts`: 127 pass, 0 fail
  (41 validator, 86 decoder unchanged).
- `bunx tsc -p tsconfig.json --noEmit`: clean. `bunx tsc -p trident/tsconfig.json
  --noEmit`: clean.
- `bash scripts/ci/typecheck-all.sh`: 50 of 51 tsconfigs pass, including
  `open/tsconfig.json`. The one failure is unchanged from T1: `app/tsconfig.json`,
  the unused `@ts-expect-error` at `app/__tests__/support/mount.tsx:17`, outside
  this diff.
- `bunx eslint tests/fixtures/trident-sequence-trace/` and `git diff --check`:
  clean.
- Hand semantic mutants of `validate.ts`, each typechecked clean under the strict
  base config, then `validate.test.ts` run, then the file restored byte-identical
  (sha256 `2f245c01…` verified). A positive control that adds a type error made
  that typecheck exit 2, so a clean typecheck is a real signal.
  - M1, `remainingTasks` check deleted: 7 tests fail.
  - M2, `final task did not merge` check deleted: 2 tests fail.
  - M3, accept on `length > 0` instead of `length === taskCount`, so a prefix is
    accepted: 8 tests fail.
  - M4, task check `!==` to `>`, so repeats pass: 1 test fails.
  - M5, after-merge `index >= taskCount` check deleted: 3 tests fail.
  - M6, premature merge permitted (`merged before the final task` check deleted):
    3 tests fail.
  - M7, a legitimate completed trace refused (the accept branch returns a
    rejection): 7 tests fail.
- The full suite is deferred for this intermediate task. The terminal task runs it
  over the cumulative branch.

T2 revalidation (run b2fb8978): T1 and T2 came onto this run's branch by a
fast-forward merge of the published PR #1475 head `c24a8c24`, not by a rebuild;
`c24a8c24` is an ancestor of the branch head. The branch diff against main
`5195c246` lists only the four fixture files, this shard and the run-owned ledger.
Measured again on that head:

- `bun test tests/fixtures/trident-sequence-trace/validate.test.ts`: 41 pass,
  0 fail. `bun test tests/fixtures/trident-sequence-trace/decode.test.ts`: 86 pass,
  0 fail.
- `bunx tsc -p tsconfig.json --noEmit` and `bunx tsc -p trident/tsconfig.json
  --noEmit`: clean.
- `bash scripts/ci/typecheck-all.sh`: 50 of 51 pass, including
  `open/tsconfig.json`. The one failure is the same `app/tsconfig.json` unused
  `@ts-expect-error` at `app/__tests__/support/mount.tsx:17`, outside this diff.
- `bunx eslint tests/fixtures/trident-sequence-trace/` and
  `git diff --check 5195c246..HEAD`: clean.
- M6 (the `merged before the final task` check deleted, so a premature merge
  passes): strict `tsc` clean, 3 of 41 tests fail. M7 (the accept branch returns a
  rejection, so a legitimate completed trace is refused): strict `tsc` clean, 7 of
  41 tests fail. After each, `validate.ts` was restored and
  `git diff --exit-code` was clean (sha256 `2f245c01…` before and after).
- The full suite remains deferred to the terminal task (T3).

### T3 CLI and E2E consumer

T3 was built in run b2fb8978 as the terminal task of the run's own
`task_sequence` (host-selected `topTask` T3, `remainingTasks` 0). `decode.ts`,
`decode.test.ts` and `validate.ts` are unchanged (`validate.ts` sha256
`2f245c01…` before and after every mutation below).

- `tests/fixtures/trident-sequence-trace/cli.ts` — `bun cli.ts <trace.json>`.
  Exactly one argument, else `usage: bun cli.ts <trace.json>` and exit 2
  (`cli.ts:27`). Unreadable file: `cannot read input file`, exit 1 (`:32`).
  Invalid JSON: `input is not valid JSON`, exit 1 (`:38`). A decoder refusal
  writes one stderr line `trace: <reason>` and exits 1 (`:41`); decoder reasons
  carry a field name or event index only, so no input bytes are echoed. A decoded
  trace prints exactly one `JSON.stringify(SequenceValidation)` line (`:43`) and
  exits 0 only for `accepted`; `incomplete` and `rejected` print their result
  line with empty stderr and exit 1 (`:44`). Imports only `node:fs/promises`,
  `./decode.ts` and `./validate.ts`.
- `tests/fixtures/trident-sequence-trace/cli.test.ts` — 26 tests that spawn the
  real CLI (`Bun.spawn([process.execPath, cli, …])`, per-test temp dir) and never
  import the decoder or validator: accepted three- and two-task traces (exact
  stdout, one line, exit 0); a one-of-three prefix and an empty event list
  (`incomplete`, exit 1, empty stderr); every proper prefix of a legitimate trace
  exits nonzero; six rejections with the validator's exact reasons (premature
  merge, repeated task, skipped task, event after the merge, `remainingTasks`
  mismatch, final task continued); a sentinel `runId` on a rejected trace is never
  echoed; refusals (no argument and two arguments exit 2; nonexistent path,
  malformed JSON and eight decoder refusals exit 1) each have empty stdout and one
  sentinel-free stderr line; a refusal is distinguishable from a rejection; the
  input file is unchanged after a passing and a failing run.
- `open/__tests__/project-build-e2e.test.ts` — two imports (`:92`, `:94`) with the
  same `import/no-relative-packages` suppression as the ledger-delta imports.
  Inside the existing `same-run task-sequence crash ${boundary} in ${mergeMode}
  cannot publish unfinished tasks` test only, after the existing recovery
  assertions and before the terminal run (`:7575`–`:7604`): an explicit
  outcome-kind map that throws on any kind outside `continued`/`merged`
  (`:7580`); the recovery outcome is required to be `continued` before an event
  is built (`:7587`); the trace uses the fixture run id, the accepted plan's task
  count, the ledger delta's completed task (cross-checked against the selected
  task identity) and the recovery outcome's own `remainingTasks`; the validator
  must report `incomplete` with `completedTasks` 1 and `nextTask` 2 (`:7598`); the
  observed event re-kinded `merged` must be rejected as `event 0: merged before
  the final task` (`:7604`). After the existing terminal assertions
  (`:7616`–`:7633`): task two is the selected task's position in the accepted plan
  (asserted one after task one), the terminal durable built checkpoint is the last
  `built`, head-bearing, non-pending checkpoint in `build-mode-state` stage-event
  history, its head differs from the interrupted one and its remainder is
  independently asserted zero (`:7624`); the trace extended with the terminal
  outcome's kind is `accepted` (`:7629`); the observed completed trace reversed is
  rejected as `event 0: task is not the next task` (`:7633`). Every existing
  assertion, the host setup, the interruption injection and the zero-conflict
  early return are unchanged; the zero-conflict cases get no trace.

Validation measured for T3:

- `bun test tests/fixtures/trident-sequence-trace/`: 153 pass, 0 fail across 3
  files (26 CLI, 41 validator, 86 decoder).
- `bun test open/__tests__/project-build-e2e.test.ts -t 'same-run task-sequence
  crash'`: 10 pass, 0 fail (8 non-zero-conflict, 2 zero-conflict). Subset
  evidence only, not a full-suite pass.
- Consumer positive controls on `validate.ts`, each followed by the same `-t`
  command and a byte-identical restore (sha256 `2f245c01…`):
  prefix accepted (`length === taskCount` to `length > 0`): 8 fail, 2 pass, every
  failure at the `incomplete` assertion (`:7598`); the `merged before the final
  task` check deleted: 8 fail, 2 pass, every failure at the premature-merge
  assertion (`:7604`). The two zero-conflict cases stay green, as they build no
  trace.
- CLI hand mutants, each failing `cli.test.ts` then restored (sha256 of `cli.ts`
  identical before and after): C1 unconditional exit 0: 11 fail; C2 decoder
  refusal written to stdout: 9 fail; C3 `incomplete` exits 0: 3 fail.
- `bunx tsc -p tsconfig.json --noEmit`, `bunx tsc -p trident/tsconfig.json
  --noEmit` and `bunx tsc -p open/tsconfig.json --noEmit`: clean. Positive
  control: a type error injected into the new E2E lines made the `open` check
  exit 2.
- `bash scripts/ci/typecheck-all.sh`: 50 of 51 pass, including
  `open/tsconfig.json`. The one failure is `app/tsconfig.json` at
  `app/__tests__/support/mount.tsx:17` (unused `@ts-expect-error`); it reproduces
  identically with this task's changes stashed, so it is pre-existing.
- `bash scripts/ci/lint.sh`: exit 0, every gate 0 found. `bunx eslint` on the
  three changed code files through `scripts/ci/lint-filter.mjs`: 0; positive
  control, one new suppression removed: 1. `git diff --check`: clean.
- The full suite (`bash scripts/run-tests.sh`) is host-owned for this task and
  was not run by the builder.

### Evidence boundary

All trace data here is synthetic. This fixture proves only that the decoder, the
validator and the CLI handle that data as described, and that the build E2E crash
test's own host observations validate as an incomplete then accepted two-task
trace. It proves no live `task_sequence` selection, host handoff, review,
publication or merge, and no provider usage or savings.
