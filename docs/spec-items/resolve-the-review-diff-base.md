---
title: Resolve every rev-range base to the pinned sha or origin/<base>
group: trident
status: open
priority: P0
cutover: true
issue_ref: "#546"
---

**A bare local branch name is never the left-hand side of a rev-range.** `git diff main..<head>`
in a shared build checkout diffs against whatever `refs/heads/main` happens to hold, and that ref
is only as fresh as the last time something on the box pulled it. Every commit merged into the
base since then is then presented as this branch's own work.

The failure is silent in both directions that matter: git exits 0, and the extra files are real
code, so nothing downstream can tell an inflated diff from a genuinely large one. It has been
measured twice on this repo:

- **Argus r4, run `25b2327d`** — local `main` was 8 merges behind `origin/main`; the published
  review artifact was 15,154 lines across ~100 files for a branch whose own work was 20 files /
  1,738 lines. ~87% of what a reviewer read was already-merged unrelated code. One reviewer
  vetoed the branch over bugs in files it does not touch and the round was lost.
- **#546** — reviewers read 149 files where the branch changed 30.

**And it had already been fixed twice, as a call site.** When #546 was filed,
`trident/inner-workflow.mjs` was resolving the base correctly in `probeCiBase` (the launch-pinned
sha) and in the plan probe's branch log (`origin/<base>`), while two other sites in the same file
— the resume diff and the forge contract's reviewer diff — still composed the bare name. A
boundary that depends on the next author noticing the right form thirty lines away is the failure
mode `docs/agent-legible-architecture.md` §1 names explicitly. So the unit of the fix is the
**rule**, not the call sites.

The resolution order is evidence-first, and is the same at every site:

1. the **launch-pinned base sha** — the commit `origin/<base>` held when the launcher observed it
   and cut the build branch. A sha cannot go stale, and it IS the cut point;
2. **`origin/<base>` in pr mode** — the remote-tracking ref. The launch path fetches
   `+refs/heads/<base>:refs/remotes/origin/<base>` and refuses to start the build if that fetch
   or its rev-parse fails, so the ref exists and is as fresh as launch;
3. the **bare name in local mode only** — the one world where it is right rather than tolerated:
   a local-mode run has no origin to be behind, and the launcher pins `base_sha` from
   `refs/heads/<base>` itself there.

## Acceptance

- [ ] **The stale case is proven against real git, with the correct and buggy answers
      differing.** A fixture whose local base ref is deliberately behind `origin/<base>`, where
      the resolved base names N files and the bare local name names N+K, both asserted as
      VALUES (counts AND file names), not as a relation. Verified by
      `trident/review-diff-base-realgit.test.ts` — "THE BUGGY ANSWER AND THE CORRECT ANSWER
      DIFFER" and "UNPINNED, pr mode". A test that diffs two refs in a freshly cloned fixture
      is satisfied by the broken implementation and does not count.
- [ ] **The workflow's own command is executed, not merely inspected.** The test extracts the
      Bash command the workflow composes and runs it with bash in the fixture, then reads the
      diff file git produced. Verified by the same file — the `resume-diff` seam in
      `runResumeDiff` runs `spawnCapture(['bash', '-c', …])`. Asserting the command STRING
      alone would pass against a command that resolves correctly and produces nothing.
- [ ] **The fresh case shows the two answers AGREE.** With the local ref fast-forwarded, the
      resolved base and the bare local name name exactly the same files. Verified by
      "FRESH local ref: the resolved base and the bare name AGREE, file for file", stated
      without reference to the composed command so it stays green under the mutation — a fix
      that merely always preferred something else would pass the stale case and fail this one.
- [ ] **A pinned base that is the STALE sha is still honoured.** The order is over real inputs,
      not a hard-wired preference for `origin/<base>`. Verified by "A PINNED BASE THAT IS THE
      STALE SHA IS STILL HONOURED" — which a fix that unconditionally reached for
      `origin/<base>` would fail while passing every other stale-case test.
- [ ] **Local mode keeps the bare name.** Verified by "LOCAL MODE, unpinned: the bare name is
      kept" and by `trident/inner-workflow-assembly.test.ts`'s local/pr pair. Prefixing
      `origin/` unconditionally would break every run in a repo with no remote, and no
      stale-case test can see that.
- [ ] **Reverting the fix reddens the suite.** Restoring `${shSingleQuote(baseBranch)}` at
      `writeResumeDiff` must turn `trident/review-diff-base-realgit.test.ts` red. Measured:
      4 of 7 tests fail, and the two agreement/complement tests stay green.
- [ ] **The class is closed as a rule, not as call sites.** `scripts/ci/diff-base-check.mjs`
      fails CI on a rev-range in `trident/` or `tools/` whose left operand names a base
      BRANCH — by spelling (`baseBranch`, `base_branch`, `BASE_BRANCH`) or by the binding it
      came from (`resolveBase()`, `detectBaseBranch()`, a `base_branch` field). Wired as
      CHECK 8 of `scripts/ci/lint.sh`.
- [ ] **The gate can fail on the REAL shape.** The site #546 was filed against is
      `git diff ${shSingleQuote(baseBranch)}..${shSingleQuote(headOid)}` — the name inside a
      call. A matcher that only knew `${baseBranch}..` would report success on the actual bug.
      Verified by `scripts/ci/diff-base-check.test.ts` — "THE NAME INSIDE A CALL is caught",
      plus a mutation test that plants an offending file under a scan root and asserts the
      gate exits 1.
- [ ] **The gate has a positive control and refuses an empty scan.** A grep that finds nothing
      proves nothing until the same grep has been shown finding something. Verified by the
      gate's own `runControls()` (5 pinned offenses at pinned lines, plus a negative control
      whose only hit is an un-argued exemption), which runs before the tree is touched, and by
      "an empty scan set is a FAILURE, not a pass".
- [ ] **Every site in the class is either fixed or has evidence that it is correct.** The
      dispositions are recorded in the as-built record for the branch that ships this.
