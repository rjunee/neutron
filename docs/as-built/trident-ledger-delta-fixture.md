## 2026-09-29 — Reusable task-ledger delta fixture consumed by the build E2E crash tests

Test-only change. It adds a strict task-ledger decoder, an exact single-completion
delta comparator and a CLI under `tests/fixtures/trident-ledger-delta/`, and makes
the parameterized `same-run task-sequence crash ${boundary} in ${mergeMode} cannot
publish unfinished tasks` test in `open/__tests__/project-build-e2e.test.ts` consume
the decoder and comparator. No production runtime code, dependency, lockfile,
package script, shared governance document or other fixture changed.

It was built as a three-task `task_sequence` (T1 decoder, T2 comparator, T3 CLI plus
the E2E consumer and this shard), each task a separate commit with a host ledger
tick between them.

### What was added

- `tests/fixtures/trident-ledger-delta/decode.ts` (T1) — pure
  `decodeLedger(input: unknown)` (`decode.ts:58`) returning
  `{ ok: true, ledger: { tasks: { label, completed }[] } }` or
  `{ ok: false, reason }`, and `summarizeLedger` (`decode.ts:83`) returning
  `{ completed, remaining, firstUnchecked }` where `firstUnchecked` is the literal
  `- [ ] LABEL` line or `null`. Grammar: one or more lines, each exactly
  `- [ ] LABEL` or `- [x] LABEL` (lowercase `x` only), LF-separated, at most one
  trailing LF. Rejections, first violation wins: not a string (`decode.ts:59`),
  empty (`:60`), blank line (`:67`), malformed task line (`:71`), empty label
  (`:73`), control character incl. CR/tab/NUL/DEL (`:74`), leading or trailing
  whitespace (`:75`), duplicate label by exact equality (`:76`). Labels are never
  normalized; reasons carry a zero-based line index and rule name, never input bytes.
- `tests/fixtures/trident-ledger-delta/compare.ts` (T2) — pure
  `compareLedgerDelta(before, after)` (`compare.ts:37`). Rules in order: same task
  count (`:40`); identical label at every index, which rejects relabel, insertion,
  removal and reordering even when totals match (`:42`); `before` has an unchecked
  task (`:45`); the first unchecked task of `before` is checked in `after`, which
  rejects no-op and skipped task (`:44-46`); every other checkbox unchanged, which
  rejects reversal and completing two (`:49`). Accepted:
  `{ ok: true, completedLabel, after: summarizeLedger(after) }` (`:51`).
- `tests/fixtures/trident-ledger-delta/cli.ts` (T3) — Bun CLI taking exactly one
  JSON file path. Wrong argument count: `usage: bun cli.ts <input.json>`, exit 2
  (`cli.ts:27`). Unreadable file, invalid JSON, a value that is not a non-array
  object with own keys exactly `before` and `after`, a non-string value, or a
  ledger the decoder rejects: one concise stderr line, nothing on stdout, exit 1
  (`cli.ts:32-54`). Structurally valid input: exactly one
  `JSON.stringify(LedgerDeltaResult)` line on stdout (`cli.ts:56`), exit 0 only for
  an accepted delta, 1 for a rejected one (`cli.ts:57`). Imports only
  `node:fs/promises`, `./decode.ts`, `./compare.ts`; no network, repository,
  database, provider or environment access; the input file is only read.
- `decode.test.ts` (64), `compare.test.ts` (35), `cli.test.ts` (20). The CLI tests
  spawn the real CLI in a temp directory and observe only exit status, stdout and
  stderr, with a sentinel that must never be echoed.

This format is deliberately narrow and synthetic. It is not the production plan
parser, and it is not the host's ledger tick; it only describes the two-line
ledger this E2E fixture's planner emits and the host commits.

### Production E2E consumption

In the crash test (`open/__tests__/project-build-e2e.test.ts:5536`, 10 cases:
`pr`/`local` x `before-ledger`, `before-commit`, `commit-uncheckpointed`,
`after-ledger`, `zero-conflict`), every existing assertion is kept. Additions:

1. After the interrupted first build and before any recovery (`:5570-5577`), the
   accepted plan is read from the run's persisted `strategy_plan` column (written
   only by `TridentRunStore.selectExecutionStrategy`, `trident/store.ts:739-743`),
   its `implementationPlan` is decoded, and it must be exactly the two unchecked
   tasks `T1 record the note`, `T2 record another note`. It is captured before
   recovery because the resumed host re-selects the strategy and may replace the
   row. This runs in all ten cases.
2. In the eight non-zero-conflict cases, right after the existing
   `git show <head>:.trident/ledgers/<branch>.md` assertion (kept unchanged on its
   trimmed `spawnCapture` output), the same blob is read a second time with a
   direct `Bun.spawn` of the same `git show` argv, its exit code (0) and stderr
   (empty) asserted, and its RAW stdout decoded unchanged (`:5625-5630`).
   `spawnCapture` trims both ends (`trident/git-mode.ts:1164`), which would hide a
   leading blank line, a second trailing LF or a trailing CR/space from the strict
   decoder; the only normalization left is the decoder's own single optional
   trailing LF. The comparator must accept the captured plan against those raw
   committed bytes with `completedLabel: 'T1 record the note'` and
   `after: { completed: 1, remaining: 1, firstUnchecked: '- [ ] T2 record another note' }`
   (`:5632-5634`).
   A derivative wrong-order completion is then built from the captured accepted
   plan itself, not from a literal: its first unchecked task (index 0) is left
   open and the next unchecked task (index 1) is completed instead (`:5639-5643`).
   It is asserted to keep the recovered ledger's exact labels and the same
   completed total, so neither the label rule nor the totals can reject it; the
   comparator must reject it with `task ${firstOpen}: first unchecked task not
   completed` (`:5646-5647`). No terminal fully-completed ledger is invented.
