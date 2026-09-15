## Issue 992 — keep-in-place gate tests

### What changed

The existing G083 publication-prerequisite table now includes successful 40- and 64-character branch-head cases at `trident/orchestrator.test.ts:365`. The success assertions at `trident/orchestrator.test.ts:390` pin both accepted constants, require a completed run, require exactly one leased push, and require the review dispatch.

The previously present G018 cases at `trident/orchestrator.test.ts:343` separately cover empty, non-string, and usable dispatch identifiers. The previously present G085 cases at `trident/orchestrator.test.ts:440` separately cover a present remote branch, an absent remote branch, and an unreadable remote state; the unreadable case pins the three-attempt budget at `trident/orchestrator.test.ts:471`.

### Corrected locations and reachability

The issue inherited pre-extraction inventory locations. Searching by the quoted properties found G018 at `trident/orchestrator.ts:3610`, with its refusal at `trident/orchestrator.ts:3611`; G083 at `trident/orchestrator.ts:1613` and `trident/orchestrator.ts:1621`; and G085's observation and refusal at `trident/orchestrator.ts:1658` and `trident/orchestrator.ts:1661`.

Reachability was measured by compiling wrong-answer mutations at those exact lines. G018's invalid cases advanced to `forge-init`, G083's five refusal cases reached later publication outcomes, and G085's unreadable case made five observations instead of stopping after three. The restored positive cases reached launch, leased push, and review dispatch respectively.

### Decisions

The accepted full-head widths are pinned in the same scenario table as the G083 refusals so the success and failure boundaries share one fixture. Both widths are explicit because the production predicate accepts exactly 40 or 64 hexadecimal characters at `trident/orchestrator.ts:1621`; a relational assertion would not protect either constant.

G085 keeps three distinct states because empty successful output means an absent branch at `trident/orchestrator.ts:1664`, while a failed observation is refused at `trident/orchestrator.ts:1661`. Collapsing those outcomes would lose the lease distinction asserted at `trident/orchestrator.test.ts:470` and `trident/orchestrator.test.ts:477`.

### Mutation table

| gate | exact edit | landed at | tests that reddened | mutated → restored |
| --- | --- | --- | --- | --- |
| G018 | `if (typeof id !== 'string' \|\| id.length === 0)` → `if (false)` | `trident/orchestrator.ts:3611` | empty string; `undefined` | 1 pass / 2 fail → 3 pass / 0 fail |
| G083 refusal | PR-mode predicate and local-head predicate → `if (false)` | `trident/orchestrator.ts:1613`, `trident/orchestrator.ts:1621` | local mode, read failure, empty head, abbreviated head, nonhex head | 0 pass / 5 fail → 5 pass / 0 fail |
| G083 constants | `{40}`/`{64}` → `{41}`/`{65}` | `trident/orchestrator.ts:1621` | full-40; full-64 | 5 pass / 2 fail → 7 pass / 0 fail |
| G085 | `if (!observed.ok)` → `if (false)` | `trident/orchestrator.ts:1661` | unknown remote state | 2 pass / 1 fail → 3 pass / 0 fail |

### Deliberately not changed

No production file remains modified. The inventory and product specification were not changed: this lane is tests-only, and no product decision changed. The full test suite was not run; validation was limited to the requested test file plus repository typecheck and lint gates.
