## 2026-10-05 — Account admission distinguishes proven kernel tasks

The account writer census attempted executable-link reads for every live task
with the invoking UID. A kernel task has no userspace executable, so that read
could turn an otherwise clear account census into admission unknown. The existing
account exclusion requirement remains the governing contract (SPEC decision
2026-10-04; `docs/spec-items/instance-project-provider-resolution.md:107`).

The census now parses the PID, scheduler state, unsigned task flags and start
ticks from stat. Only `PF_KTHREAD` permits skipping userspace reads, after a
second stat observation confirms the same PID, start ticks and full flags
(`runtime/adapters/codex-cli/account-writer.py:74`, `:107`). A state-only
scheduler transition is harmless. Missing or malformed stat, changed identity
or flags, and unreadable userspace evidence still refuse admission. Existing
same-account native consumers still raise busy; distinct accounts remain
independent (`runtime/adapters/codex-cli/account-writer.py:119`).

The flag comes from [Linux v6.8 sched.h](https://github.com/torvalds/linux/blob/v6.8/include/linux/sched.h#L1541);
[the proc stat producer](https://github.com/torvalds/linux/blob/v6.8/fs/proc/array.c#L567)
emits that flags field. The file-backed tests use its literal value independently
of the production constant and include a task name containing parentheses,
non-kernel flags, missing executable and empty argv, PID reuse, flag changes,
malformed stat and denied reads (`runtime/adapters/codex-cli/account-writer-test.py:85`).
These fixtures establish the kernel distinction; the existing private-process
namespace fixture separately exercises readable native same-account busy,
distinct-account admission and unreadable userspace refusal
(`runtime/adapters/codex-cli/account-writer-boundary-test.py:42`).

Validation: all twelve Python census tests pass. Three in-memory semantic source
mutations were rejected: removing the kernel branch broke the kernel positive;
treating all userspace tasks as kernel broke busy and unknown controls; ignoring
every missing executable broke the live-userspace refusal. Restoring the source
returned all twelve tests to green. Both `tsc -p tsconfig.json` and
`tsc -p trident/tsconfig.json` passed using this worktree's frozen dependency
installation. Consuming-surface validation is still running at source freeze;
the full suite has not run for this change. This change does not establish live
credential adoption or exclusion against later unwrapped launches.
