## Issue #661 — deterministic sink restart-survival replacement race

### What changed

The cause was the third candidate: a genuine production unserialised region. After an atomic publish, `createTokenIfAbsent` discarded its staging name and re-read the destination. A concurrent replacer could quarantine that destination before the re-read, producing ENOENT. The staged token is fully written and mode-normalised before publication (`runtime/adapters/claude-code/persistent/sink-coordinates.ts:523-552`), and `linkSync` publishes that inode atomically (`runtime/adapters/claude-code/persistent/sink-coordinates.ts:585-590`). The winner now returns the staged secret directly after dropping the staging name (`runtime/adapters/claude-code/persistent/sink-coordinates.ts:605-614`). Its value was therefore published even if a competitor subsequently moved it to quarantine.

The test no longer assumes a 700 ms wall-clock head start will schedule four children evenly. Each injected unacquired lock writes a ready marker after the loader's fast read and blocks on a release marker (`runtime/adapters/claude-code/persistent/__tests__/sink-restart-survival.test.ts:1162-1182`). The parent creates that release only after all ready markers exist (`runtime/adapters/claude-code/persistent/__tests__/sink-restart-survival.test.ts:975-985`). Results still await each child's exit before inspection (`runtime/adapters/claude-code/persistent/__tests__/sink-restart-survival.test.ts:960-972`), so close remains confirmed rather than requested.

### Decisions and maintained invariant

The successful publisher returns the secret from its already-validated staging inode instead of consulting a pathname a competitor is allowed to move. The continuous maintainers are the exclusive staging create, complete write, descriptor-based mode normalisation, and atomic hard-link publication at `runtime/adapters/claude-code/persistent/sink-coordinates.ts:523-552` and `runtime/adapters/claude-code/persistent/sink-coordinates.ts:585-614`. They do not require the publishing process to remain alive after `linkSync`: the published inode persists independently.

No new error, verdict, state, or refusal was added, so no outcome vocabulary or default classification changes. The existing weaker outcome remains: without serialisation, every returned value was published somewhere visible, but racers need not converge on the final pathname (`runtime/adapters/claude-code/persistent/sink-coordinates.ts:642-655`). The warning continues to classify that weaker mode at `runtime/adapters/claude-code/persistent/sink-coordinates.ts:737-748`.

The obsolete `confirmInstalled` implementation was deleted rather than retained as a second path. Enumeration used `rg -n "confirmInstalled|createTokenIfAbsent"` across the persistent runtime and its historical as-built record: the positive control found all current `createTokenIfAbsent` definitions/callers at `runtime/adapters/claude-code/persistent/sink-coordinates.ts:585,639,683,767,794`; `confirmInstalled` remained only in the immutable historical record `docs/as-built/durable-reply-sink-coordinates.md:922,959`, which was deliberately not rewritten.

### Reproduction and mutation table

Before the change, 64 focused test processes at concurrency 16 reproduced one child failure. Its stack ended at the former `confirmInstalled` pathname stat, before either test assertion, establishing the production cause.

| Guard | Mutation and printed landing line | Red | Restored green |
|---|---|---|---|
| Return the atomically published staged secret | Changed `runtime/adapters/claude-code/persistent/sink-coordinates.ts:614` from `return secret` to `return readFileSync(path, 'utf8').trim()` after printing the line and diff | Loaded focused run 24 failed with ENOENT at the mutated line | Restored line printed and diffed; 64/64 focused runs passed at concurrency 16 |

The focused case also passed once in isolation with 19 assertions and passed both full-file attempts. The repository lint gate passed. The complete typecheck matrix passed all 51 configurations. Two full-file attempts each ended 34 pass / 19 fail because this build environment refused every socket allocation, including the suite's positive-control `Bun.serve({ port: 0 })` at `runtime/adapters/claude-code/persistent/__tests__/sink-restart-survival.test.ts:74`; the changed case passed in both attempts.

### Deliberately not done

I did not widen a time allowance, skip a case, weaken an assertion, add a feature flag, or add a second production path. I did not alter the locked-path convergence contract. I did not edit the historical as-built references to `confirmInstalled`, because merged records are immutable under `docs/process/work-tracking.md:89-94`; this record supplies the correcting evidence.

`SPEC.md` and the issue's product decision did not change. The implementation now satisfies the already-documented weaker unlocked guarantee instead of throwing while trying to reconfirm a movable pathname.
