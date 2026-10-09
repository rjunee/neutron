## 2026-10-09 — Admit independent reviewers alongside native builders

The live concurrency attempt in #1295 reached a green host suite and CI, then
its standalone review spent its entire 15-minute wall waiting for another
card's builder. The parent received no review dispatch. The independence
predicate accepted reader/reader and disjoint writer/writer pairs, but rejected
a mixed pair even with the same measured isolation proof.

`runtime/workers/native-child-workspace.ts:128` now applies that existing proof
to every pair containing a writer. Canonical worktree paths, Git directories,
inode identities, branches in a shared repository, and workspace/result paths
must remain independent. Two readers retain their existing shared-tree rule.
The session queue still requires exact child binding before yielding parent
input, and preserves FIFO order, ordinary-turn exclusion, the durable census,
unknown ownership, cancellation and original deadlines. Harness grants still
govern what each child may access; this is scheduling authority, not a new tool
grant. No live request, budget, receipt or lease was edited.

This extends the admitted-workspace scheduling described by
`docs/as-built/native-child-independent-writers.md`; the earlier record remains
historical. The current queue comment and
`docs/spec-items/trident-build-efficiency.md` describe the mixed-pair contract.
Ordinary turns without measured workspace authority remain excluded behind
background children, including the earlier mixed-mode ordering controls.

Before the correction, the runtime barrier failed both mixed launch orders
(17 pass, 2 fail). The consuming Open regression failed all four independent
mixed cases, including simultaneous admission (5 pass, 4 fail). Those consuming
cases use actual Git worktrees, database admission, prepared role requests and
the real REPL queue; their alias controls remained green.

After the correction, 25 workspace/budget tests, 176 actor/runner regression
tests and 13 consuming tests passed. The latter include the existing
standalone/panel review barriers and vetoes.
Mixed pairs sharing a canonical worktree, branch or result-write path remain
serialized in both orders. A semantic mutation admitting mixed pairs without
the isolation proof failed all six opposing controls while 15 other cases
passed. Restoring the exact implementation bytes returned all 25 focused
workspace/budget cases to green. Lint and `git diff --check` also passed.

The runtime typecheck passed. The Open typecheck caught the new test's expected
role array widening to `string[]`; declaring its worker-role element type fixed
that assertion without changing runtime behavior. The corrected Open typecheck
and all nine admitted-child consuming cases passed. Dependency-layer validation
also passed with no new violations.

The canonical full shared-host gate passed on tested revision
`2d865754579651753fd3410de273b189f32e6674`, based on
`cb93f492a9e6739bec2f3fd6f1026f42359d76c1`. Command:
`bash scripts/check-shared-host.sh`, with Bun 1.4.2, four jobs and the wrapper's
unchanged default concurrency. The run started at 19:11:05 UTC and completed
at 19:45:57 UTC on 2026-10-09 with exit 0: lint, all 51 TypeScript projects,
and all 1,805 discovered test files across 19 lanes. The coverage audit reports
zero failed lanes and unchanged suite input identity. The final HTTP batch
passed 1,442 cases with 14 configured skips and no failures. This final receipt
is the only tracked change after that full validation.

Local full-tree purity is not a clean receipt: the local denylist reports
findings outside the six changed files and the linked-worktree pointer. The
same configured gate found zero findings in all six changed tracked files,
with an unchanged tracked control included. Commit-message and as-built guards
passed. Exact publication-head CI purity remains required.

Final-head CI, deployment and a new live concurrent completion witness remain
pending. These local results do not establish unattended acceptance or close
#1295.
