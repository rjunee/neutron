## 2026-09-23 — Recover an interrupted task ledger commit without refunding spend

The host previously committed the intermediate task ledger before checkpointing
the resulting head. A process exit between those writes left a builder checkpoint
behind the Git tip, causing a full rebuild with the completed task still absent
from durable iteration spend. The existing after-ledger crash test interrupted
after the checkpoint, so it did not cover that boundary.

The completed intermediate-build checkpoint now records the original iteration,
builder head and exact ticked ledger bytes (`trident/build-run.ts:709`). The
checkpoint append and run/card spend projection share the existing transaction;
reconciliation takes the maximum of consumed iterations and the pending completed
task's charge (`trident/store.ts:1167`, `trident/store.ts:1219`). Handoff settlement
clears the intent without charging again (`trident/production-host-effects.ts:458`).
Old checkpoints acquire an intent before their next ledger write.

A moved tip is adopted only when Git proves a single parent equal to the recorded
builder, exactly the branch ledger path changed, and the complete regular-file
tree entry matches the expected blob and path. The host remeasures before
accepting (`trident/production-host-effects.ts:423`). Arbitrary moved heads retain
their spent iteration and rebuild under the next identity after a budget check
(`trident/build-run.ts:487`, `trident/build-run.ts:564`). An empty regenerated diff
also retires its spent intent before rebuilding (`trident/build-run.ts:529`): a
production regression first reproduced the invalid handoff-plus-pending state,
then verified both the exhausted refusal and remaining-budget continuation.

Latest intent recovery refuses an older task identity if run or linked-card spend
has advanced beyond that single charge (`trident/store.ts:1198`). Historical
checkpoint parsing validates intent shape independently of later plan refreshes,
so old completion events remain usable by receipt readers
(`trident/build-mode-state.ts:90`).

Consuming tests interrupt before Git, after Git but before checkpoint, after
checkpoint, and again during recovery, in PR and local modes. They reach the next
task and merge without redispatching completed work. Differing-head siblings
exercise exhausted and remaining budgets against real Git and SQLite/card state
(`open/__tests__/project-build-e2e.test.ts:3048`,
`open/__tests__/project-build-e2e.test.ts:3138`). Production controls reject extra
files, wrong ledger bytes, grandchildren, merge commits, malformed intents and
stale run/card spend, while allowing a valid child and legacy checkpoints
(`trident/production-host-effects.test.ts:1003`). The mutation test removes parent,
ledger-only, spend and stale-identity guards separately, and also refuses valid
recovery; each mutant fails its named behavioral control
(`trident/task-ledger-intent-mutation.test.ts:10`).

The same-run spec and G038 inventory now state the narrow authenticated ledger
exception. This change does not establish deployment or live acceptance, which
remain required by the spec's delivery criterion.

Verification: the driver, production effects, spend provenance, cross-run retry,
same-run crash mutations and ledger-intent mutations pass together: 564 tests.
The complete Open project-build E2E file passes on stable final source: 256 tests,
with temporary Unix sockets allowed for its owner-broker fixtures. The initial
sandboxed run had nine socket-listen permission failures; the complete permitted
rerun passes those fixtures as well as every ledger case.
Both `bunx tsc -p tsconfig.json --noEmit` and
`bunx tsc -p trident/tsconfig.json --noEmit` pass on the final implementation.
The optional local whole-tree leak scan reports 455 denylist findings, with the
same category counts on the untouched parent revision (167 literal and 288 word
findings); this change does not claim that repository-wide gate is green.
