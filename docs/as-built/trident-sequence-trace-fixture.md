## 2026-09-28 — Reusable sequence-trace fixture consumed by the production build E2E tests

Test-only change, built as a three-task sequence (T1 decoder, T2 validator, T3 CLI
plus E2E consumer plus this shard). It adds a reusable sequence-trace decoder,
validator and CLI under `tests/fixtures/trident-sequence-trace/`, and makes the
parameterized same-run task-sequence crash test in
`open/__tests__/project-build-e2e.test.ts` consume the validator. No production
runtime code, dependency, lockfile, package script, shared governance document or
other fixture changed.

### What was added

- `tests/fixtures/trident-sequence-trace/decode.ts` — pure
  `decodeSequenceTrace(input: unknown)` returning a typed
  `{ ok: true, trace } | { ok: false, error }`. It validates STRUCTURE only: an
  object `{ runId, taskCount, events }` with `runId` a nonempty string without
  surrounding whitespace, `taskCount` a safe integer of at least 2, and `events`
  an array of `{ task, kind, remainingTasks }` where `task` is a safe integer from
  1 through `taskCount`, `kind` is `continued` or `merged`, and `remainingTasks` is
  a nonnegative safe integer. Extra properties are ignored; the input is only
  read and the result shares no references with it. Diagnostics name the event
  index and the violated rule, never an input value. Order is not judged here.
- `tests/fixtures/trident-sequence-trace/validate.ts` — pure
  `validateSequenceTrace(trace)` over the decoded type, returning `accepted`,
  `incomplete` or `rejected`. A completed trace for `taskCount` n is one event per
  task in order: `continued` for tasks 1 through n - 1 with
  `remainingTasks === n - task`, then `merged` at task n with zero remaining.
  Exactly that trace is `accepted`; any proper valid prefix (including no events)
  is `incomplete`; the first violation (premature merge, wrong remaining count,
  skipped, repeated or reordered task, `continued` in the merge position, any
  event after the merge) is `rejected`. It never throws.
- `tests/fixtures/trident-sequence-trace/cli.ts` — Bun CLI,
  `bun tests/fixtures/trident-sequence-trace/cli.ts <trace.json>`. A structurally
  valid trace prints exactly one line
  `{"runId":…,"taskCount":…,"events":<count>,"verdict":…}` to stdout; exit 0 only
  for `accepted`, exit 1 for `incomplete` and `rejected` (result line still
  printed, stderr empty). Wrong argument count exits 2; an unreadable file,
  invalid JSON or a decoder refusal exits 1 with one concise stderr line and
  nothing on stdout. Diagnostics never echo input bytes; `runId` is copied from
  the input into the result line only. No network, repository, database or
  environment access; the input file is only read.
- `decode.test.ts`, `validate.test.ts` and `cli.test.ts` — structure rules and
  immutability; two- and three-task positives, proper prefixes and each rejection;
  and a spawned CLI child observed only through exit status, stdout and stderr
  (accepted two- and three-task, incomplete prefix and empty, rejected premature
  merge, events after merge and wrong count, refusals for no argument, two
  arguments, a missing path, malformed JSON and six decoder refusals, each
  asserting a sentinel value never reaches stderr, and input bytes unchanged
  after an accepted and a refused run). `cli.test.ts` never imports the decoder
  or validator.

### Production E2E consumption

Test: `same-run task-sequence crash ${boundary} in ${mergeMode} cannot publish
unfinished tasks` (five boundaries times two merge modes). Every pre-existing
statement is unchanged: the fixture options, the checkpoint/commit interruption
injection, the first build run and its assertions, the zero-conflict stage-event
rewrite and its early `return`, the second-death path, the resume run, the
dispatch, ledger, budget and `main:NOTES.md` checks, and the terminal run's
`merged`, planner-choice, selected-task, dispatch and `gh` assertions. The
existing `selectedTasks` assertion remains the independent task-identity check.

- A file-level helper `sequenceEventKind` beside `lastCheckpoint` maps an observed
  outcome kind to a trace kind and THROWS for anything but `continued`/`merged`,
  so unknown, blocked or failed outcomes are never coerced.
