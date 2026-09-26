## 2026-09-26 — Measure and batch fresh fake GitHub ref reads

The Open build E2E fake GitHub projection resolved its base and head with two
sequential real Git processes before selecting requested JSON fields. Repeated
diagnostics identified those reads as a material fixture cost. The projection
now uses one fresh `git for-each-ref` invocation and exact full-ref lookup for
both values. It retains all projection fields, independently returns an empty
string for each missing ref, and never caches mutable refs. Prefix matches are
not accepted as substitutes. The separate merge-pin read remains fresh.
The implementation is confined to `open/__tests__/project-build-e2e.test.ts`;
production code, runtime waits, host suite receipts and budget gates are unchanged.

Existing opt-in `OPEN_E2E_FIXTURE_TIMING=1` diagnostics now capture each direct
`spawnCapture` command once, with relative start/end intervals and concurrent
interval unions. They distinguish fake API ref reads, host Git, worker Git,
suite/install, fixture Git and other commands. Script descendants are outside
this measurement. Category unions may overlap and must not be added as a wall
time decomposition. The fixture Git bucket also includes the fake merge push.

The audit baseline was merged revision
`b14bc4536c6cb2624d11619540aeb83ddb5ef1c8`. Dependencies were installed in the
isolated worktree with `bun install --frozen-lockfile --offline --ignore-scripts`
(exit 0), using Bun 1.3.13. Paired measurements used the same source, dependencies,
selector and environment; only the projection mechanism changed. Three repeats
ran in order A1/B1/A2/B2/A3/B3, where A is the original two-process projection.
An earlier incorrectly grouped diagnostic attempt was discarded before pairing.
All six paired test processes exited 0, each executing the same three consumers:

```sh
OPEN_E2E_FIXTURE_TIMING=1 bun test open/__tests__/project-build-e2e.test.ts --test-name-pattern '^(terminal (single|task-sequence) runs one host suite for review and publication|v2 pending builder reconstruction preserves every brief and its later fix contract)$'
```

| Consumer | A case ms, repeats 1/2/3 | B case ms, repeats 1/2/3 | Fake ref commands A → B |
|---|---|---|---|
| terminal single | 1924 / 2088 / 2102 | 1931 / 1963 / 1930 | 43 → 22 |
| terminal task-sequence | 1485 / 1579 / 1570 | 1351 / 1739 / 1664 | 43 → 22 |
| pending builder with later fix | 2446 / 2511 / 2607 | 2222 / 2572 / 2545 | 69 → 35 |

The nine cases per variant saved exactly 228 direct fake API processes:
465 → 237 (49.0%). Their category interval unions decreased from 2456.950 ms
to 1316.155 ms (46.4%). All direct commands decreased from 2241 to 2013;
host Git counts remained 145/145/246 per three consumers and host suite/install
counts remained 1/1/2. Total case body plus cleanup was 18311.738 ms versus
17917.849 ms (2.2% lower aggregate), with mixed individual paired results.
This demonstrates process reduction and a smaller measured fake API cost;
it does not establish a reliable whole-file or suite-lane speedup. No whole-file
or full-suite run was authorized for this bounded experiment.

The new focused real-Git consumer verifies exact JSON fields/OIDs, movement of
either ref becoming visible on the next call, either/both missing refs, a
descendant ref that must not fill a missing branch, wrong merge-pin refusal
without moving main, and successful legitimate pinned merge. The focused command
`bun test open/__tests__/project-build-e2e.test.ts --test-name-pattern '^fake GitHub projection freshly'`
passed, exited 0, and passed again after restoring both semantic mutants.
A stale cached-map mutant exited 1 at the moved-head assertion. An overbroad
missing-all mutant exited 1 when a present base was erased by a missing head.
Both mutants were removed. Private logs retain the initial audit, paired runs,
controls and mutant failures; raw commands and fixture paths are not emitted
by the added diagnostics.

After freezing source at `f1a7c352805c622faf78bcd7f0b41447a856b22f`, both
`bunx --no-install tsc --noEmit -p tsconfig.json` and
`bunx --no-install tsc --noEmit -p trident/tsconfig.json` exited 0. The focused
ref/merge control also exited 0 on that source. An initial root type check had
reported the diagnostic wrapper's missing `writesDiffOutput` capability marker;
the wrapper now preserves the original marker and the repeated checks passed.
The paired A/B runs shared the same wrapper; the marker correction was applied
after pairing and did not change either projection mechanism. `git diff --check`
passed. Subsequent changes only add this validation receipt.

Required full host coverage and CI remain unverified for this candidate. This
bounded receipt does not complete the full acceptance of
`docs/spec-items/host-test-suite-efficiency.md` or supersede its full-host gate.
