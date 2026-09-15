## 2026-09-15 — Lead Work Board fragments with PR number and title

### What changed

The per-turn board heading now describes PR/title-first entries at `work-board/fragment.ts:47`. Each rendered item uses its durable PR number when present, then its escaped title, with status and activity after the title at `work-board/fragment.ts:71-72`. A PR-less item begins directly with its title; the internal board id is not rendered.

The focused regression at `work-board/fragment.test.ts:43-52` exercises both directions: a PR-backed item must render `PR #265 — A`, a PR-less item must render `B`, and neither internal fixture id may appear. Existing activity and blocked-lane expectations were updated to the title-first shape at `work-board/fragment.test.ts:54-83` without weakening their marker assertions.

### Evidence and decisions

The filed citation remained current: `work-board/fragment.ts:47` contained the id/paste instruction, while the item construction began at `work-board/fragment.ts:62` and rendered the id before the title on the former line 71. Durable PR provenance is part of `WorkBoardItem` at `work-board/store.ts:94-108`, included in the selected columns at `work-board/store.ts:285`, and mapped into returned items at `work-board/store.ts:552-553`.

The formatter uses `pr` rather than deriving a number from `pr_url`, because `pr` is the stored number and `pr_url` may legitimately be null for a non-GitHub or unresolved repository (`work-board/store.ts:101-108`). No new outcome, error, state, or refusal was introduced, so there is no outcome vocabulary to extend. No spec decision changed.

The complete formatter-field check was enumerated with `rg -n "item\\.(id|pr)" work-board/fragment.ts`: the positive control found `item.pr` at line 71 and found no `item.id`, establishing that the formatter no longer reads the internal id. The distinctive old/new heading check was enumerated with `rg -n "id in parens|PR number and title first" work-board/fragment.ts work-board/fragment.test.ts`: it found only the new heading at `work-board/fragment.ts:47`.

### Mutation and validation

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| `work-board/fragment.ts:71` selects `PR #N — ` for non-null `pr` and no prefix otherwise | Replaced the expression with an internal-id prefix; printed `work-board/fragment.ts:71` to prove the mutation landed | `bun test work-board/fragment.test.ts`: 4 failed, including `leads with PR number and title, and does not expose the internal item id` | `bun test work-board/fragment.test.ts`: 7 passed, 0 failed |

`bash scripts/ci/lint.sh` passed every reported gate. `bash scripts/ci/typecheck-all.sh` checked 51 configurations; `work-board/tsconfig.json` passed, while the matrix failed only in untouched files: `app/tsconfig.json` could not find the `@types` type definition, `gateway/tsconfig.json` and the root config reported existing errors in `gateway/transcription/__tests__/whisper-install.test.ts:186` and `onboarding/history-import/__tests__/zip-writer.ts:10`, and `logger/tsconfig.json` plus the root config reported `logger/__tests__/fire-and-forget.test.ts:301`. `git diff --check` passed.

### Deliberately not changed

The stored id and all id-based Work Board tool contracts remain unchanged; only the compact prompt fragment stopped exposing the id. PR links were not added to the plain-text fragment because the requested lead is the durable number and title, and `pr_url` may be null by design at `work-board/store.ts:103-108`. No spec-item or `SPEC.md` content changed because this implementation does not alter a product decision.
