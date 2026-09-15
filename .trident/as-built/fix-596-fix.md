## Issue 596 — usage spend, waste, and throughput

### What changed

The authenticated usage dashboard response now carries an `analytics` sibling beside the existing quota pools (`gateway/http/app-usage-surface.ts:39-51,86-87`). The Open composition reads it from the same project database as the existing quota series (`open/composer.ts:4961-4979`).

`TridentUsageAnalytics` joins phase snapshots to their run records, reports token totals by repository basename and phase, classifies terminal waste through the existing `terminalRunDisposition` vocabulary, and ranks terminal runs by elapsed seconds (`trident/usage-analytics.ts:88-101,104-150`). `approved` and `not-terminal` are the existing vocabulary's non-waste defaults (`trident/usage-analytics.ts:89-96`); unclassified or unmeasured outcomes remain unknown rather than becoming zero (`trident/usage-analytics.ts:56-70,131-145`).

Both dashboard decoders retain an explicit `unknown | partial | complete` measurement state. The web and mobile settings surfaces render exact values, lower bounds with `≥`, and unknown values distinctly (`landing/chat-react/SettingsTab.tsx:1647-1683`; `app/app/usage.tsx:269-302`).

### Decisions

Token counters are summed as disjoint counters because the phase-usage contract calls input uncached and names both cache counters separately (`trident/phase-usage.ts:3-12`). The wire amount also names its unit instead of relying on a global implicit unit (`trident/usage-analytics.ts:5-16`), leaving a typed extension point for another billed quantity later.

Historical model identity is not inferred from current settings. The stored phase row has no model column (`migrations/0144_trident_phase_usage.sql:11-22`), so the model breakdown is an explicit unknown seam (`trident/usage-analytics.ts:18-25,136-141`).

Waste is measured only for terminal runs that the existing disposition taxonomy does not classify as approved. Unknown phase rows remain in each waste group so a measured subset cannot render as an exact total (`trident/usage-analytics.ts:88-101,113-115`). The terminal-cause value refines full-budget exits, and missing cause evidence increments the unclassified count (`trident/usage-analytics.ts:80-101,131-145`).

### Mutation evidence

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| All-null counters are unknown (`trident/usage-analytics.ts:56-58`) | returned `0` for an all-null row; mutation printed at line 58 | `unknown rows stay unknown instead of becoming zero` expected unknown/null and received partial/0 | `bun test trident/usage-analytics.test.ts`: 2 pass |
| Unknown phases keep a waste total partial (`trident/usage-analytics.ts:113-115`) | filtered waste rows to measured rows only; mutation printed at line 115 | attribution test expected partial and received complete | `bun test trident/usage-analytics.test.ts`: 2 pass |

### Validation

- `bun test trident/usage-analytics.test.ts gateway/__tests__/app-usage-surface.test.ts gateway/__tests__/usage-dashboard-client-parity.test.ts`: 66 pass.
- `bun test landing/chat-react/__tests__/usage-dashboard-web.test.tsx`: 37 pass.
- `bun test app/__tests__/usage-dashboard-reachable.test.tsx`: 25 pass.
- `bunx tsc -p trident/tsconfig.json --noEmit`, `bunx tsc -p gateway/tsconfig.json --noEmit`, and `bunx tsc -p landing/chat-react/tsconfig.json --noEmit`: pass.
- `bunx eslint` over every touched TypeScript/TSX file and `git diff --check`: pass.
- The app package's declared `bun run typecheck` stops before source checking with `TS2688: Cannot find type definition file for '@types'`; the same error occurs through `bunx tsc -p app/tsconfig.json --noEmit`.

### Deliberately not done

No price table, currency conversion, per-card cost attribution, or shared-turn attribution was added. No current model was projected backward onto historical phase rows. No production phase-usage instrumentation was invented: the current tree seeds the rows (`migrations/0144_trident_phase_usage.sql:37-43`) and exposes a validated writer (`trident/phase-usage.ts:38-58`), but a whole-tree production-call search found no caller; the schema occurrence at `migrations/0144_trident_phase_usage.sql:11-33` was the positive control. Until another change connects that existing writer, the dashboard correctly presents those totals as unknown.

The filed scope did not change `SPEC.md` or an in-repository spec item, so neither was edited.
