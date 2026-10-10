## 2026-10-10 — Nested package fixture budgets and exact summaries

Refs #1461 (follow-up to #1460). `open/__tests__/package-launcher-fixture-env.test.ts`
launches a real outer `bun run test` package script whose `entry.ts` runs one
anchored case from `open/__tests__/project-suite-identity.test.ts` or
`open/__tests__/project-build-e2e.test.ts` in a nested `bun test`. CI run
37907664369 attempt 1 failed the identity case at exactly 5,000ms, and its
wrapper failed at 5,093.92ms. A retry on unchanged source passed, so the retry
was luck, not a repair.

Root cause: the nested `bun test` had no `--timeout`, so the selected case ran
under Bun's 5s default. `scripts/run-tests.sh` never uses that default; it passes
`NEUTRON_TEST_TIMEOUT` (15s unless overridden) to every chunk. The identity case
(`open/__tests__/project-suite-identity.test.ts:296`) declares no limit and takes
two full package-launcher measurements, each with probe subprocesses, tool
hashing and a `git worktree add`, so it can approach 5s on a contended runner.
Three further layering defects existed. The prepared retry case
(`open/__tests__/project-build-e2e.test.ts:5164`) declares 120s
(`open/__tests__/project-build-e2e.test.ts:5324`), but the wrapper allowed only a
60s spawn and a 70s outer test. `spawnCapture` in `trident/git-mode.ts` kills only
its direct child, the outer `bun run test`, so the nested `bun test` grandchild
had no bound of its own. The assertions `toContain('1 pass')` and
`toContain('0 fail')` also matched `11 pass` and `10 fail`.

Budgets are now explicit per case and nested innermost first, each layer
outliving the one it contains:

| Case | nested `--timeout` | `entry.ts` watchdog | `bun run test` spawn | outer test |
| --- | --- | --- | --- | --- |
| portable identity | 30s | 45s | 50s | 60s |
| prepared retry (package, none) | 120s | 135s | 140s | 150s |

The identity case limit is 30s: six times the observed failure point and twice
the suite runner's default for the same case. The prepared retry case keeps its
own declared 120s; `--timeout` also gives its hooks that budget instead of 5s.
The watchdog adds a 15s margin for nested Bun startup, preloads, imports and
hooks. It kills the nested child, prints
`nested bun test exceeded its <childMs>ms budget and was killed`, and exits 124.
The spawn adds 5s for the outer launcher and output relay. The outer test adds
10s for temp-directory cleanup and assertions. Every layer is finite. There are
no retries.

The wrapper now parses the nested summary exactly. It requires exactly one
`N pass` line, one `N fail` line and one `Ran N test(s) across M file(s).` line,
and asserts `{ pass: 1, fail: 0, ran: 1, files: 1 }` together with
`timed_out` false and exit 0. A missing or repeated line reads as null, so a
zero-match or truncated run fails. Each assertion message starts with a JSON
header (file, pattern, exit, timedOut, elapsedMs, caseMs, childMs, launcherMs,
summary), followed by the full nested stdout and stderr. A direct parser test
covers exact counts, `11 pass`/`10 fail` near misses, a `(pass) 1 pass` title
line, a doubled summary and Bun's zero-match error.

The real outer package-script invocation, both anchored selectors and test
titles, the `entry.ts` check for `npm_lifecycle_event`/`npm_package_json`/`NODE`,
the environment-restoration control and temp-directory cleanup are unchanged.
The production launcher measurement, its refusal rules, `scripts/run-tests.sh`
and `open/__tests__/project-suite-identity.test.ts` are unchanged; the identity
case measured well below 30s, so it needs no per-test limit.

Measured worker stage 1 with Bun 1.4.2 on the shared host:
`bun test open/__tests__/package-launcher-fixture-env.test.ts` ran 4 tests, 4 pass,
0 fail, 14 assertions in 7.2s. That run includes the real nested package-script
execution of the identity case and the prepared retry package/none case, each
nested run reporting 1 pass, 0 fail, 1 ran. Run directly with the same selectors,
the nested identity case reported 1 pass, 45 filtered out in 0.84s, and the
prepared retry case 1 pass, 627 filtered out in 6.31s.

Temporary controls, each reverted before commit and selected with
`-t 'project-suite-identity.test.ts nested'`:

- A nonexistent identity pattern: Bun printed `matched 0 tests` and exited 1,
  and the wrapper failed with summary all null in its diagnostic.
- An identity `caseMs` of 1ms: the nested case reported `timed out after 1ms`,
  so the nested `--timeout` reaches the case. The wrapper failed with summary
  `{ pass: 0, fail: 1, ran: 1, files: 1 }`.
- A 50ms watchdog: `entry.ts` killed the nested run, printed the budget message
  and exited 124, and the wrapper failed with that diagnostic.

`bash scripts/ci/typecheck-all.sh` passed 50 of 51 configurations, including
`open/tsconfig.json`. The `app/tsconfig.json` failure is an unused
`@ts-expect-error` in `app/__tests__/support/mount.tsx`, which this change does
not touch; no file under `app/` is in this diff.

Deferred coverage: the complete `open/__tests__/project-suite-identity.test.ts`
and `open/__tests__/project-build-e2e.test.ts`, and the rest of the suite, are
covered by the host-owned full suite. Focused stage 1 is subset evidence only.
SYSTEM-OVERVIEW changes: none.
