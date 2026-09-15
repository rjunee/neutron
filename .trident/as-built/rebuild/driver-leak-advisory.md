## 2026-09-15 — G139 advisory driver leak preflight

### Change and evidence

The driver now logs incomplete scans, unresolved findings and returned gate errors,
then continues through the existing publication gates (`trident/build-run.ts:354`,
`trident/build-run.ts:357`, `trident/build-run.ts:366`). The positive test observes
both publication and the logged finding, including its rule and file
(`trident/build-run.test.ts:159`, `trident/build-run.test.ts:169`). The former
"cannot publish" assertions were incorrect: they encoded the veto this lane was
assigned to remove, contrary to G139 (`docs/trident-gates-inventory.md:233`).

The host records whether the scanner command returned an observation, preserving
returned gate errors as advisory while reporting setup failures and thrown calls
as unknown (`trident/build-host.ts:98`, `trident/build-host.ts:105`,
`trident/build-host.ts:109`). Recognition uses the actual scanner command shape
(`trident/leak-preflight.ts:291`). The marker is local to each invocation, so a
previous successful scan cannot certify a later failed attempt. This measurement
is host-owned and does not depend on the scanner successfully classifying itself.

### Vocabulary and decisions

The driver seam extends the existing LeakPreflightOutcome status vocabulary with
unknown (`trident/build-run.ts:16`; existing vocabulary at
`trident/leak-preflight.ts:147`). The explicit unknown/skipped branch returns the
existing nonterminal BuildRunOutcome unknown, with publish phase, null step and a
reason; it does not default to clean or terminal failure
(`trident/build-run.ts:118`, `trident/build-run.ts:147`,
`trident/build-run.ts:352`, `trident/build-run.ts:359`). Thrown seam calls follow
the existing unknown catch (`trident/build-run.ts:397`). The host passes the build
outcome through (`trident/build-host.ts:141`).

A returned command error is evidence of an attempted scan, not a clean verdict.
The host preserves the existing helper's classification in that case
(`trident/build-host.ts:110`). A failure before the scanner returns is unknown.
This local wrapper preserves the kept helper and orchestrator while implementing
the lane's explicit distinction between an unrun scan and advisory results.

G139's kept implementation logs before continuing (`trident/orchestrator.ts:2663`).
Its cited tests moved: current certification starts at
`trident/orchestrator.test.ts:9719` and `trident/orchestrator.test.ts:9762`;
ordering is asserted at `trident/orchestrator.test.ts:9752`, and findings still
reach a published checkpoint at `trident/orchestrator.test.ts:9804`.

### Mutation evidence

Each mutation was applied separately, its actual source line printed, and its
focused Bun tests executed to assertion failures, then restored to green. The
mutated code ran; failures were wrong outcomes rather than parse failures.

| Guard/property | Compiling mutation and actual landing | Red | Restored green |
| --- | --- | --- | --- |
| Early detection | Replace awaited call with a typed clean result, `trident/build-run.ts:354` | 3 failures, `logs and publishes` | 3 passed |
| Honest unrun outcome | Replace unknown with clean, `trident/build-host.ts:109` | 3 failures, `prevents a scan` | 3 passed |
| Driver stops unrun scans | Replace unknown/skipped condition with false, `trident/build-run.ts:359` | 2 failures, `cannot publish without a scan` | 2 passed |
| Advisory publication | Reinsert clean/fixed-only veto before observation, `trident/build-run.ts:360` | 3 failures, `logs and publishes` | 3 passed |
| Finding logged | Prefix emit with `if (false)`, `trident/build-run.ts:357` | 3 failures, `logs and publishes` | 3 passed |
| Recognize scanner observation | Replace command condition with false, `trident/build-host.ts:105` | 2 failures, `preserves observed` | 2 passed |

The host fixtures cover missing gate, failed worktree setup and thrown invocation
(`trident/build-host.test.ts:548`), plus actual returned findings and gate errors
(`trident/build-host.test.ts:568`). The driver fixtures cover each advisory status,
unrun status and thrown seam (`trident/build-run.test.ts:159`,
`trident/build-run.test.ts:179`, `trident/build-run.test.ts:188`).

### Validation

- `bun test trident/build-run.test.ts trident/build-host.test.ts`: 134 passed.
- `bun test trident/orchestrator.test.ts`: 305 passed, including both G139 tests.
- `bunx --no-install tsc --noEmit -p trident/tsconfig.json`: passed.
- Scoped ESLint over all four changed TypeScript files: passed.
- `bash scripts/ci/lint.sh`: passed all checks.
- `bash scripts/ci/typecheck-all.sh`: checked 51 configs; only app failed
  with TS2688, missing type definition file for `@types`. Root and Trident passed.
  The failure is outside the changed files; no app configuration was modified.
- `bun run typecheck`: unavailable (no package script); repository typecheck used instead.

### Scope and deliberate omissions

No product decision changed: this restores G139's existing target. No fixer,
annotation flow, CI gate or retained orchestrator policy was changed. Reviewed
revision checks remain after preflight (`trident/build-run.ts:363`); merge still
requires green CI (`trident/build-host.ts:124`). CI invokes the leak gate in its
purity job (`.github/workflows/ci.yml:335`).

Changed files were enumerated with `git diff --cached --name-only`: the four owned
TypeScript files and this record. A whole-tree content search for the corrected
host comment, its replacement, the former veto text and the old test title found
only the replacement comment and the correctly restricted unrun-scan test
(`trident/build-host.ts:48`, `trident/build-run.test.ts:180`). Those replacement
hits were the positive controls for that search.

This record uses the lane-mandated staging path instead of the standard shard
path, as explicitly directed by the task. Publication and merge are left to the
orchestrator; this lane delivers a local commit only.
