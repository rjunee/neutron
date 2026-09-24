## 2026-09-24 — one oversized log line no longer voids host suite failure identity

Follows `docs/as-built/host-owned-terminal-suite.md`, which introduced the host
suite-failure parser in `trident/suite-failure.ts`.

### Defect

The line reader set `overflow = true` whenever any single log line exceeded
16384 characters, and the identity predicate refuses `hostFailureId` whenever
`overflow` is set. One oversized line therefore voided failure identity for the
whole suite log. In this repository `trident/orchestrator.test.ts` (the
600-file mutation-exempt case) prints a 21,689-character
`[trident] event=mutation_proof_exempt ...` line on every full-suite run, so
every red host suite here was unidentified. Consequences: the G072 check in
`trident/gates/review-progress.ts` returned unknown ("cannot compare
unidentified host suite failures") for any red after a blocker round, and the
failed-preexisting exemption in `trident/gates/review-suite.ts` could never be
earned. Run 234810dd died this way: unanimous APPROVE, CI green, one flaky red.

### Rule

An oversized line is still never fed to the line parser. Its first 16 KiB
prefix is checked against the line-start forms of every pattern the parser
acts on: `bun test v`, `N tests failed:`, `Ran N tests across`, `N fail`, the
fatal-marker regex, the error-line regex, a test-file header, `(fail) `, and a
whitespace-only prefix. The fatal-marker and error-line regexes are now shared
module-level constants used by both the parser and the prefix check. Only a
prefix that could itself be one of those lines voids identity, because its tail
was not read; any other oversized line (a trident event line, a JSON blob, a
stack frame) is skipped. Only the first 16 KiB of a line is checked; later
fragments of the same line are discarded as before. Every other overflow
condition is unchanged: unfinished runs, count mismatch, more than 200
failures or errors, fatal markers, a failure with no file header, an
unreadable log, and a log truncated inside an oversized line. The 16384
threshold, the identity hash inputs and the diagnostics text are unchanged.
`trident/gates/review-progress.ts` and `trident/gates/review-suite.ts` are not
changed; their existing identity-dependent paths are now reachable here.

### Measurement on run 234810dd

- `suite-round-2.log` (one named failure plus the 21,689-character event line):
  unidentified before; now `host-suite:25a142bc...` naming
  `gateway/__tests__/app-ws-chat-observability.test.ts: app-ws observability — the /ws/app/chat path (ISSUES #557) > emits message_received → turn_dispatched → turn_completed for one send`.
- `suite-round-1.log`: unidentified under both parsers, correctly, because it
  contains zero `(fail)` lines (19 shells started, 19 finished).

### Tests and mutation

`trident/suite-failure.test.ts` gains one test: a Bun log with a 20,000+
character non-failure line before the file header and a 20,000+ character
trident event line after it yields the same `hostFailureId` as the log without
them. Positive controls keep identity void for an oversized `(fail)` line
(plain and ANSI-coloured), an oversized `error: Cannot find module` line, an
oversized `TypeError:` line, and a log truncated inside the oversized line. The
existing test (missing `Ran` line, count mismatch, fatal marker, 100 KB blob)
is unchanged.

Mutation: replacing the prefix check with the old unconditional
`overflow = true` turns the new test red (`hostFailureId` is undefined);
restored, it is green. `trident/gates/review-suite.test.ts` stays green under
the mutation.

### Verification

- `bun test trident/suite-failure.test.ts trident/gates/review-suite.test.ts trident/gates/review-progress.test.ts`
  (CLAUDECODE and AI_AGENT unset): 16 pass, 0 fail.
- `tsc -p tsconfig.json --noEmit` and `tsc -p trident/tsconfig.json --noEmit`: exit 0.
- `scripts/ci/lint.sh`: exit 0.
- Leak gate: `--messages-only` over the branch commits and `--tree` over the
  changed files: no findings.
