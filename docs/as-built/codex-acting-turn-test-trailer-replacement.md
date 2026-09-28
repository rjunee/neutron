## 2026-09-28 — Make the Codex acting-turn trailer test replacement atomic

The existing test for a trailer belonging to another step replaced the result
file with an in-place `writeFile`, then marked `replaced` true. The acting-turn
observer reads that file after checking its metadata
(`runtime/workers/codex-acting-turn.ts:112-116`). It could observe the new bytes
before the write promise resolved and return while `replaced` was still false.

The test now writes the replacement into a separate file in its fixture directory,
sets `replaced` true, and renames the complete file over the result path
(`runtime/workers/codex-acting-turn.test.ts:111-124`). The assertion still proves
that the other step's valid trailer did not end the turn and that the replacement
was made before the turn ended.

The focused Bun suite passed with 44 tests and 119 assertions. Two temporary
semantic mutations of the production trailer condition each made this test fail:
accepting every trailer failed on `replaced === false`, and accepting none failed
on the expected `turn-ended` outcome. The production condition was restored.
