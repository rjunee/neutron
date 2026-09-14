## Issue 617 — unbound cards render their state

### What changed

Work-board phase tags now fall back to the card's durable lane when run progress is absent. The app derivation is at `app/lib/work-board-helpers.ts:207`; its web mirror is at `landing/chat-react/WorkBoardTab.tsx:202`. Bound progress remains authoritative because both implementations enter the existing run-step switch after the no-progress fallback at `app/lib/work-board-helpers.ts:224` and `landing/chat-react/WorkBoardTab.tsx:219`.

The store, rather than the component, establishes the conditions. Each item owns a durable status and optional run binding at `work-board/store.ts:68-85`. Dispatch binds the run and writes `in_progress` together at `work-board/store.ts:1249-1263`. Reopening or re-queueing clears a stale binding at `work-board/store.ts:1024-1066`. These are therefore distinct inputs: a bound card with live or terminal run detail, and an unbound card whose durable lane is the available state.

### Vocabulary and consumers

The fallback joins the existing `PhaseTag` vocabulary at `app/lib/work-board-helpers.ts:188-191` and `landing/chat-react/WorkBoardTab.tsx:183-186`; it does not add a wire phase or store outcome. Nonterminal durable lanes use the existing build color bucket, while done, failed, and blocked keep their existing merge, failed, and blocked classifications at `app/lib/work-board-helpers.ts:212-221` and `landing/chat-react/WorkBoardTab.tsx:207-216`.

Consumers were completely enumerated with `rg -n 'stepTag\(' app landing`: besides the two definitions, the render consumers are `app/components/WorkBoardRow.tsx:131-132` and `landing/chat-react/WorkBoardTab.tsx:1076-1078`. Both consume tags generically: the app looks up the returned existing color key at `app/components/WorkBoardRow.tsx:322-329`; the web renders the returned existing class at `landing/chat-react/WorkBoardTab.tsx:1223-1225`. Thus neither has an unknown-value default to fall into.

### Tests and mutation evidence

The pure regression covers unbound upcoming and in-progress states at `app/__tests__/work-board-helpers.test.ts:150-153`. The rendered regression pairs an unbound Upcoming card with a bound Reviewing control at `landing/chat-react/__tests__/work-board-tab.test.tsx:261-294`. The prior queued-row test now asserts the durable tag and absence of an invented round at `landing/chat-react/__tests__/work-board-tab.test.tsx:584-624`; its old bare-title assertion directly encoded the defect and was replaced, not loosened.

| Guard | Mutation | Red evidence | Restored evidence |
|---|---|---|---|
| App no-progress fallback, `app/lib/work-board-helpers.ts:210` | Changed the condition to `rp === undefined && false`; printed the mutated line before execution | `falls back to the card state when no run is bound` failed | Focused app test: 61 pass, 0 fail |
| Web no-progress fallback, `landing/chat-react/WorkBoardTab.tsx:205` | Changed the condition to `rp === undefined && false`; printed the mutated line before execution | 19 web tests failed, including the bidirectional regression | Combined focused run: 102 pass, 0 fail |

Validation: `bun run --cwd app typecheck` passed; `bunx tsc -p landing/tsconfig.json --noEmit` passed; touched-file ESLint passed. The full app lint reached ESLint but remains red on the pre-existing out-of-scope error at `app/app/projects/[id]/cores/dtc-analytics.tsx:279`; none of its findings named a touched file.

### Decisions and deliberate omissions

Run detail continues to refine the durable lane instead of being replaced by a universal Upcoming label; the bound Reviewing control proves that direction. No store schema, wire phase, client parser, feature flag, or second code path was added. `SPEC.md` and spec-item decisions were not changed because this fixes the filed rendering defect without changing product policy. Out-of-scope lint debt was not edited.

Two presentation comments outside the primary implementation files were corrected because they asserted the removed bare-title behavior: `app/components/WorkBoardRow.tsx:217-219` and `landing/chat-react.html:820-821`. No runtime logic changed in either file.
