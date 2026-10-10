## 2026-10-10 — Correct efficiency benchmark scope fidelity

Issue #1220 found two places where the deterministic efficiency benchmark did
not compare the workload it actually ran. At revision 794761bf,
`compareEfficiency` in `open/__tests__/fixtures/trident-efficiency-benchmark.ts`
sorted the observed gate names but did not deduplicate them, while the benchmark
producer in `open/__tests__/project-build-e2e.test.ts` already recorded them as a
set. A gate observed twice therefore read as an unmatched workload. The existing
duplicate-observation test only duplicated a model assignment. The producer also
reported a literal `pr` merge mode instead of the mode the fixture configured.

The governing contract is the deterministic benchmark criterion in
`docs/spec-items/trident-build-efficiency.md`: compare equal task/gate/model
scopes and report unmatched cases as unmatched.

`compareEfficiency` now compares observed gates with the producer's set
semantics, so observation order and repetition do not change the gate scope.
A missing or substituted gate, and every other gate input, still does. The
producer takes an optional configured merge mode and passes it to the fixture,
which writes it to the run row. The reported `scope.gates.merge_mode` and the
die-path `buildRun` input both read the run row's configured `merge_mode`. This
is the same source the host passes in `trident/project-build-host.ts`.
Observed gates, counts, decisions, intervals, outcomes and usage are produced
exactly as before.

The oracle tests in `open/__tests__/trident-efficiency-benchmark.test.ts` gained
two controls. The positive control adds a repeated gate observation to the
equivalent-scope test and asserts a match in both directions. The negative
control is a `duplicate-gate` case: a repeated gate stands in for a missing one
at the same length, and it stays unmatched on `gates`. One new case in the real
consumer runs the producer twice for `fresh`/`concurrent`: once in the default
PR mode and once with a configured local mode. Each report carries its own mode.
The real PR report, with every gate observed twice and in reverse order, matches
itself in both directions. The local-mode report stays unmatched against it on
exactly `gates`, in both directions. Both reports pass `assertEfficient` with
identical counts and a single `merged` outcome. Scripted usage stays unknown.
The six existing scenario assertions are unchanged.

Receipts (Bun 1.4.2, repository root):

- `bun test open/__tests__/trident-efficiency-benchmark.test.ts`: 30 pass,
  0 fail (121 expect calls).
- `bun test open/__tests__/project-build-e2e.test.ts -t 'deterministic efficiency benchmark'`:
  7 pass, 0 fail, 622 filtered out. These are the six scenario cases plus the
  new scope-fidelity case.
- Mutation 1, restored afterwards: reverting `compareEfficiency` to
  `[...gates.observed].sort()` failed the unit positive control (29 pass,
  1 fail) and the new real-consumer case (6 pass, 1 fail). The `duplicate-gate`
  negative control stayed green.
- Mutation 2, restored afterwards: reintroducing the literal `merge_mode: 'pr'`
  in the producer scope failed the new real-consumer case on
  `expect(local.scope!.gates.merge_mode).toBe('local')` (6 pass, 1 fail).
- `bash scripts/ci/typecheck-all.sh`: 50 of 51 projects passed, including the
  root, `open/` and `trident/` projects. The one failure was `app/tsconfig.json`
  on an unused `@ts-expect-error` in `app/__tests__/support/mount.tsx`. That
  project includes only `app/` sources, which this change does not touch.

The worker ran only these selected cases. The full consuming file and the full
suite are left to the host-owned suite run.

This is offline evidence measured in scripted workload units. It makes no live
token or price claim and does not change production scheduling, publication or
merge authority. No feature flag was added. SYSTEM-OVERVIEW changes: none (fixture correction only).
