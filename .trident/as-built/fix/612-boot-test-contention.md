## Issue 612 — isolate real-HTTP tests from listener contention

### Root cause and measurement

The runner gives each general chunk a fresh process but runs tests within that
process at host-core concurrency (`scripts/run-tests.sh:602-610`). Real listener
tests were not classified: only PGLite and device files left the general lane
before this change (`scripts/run-tests.sh:291-308`).

Two sequential-run captures reproduced the failure. In both, the first relevant
failure was not a slow assertion: `Bun.serve({ port: 0 })` threw `EADDRINUSE`
before the request path ran. After the runner process exited, a new one-file test
process and repeated minimal `Bun.serve({ port: 0 })` probes also received
`EADDRINUSE`. Thus the constrained resource outlived a test process and was
shared with neighboring work. The filed 15-second timeout was measuring time
spent unable to acquire HTTP infrastructure, not the behavior of a healthy boot.

The source-side reproduction point opens one ephemeral listener before returning
its harness (`gateway/__tests__/focus-production-composer.test.ts:122-141`), and
its setup installs that harness for every test (`gateway/__tests__/focus-production-composer.test.ts:198-203`).
When the bind was refused, the harness was never returned and the teardown's
attempt to close it produced only a secondary error.

### What changed

The runner now derives a real-HTTP lane from test content: direct `Bun.serve(...)`
calls and awaited `boot(...)` or `bootSignup(...)` calls are classified without
an allowlist (`scripts/run-tests.sh:295-326`). Those files run in their own
process at `--max-concurrency=1`, retaining the normal `TIMEOUT` and receiving no
retry (`scripts/run-tests.sh:670-681`). Serial listener acquisition bounds demand
on the shared ephemeral TCP allocator instead of extending the wait.

The new lane remains part of the existing partition and coverage vocabulary. It
is round-robin sliced across shards (`scripts/run-tests.sh:533-553`), included in
the assigned-file total (`scripts/run-tests.sh:564-583`), and a nonzero lane exit
joins the existing fatal failure list (`scripts/run-tests.sh:723-765`). Its default
therefore costs the same as any ordinary failed lane: the runner exits nonzero.

The maintained invariant is content-derived classification on every runner
invocation (`scripts/run-tests.sh:310-326`), before sharding and execution. It
does not depend on a failing test successfully releasing a listener. Current
architecture and operator documentation describe the same lane and unchanged
budget (`docs/SYSTEM-OVERVIEW.md:8616-8622`, `docs/testing-runner.md:72-84`).

### Tests and mutation table

The focused runner fixture records fake-Bun invocations. It proves a plain test
retains configured concurrency, while both direct-listener and production-boot
fixtures run together at concurrency one; all retain the configured timeout
(`scripts/__tests__/run-tests-http-lane.test.ts:13-71`). The existing partition
suite enumerates the complete plan through the runner's plan-only output and
asserts exact union and no overlap across two and four shards
(`scripts/__tests__/run-tests-shard.test.ts:43-60`,
`scripts/__tests__/run-tests-shard.test.ts:106-135`).

| Guard | Mutation and printed landing line | Red | Restored green |
|---|---|---|---|
| HTTP membership dispatch | Removed the `HTTP_MATCH` case; printed `scripts/run-tests.sh:316-325`, showing the loop fell directly from device classification to `GENERAL_FILES` | Focused test expected a two-file real-HTTP lane but observed zero files and all three fixtures in the general chunk | Restored `scripts/run-tests.sh:324-326`; focused test passed 1/1 |

After restoration, the three specific runner suites passed 26 tests with zero
failures. `bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript configs, and
`bash scripts/ci/lint.sh` passed every lint sub-gate.

### Decisions and deliberately not changed

The lane uses serial execution rather than a longer budget, a sleep between
chunks, or a retry. A sleep guesses at drain time; a retry or larger timeout can
hide a broken boot. Content-derived membership was chosen over a file allowlist
so the runner continuously maintains isolation as new listener tests arrive.

No production listener behavior changed. The deterministic configured-port retry
remains scoped to nonzero ports (`gateway/boot-listener-registry.ts:283-320`), and
the test lane does not reinterpret `EADDRINUSE`. No feature flag or dual test path
was added. `SPEC.md` was not changed because this alters test execution, not the
product target or a product decision.
