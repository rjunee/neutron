## 2026-10-01 — Initialize the activity test DOM before loading React DOM

The partitioned consuming suite exposed an order-dependent Work Board failure:
`work-activity.test.tsx` passed immediately before `work-board-tab.test.tsx`, but
the latter's real input and Add-button interaction never sent its POST. Running
the Work Board file alone passed. The activity fixture imported
`react-dom/client` at module load, before its `beforeAll` registered happy-dom.
React DOM caches DOM and input-event support on import, so the later synthetic
input event did not update the controlled title. The empty title disabled Add.

The activity fixture now imports `react-dom/client` inside `beforeAll`, after
registering happy-dom. Its existing hook and drawer tests still use the real
React root. No Work Board interaction, production code, or runner coverage was
changed. The existing Work Board test remains the consuming regression: it
sets the input through the native setter, dispatches `input`, clicks Add, and
asserts the POST title and re-fetch.

Verification on the change: activity alone 12 pass; Work Board alone 52 pass;
both files in either order 64 pass. Restoring the eager React DOM import as a
temporary, syntax-valid mutation reproduced the exact POST failure (63 pass,
1 fail). A temporary blanket refusal to initialize when a DOM was present
failed the standalone activity fixture, confirming that legitimate DOM setup
must remain allowed. Both mutations were restored. Root, Trident, and chat
React TypeScript checks passed. The complete partitioned suite remains for the
final gate.
