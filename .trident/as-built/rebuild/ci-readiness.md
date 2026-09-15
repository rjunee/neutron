## Host-owned CI readiness

### What changed

CI readiness is now a host TypeScript classification with a closed verdict vocabulary at `trident/ci-readiness.ts:9-15`. Only a completed successful run whose recorded head equals the requested PR head becomes green at `trident/ci-readiness.ts:26-32`; the merge-facing predicate recognizes only that value at `trident/ci-readiness.ts:35-37`.

The focused tests prove successful, stale-head, absent, running, failed, and unreadable observations at `trident/__tests__/ci-gate.test.ts:13-48`. An unreadable observation is `cannot-read`, not `red`, at `trident/ci-readiness.ts:22-24`, so a blind probe cannot allege a failed run.

### Gate decisions

The retained five merge facts are G044 (evidence must be readable), G047 (the observed PR state must be merge-ready), G049 (the required run must exist and settle), G052 (zero runs is not green), and G054 (a settled run is success or failure). The source inventory defines those facts at `docs/trident-gates-inventory.md:114-126`.

The following are follow-ups instead of ports: G045/G046 producer discovery completeness, G048 producer identity, G050/G051 configuration inference and refresh, G053 retry cadence, G055 base-failure comparison, and G056 reviewer routing. They do not alter the host verdict vocabulary in this change.

### Outcome vocabulary and invariant

The new outcomes join `CiReadinessVerdict` at `trident/ci-readiness.ts:9-15`. `isCiGreen` defaults every value except `green` to false at `trident/ci-readiness.ts:35-37`. Head identity is maintained continuously by requiring the caller's requested head on every classification and comparing every existing run before interpreting its state at `trident/ci-readiness.ts:18-29`; it does not depend on the CI run still executing.

### Mutation evidence

| Guard | Compiling mutation | Red result | Restored result |
| --- | --- | --- | --- |
| Absent run is not green | `trident/ci-readiness.ts:25` returned `green` | `no run exists is explicit and is not green` failed at `trident/__tests__/ci-gate.test.ts:27` | focused file: 6 pass, 0 fail |

### Verification

`bun test trident/__tests__/ci-gate.test.ts`, `bunx tsc --noEmit -p trident/tsconfig.json`, and focused ESLint passed. The requested root `bun run typecheck` command is not defined, so the module TypeScript configuration was checked directly. The leak gate reported zero findings from checks it could run but could not load its external denylist, so purity is not certified locally.

### Deliberately not done

No workflow implementation was edited, no retry loop was introduced, and none of the seven follow-up policies was reimplemented. The missing bounded-work contract in this checkout was not guessed or replaced, and no spec decision changed.
