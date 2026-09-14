## 2026-09-14 — deterministic doc-store write/delete race coverage

### What changed

`DocStoreOptions` now accepts the narrow `now` seam used only for delete-event ordering stamps (`gateway/http/doc-store.ts:363`). `DocStore` retains that clock with a production default that calls `Date.now()` (`gateway/http/doc-store.ts:420`) and samples it immediately after a successful unlink (`gateway/http/doc-store.ts:849`). Production behavior is unchanged because omitting the option follows the prior wall-clock call; the wiring test replaces `Date.now` after construction and proves the omitted option supplies that exact value to the delete hook (`gateway/comments/__tests__/anchor-walker.test.ts:809`).

The formerly skipped regression now uses a controlled version-store commit as a barrier (`gateway/comments/__tests__/anchor-walker.test.ts:1032`). It pauses the deleter after the real unlink, lets the real writer complete rename, stat, and anchor hook, then releases the deleter so its hook arrives last (`gateway/comments/__tests__/anchor-walker.test.ts:1104`). The injected clock returns `1` at unlink sampling and a deliberately late value after the writer hook (`gateway/comments/__tests__/anchor-walker.test.ts:1061`), while the assertions prove the recreated file exists, hook order is write then delete, the captured delete stamp remains `1`, and the anchor remains live (`gateway/comments/__tests__/anchor-walker.test.ts:1131`).

### Decisions

The seam is a clock rather than an operation hook because only the independent delete clock prevented deterministic ordering; the existing version-store await already provides a real post-unlink concurrency boundary. The invariant continues to be maintained by sampling the delete stamp immediately after unlink, before best-effort downstream work (`gateway/http/doc-store.ts:849`), so it does not rely on the slower commit or anchor hook succeeding. This adds no outcome to an error or verdict vocabulary.

The stale test's conditional final-state assertion was replaced. The controlled barrier fixes the operation order, so accepting either a live or dead ending would conceal failure to exercise the intended race; the test now requires the writer-created file and live anchor (`gateway/comments/__tests__/anchor-walker.test.ts:1116`).

### Mutation and verification

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| Delete clock sampled immediately after unlink (`gateway/http/doc-store.ts:862`) | Read `this.now()` at the delayed hook argument (`gateway/http/doc-store.ts:896`) | Focused race test received `9000000000000000`, expected `1`; 0 pass, 1 fail | Focused race test passed 50/50 consecutive runs |

`bun test gateway/comments/__tests__/anchor-walker.test.ts` passed 31 tests. `bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript configurations. `bash scripts/ci/lint.sh` passed every reported gate. A combined `rg` over the complete test file used the race suite phrase as the positive control and returned no `it.skip` match, so no test in that file remains skipped for this reason.

### Deliberately not changed

The temp-file suffix still uses its existing independent wall clock (`gateway/http/doc-store.ts:733`); it does not participate in anchor ordering. No feature flag, alternate production path, outcome, spec decision, or broader doc-store synchronization was added.
