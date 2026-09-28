## 2026-09-28 — Reusable usage-coverage fixture consumed by the production build E2E tests

Test-only change. It adds a reusable measurement-coverage reducer and CLI under
`tests/fixtures/trident-usage-coverage/`, and makes three existing attempt-accounting
tests in `open/__tests__/project-build-e2e.test.ts` consume it. No production
runtime code, dependency, lockfile, package script or shared governance document
changed.

### What was added

- `tests/fixtures/trident-usage-coverage/summarize.ts` — pure
  `summarizeUsageCoverage(input: unknown)`. It validates an array of
  `{ attemptId, outcome, tokens }` records (nonempty string identity with no surrounding whitespace,
  unique by exact equality; outcome `completed` or `failed`; tokens `null` or a
  nonnegative safe integer) and returns `{ knownTokens, unknownAttempts, complete }`.
  Every known count is summed, failed attempts and measured zero included; each
  `null` is one unknown attempt and is never read as zero
  (`summarize.ts:59`); a measured zero passes the nonnegative check
  (`summarize.ts:60`); an unsafe running total throws `RangeError`
  (`summarize.ts:62`); `complete` is exactly `unknownAttempts === 0`
  (`summarize.ts:64`). Invalid input throws with index-and-rule diagnostics that
  never carry record values. Extra properties are ignored and the input is only read.
- `tests/fixtures/trident-usage-coverage/cli.ts` — Bun CLI taking exactly one JSON
  file path. Valid input (including unknown measurements) prints one JSON summary
  line to stdout and exits 0 (`cli.ts:43-44`); usage, read, parse or reducer errors
  print one concise stderr line, nothing on stdout, and exit nonzero. It imports only
  `./summarize.ts` and does no network, repository, database or environment access.
- `summarize.test.ts` and `cli.test.ts` — the reducer rules, immutability of frozen
  inputs on success and error paths, and a spawned CLI child observed only through
  exit status, stdout and stderr (no process-exit mocking, no direct reducer calls).

Coverage describes the selected scalar measurement only. It is not execution
validity, billing completeness or provider trust, and incomplete coverage never
vetoes a run.

### Production E2E consumption

Each of the three named tests maps its already-asserted attempt ledger to reducer
records keyed by `JSON.stringify([run_id, step_id, attempt_id])`, with each
attempt's receipt `input_tokens` (or `null`) as the named selected metric. The
attempt outcome is asserted to be `completed` or `failed` rather than coerced; the
ledger outcome union is wider (`trident/attempt-ledger.ts:18`) and receipt input
counts are nullable (`trident/attempt-ledger.ts:31`). Expected summaries are
hand-written literals, not reducer output:

| Test (`open/__tests__/project-build-e2e.test.ts`) | Summary | Host outcome (unchanged assertion) |
|---|---|---|
| native child measurements (line 2310) | `{ knownTokens: 35, unknownAttempts: 0, complete: true }` | merged |
| provider-reported model without usage (line 2334) | `{ knownTokens: 0, unknownAttempts: 5, complete: false }` | merged; incomplete coverage did not veto |
| explicit zero plus failed build (line 2376) | `{ knownTokens: 23, unknownAttempts: 0, complete: true }` | failed, no merged PR; coverage authorizes nothing |

Every pre-existing assertion (measured zeros, source/model metadata, unknown cost and
cache fields, phase usage rows, run outcome) is retained.

The new import line from `open/__tests__/` into `tests/fixtures/` carries an inline
`import/no-relative-packages` suppression: `tests/` is root test-support with no
workspace specifier, the same reason `eslint.config.mjs` lists its `tests/support`
exceptions. Positive control: with the suppression line removed, the CI lint filter
reports the import (1 finding); with it present, 0.

### Validation this session

- `bun test tests/fixtures/trident-usage-coverage`: 54 pass, 0 fail.
- `bun test open/__tests__/project-build-e2e.test.ts -t "attempt accounting (consumes native child measurements|keeps a provider-reported model without usage|keeps explicit zero on successful work)"`: 3 pass, 0 fail.
- `bun test open/__tests__/project-build-e2e.test.ts` (whole file): 397 pass, 0 fail.
- `bun x eslint` on the changed files through `scripts/ci/lint-filter.mjs`: 0 findings.
  `console-ban-check`, `void-promise-check` and `type-query-check`: 0 found each.
- `bash scripts/ci/typecheck-all.sh`: all 51 configurations passed (run with a
  local `bunx` shim that forwards to `bun x`, because `bunx` was not on the path).
  The first run failed on a `toContain` overload for the nullable outcome type; the
  supported-outcome list is now typed `ReadonlyArray<string | null>`.
- The full terminal suite is host-owned for this build and was not run here.

### Semantic mutations

| Mutation of `summarize.ts` | Result |
|---|---|
| M1: null adds zero instead of counting unknown (`knownTokens += 0`) | 4 red: null-only, mixed, frozen-input summary, CLI unknown-count case |
| M2: nonnegative check rejects zero (`tokens <= 0`) | 6 red: measured zero (completed and failed), mixed, maximum-safe total, frozen-input summary, CLI positive case |
| Restore | byte-identical to the committed file; 54 pass, 0 fail |

Both mutations are valid programs; neither result is a parser or type error.

### Evidence boundary

All unit and E2E data here are synthetic. This does not demonstrate real provider
token savings, pricing, complete telemetry coverage, workload equivalence, live
concurrency, or completion of any earlier blocked publication.
