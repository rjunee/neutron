## Issue #516 — show both build counters on work cards

### What changed

The canonical live run snapshot now includes the persisted outer build counter alongside the inner review counter (`trident/run-progress.ts:60-73`, `trident/run-progress.ts:221-227`). The mobile and web decoders preserve that counter while defaulting an older frame to the first task (`app/lib/work-board-client.ts:410-420`, `landing/chat-react/work-board-client.ts:465-473`).

Both card implementations render the pair as `<task>.<review>`, converting the stored zero-based outer counter to the owner-facing one-based task number (`app/lib/work-board-helpers.ts:337-342`, `landing/chat-react/WorkBoardTab.tsx:323-328`). A stored outer counter of 1 with inner counter 1 therefore reads `2.1` (`app/__tests__/work-board-helpers.test.ts:113-115`); the web renderer independently exercises a stored outer counter of 1 (`landing/chat-react/__tests__/work-board-tab.test.tsx:225-254`).

The `codegen_status` adapter now derives the live step and both counters from the same canonical snapshot instead of returning the raw machine phase (`gateway/codegen-cancel-router.ts:105-120`). Its re-fired-run fixture requires the status and fetch views to report `reviewing`, inner counter 1, and outer counter 1 together (`gateway/__tests__/codegen-cancel-router.test.ts:172-187`).

### Decisions

The stored `ralph_round` remains unchanged and zero-based; only card presentation adds one. The durable re-fire path increments it atomically when preparing the next task (`trident/orchestrator.ts:4920-4930`), so the invariant is maintained by the same persistence operation that releases the prior worker and does not depend on that worker continuing to run (`trident/orchestrator.ts:4912-4919`).

No new outcome was introduced. Status joins the existing `RunStepLabel` vocabulary—`building`, `reviewing`, `fixing`, `merging`, `done`, and `failed`—whose canonical type and checkpoint mapping live at `trident/run-progress.ts:35-53` and `trident/run-progress.ts:123-143`. An unrecognized live checkpoint defaults to `building` (`trident/run-progress.ts:142-143`).

The complete production surface set was enumerated with `rg -n "function roundText|ralph_round: typeof r\['ralph_round'\]|deriveRunProgress\(run" app landing trident gateway --glob '*.ts' --glob '*.tsx'`. It found both card formatters, both client decoders, the canonical derivation, and the status adapter. As a positive control, the same search found the known canonical calls throughout `trident/run-progress.test.ts`; there was no additional production card formatter or decoder in those roots.

### Mutation table

| Guard | Compiling mutation | RED | Restored GREEN |
|---|---|---|---|
| Canonical outer-counter projection at `trident/run-progress.ts:226` | Forced the projected value to 0 | `a re-fired second task carries outer counter 1 beside inner round 1` received 0 | Focused six-file run: 208 pass, 0 fail |
| Mobile decoder at `app/lib/work-board-client.ts:420` | Forced the decoded value to 0 | Explicit progress decoder expected 1 and received 0 | Focused six-file run: 208 pass, 0 fail |
| Web decoder at `landing/chat-react/work-board-client.ts:473` | Forced the decoded value to 0 | Valid-progress decoder expected 1 and received 0 | Focused six-file run: 208 pass, 0 fail |
| Mobile one-based display at `app/lib/work-board-helpers.ts:342` | Removed `+ 1` | Re-fired task rendered `1.1` instead of `2.1` | Focused six-file run: 208 pass, 0 fail |
| Web one-based display at `landing/chat-react/WorkBoardTab.tsx:328` | Removed `+ 1` | Re-fired fixture rendered `1.2` instead of `2.2` | Focused six-file run: 208 pass, 0 fail |
| Status live-step derivation at `gateway/codegen-cancel-router.ts:108-113` | Returned the stored phase for status and phase | Re-fired fixture returned `argus` instead of `reviewing` | Focused six-file run: 208 pass, 0 fail |

Each mutation line was printed before its failing test ran, then restored before the green run.

### Verification

`bun test trident/run-progress.test.ts app/__tests__/work-board-helpers.test.ts app/__tests__/work-board-client.test.ts landing/chat-react/__tests__/work-board-client.test.ts landing/chat-react/__tests__/work-board-tab.test.tsx gateway/__tests__/codegen-cancel-router.test.ts`: 208 pass, 0 fail, 534 assertions.

The root package has no `typecheck` or lint script (`package.json:57-62`). `bunx tsc --noEmit` passed, and `bunx eslint` passed for every touched TypeScript and TSX file.

### Deliberately not changed

The counter persistence model and re-fire transition were not changed; they already write the outer counter atomically (`trident/orchestrator.ts:4912-4930`). Terminal cards still omit a counter pair (`app/lib/work-board-helpers.ts:338-342`, `landing/chat-react/WorkBoardTab.tsx:324-328`). No feature switch, parallel rendering path, heartbeat work, or product-spec decision was added.
