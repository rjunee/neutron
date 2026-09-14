## 2026-09-14 — A work-item dot opens that item's worker

### What changed

The leading work-item dot no longer advances status. On web it invokes the row's inspector callback and status advancement has a separate labelled control (`landing/chat-react/WorkBoardTab.tsx:1143-1150`, `landing/chat-react/WorkBoardTab.tsx:1200-1201`). Mobile has the same split (`app/components/WorkBoardRow.tsx:233-249`, `app/components/WorkBoardRow.tsx:292-293`). Both real board screens pass the selected item's id to their clients (`landing/chat-react/WorkBoardTab.tsx:724-733`, `landing/chat-react/WorkBoardTab.tsx:868-880`, `app/app/projects/[id]/workboard.tsx:350-359`, `app/app/projects/[id]/workboard.tsx:423-438`).

The authenticated item-scoped route is `GET /api/app/projects/<project>/work-board/<item>/worker` (`gateway/http/work-board-surface.ts:367-372`). It first reads the requested item in its already authenticated board scope, then follows only that item's `linked_run_id` (`gateway/http/work-board-surface.ts:393-410`). Production inspection feeds the run's primary and rebase worktree paths to the existing exact-ownership observer (`open/composer.ts:4534-4538`); that observer matches registered sessions by resolved worktree path (`runtime/adapters/claude-code/persistent/observe-workers.ts:6-18`).

### Decision and outcome vocabulary

The endpoint introduces one closed result vocabulary: `running`, `finished`, and `unknown` (`gateway/http/work-board-surface.ts:388-391`). A live run becomes `running` only after its exact-worktree observation resolves to `working` or `blocked`; terminal runs and terminal cards are `finished`; absent links, absent run rows, unavailable inspection, and an observer that cannot identify an owner all become `unknown` (`gateway/http/work-board-surface.ts:400-427`). The clients render each arm explicitly (`landing/chat-react/WorkBoardTab.tsx:842-846`, `app/app/projects/[id]/workboard.tsx:370-378`), so the default cost of incomplete resolution is a visible refusal to identify a worker, never a plausible sibling.

The invariant is maintained continuously by the board item's durable `linked_run_id`, read anew for every inspector request (`gateway/http/work-board-surface.ts:400-410`), and by worktree ownership matching in the observer (`runtime/adapters/claude-code/persistent/observe-workers.ts:6-23`). It does not require the selected worker to answer: a missing, exited, or unobservable session returns `unknown`.

### Mutation evidence

| Guard | Mutation | Landed line | Red | Restored |
|---|---|---|---|---|
| Requested item selects the worker | replaced `store.get(scope, item_id)` with the second board row | `gateway/http/work-board-surface.ts:400` | expected `run-a` / `screen:run-a`, received `run-b` / `screen:run-b` | focused test: 1 pass |
| The dot is wired to inspection | replaced `onInspect` with `onAdvance` | `landing/chat-react/WorkBoardTab.tsx:1146` | expected request `a`, received no worker request | focused test: 1 pass |

The exact-item gateway test asserts both directions: item A returns A's run and screen, while the observer call list excludes B (`gateway/http/work-board-surface.test.ts:418-441`). The real web surface clicks A's rendered dot, asserts the request path names A, asserts A's screen is shown, and asserts B's screen is absent (`landing/chat-react/__tests__/work-board-tab.test.tsx:895-918`). The mobile render test proves the dot and the separate advance control invoke different callbacks (`app/__tests__/work-board-row-brief-alert.test.tsx:77-94`).

### Verification

- `bun test gateway/http/work-board-surface.test.ts` — 58 pass, 0 fail.
- `bun test landing/chat-react/__tests__/work-board-tab.test.tsx` — 42 pass, 0 fail.
- `bun test app/__tests__/work-board-row-brief-alert.test.tsx` — 4 pass, 0 fail.
- `bun test app/__tests__/work-board-client.test.ts` — 24 pass, 0 fail.
- `EXPO_NO_TELEMETRY=1 bun run lint` from `app/` — 0 errors; existing warnings remain outside this change.
- Root `bunx tsc --noEmit` reaches three existing unrelated errors in transcription, logger, and history-import tests; it reports no error in a changed file. App-local typecheck cannot start because the installed dependency tree contains an invalid implicit `@types` entry.

### Deliberately not changed

`work-board/store.ts` ordering was not touched. The existing project activity inspector remains project-scoped; the work-item inspector is a separate exact-run read because a project can have several workers. No feature flag or fallback-to-latest path was added. `SPEC.md` product decisions did not change. The current retry spec wording was corrected from “status-dot advance” to “status-advance control” at `docs/spec-items/a-retry-must-resume-from-the-checkpoint.md:23` and `docs/spec-items/a-retry-must-resume-from-the-checkpoint.md:106`; the frozen historical record was left unchanged.
