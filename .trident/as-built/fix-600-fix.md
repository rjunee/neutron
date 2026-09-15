## Issue #600 — the native work-item dot opens its worker inspector

### What changed

The native active-row status dot is again a labelled button whose press invokes the row's `onInspect` callback (`app/components/WorkBoardRow.tsx:244-262`). Status advancement remains a different, explicitly labelled arrow control routed through `requestAdvance` (`app/components/WorkBoardRow.tsx:304-310`). The redundant search-glyph inspector action was removed from that action cluster.

The existing exact-item plumbing remains the destination: the work-board screen passes the selected row to `inspectWorker` (`app/app/projects/[id]/workboard.tsx:351-360`, `app/app/projects/[id]/workboard.tsx:428-442`), and the HTTP surface loads that item, reads its `linked_run_id`, and resolves the run before observing it (`gateway/http/work-board-surface.ts:356-390`). No new outcome was added, so there is no outcome vocabulary or default classification to extend.

### Evidence and issue-citation correction

The filed citation predates the prerequisite change. In this checkout, the native dot is at `app/components/WorkBoardRow.tsx:244-262`, not the filed lines 232-238. Before this change it was inert and inspection lived in a separate action; after this change its accessible button invokes inspection. The web client already satisfies the same interaction at `landing/chat-react/WorkBoardTab.tsx:1143-1150`, and its status arrow remains separate at `landing/chat-react/WorkBoardTab.tsx:1200-1202`.

Call sites were enumerated with `rg -n 'onInspect=|onInspect:' app landing/chat-react --glob '!**/__tests__/**' --glob '!**/node_modules/**'`: the production bindings are the web row at `landing/chat-react/WorkBoardTab.tsx:879`, its row prop at `landing/chat-react/WorkBoardTab.tsx:1081`, and the native row at `app/app/projects/[id]/workboard.tsx:442`. For the absence check on a second native inspector glyph, `rg -n 'glyph="(⌕|→)"' app/components/WorkBoardRow.tsx` found the known-positive arrow at `app/components/WorkBoardRow.tsx:307` and no search glyph.

### Test and mutation table

The mounted native-row test asserts that the dot has button semantics, invokes item A's inspection callback, never names item B, and does not advance status (`app/__tests__/work-board-row-brief-alert.test.tsx:78-94`).

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| Dot `onPress` routes to `onInspect` (`app/components/WorkBoardRow.tsx:248`) | Replaced it with `onPress={undefined}`; the printed mutation landed at line 248 | `the dot calls this row's inspector callback, while status advance stays separate` failed because `opened` was `[]` rather than `['item-a']` | `bun test app/__tests__/work-board-row-brief-alert.test.tsx`: 6 pass, 0 fail |

`EXPO_NO_TELEMETRY=1 bun run lint` completed with 0 errors and 21 pre-existing warnings outside the touched files. `bun run typecheck` could not enter source checking because TypeScript reported `TS2688`, a missing implicit `@types` definition. `git diff --check` passed.

### Decisions and deliberate exclusions

The dot owns inspection because it is the pulsing worker affordance named by the acceptance criterion; the arrow continues to own status mutation. This restores the requested interaction without adding a third meaning or a duplicate action. The mounted test continuously guards that division and does not depend on the inspector backend being healthy.

No web, server, inspector-result, or spec change was made. Web already routes its dot to the selected item (`landing/chat-react/WorkBoardTab.tsx:1143-1150`), and the server's existing result vocabulary distinguishes `running`, `finished`, and `unknown` (`gateway/http/work-board-surface.ts:351-354`), with unresolved observations defaulting to `unknown` (`gateway/http/work-board-surface.ts:373-385`). The current product decision did not change; this repairs the later native regression.
