## 2026-09-14 — pidfd lifecycle proof reports its step and confirms fixture teardown

### What changed

The Bun wrapper now invokes unittest in verbose mode, retaining the exact Python
subtest names in the stderr that its existing aggregate assertion publishes on a
failure (`trident/lane-processes.test.ts:4-13`). A shard failure therefore names
the lifecycle step instead of only the outer case.

The fixture now sends SIGKILL through each already-open pidfd, waits for that
pidfd to become readable, and only then closes it
(`trident/lane-processes-test.py:19-28`). Teardown applies that confirmed-close
operation to every recorded handle before it waits for every direct child
(`trident/lane-processes-test.py:43-51`). The existing readiness wait remains
three seconds (`trident/lane-processes-test.py:58-65`); this change does not
increase it. The added three-second ceiling is assigned specifically to
post-SIGKILL kernel exit notification, and normally returns immediately.

### Findings and decisions

WHICH STEP FAILED ON THE SHARD WAS NOT ESTABLISHED, and this record does not
claim it was. The shard log named the outer Bun case only, and the run is gone;
nothing here identifies the failing assertion after the fact. What was done
instead is the issue's second acceptance branch: name a sensitivity the fixture
really has, close it, and make the NEXT occurrence name its own step.

The sensitivity closed is fixture teardown racing its own children. The old
teardown requested SIGKILL and immediately closed its proof handle, so the case
could return while a child was still settling -- the leak class the issue names.
The new helper makes handle readability the exit confirmation before return
(`trident/lane-processes-test.py:19-28`). This is a race the fixture demonstrably
had; it is NOT demonstrated to be the one that failed on shard 4/8.

A SECOND CANDIDATE IS DELIBERATELY LEFT ALONE. `wait_file` fails the case on a
hard three-second wall-clock deadline for a child to publish readiness
(`trident/lane-processes-test.py:58-65`), and on an eight-way-sharded loaded
runner that is at least as plausible a source as teardown. It is NOT raised here,
because raising it without an account of where the time went is the non-fix the
issue rules out. `-v` is what will settle it: if the next failure is
`wait_file`'s `self.fail`, the verbose stream says so by name. The pid-reuse case still independently
asserts that no signal was sent and its original subject is alive
(`trident/lane-processes-test.py:182-190`).

The CI job uses an Ubuntu runner (`.github/workflows/ci.yml:381-383`). I enumerated
workflow process-environment declarations with the combined positive-control
search `rg -n "container:|runs-on:" .github/workflows`: it found the known
`runs-on:` entries, including that shard, and no `container:` entry. Within the
proof, every process is spawned as a descendant of the Python test
(`trident/lane-processes-test.py:53-56`), and `/proc` enumeration is narrowed to
those fixture PIDs (`trident/lane-processes-test.py:38-41`). A direct probe also
showed the child-reported PID equals the parent-visible PID and has a visible
`/proc` entry. Thus this path does not cross a PID-namespace boundary; load can
delay exit, and the fixture now waits on the kernel fact rather than scheduling.

The new `TimeoutError` joins unittest's existing error outcome (reported as an
ERROR on the case, distinct from a FAIL). By default an uncaught teardown error
makes the Python runner exit nonzero (`trident/lane-processes-test.py:27-28`), and the Bun assertion publishes verbose
stderr on that nonzero outcome (`trident/lane-processes.test.ts:10-13`). It is a
loud failed proof, not a pass or skip. The invariant is continuously maintained
by pidfd readability from the kernel plus teardown's wait; it does not require
the terminated child to cooperate (`trident/lane-processes-test.py:19-28`).

### Mutation table

| Guard | Mutation | Mutated result | Restored result |
|---|---|---|---|
| Wait for pidfd readability before close (`trident/lane-processes-test.py:25`) | Replace the `select` result with unconditional `True`; the printed mutation landed at line 25 | `bun test trident/lane-processes.test.ts`: RED, 0 pass / 1 fail; verbose stderr named `test_pidfd_teardown_confirms_exit_before_close` | GREEN, 1 pass / 0 fail |
| THE SUBJECT GUARD ITSELF -- the post-`/proc`-read pidfd exit check that stops a reaper signalling a stranger (`trident/lane-processes.py:130`) | `if select.select([fd], [], [], 0)[0]:` -> `if False:`, anchored on the three-line signal sequence and asserted to match exactly one site; printed landing line `trident/lane-processes.py:130` and the diff before running | `bun test trident/lane-processes.test.ts`: RED, 0 pass / 1 fail. The verbose stream named the step: `test_pid_reuse_does_not_signal_successor ... FAIL`, `Calls: [call(5, <Signals.SIGTERM: 15>)]` -- the kill the guard exists to prevent | restored: GREEN, 1 pass / 0 fail, 18 tests, `FAILED` absent |

The second row is the row that matters, and it is also the direct evidence for the
`-v` change: the first mutation only reddens the new helper's own contract test,
while the second reddens the real kill-safety proof AND, because of `-v`, says
which of the eighteen steps died. Before `-v` that same failure printed only the
outer Bun case name -- which is precisely the diagnostic gap the issue opened with.

The dedicated contract proof records signal, wait, and close order and pins the
three-second wait argument (`trident/lane-processes-test.py:192-200`).

### Verification

- `bun test trident/lane-processes.test.ts` — 1 pass, 0 fail.
- `bash scripts/ci/typecheck-all.sh` — 51 tsconfigs checked, all pass.
- `bash scripts/ci/lint.sh` — all lint guards pass.
- `git diff --check` — pass.

The requested `bun run typecheck` and `bun run lint` names are not defined; the
package exposes only test/start/migrate scripts (`package.json:57-62`). I used
the commands wired into CI instead (`.github/workflows/ci.yml:229-272`).

### Deliberately not changed

I did not skip or mock the real pidfd refusal proof. I did not increase its Bun
timeout or the readiness deadline, change production reaping behavior, add a
second implementation path, or modify the completed specification: its pidfd
and PID-reuse requirements remain unchanged (`docs/spec-items/dead-lane-process-reaping.md:22-26`,
`docs/spec-items/dead-lane-process-reaping.md:33-42`).

### Review addendum (review lane)

`tearDown` now COMPLETES even when a confirmed close raises
(`trident/lane-processes-test.py:47-62`). As first written, a `TimeoutError` from
the first handle propagated out of the `for fd in self.handles` loop, so the
remaining handles were never signalled or closed, no child was killed, the
`os.listdir` patch was never stopped and the tmpdir was never cleaned -- the
helper's one failure mode skipping the cleanup the helper exists to guarantee.
Failures are now collected and the first is re-raised after cleanup, so the
outcome is equally loud (measured: 15 ERRORs both before and after, forcing the
timeout path) without abandoning teardown halfway.

HONESTLY SCOPED: this is hygiene, not a demonstrated defect. The leak was looked
for and not found -- `TemporaryDirectory`'s finalizer and interpreter exit clean
up what the aborted teardown skipped, and a comparative run with the timeout path
forced showed 0 leaked `lane-process-proof-*` directories either way. What the
change buys is a deterministic error path rather than one relying on exit-time
finalizers, and all N handle failures reachable instead of the first.
