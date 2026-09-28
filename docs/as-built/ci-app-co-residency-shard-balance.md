## 2026-09-28 — Balance the full app co-residency check across CI shards

The four-runner test matrix still executes the same ordinary shard slices, and
the full isolated app suite still runs once before one runner's ordinary slice.
Its co-residency step now runs on shard 4 instead of shard 1. No test command,
test selection, runner count, or aggregate requirement changed. The workflow
guard pins the matrix membership, one app step and its command, destination,
and ordering, so a missing, duplicated, or misplaced step fails locally.

Two preceding CI runs showed the app step taking 76.68s and 84.05s while shard
1, the slowest leg, took 11m17s and 12m20s. Shard 4 took 4m06s and 4m26s. The
expected critical-path reduction is approximately the app-step duration; this
is an estimate, not a measured paired speedup. The larger shard-1 cost remains
the ordinary chunk containing `open/__tests__/project-build-e2e.test.ts` and
is outside this scheduling change.

The focused workflow and spec-index tests passed (120 tests), as did both
TypeScript checks and lint on the changed test. Temporary changes sending the
app step back to shard 1, naming a non-member shard, duplicating the step, and
removing it each made the guard fail; the changes were then reverted.
