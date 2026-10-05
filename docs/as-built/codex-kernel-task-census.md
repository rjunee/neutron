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
installation.

The nine-file consuming invocation below finished with 939 passed, zero failed
and 10,190 assertions in 1,138.05 seconds. Its first file overlapped the final
parser-validation edit, so this aggregate is not an exact-frozen-source receipt.
That affected file, `trident/codex-build.test.ts`, was then rerun alone against
source revision `5ed4b29b6d1d7a9fea8eaf5f0a8ee8babed625f5`: 132 passed, zero
failed and 534 assertions in 58.49 seconds. The remaining eight files ran after
the source stabilized. The production and Python-test blobs remained unchanged
through the evidence-only update. The as-built guard and commit-message leak
scan passed. A local worktree tree scan reported existing-tree and worktree
metadata findings; it is not reported as a clean public-tree scan.

```sh
bun test runtime/adapters/codex-cli/account-writer-lock.test.ts \
  runtime/adapters/codex-cli/persistent/project-owner-admission-refusal.test.ts \
  runtime/adapters/codex-cli/persistent/project-control-bootstrap-account-lease.test.ts \
  trident/codex-review.test.ts trident/codex-build.test.ts \
  open/__tests__/codex-durable-owner.test.ts \
  open/__tests__/codex-owner-binding.test.ts \
  open/__tests__/project-build-e2e.test.ts \
  gateway/http/codex-credential-surface.test.ts
```

A coordinating-agent read-only host check called the census directly as root
against a synthetic non-account path: the baseline refused on a stable kernel
task, while the frozen implementation admitted with a readable self-executable
positive control. It performed no account canonicalization, lock acquisition or
credential writes. A separate ordinary-user host census still refused an
unreadable userspace executable, while an isolated process namespace admitted.
That residual remains fenced; isolated test success is not live admission proof.
The canonical `bash scripts/check-shared-host.sh` subsequently completed with
exit 0 on tested revision `173b7fa31f3e5ee1289b068945d5484774f0dfc4`:
lint passed, all 51 typechecks passed, and all 1,795 declared test files were
discovered, assigned and executed across 19 lanes with zero failed lanes.
The host measured the same suite input identity before and after execution:
`79b3a03519ff68289b98b0ef49baf464e42a0f770cdb6be5cd7d1d42078bcf18`.
The retained log SHA-256 is
`7e71b8a2044a2303194f25110ba1add15158703e4ef88749d7b3bde24fcf8eab`.
This final receipt-only update leaves production and test blobs unchanged;
the local receipt names the tested revision, not a new receipt for the changed
publication head. Exact-head CI remains required before merge. No live
credential adoption or exclusion against later unwrapped launches is claimed.
