## 2026-09-18 — Teach build workers the executable mutation argv contract

### Root cause and change

A completed live build nominated `guard` and `control` as arrays containing only test filenames. Publication correctly refused the nomination because the first argv element was not an allowed test runner. The emitted forge schema previously described both fields only as arrays of strings. `prepareProjectBuild` serializes that schema into both build and fix briefs (`open/wiring/project-build.ts:338-362`), leaving the worker without the runner semantics the consuming prover requires (`trident/mutation-prover.ts:2639-2652`).

The forge schema now carries descriptions and a complete executable argv example: runner, subcommand and repo-relative test selector. It explains the distinct guard/control observations, separate behavioural tests, and adaptation to actual repository files (`trident/gates/result-contract.ts:109-130`). These annotations travel through the existing brief generator. The prover's allowlist and rejection behaviour are unchanged; no filenames are silently converted into commands. This preserves G143 (`docs/trident-gates-inventory.md:242`).

### Evidence and limits

The new focused test prepares real build/fix briefs, parses their emitted schema example and passes it through the forge trailer validator and production mutation prover (`open/__tests__/project-build-mutation-contract.test.ts:56-78`). The fixture uses real git and real Bun test processes: a clamping assertion fails under the mutation, a below-limit control stays green, and the restored guard passes. The complement removes the runner from each command in turn and requires refusal before any nominated command runs (`open/__tests__/project-build-mutation-contract.test.ts:80-88`). This establishes executable example compatibility, not that every model will follow the instructions or that an arbitrary nomination will prove.

Mutation checks were run in both directions and restored:

- Replacing the emitted example's guard with a bare test filename made both role cases fail at the actual `proved` result: the production prover refused the filename as a runner.
- Temporarily accepting unknown runner programs in `validateArgv` made both role cases fail at the zero-execution assertion: bare filenames reached the nominated-command runner. The prover source was restored with no final diff.

Restored verification: the focused test and result-contract unit tests passed together (6 tests, 46 assertions). Both `tsc -p tsconfig.json` and `tsc -p trident/tsconfig.json` passed.
