## DRV4 — one bounded design-gap re-plan

### Positive result

A design gap now re-plans, rebuilds, reviews, fixes a new converging finding,
and reaches merged in the driver fixture. The positive case asserts both the
worker sequence and 14 independent measurements (`trident/build-run.test.ts:610`).
The panel accepts a valid declaration using the kept escalation policy
(`trident/gates/review-panel.ts:89`); the concrete host forwards its usage count
(`trident/build-host.ts:98`, tested at `trident/build-host.test.ts:452`).

### Implementation and vocabulary

`re-plan` joins `ReviewDecision` alongside approve, fix, blocked and unknown
(`trident/build-run.ts:23`). It has an explicit driver branch, so it does not
fall through into a fix. That branch spends the host counter before dispatch,
passes the missing requirement to planning, selects the full planner, and drops
the old committed-plan shortcut (`trident/build-run.ts:325`). Planning and building
share the existing implementation (`trident/build-run.ts:265`). Every completed
worker still passes the host measurement and corroboration checks
(`trident/build-run.ts:248`); forged re-plan and rebuild heads are tested at
`trident/build-run.test.ts:639`.

The continuously running driver maintains the bound, independently of worker
cooperation: its local counter is passed separately from the payload
(`trident/build-run.ts:321`) and a second request is refused before dispatch
(`trident/build-run.ts:326`). Host resume checkpoints can carry the spent count
and previous blocking count (`trident/build-run.ts:46`); loading validates usage
(`trident/build-run.ts:180`). This change defines and consumes that checkpoint
contract; it does not add a durable checkpoint storage implementation.

The kept trigger vocabulary is repeat-finding, no-progress and valid declarations
(`trident/gates/escalation.ts:109`). The panel delegates declaration validation and
the one-use rule to that gate (`trident/gates/review-panel.ts:89`). Any other
escalation blocks. The driver independently stops repeated findings or a
nondecreasing blocking count after re-plan (`trident/build-run.ts:337`), including
resumed rejection before another fix (`trident/build-run.ts:311`). Panel decisions
carry blocker counts separately from deduplicated identities
(`trident/gates/review-panel.ts:85`, `trident/gates/review-panel.ts:97`). Existing
injected hosts may omit that count and use their finding-list length
(`trident/build-run.ts:337`).

Review rounds inherit the spent budget: the loop increments normally after
re-planning, with the same fix ceiling and repeat rule (`trident/build-run.ts:318`,
`trident/build-run.ts:340`). The separate one-use allowance matches the kept gate's
first-gap priority (`trident/gates/escalation.ts:140`). Thus a first gap may buy a
re-plan at the ceiling, but cannot buy further fix rounds. Unknown and blocked
retain their existing routing (`trident/build-run.ts:322`), and worker uncertainty
still returns through the existing work switch (`trident/build-run.ts:241`).

### Mutation evidence

Each mutation was applied separately, its landed source line printed, and its
named test executed with `bun test <file> --test-name-pattern <name>`. Every
mutation compiled and executed to an assertion failure (exit 1), then the
restored source passed the same test (exit 0). No test assertions were loosened.
The table enumerates all eight mutation executions in this change.

| Guard / landed location | Executed mutation | RED evidence | Restored |
| --- | --- | --- | --- |
| Second re-plan, `trident/build-run.ts:326` | `replansUsed !== 0` → `replansUsed > 100` | Second-re-plan test at `trident/build-run.test.ts:622`: dispatch continued to unscripted review 6, returning unknown instead of blocked | GREEN |
| Post-re-plan triggers, `trident/build-run.ts:337` | `replansUsed > 0` → `replansUsed > 100` | Both fixtures at `trident/build-run.test.ts:629` merged instead of stopping: repeated identity with falling count; distinct identity with flat count | GREEN |
| Host-owned usage, `trident/build-run.ts:321` | Insert `replansUsed = (result.payload as { replansUsed?: number } \| undefined)?.replansUsed ?? replansUsed` before the gate call | Worker supplied zero at `trident/build-run.test.ts:624`; planner call count became 3 instead of 2 | GREEN |
| Panel bound, `trident/gates/review-panel.ts:89` | Pass `replansUsed: 0` to kept gate | Later gap returned re-plan at `trident/gates/review-panel.test.ts:115` | GREEN |
| Host composition, `trident/build-host.ts:98` | Forward literal `0` instead of usage | Spent allowance returned re-plan at `trident/build-host.test.ts:463` | GREEN |
| Resumed trigger, `trident/build-run.ts:311` | `replansUsed > 0` → `replansUsed > 100` | Resume fixture merged at `trident/build-run.test.ts:666` instead of stopping before fix | GREEN |
| Invalid checkpoint count, `trident/build-run.ts:181` | Replace condition with `replansUsed < 0` | Invalid count reached review and returned the wrong refusal at `trident/build-run.test.ts:656` | GREEN |
| Positive declaration branch, `trident/gates/review-panel.ts:90` | Compare action against `continue` instead of `re-plan` | Valid first gap blocked at `trident/gates/review-panel.test.ts:114` | GREEN |

### Validation

- Requested bounded command: `bun test trident/build-run.test.ts trident/build-host.test.ts trident/gates/ trident/__tests__/escalation-gate.test.ts` — 196 pass, 0 fail, 797 assertions across 9 files.
- Kept G073 certification passed with that command; current anchors are `trident/__tests__/escalation-gate.test.ts:588` and `trident/__tests__/escalation-gate.test.ts:603`.
- `bun run typecheck` reported script not found. Positive-control search `rg -n '"(typecheck|test:bun)"' package.json` matched `test:bun` at `package.json:61`; it did not match a typecheck script.
- Both `bunx tsc --noEmit` and `bunx tsc --noEmit -p trident/tsconfig.json` passed.
- ESLint passed for the six changed TypeScript files, enumerated by `git diff --name-only` before adding this record. `git diff --check` passed.

### Scope and decisions

This implements the supplied G073 target without changing product policy.
The existing APPROVE-plus-escalation refusal assertions remain; their declarations
are contradictory under the kept validator (`trident/gates/escalation.ts:85`).
Two existing panel expectations now include the measured blocking count
(`trident/gates/review-panel.test.ts:73`).

Deliberately did not edit the kept escalation gate, orchestration, inner loop,
workflow script, gateway, or application entrypoints; did not add flags, another
planning implementation, or durable storage. The diff is limited to the three
owned implementation files, their three test files, and this record. This record
uses the lane-requested location instead of the general tracking default. No
push, PR creation, or merge is part of this lane.
