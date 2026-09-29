## 2026-09-29 — Keep project maintenance fenced until the planner profile attests

Refs #1237. The maintenance attestation predated the closed native planner
profile introduced by #1413. A surviving replacement could match the conversation,
generation, tool surface and bridge while lacking that planner capability. The
restart regression reproduced admission reopening for that observation.

`runtime/adapters/claude-code/persistent/generation-replacement.ts:218` now reports
the live session's planner role independently from the durable registry's profile
at `:227`. It does not infer either from the requested profile.
`gateway/project-generation-replacement.ts:119` requires the registered planner
role, and `:128` requires the current profile digest. Both immediate replacement
and restart recovery use this attestation before reopening admission.

This preserves the ownership and uncertainty contract in
`docs/spec-items/project-herdr-workspaces.md:73` and `:106`, and the native placement
contract in `docs/spec-items/trident-build-efficiency.md:140`. It does not activate
replacement or retire an adopted parent. Gateway restart still preserves the
surviving child's actual spawn profile; unresolved children still prevent
replacement. Issue #1237 remains open for safe activation and live acceptance.

Validation: the focused gateway and runtime suites passed 72 tests, including
runtime/registry independence and missing/stale planner evidence. The consuming
Open admission case passed with 53 assertions: stale role and stale digest each
keep admission fenced, and current evidence reopens the same fence. Root and
Trident TypeScript checks passed. Semantic mutation copies disabling the two
checks produced six intended failures with 44 controls passing; refusing every
profile produced ten intended failures with 40 controls passing. The candidate
production modules were unchanged during those mutation runs.

The complete consuming `open/__tests__/project-build-e2e.test.ts` also passed:
490 tests, zero failures, 6,885 assertions. This is local validation, not a
deployment or live replacement receipt.