- After the last recovery assertion: the recovery outcome is asserted `continued`
  and narrowed; task one's event takes its observed kind and its actual
  `remainingTasks`; the trace uses the fixture run id and `taskCount` 2 (a literal
  matching the fixture's two-line plan); the validator must say `incomplete`. The
  stage-event count is captured here.
- After the terminal assertions: the terminal durable built checkpoint is read
  from the stage events the terminal run appended (`build-mode-state`, stage
  `built`, a string head, no pending); its remainder is independently asserted to
  be 0 (`trident/build-run.ts:780` stamps the plan's remainder on that
  checkpoint). Task two takes the observed terminal outcome kind and that
  remainder; the completed trace must be `accepted`, and a derivative that
  replaces task one's observation with `merged` must be `rejected`.
- The zero-conflict pair gets no trace assertions and no manufactured result; it
  still exits through its original early return.

The two new import lines from `open/__tests__/` into `tests/fixtures/` each carry
the same inline `import/no-relative-packages` suppression already used for the
usage-coverage fixture: `tests/` is root test-support with no workspace specifier.

### Validation this session (T3)

- `bun test tests/fixtures/trident-sequence-trace`: 116 pass, 0 fail (98 from T1
  and T2 plus 18 CLI cases).
- `bun test open/__tests__/project-build-e2e.test.ts -t "same-run task-sequence crash"`:
  10 pass, 0 fail.
- Positive control on the derivative: with its expectation temporarily flipped to
  `accepted`, the same filter gave 8 fail, 2 pass (the two zero-conflict cases,
  which return before the trace); restored byte-identical by `cmp`, not committed.
- `bun test open/__tests__/project-build-e2e.test.ts` (whole file): 397 pass, 0 fail.
- `bunx tsc -p tsconfig.json --noEmit` and `bunx tsc -p trident/tsconfig.json --noEmit`:
  both clean.
- `bash scripts/ci/typecheck-all.sh`: TYPECHECK MATRIX: ALL PASS, 51 tsconfigs.
- `bash scripts/ci/lint.sh`: exit 0. `console-ban-check`, `void-promise-check`,
  `type-query-check` and `wall-clock-bound-check`: 0 found each.
- `bun scripts/ci/check-governed-repo-attributes.ts .`: OK (outside Actions the
  shard guard reported nothing to guard; it was re-run with explicit base and head
  after committing, see below).
- `bash scripts/ci/leak-gate.sh --tree .` on the whole worktree: FAIL with 452
  findings, none in this change's files: they are pre-existing matches of the local
  owner denylist across the tree plus the worktree's own `.git` pointer file.
  The same gate run over a scratch tree holding only the three new files and the
  E2E file's added lines reported a single finding, the scratch tree's missing
  `LICENSE`; no vocabulary, denylist or structural finding.
- The complete terminal suite is host-owned for this build (host test scope) and
  was not run here; its result belongs to host review, not to this record.

### Semantic mutations (T2, recorded in the T2 commit)

Both mutants are valid programs (root `tsc` clean under each); each was restored
byte-identical by `cmp`, after which `bun test tests/fixtures/trident-sequence-trace`
gave 98 pass, 0 fail.

| Mutation of `validate.ts` | Result |
|---|---|
| M1 "premature merge permitted": `isExpectedEvent` returns true for any merged event with remainingTasks 0 at any position | 6 red: rejected: premature merge at task one of two; rejected: premature merge at task two of three; rejected: skipped middle task; rejected: a short trace with an invalid prefix is rejected, not incomplete; composition premature merge row; deep-frozen rejected trace |
| M2 "legitimate completed trace refused": final verdict always `incomplete` (never `accepted`) | 5 red: two-task completed trace is accepted; three-task completed trace is accepted; a decoded raw two-task completed trace is accepted; deep-frozen accepted trace; mutable trace not frozen or modified |

### Evidence boundary

Every unit and E2E datum here is synthetic. The E2E use is a consumer of local
host outcomes inside a fixture, not authentication of a live run. It does not
establish the live criteria in
`docs/spec-items/same-run-task-sequence-crash-handoff.md:96-101`,
`docs/spec-items/trident-build-efficiency.md:247-258` or the delivery rule at
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:291-295`: there is no
served-revision run, no attributable provider usage, no savings and no live
concurrency evidence here. Those criteria stay open.
