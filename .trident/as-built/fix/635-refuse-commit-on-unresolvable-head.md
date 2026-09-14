## Issue 635 — refuse commits when HEAD cannot resolve

### What changed

`trident/commit-with-resolved-head.sh` probes `git rev-parse --verify HEAD` and only then
`exec`s the requested `git commit`. It keeps the three answers apart, because they imply
different repairs:

| Answer | Exit | Line |
|---|---|---|
| the expected branch was not supplied | 64 | `trident/commit-with-resolved-head.sh:5-8` |
| THE QUERY FAILED — "I could not ask" | 65 | `trident/commit-with-resolved-head.sh:16-20` |
| the query SUCCEEDED and named nothing — "I asked and got nothing" | 66 | `trident/commit-with-resolved-head.sh:22-25` |
| the query SUCCEEDED and named a non-object | 67 | `trident/commit-with-resolved-head.sh:27-32` |

Only a non-empty hexadecimal object name reaches the commit
(`trident/commit-with-resolved-head.sh:34-40`). The refusal text names which case it was, so
the distinction survives into what the operator reads and not only into the exit status.

Forge's commit instruction routes through the wrapper in all three git-modes
(`trident/inner-workflow.mjs:1686-1692`).

### HOW STRONG THE ENFORCEMENT ACTUALLY IS — stated plainly

The build's commit is an agent running `git commit` in its worktree, driven by prompt text;
the issue says so itself, and it is why there is no function here to wrap. So the guard is
composed of two parts with very different strengths:

- the WRAPPER is real enforcement. Anything that runs it cannot produce a parentless commit,
  for every interleaving, and that is pinned by a real-git test.
- the ROUTING is an INSTRUCTION, not an interception. `trident/inner-workflow.test.ts:754-761`
  asserts that the prompt tells the agent to use the wrapper and never to call `git commit`
  directly — which is what a prompt-text assertion can establish, and all it can establish. An
  agent that calls `git commit` itself still bypasses the guard entirely.

This record therefore does NOT claim that a run whose HEAD does not resolve cannot commit. It
claims the wrapper refuses, and that the prompt routes every documented commit path through
it. Closing the remainder wants an interception git cannot be talked out of — a `pre-commit`
hook installed into the build worktree — which is a separate change and is not in this PR.

### Joining the existing vocabulary

The refusal introduces NO new outcome class. The wrapper exits nonzero; the agent's command
fails; a build that cannot commit fails the seat through the workflow's existing terminal
error result, whose `terminalCause` carries the composed sentence and whose `terminalCauseKind`
is the already-defined `workflow-threw` (`trident/inner-workflow.mjs:9219-9241`). No review
verdict is asserted alongside it, which is correct here: a commit refusal is not a judgement
about the code. NOT VERIFIED END-TO-END: that this specific wrapper exit reaches that specific
terminal result was read from the code, not observed in a run.

### Verification and mutation

`bun test trident/commit-with-resolved-head-realgit.test.ts trident/inner-workflow.test.ts`
— 158 pass, 0 fail. Every mutation printed its landing line and the file diff before running.

| Guard | Mutation | Mutated | Restored |
|---|---|---|---|
| the probe-failure branch (`:16`) | `-ne 0` -> `-eq 0` | 2 fail | 0 fail |
| the probe itself (`:14`) | replace the `rev-parse` call with a hardcoded OID | 1 fail | 0 fail |
| THE COMPLEMENT — refuse always (`:16`) | `[ "$probe_exit" -ne 0 ]` -> `true` | 1 fail | 0 fail |
| "asked and got nothing" stays its own answer (`:23`) | `exit 66` + its text -> `exit 65` + the 65 text | 1 fail | 0 fail |
| "resolved unexpectedly" stays its own answer (`:28`) | the non-hex glob -> a literal that never matches | 1 fail | 0 fail |
| the missing-argument refusal (`:5`) | `[ -z "$expected_branch" ]` -> `false` | 1 fail | 0 fail |
| the success path leaves no scratch file (`:37`) | drop the pre-`exec` cleanup | 1 fail | 0 fail |

The third row is the half a one-directional guard fails: a wrapper that refused unconditionally
would still satisfy the first two.

### Defects found in review and fixed here

- THE 66 AND 67 BRANCHES WERE UNPINNED. Collapsing `exit 66` into `exit 65` originally left the
  suite fully green, so the distinction the refusal exists for was held by no test. They are
  unreachable from real git, so they are now driven through a `git` shim on `PATH` that answers
  `rev-parse` from the environment and records whether `commit` was reached
  (`trident/commit-with-resolved-head-realgit.test.ts:69-125`). The resolvable case runs through
  the SAME shim as a control, so a shim that merely broke everything could not pass for a guard.
- THE SUCCESS PATH LEAKED A TEMP FILE. `exec` replaces the shell, so the `EXIT` trap that removes
  the probe's stderr capture never ran — measured at 5 leaked files for 5 guarded commits against
  0 for 5 unguarded ones. Cleaned up before the `exec` and pinned by running the wrapper with
  `TMPDIR` pointed at a directory the test owns (`trident/commit-with-resolved-head-realgit.test.ts:58-76`).

### Deliberately not done

- NO REAPER CHANGE. The lane had also removed `worktree-reaper.ts`'s deferral and made the sweep
  call `deleteReapableRef`, deleting seven tests (including the "a SWEEP issues NO delete" pin and
  the destructive half's direct complement) and adding none. That is a destructive operation going
  live with no coverage of the newly-reachable path, in a PR whose issue and spec item are entirely
  claimant-side. Both files are reverted to `origin/main` byte-for-byte. Enabling the reap is a real
  follow-up and wants its own PR, its own review and tests for the deletion it turns on.
- No feature flag, no second commit path, no `pre-commit` hook.
- The reaper's deferral text still reads "until #635 lands". Once this merges that sentence is
  stale-but-harmless prose; correcting it belongs with the PR that enables the reap.