3. After the terminal merged run, `delta.after.firstUnchecked` must equal the
   host-selected task-two identity `f.world.selectedTasks[1]` (`:5657`).

The two `zero-conflict` cases keep their independent `Task ledger intent is invalid`
refusal and early return (`:5604`); they act as the negative control.

The two new import lines each carry the same inline `import/no-relative-packages`
suppression as the existing `trident-usage-coverage` import (`:72`, `:74`).

### Validation

Ownership is configuration-driven. The host picks each worker's `suiteScope`
(`trident/build-run.ts:682-684`: `subset` while tasks remain, `host-suite` for the
terminal task) and renders its test strategy (`trident/project-build-host.ts:134-146`).
The host's publication suite runs `fullSuiteCommand(test_strategy)`
(`open/wiring/project-build.ts:1029-1038`), which resolves the package `test`
script, `bash scripts/run-tests.sh`. That runner runs no TypeScript check, so the
full TypeScript matrix was run once by the T3 worker, below. It is not a host receipt.

- T1 (subset scope): 64 decode tests pass; root and trident `tsc --noEmit` clean.
  Full suite deferred.
- T2 (subset scope): 99 tests pass (compare 35, decode 64); root and trident
  `tsc --noEmit` clean. Hand mutants of `compare.ts`: M1 skipped-task permit 6
  fail / 29 pass, M2 refuse legitimate first completion 7/28, M3 3/32, M4 2/33.
  Nominated M1 with control `tests/fixtures/trident-usage-coverage/summarize.test.ts`
  42/42.
- T3 (host-suite scope, worker stage 1):
  - `bun test tests/fixtures/trident-ledger-delta/cli.test.ts tests/fixtures/trident-ledger-delta/decode.test.ts tests/fixtures/trident-ledger-delta/compare.test.ts`:
    119 pass, 0 fail (cli 20).
  - `bun test open/__tests__/project-build-e2e.test.ts -t 'same-run task-sequence crash'`:
    10 pass, 426 filtered out, 0 fail, 236 `expect()` calls. This is a subset of
    the file, not a whole-file or full-suite result.
  - Consumer positive control: `compare.ts` M1 (`findIndex((task) => !task.completed)`
    changed to also require `afterTasks[index]!.completed`, so the first flipped
    task is accepted) made the same `-t` command 8 fail (every non-zero-conflict
    case, on the wrong-order `toEqual`) and 2 pass (zero-conflict). Restored
    byte-identical (sha256 prefix `b43811851f91`); re-run 10 pass, 0 fail.
  - Hand mutants of `cli.ts`, each restored byte-identical, decode + compare 99/99
    green under each: C1 unconditional `process.exitCode = 0`, cli 3 fail / 17 pass;
    C2 exact-keys check removed, 1 fail / 19 pass; C3 before-ledger rejection
    printed as a stdout result, 2 fail / 18 pass.
  - `bunx tsc -p tsconfig.json --noEmit`, `bunx tsc -p trident/tsconfig.json --noEmit`,
    `bunx tsc -p open/tsconfig.json --noEmit`: clean. The first run flagged
    `selectedTasks[1]` as `string | undefined`; it now carries a non-null assertion,
    since the line above already asserts the array has exactly two entries.
  - `bash scripts/ci/typecheck-all.sh` (run once, after the index fix): all 51
    configurations pass.
  - `bunx eslint` on the changed files through `scripts/ci/lint-filter.mjs`: 0
    findings. Positive control: with one new suppression line removed, 1 finding.
    `console-ban-check`, `void-promise-check`, `type-query-check`: 0 found each.
    `git diff --check`: clean.
- T3 fix round 1 (host-suite scope, worker stage 1). Addresses the review findings
  "never silently normalize Git output beyond the decoder's stated optional
  trailing LF" (raw blob decode, above) and "add a derivative wrong-order
  completion" (derived from the accepted plan, above). Only the crash test body
  and this shard changed.
  - `bun test open/__tests__/project-build-e2e.test.ts -t 'same-run task-sequence crash'`:
    10 pass, 426 filtered out, 0 fail, 268 `expect()` calls (subset evidence only).
  - Consumer positive control: the same `compare.ts` M1 mutant made that command
    8 fail (every non-zero-conflict case, on the derivative wrong-order `toEqual`)
    and 2 pass (zero-conflict); `compare.test.ts` 6 fail / 29 pass;
    `decode.test.ts` 64/64 (control). Restored byte-identical (sha256 prefix
    `b43811851f91`).
  - Fixture files (`decode`, `compare`, `cli` tests): 119 pass, 0 fail.
  - `bunx tsc -p tsconfig.json --noEmit`, `bunx tsc -p trident/tsconfig.json --noEmit`,
    `bunx tsc -p open/tsconfig.json --noEmit`: clean. `bunx eslint` on the E2E file:
    0 messages. `git diff --check`: clean.
  - The C1-range control-character nit (`decode.ts` rejects U+0000-U+001F and
    U+007F only, as its docblock states) was left as documented; it has no E2E
    impact.
  - Not run by the worker: `bash scripts/run-tests.sh` (host stage 2 owns it) and
    `scripts/check-shared-host.sh` (shared-host admission, not a build gate). CI's
    typecheck-all, lint, leak-gate, as-built-write-guard and run-tests jobs run on
    the PR.

### Evidence boundary

All fixture and E2E data here are synthetic. A passing fixture proves no live
`task_sequence` selection, no real host handoff, and no review, publication or
merge. Those remain separate acceptance items.
