## 2026-09-29 — Reusable exact-scope input-usage comparison fixture

Test-only change. It adds a pure exact-scope input-usage comparator and a Bun CLI
under `tests/fixtures/trident-scope-usage-match/`, with unit and spawned-CLI tests.
No production runtime code, dependency, lockfile, package script, shared manifest,
existing fixture, `open/__tests__/project-build-e2e.test.ts` or `docs/AS_BUILT.md`
changed.

### What was added

- `tests/fixtures/trident-scope-usage-match/compare.ts` — pure
  `compareScopeUsage(input: unknown)` (`compare.ts:144`). The input must be exactly
  `{ before, after }`; each side exactly `{ scope, attempts }`; each scope exactly
  `{ task, gates, models }` of nonempty strings without leading or trailing
  whitespace (`compare.ts:96-104`); each attempt exactly `{ attemptId, inputTokens }`
  with a nonempty trimmed `attemptId` unique by exact equality within its side and
  `inputTokens` either `null` or a nonnegative safe integer (`compare.ts:132-133`).
  A running total that leaves the safe integer range is rejected
  (`compare.ts:137`). Every rejection is one typed `ScopeUsageInputError`
  (a `TypeError` subclass, `compare.ts:62`) whose message is a structural path and
  a rule, never an input value. Both sides are fully validated before any
  comparison, and the input is only read.
- Each side is summarised as `{ knownInputTokens, unknownAttempts, complete }`
  (`compare.ts:141`): known counts are summed with measured zero kept as known,
  each `null` is one unknown attempt and is never read as zero, and `complete` is
  exactly `unknownAttempts === 0`. Empty attempts give `{ 0, 0, true }`.
- The result is `{ kind, before, after, inputTokenReduction }` (`compare.ts:159`).
  `kind` is `matched` exactly when all three scope strings are equal by `===`
  (`compare.ts:151-153`); nothing trims, case-folds, parses or collapses whitespace
  to manufacture equivalence. `inputTokenReduction` is
  `before.knownInputTokens - after.knownInputTokens` only when matched and both
  sides are complete, otherwise `null` (`compare.ts:156-158`). Zero and negative
  reductions are legitimate; no percentage is computed and incomplete telemetry
  vetoes nothing.
- `tests/fixtures/trident-scope-usage-match/cli.ts` — Bun CLI taking exactly one
  JSON file path (`cli.ts:24`). Every structurally valid input, including unmatched
  scopes and unknown usage, prints one JSON comparison line and exits 0
  (`cli.ts:45-46`). Usage errors exit 2; unreadable files, malformed JSON and
  rejected input exit 1 with one concise stderr line and nothing on stdout. The
  JSON parser's own message is never forwarded, so input bytes are not echoed. It
  imports only `node:fs/promises` and `./compare.ts`; no network, database,
  provider, repository or environment access.
- `compare.test.ts` — exact matches; mismatch on each field and on all three;
  case, internal-whitespace and punctuation differences left unmatched; a
  numeric-looking scope string compared as a string; matched unknown and mixed
  counts; measured zero; empty attempts; positive, zero, negative and extreme
  (`±MAX_SAFE_INTEGER`) reductions; null reduction for every unmatched or
  incomplete case; every validation failure named in the brief (missing and extra
  keys at each level, malformed objects and arrays, invalid strings, coercible
  numeric strings, booleans, negative, fractional, non-finite and unsafe counts,
  per-side duplicate identities, summed overflow on either side); diagnostics that
  never contain a sentinel; and deep-frozen inputs unchanged on success and error
  paths.
- `cli.test.ts` — spawns the real CLI with temporary files and asserts exit status,
  exact stdout bytes and stderr for a known match, an unknown-usage match,
  unmatched scopes, empty attempts, usage errors, an unreadable path, malformed
  JSON and seven rejected inputs; input files are byte-identical afterwards. The
  comparator is never imported by this file.

The comparator checks declared scope equality only, not whether declarations are
truthful or scientifically adequate. Its scalar is observed input tokens only —
never total billed tokens, cache counts or cost.

### Validation this session

- `bun test tests/fixtures/trident-scope-usage-match`: 136 pass, 0 fail
  (344 expect calls, 2 files).
- `bun test open/__tests__/project-build-e2e.test.ts` (whole file, unedited):
  436 pass, 0 fail (5968 expect calls). No test in that file was edited.
- `bunx tsc -p tsconfig.json --noEmit`: exit 0 (the root config includes
  `tests/fixtures/**/*.ts`; `--listFilesOnly` lists all four new files).
- `bunx tsc -p trident/tsconfig.json --noEmit`: exit 0.
- `bash scripts/ci/typecheck-all.sh`: 51 configurations checked, all pass.
- `bunx eslint` on the four new files through `scripts/ci/lint-filter.mjs`:
  0 gated findings. `type-query-check`, `void-promise-check`, `console-ban-check`,
  `wall-clock-bound-check` and `keyboard-taps-check`: 0 found each.
- `git diff --cached --check`: clean.
- The full terminal suite is host-owned for this build (`host-suite` scope) and was
  not run here.

### Semantic mutations

Each mutant was applied in place, run against `compare.test.ts` (or `cli.test.ts`),
and restored; the restored files are byte-identical to the committed ones
(sha256 checked). Every mutant is a valid program — each failure is an assertion,
not a parser or type error. The control `tests/fixtures/trident-usage-coverage/summarize.test.ts`
stayed green under every `compare.ts` mutant.

| Mutation | Result |
|---|---|
| M1a: coerce unequal scopes (case-fold and collapse whitespace before `===`) | 4 red (case, gate case, internal and model whitespace) |
| M1b: drop the `gates` comparison | 2 red (gates mismatch, gate case) |
| M2a: refuse equal scopes (`kind` forced to `unmatched`) | 10 red |
| M2b: refuse equal scopes (`models` `===` becomes `!==`) | 15 red |
| M3: null treated as measured zero (`knownInputTokens += 0`, unknown not counted) | 4 red (both one-sided unknown cases, mixed, unmatched incomplete) |
| M4: refuse legitimate measured zero (`< 0` becomes `<= 0`) | 7 red |
| C1: CLI exits 0 on every refusal | 12 of 16 CLI tests red |
| C2: CLI writes refusals to stdout instead of stderr | 11 of 16 CLI tests red |

### Evidence boundary

All data here are synthetic. A fixture comparison does not demonstrate provider
token savings, workload equivalence, complete telemetry or live concurrency.
Real comparisons must report unmatched scopes as unmatched and unknown usage as
unknown; unknown usage cannot establish a token saving. Fixture success cannot
close the normative item in `docs/spec-items/trident-build-efficiency.md:247-253`,
which still requires observed overlapping live runs and accepted native children,
independent concurrent review where required, attributable known versus unknown
measurements, ordinary gate receipts and unattended merges on the served revision.
