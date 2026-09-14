## Issue 639 — checkpoint writes survive build-load contention

### What changed

Both out-of-process SQLite writers now source one retry implementation
(`trident/sqlite-write-retry.sh:1-32`). Each attempt uses a 100 ms
same-connection busy timeout, retries only SQLite busy diagnostics, waits 150 ms
between attempts, and stops after 120 attempts (`trident/sqlite-write-retry.sh:7-30`).
The checkpoint write invokes it without changing its atomic UPDATE and outcome
readback (`trident/checkpoint.sh:1080-1092`); the stage-event writer invokes the
same function while retaining its always-zero caller contract
(`trident/stage-stamp.sh:52-63`).

Exhausted contention joins the shell exit-status vocabulary as status 75 and a
`SQLITE_BUSY: retry budget exhausted` diagnostic
(`trident/sqlite-write-retry.sh:25-29`). Non-busy SQLite failures return their
original status and diagnostic immediately (`trident/sqlite-write-retry.sh:17-22`).
Because stage stamps deliberately always exit zero, their existing stderr
vocabulary labels those two outcomes `contention exhausted` and `write failed`
(`trident/stage-stamp.sh:55-60`). The default consequence is therefore retryable
failure for checkpoint callers and observable best-effort loss for stage callers,
without presenting a schema or I/O failure as lock pressure.

### Contention measurement and decision

The database already opens in WAL mode (`persistence/db.ts:15-22`), so enabling
WAL again cannot address this failure. In-process writers are serialized by a
per-instance mutex (`persistence/db.ts:53-63`), while the shell writers run in
separate processes and meet those writers only at SQLite. A ProjectDb transaction
holds BEGIN through an awaited callback and COMMIT (`persistence/db.ts:230-275`),
so scheduler delay under build load extends the observed lock hold even when the
statements themselves are short.

The deterministic measurement holds a real second connection's EXCLUSIVE lock
for 5,250 ms and releases it only by COMMIT
(`trident/checkpoint-sh.test.ts:1669-1678` and
`trident/stage-stamp-sh.test.ts:98-109`). That establishes the relevant tail as
greater than the former 5,000 ms ceiling. It does not claim a full production
distribution: the filed observation supplied two saturated-host expiries, but no
historical lock-duration telemetry exists from which to reconstruct percentiles.
That absence was checked with
`rg -n 'lock[-_ ]duration|busy_timeout' persistence trident`: the
`busy_timeout` arm was the positive control and matched the known pragma sites;
the lock-duration arm returned no site.

I rejected a longer single `busy_timeout`: SQLite's wait is synchronous, whereas
short attempts yield between processes and avoid one long opaque block. I rejected
a shorter checkpoint critical section because the write is already one atomic
UPDATE plus readback (`trident/checkpoint.sh:1080-1083`). I rejected a new
single-writer service because the existing in-process mutex cannot serialize the
separate workflow processes (`persistence/db.ts:53-63`) and introducing an IPC
owner would expand the failure surface. Bounded application retry addresses the
measured scheduler-delayed holder while retaining a finite, classified failure.

### Tests and mutation evidence

The complete changed-test set was enumerated from `git diff --name-only` and is
`trident/checkpoint-sh.test.ts` plus `trident/stage-stamp-sh.test.ts`. The former
also proves an unmigrated database is non-zero, non-75, retains the table error,
and never reports retry exhaustion (`trident/checkpoint-sh.test.ts:1681-1691`).
The latter proves the same genuine failure is labeled `write failed`
(`trident/stage-stamp-sh.test.ts:86-96`).

| Guard | Mutation printed and diffed before run | Mutated result | Restored result |
|---|---|---|---|
| bounded application retry | `trident/sqlite-write-retry.sh:7`, `max_attempts=120` → `1` | both held-lock tests red: checkpoint exited 75; stage reported contention exhaustion | 2 pass, 0 fail |

`bun test trident/checkpoint-sh.test.ts trident/stage-stamp-sh.test.ts trident/inner-workflow.test.ts`
passed 245 tests. `bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript projects.
`bash scripts/ci/lint.sh` passed every repository lint guard. The requested root
`bun run typecheck` command was attempted first, but the root package defines no
such script (`package.json:57-62`), so the repository's typecheck matrix was used.

### Deliberately not done

I did not change schema, journal mode, checkpoint payload semantics, or the stage
writer's always-zero contract. I did not claim closure of the separate resume
inheritance work. I did not add a permanent lock-duration telemetry stream: the
change establishes the reported boundary with real concurrent connections, while
a fleet distribution would require an observability product decision beyond this
write-path repair.

The distinctive old `busy_timeout=5000` wording was searched across the tree.
Current-behaviour claims were corrected in `trident/inner-workflow.mjs:39-40`,
`trident/inner-workflow.mjs:177-179`, and the stage-ledger plan. The remaining
hits deliberately describe the former implementation or retain a 5,000 ms test
fixture: `trident/checkpoint-sh.test.ts:1672-1674`,
`persistence/persistence.test.ts:308`, and
`docs/plans/2026-07-02-world-class-refactor-plan.md:1020`.
