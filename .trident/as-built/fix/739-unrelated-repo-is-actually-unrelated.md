## 2026-09-14 — The "unrelated repository" was the repository (#739)

### The defect, and how it was finally seen

`test_deleted_subdirectory_and_unrelated_repo_survive` failed on two independent CI
runs (PRs #727 and #737, both shard 7/8) with `AssertionError: [3] is not false` at
the SECOND survival assertion. It passed locally 10/10 and no investigation could
attribute the death: a readable pidfd establishes exit and nothing else.

The diagnostics added for this issue (#753) are what made it attributable. The first
failure after they landed printed:

```
second sweep: unrelated repo: pid=2558602, wait_status=-9,
  sweeps={'first': {'reaped': [], …}, 'second': {'reaped': [2558602], …}}
```

The sweep the test calls "unrelated repo" had reaped the child itself. That is not
ambiguous, and it points at one line.

### Root cause

The unrelated repository was built as `str(self.root)[:-1] + 'x'` — the fixture root
with its LAST CHARACTER REPLACED by `x`. `tempfile.mkdtemp` draws its random suffix
from 37 characters and `x` is one of them, so one run in 37 (~2.7%) produces a suffix
already ending in `x`, and the "unrelated" path is then the root ITSELF.

The test removes the `wf_` root immediately before that sweep, so on those runs the
child was a genuinely eligible target of a sweep naming its own repository, and the
production code reaped it exactly as specified. **No production defect: the sweep was
right and the fixture was wrong.** `trident/lane-processes.py` is unchanged.

### The fix

The near miss is APPENDED rather than substituted (`str(self.root) + 'x'`). A strict
extension of a path can never equal that path, so the collision is impossible by
construction rather than improbable. The inequality is then ASSERTED as well, so a
future rewrite of the line cannot quietly reintroduce it.

The test also now says WHY the child survives instead of only that it did: the removed
root makes it eligible for its own repository (asserted), and NOT eligible for the near
miss (asserted). A survival with no stated cause is what let this read as a flake.

### Mutation

Reproduced deterministically before fixing: a harness that forces `mkdtemp` to return a
name ending in `x` fails the test 100% of the time with the diagnostic above. With the
fix, that same harness passes. Restoring the original `[:-1] + 'x'` construction under
it reds immediately, naming the collision:

```
AssertionError: '/tmp/lane-process-proof-7gg8je1x' == '/tmp/lane-process-proof-7gg8je1x'
```

Full python suite: 27 pass.

### Deliberately not done

No change to `trident/lane-processes.py`, and no widening or narrowing of sweep
eligibility. The 1-in-37 odds are not made smaller — they are removed.
