## Issue #562 — share the dispatch rejection-code union

### What changed

The board-bound dispatch module remains the single declaration owner for
`BoardBoundBuildRejectionCode` (`trident/board-dispatch.ts:434-467`). The HTTP
surface now imports that type directly (`gateway/http/work-board-surface.ts:54`)
and uses it for the rejected member of `WorkBoardStartResult`
(`gateway/http/work-board-surface.ts:87-93`). The former literal union and its
instruction to update two declarations were deleted.

The production composer returns the dispatch result's code through that surface
contract (`open/composer.ts:4423-4457`). This assignment is the compile-time seam
that makes a narrowing on either side fail instead of permitting the declarations
to drift.

### Decisions

The consumer imports from the declaration's module rather than introducing a
third alias. The package entry point already re-exports the same type
(`trident/index.ts:199-208`), but the gateway's nearby trident dependencies also
use direct module imports (`gateway/http/work-board-surface.ts:52-55`), so the
direct type-only import follows the existing boundary without adding runtime work.

No new rejection outcome was added. The existing HTTP outcome vocabulary keeps
its current classification: `underspecified` returns the accepted clarification
response, `backend_error` maps to 500, and every other rejection defaults to 409
(`gateway/http/work-board-surface.ts:471-480`).

The maintained invariant is a single exported union consumed by both result
types: `BoardBoundBuildResult` uses it at `trident/board-dispatch.ts:469-497`, and
`WorkBoardStartResult` uses it at `gateway/http/work-board-surface.ts:87-93`.
TypeScript checks the production assignment at `open/composer.ts:4457`; this does
not depend on a runtime caller reaching the failure branch.

### Mutation table

| Guard | Mutation and printed landing | Red result | Restored result |
| --- | --- | --- | --- |
| Shared rejection union at `gateway/http/work-board-surface.ts:91` | Replaced the field with `Exclude<BoardBoundBuildRejectionCode, 'backend_error'>`; the landed line was printed before the check | `bunx tsc -p open/tsconfig.json --noEmit` failed at `gateway/http/work-board-surface.ts:479` and the production assignment `open/composer.ts:4457` because `backend_error` no longer fit | Restored `BoardBoundBuildRejectionCode`; the same command passed |

### Verification

`bun test gateway/http/work-board-surface.test.ts`: 56 pass, 0 fail, 175
assertions. `bunx tsc -p open/tsconfig.json --noEmit`: green after restoration.
`bash scripts/ci/lint.sh`: every lint gate green. `git diff --check`: green.

The complete checker `bash scripts/ci/typecheck-all.sh` enumerated 51 TypeScript
configs. The affected `open/tsconfig.json` and `trident/tsconfig.json` passed, but
the matrix remains red on unrelated existing errors at
`gateway/transcription/__tests__/whisper-install.test.ts:186`,
`onboarding/history-import/__tests__/zip-writer.ts:10`, and
`logger/__tests__/fire-and-forget.test.ts:301`, plus the app config's missing
implicit type library.

The type-name search was enumerated with
`rg -n 'BoardBoundBuildRejectionCode|deliberate hand-copy'` across the relevant
TypeScript files. It positively found the declaration at
`trident/board-dispatch.ts:434`, its result use at
`trident/board-dispatch.ts:497`, its package re-export at `trident/index.ts:207`,
and the HTTP import/use at `gateway/http/work-board-surface.ts:54` and `:91`; it
found no remaining `deliberate hand-copy` instruction.

### Deliberately not changed

No equality test or second literal list was added, because that would restate the
copy instead of removing it. Runtime status mapping and dispatch behavior were
not changed. No feature flag or alternate path was added. `SPEC.md` was not
changed because the product behavior and decisions are unchanged. The full test
suite was not run, per the lane instruction.
