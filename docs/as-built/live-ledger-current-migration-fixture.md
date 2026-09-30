## 2026-09-30 — Extend the live-ledger repair fixture through migration 0166

The two exact application-order assertions in
`migrations/__tests__/live-ledger-125-repair.test.ts:93` and `:177` ended at 0164,
although the copied migration tree also contains 0165 and 0166. Both expected
arrays now include those ordinals in order. Exact equality continues to reject
missing, duplicate, extra or reordered applications; the historical ledger and
repair assertions remain intact.

The additions reflect existing schema, rather than introducing migrations:
`migrations/0165_claude_mcp_handler_drain.sql:1` and `:7` create handler generation
and invocation records consumed by `gateway/claude-mcp-handler-drain.ts:33` and
`:41`. `migrations/0166_claude_native_continuations.sql:3` creates the continuation
claim table owned by `gateway/project-admission-store.ts`, as recorded in
`migrations/table-ownership.json:42`. All three tables appear in the normative
schema snapshot at `migrations/expected-schema.txt:509`, `:518` and `:526`.

Verification: the focused file passes all four tests and 20 assertions. Temporary
mutations of the first runner result removing 165, duplicating 166, and reversing
the final two applications each turn that exact-order test red (three passes,
one failure); restoring the result returns all four tests to green. These probes
demonstrate the assertion's sensitivity to malformed application sequences, not
a new runner behavior. Root and Trident TypeScript checks both pass with
`tsc --noEmit -p tsconfig.json` and `tsc --noEmit -p trident/tsconfig.json` after
local workspace links and the lockfile's Zod 3 dependency are resolved against
the shared dependency cache.
