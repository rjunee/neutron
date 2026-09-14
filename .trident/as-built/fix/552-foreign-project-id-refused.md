## 2026-09-14 — Refuse foreign board item IDs (#552)

### Change and evidence

Null update and completion results now return `{ok:false,error}` naming the
supplied ID and current-board boundary, through `work-board/agent-tool.ts:162`,
`:392` and `:431`. Reorder validates every supplied card reference (`id`,
`before`, `after`, `precedes`) against the scoped lookup before invoking the
store (`work-board/agent-tool.ts:483`). Foreign references cannot silently append
an otherwise local card through this tool.

The refusal joins the existing boolean `ok` / string `error` result vocabulary
(`work-board/agent-tool.ts:108`). It is an ordinary refused tool answer, not a new
exception class subject to an unknown default. Removal already uses this shape
(`work-board/agent-tool.ts:573`), and its scoped lookup precedes cancellation and
document effects (`work-board/removal.ts:140`). Build dispatch maps its existing
`unknown_board_item` outcome into the same answer (`trident/board-dispatch.ts:608`,
`trident/work-board-build-tool.ts:278`).

### Surface enumeration and acceptance evidence

The test runs both registration functions with removal enabled, enumerates
`registry.list()`, executes every `work_board_` handler, and checks the resulting
name set (`work-board/foreign-project-tools.test.ts:26`, `:40`, `:73`). The eight
executed names are work_board_add, work_board_complete,
work_board_dispatch_build, work_board_list, work_board_remove,
work_board_reorder, work_board_start, and work_board_update.

Every ID-taking handler refuses the foreign card with its ID in the error and
accepts a local counterpart (`work-board/foreign-project-tools.test.ts:56`).
List and add have no card-ID argument: list excludes the foreign row while
including a local positive control, and add writes locally (`:48`, `:52`).
All four reorder references have foreign refusal and local acceptance controls
(`:79`). Missing IDs are also refused (`:101`).

Previously persisted rows are not grandfathered: a foreign row already on disk
is refused on the next call, while it remains accessible from its own board.
The fixture persists both boards before each handler call (`:45`); the scoped
lookup uses project and ID, without a creation-date exception
(`work-board/store.ts:788`). Checks run on each call and do not depend on the
agent noticing the mistake or cleaning up the row.

A scoped miss means unavailable on this board, not proof of global nonexistence.
The code intentionally does not probe the foreign board to distinguish those
cases. Failed reads remain exceptions via `work-board/agent-tool.ts:156`,
verified by `work-board/foreign-project-tools.test.ts:109`.

### Mutation evidence

Each mutation was applied alone; its actual landing line and full source diff
were captured before running `bun test work-board/foreign-project-tools.test.ts`.
Each was then restored. Neither mutation survived.

| Guard | Mutation and landing | Red result | Restored result |
| --- | --- | --- | --- |
| Null mutation result refusal | `work-board/agent-tool.ts:162`: replace refusal with `{ok:true}` | Exit 1; runtime matrix and missing update/complete tests fail | Green |
| Scoped reorder references | `work-board/agent-tool.ts:484`: replace condition with `false` | Exit 1; all four foreign-reference cases, runtime matrix, missing reorder, and failed-read test fail | Green |

The precedes case still reaches the existing store refusal with the new check
removed, but fails the assertion that the error must name the refused ID
(`work-board/foreign-project-tools.test.ts:89`). This proves the loudness property,
not merely that some earlier check can reject a fixture.

Final targeted run: 80 pass, 0 fail across
`work-board/agent-tool.test.ts`, `work-board/foreign-project-tools.test.ts`,
`work-board/dependency-sequencing.test.ts`, and
`work-board/complete-refuses-live-run.test.ts`. The initial valid-build fixture
shared a branch title; distinct tool-prefixed titles fixed that collision
without weakening assertions (`work-board/foreign-project-tools.test.ts:45`).

### Decisions and deliberate limits

Kept store return contracts and existing success behavior; the change belongs
to the tool surface. No migration, foreign-row repair, project ownership model
change, feature flag, or new dispatch outcome was introduced. The scoped checks
use the existing database boundary rather than requiring the caller to recover.
Concurrent local deletion and inactive-card reorder behavior are outside this
foreign-ID refusal change.

A whole-tree `rg 'cross-scope write is a no-op|function ok' .` found the helper
positive control (`work-board/agent-tool.ts:161`) and old descriptions at
`docs/AS_BUILT.md:25831` and `:26201`. Those immutable historical records remain;
the current test description was corrected (`work-board/agent-tool.test.ts:157`).
No product decision changed. This record uses the lane-requested staging path.

### Local gates

`bunx tsc -p work-board/tsconfig.json --noEmit`, `bash scripts/ci/lint.sh`,
and `git diff --check` passed. The broader `bash scripts/ci/typecheck-all.sh`
completed all 51 configurations and exited 1; work-board passed. It
reported errors outside the changed files: missing implicit `@types` for the app
configuration (`app/tsconfig.json:3`), a typed-array assertion at
`gateway/transcription/__tests__/whisper-install.test.ts:186`, the `crc32` import
at `onboarding/history-import/__tests__/zip-writer.ts:10`, and an event overload
at `logger/__tests__/fire-and-forget.test.ts:301`. These are recorded, not repaired
outside this lane's territory. No full test-suite run was attempted.

`bash scripts/ci/leak-gate.sh --tree .` exited 3: zero findings from the rules
that ran, but the private denylist and commit-message denylist rules could not
run. This is incomplete validation, not a clean leak-gate result.
