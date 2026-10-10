## 2026-09-29 — Reusable accepted-child overlap fixture

Test-only change. It adds a reusable validator and CLI under
`tests/fixtures/trident-child-overlap/` that decide whether two accepted children
ran concurrently and report the input-token coverage of the pair. No production
runtime code, dependency, lockfile, package script, shared document, existing
fixture or existing test (including `open/__tests__/project-build-e2e.test.ts`)
changed.

### What was added

- `tests/fixtures/trident-child-overlap/check.ts` — pure
  `checkChildOverlap(input: unknown)` (`check.ts:73`). It accepts an array of
  exactly two `{ childId, acceptedAt, finishedAt, inputTokens }` records and
  returns `{ overlap, overlapDuration, knownInputTokens, unknownChildren, complete }`.
  - Every required key must be an own property and no other own key may exist
    (`check.ts:54-59`); a key present with value `undefined` is malformed, not
    missing.
  - `childId` is a nonempty string with no surrounding whitespace; identity is
    exact string equality and a duplicate is refused (`check.ts:79`).
  - Timestamps are nonnegative safe integers with `acceptedAt < finishedAt`
    strictly, so reversed and empty intervals are refused (`check.ts:64-66`).
  - `inputTokens` is `null` or a nonnegative safe integer (`check.ts:67`);
    numeric strings, booleans, negative, fractional, nonfinite and unsafe numbers
    are refused.
  - Error contract: validation failure throws — `TypeError` for every shape or
    value rule, `RangeError` when the summed known counts leave the safe integer
    range (`check.ts:97`). Messages name the record index and rule, never a value.
  - The caller's array and records are only read; a fresh result object is
    returned per call.
- `tests/fixtures/trident-child-overlap/cli.ts` — Bun CLI taking exactly one JSON
  file path. A structurally valid input prints exactly one JSON result line and
  exits 0 when the intervals overlap (unknown counts included) or 3 when they do
  not (`cli.ts:47-48`). A usage error exits 2 (`cli.ts:27`); an unreadable file,
  invalid JSON or validator refusal exits 1 with one concise stderr line and
  nothing on stdout (`cli.ts:32`, `cli.ts:38`, `cli.ts:45`). It imports only
  `./check.ts` and `node:fs/promises`, reads the input file and does nothing else.
- `check.test.ts` and `cli.test.ts` — every rule with hand-written expected
  literals, deep caller-input immutability on success, `TypeError` and
  `RangeError` paths, and a spawned CLI child observed only through real exit
  status, stdout and stderr (the validator is never imported by the CLI tests).

### Semantic rules

- Strict overlap is `max(acceptedAt) < min(finishedAt)` (`check.ts:83`).
  Touching intervals (one finishes at the instant the other is accepted) and
  serial intervals return `overlap: false, overlapDuration: 0`; otherwise
  `overlapDuration` is the intersection length (`check.ts:84`).
- The selected metric is input tokens only — never total billed tokens, cache
  tokens or cost.
- A `null` count is unknown, never zero: it increments `unknownChildren`
  (`check.ts:92`) and adds nothing to `knownInputTokens`. A measured zero is
  known and keeps coverage complete. `complete` is exactly
  `unknownChildren === 0` (`check.ts:100`).
- Unknown counts never veto valid intervals: overlap is decided from the
  intervals alone, and the CLI exits 0 for an overlap with incomplete coverage.

### Validation this session

- `bun test tests/fixtures/trident-child-overlap`: 148 pass, 0 fail (131 in
  `check.test.ts`, 17 in `cli.test.ts`).
- `bun test open/__tests__/project-build-e2e.test.ts` (whole file, unedited): 436 pass, 0 fail
  (5968 `expect()` calls, 587s wall).
- `bunx tsc -p tsconfig.json --noEmit`: exit 0 (the root config includes
  `tests/fixtures/**/*.ts`, so the four new files are typechecked here).
- `bunx tsc -p trident/tsconfig.json --noEmit`: exit 0 (this config includes only
  `trident/**` and cannot see the fixture; run because both are required).
- `bash scripts/ci/typecheck-all.sh`: exit 0, all 51 tsconfig configurations
  pass (the current required matrix, including every Open package).
- `bash scripts/ci/lint.sh`: exit 0 — lint, type-query, void-promise,
  pre-swallow, console, wall-clock-bound and diff-base gates all 0 found.
- Mutation control: `bun test tests/fixtures/trident-usage-coverage/summarize.test.ts`
  42 pass, 0 fail.
- The full terminal suite (`bash scripts/run-tests.sh`) is host-owned for this
  build and was not run here.

### Semantic mutations

Each mutant was applied to a scratch copy of the fixture directory, typechecked
(`tsc --strict`, exit 0 for all four, so no result below is a parser or type
failure) and run with `bun test` over both fixture test files. The committed
`check.ts` was never edited.

| Mutation of `check.ts` | Result |
|---|---|
| M1: permit touching intervals (`latestAccepted <= earliestFinished`) | 5 red: both touching-interval unit tests, unknown count on non-overlapping intervals, CLI touching case, CLI input-unchanged case |
| M2: refuse valid overlap (`latestAccepted > earliestFinished`) | 18 red, including every strict-overlap unit test and both CLI overlap cases |
| M3: null becomes measured zero (`unknownChildren += 1` replaced by `knownInputTokens += 0`) | 7 red: every unknown-count unit test, frozen-input summary, CLI unknown-count and serial cases |
| M4: reject legitimate measured zero (`inputTokens <= 0`) | 7 red: measured-zero unit tests, identical intervals, maximum safe total, unfrozen immutability, CLI measured-zero and input-unchanged cases |
| Restore | the committed file was never mutated; 148 pass, 0 fail |

The host-proved mutation nomination is M1 with guard
`bun test tests/fixtures/trident-child-overlap/check.test.ts` and control
`bun test tests/fixtures/trident-usage-coverage/summarize.test.ts`.

### Evidence boundary

Every input here is synthetic. The fixture authenticates no observation and does
not demonstrate live concurrency, provider token savings, complete telemetry
coverage or an unattended merge. Root must separately observe actual overlapping
live run and accepted native-child intervals, independently concurrent review
where required, attributable known versus unknown usage, ordinary gate receipts
and two unattended PR merges on the served revision.
