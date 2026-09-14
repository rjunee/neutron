## Issue 719 — bound onboarding synthesis fence input

### What changed

`extractJsonObject` now refuses model output above 64 KiB before trimming or running the fence expression (`onboarding/synthesis/json-extract.ts:27-42`). The synthesis session requests at most 4,096 completion tokens (`onboarding/synthesis/synthesis-session.ts:164`), so the cap follows #712's conservative 16-characters-per-token envelope. Refusal was chosen over truncation because a partial JSON document can change meaning.

The refusal joins the extractor's existing `null` outcome (`onboarding/synthesis/json-extract.ts:22-23`). Its three synthesis callers convert that outcome through the existing record/empty-field fallbacks (`onboarding/synthesis/synthesis-session.ts:482-488`, `onboarding/synthesis/synthesis-session.ts:741-747`, `onboarding/synthesis/synthesis-session.ts:759-767`), so no new outcome taxonomy or alternate path was added.

### Tree-wide idiom enumeration

The enumeration used `rg -n --glob '*.ts' 'match\\(/.*```.*\\\\s\\*.*\\[\\\\s\\\\S\\]' .` for the overlapping-whitespace shape and `rg -n --glob '*.ts' 'match\\(/.*```.*\\[\\\\s\\\\S\\]' .` as the broader positive control. The broader search returned seven production expressions; the narrower search returned six of them:

- onboarding synthesis is now bounded before the expression (`onboarding/synthesis/json-extract.ts:27-42`).
- scribe is bounded before its expression (`scribe/extract.ts:310-332`).
- research is bounded before its anchored expression (`cores/free/research/src/backend.ts:445-453`).
- reflection removed the overlapping whitespace quantifier and retains equivalent trimmed parsing (`reflection/detector.ts:186-195`).
- daily-nudge parsing receives a 400-token model response (`gateway/tasks/p6/nudge-engine.ts:402-408`) but its exported parser itself has no character guard before the expression (`gateway/tasks/p6/nudge-engine.ts:209-218`).
- wow-action parsing receives a 600-token model response (`onboarding/wow-moment/llm-selector.ts:151-165`) but its local parser has no character guard before the expression (`onboarding/wow-moment/llm-selector.ts:201-206`).
- project-opening prose uses an anchored whole-body expression and rejects only after parsing (`gateway/wiring/build-project-opening-message.ts:249-268`).

The final three are recorded rather than silently described as bounded; changing them would exceed the task's stated scope of onboarding synthesis and its tests. The enumeration is therefore complete for TypeScript `.match(...)` fence expressions containing a cross-line capture, not a claim about every Markdown fence scanner in the repository.

### Tests and mutation evidence

The focused tests pin a just-over-bound parseable document, the slow unterminated-fence path, and a legitimate 48 KiB fenced JSON response (`onboarding/synthesis/__tests__/json-extract.test.ts:60-73`).

| Guard | Mutation and printed landing line | Mutated result | Restored result |
|---|---|---|---|
| 64 KiB pre-expression refusal | Changed `onboarding/synthesis/json-extract.ts:32` to `if (false && ...)`; printed lines 29-43 and the diff | RED: just-over-bound input parsed; focused run then timed out at 15 seconds on the slow-path fixture (exit 124) | GREEN: 12 pass, 0 fail |
| Ordinary/long complement | Changed the same line to `if (true || ...)`; printed lines 29-43 and the diff | RED: 8 ordinary and legitimate-long parsing cases failed | GREEN: 12 pass, 0 fail |

### Validation and deliberately excluded work

`bun test onboarding/synthesis/__tests__/json-extract.test.ts` passed 12 tests with 13 assertions. `bash scripts/ci/lint.sh` passed all reported guards, and `git diff --check` passed.

The two as-built guard test files passed 31 tests. The local leak gate found zero findings in the rules it could run but exited 3 and reported INCOMPLETE because the out-of-band PII denylist is unavailable in this build environment; it is not represented here as a clean run.

`bash scripts/ci/typecheck-all.sh` checked all 51 configurations but was not green because unchanged tests already report environment/toolchain type errors at `gateway/transcription/__tests__/whisper-install.test.ts:186`, `onboarding/history-import/__tests__/zip-writer.ts:10`, and `logger/__tests__/fire-and-forget.test.ts:301`; none is in the changed-file list. This record does not relabel that run as a pass.

No expression was rewritten, no feature switch or second path was added, and no spec decision changed. The out-of-scope parser findings from the complete enumeration above were not modified.
