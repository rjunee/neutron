## Issue 1018 — Publish the candidate before PR review

### Design decision (recorded before implementation)

Choose option 1: review an open PR. The locked design does not settle the order:
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:346` explicitly excludes
“The internal stages of the rebuilt trident beyond the model-split rule.” Its
instruction at line 265 is “Keep the gates, replace the loop.” The strongest
argument is preserving the actual PR-head CI observation at
`trident/project-observation-sources.ts:34`, including branch protection and
mergeability, rather than inventing a weaker pre-PR CI substitute.

Cost: unapproved candidates become visible as PRs, and each fix must be published
before another review. Publication preflight and mutation proof must still run
before that write. Admission still refuses an already-present PR at
`trident/build-run.ts:211`; publication happens later in the same invocation, so
this refusal needs no relaxation. Resumption uses the existing resume contract.
Local merges retain their existing ordering. Approval and pinned merge remain
separate from publication.

### Implementation and continuous enforcement

- `trident/build-run.ts:438` extracts guarded publication; leak acquisition,
  revision stability, diff size and `publishGate` still precede the write.
  Mutation proof remains in `trident/build-host.ts:174`.
- `trident/build-run.ts:478` calls publication before every remote review,
  including after fixes and re-plans. The measured PR must be open, match the
  candidate head/diff, and retain an existing PR number (`:464`).
- `trident/build-run.ts:547` retains publication checks for local runs and
  already-approved resumes. The same helper owns both call sites. The merge
  boundary also compares the complete reviewed PR identity (`:557`).
- Fresh admission still rejects an existing PR (`trident/build-run.ts:211`).
  Admission happens before building or publishing. A PR created by this invocation
  is measured only after the publication effect (`:461`); it does not re-enter
  fresh admission. A resumed invocation uses the existing resume contract.
- The host enforces these comparisons independently of worker trailers on each
  round and before merging (`trident/build-run.ts:496`, `:557`, `:564`). If an
  observation fails, `unknown` stops the path; enforcement does not require the
  worker to remain alive or honestly report failure (`:462`).

The new publication mismatch text joins the existing `BuildRunOutcome.blocked`
vocabulary through `trident/build-run.ts:167`: recipient is the orchestrator.
It is not a new terminal-cause enum. By default the launcher reports `ok: false`,
null verdict, `inner-error`, and the block reason
(`trident/project-launcher.ts:45`, `:49`, `:54`, `:56`). Acquisition errors retain
`unknown`, which stays nonterminal (`trident/project-launcher.ts:41`).

### Tests and corrections to prior fixtures

`trident/build-run.test.ts:1367` drives the production observation sources with an
initially PR-less fresh run. Only CI transport responses are simulated; readiness,
CI and suite acquisition/classification are real. The green case reaches one
review worker and merges; red CI reaches the worker but prevents approval/merge;
unobserved CI stops before review; CI lost after the panel also stops. These are
positive controls for the preserved gate (`:1397`). The source still rejects the
same unpublished subject before the run (`:1392`). CI is re-observed after the
worker and applied before approval (`trident/build-run.ts:499`, `:506`, `:524`).
The independent merge CI gate remains at `trident/build-host.ts:184`.

Prior tests saying review failures prevent publication were wrong under the new
ordering: publication is now necessary to acquire review CI. They now assert that
those failures prevent merge, while exact publication counts and fix-head identity
are checked at `trident/build-run.test.ts:92`, `:1394`, `:1420`. The review-drift
fixture now mutates measurement 8, the actual post-review read (`:227`). Worker
fixture trailers learn the PR created by publication (`:74`).

Related fixture corrections preserve their original subjects:

- Production composition still exercises all three real observation sources;
  its publication policy/effect is explicitly simulated
  (`trident/project-build-host.test.ts:312`).
- The publication-without-effect fixture now stops before spending review usage
  (`trident/build-host.test.ts:360`). The cap fixture simulates publication and
  keeps its exact round-count assertion (`:678`, `:697`).
- Production persistence tests now stop at merge after review, and simulate PR
  creation/update against actual fixture Git heads
  (`trident/production-host-effects.test.ts:67`, `:74`, `:654`).

### Mutation evidence

Each counted mutation compiled with `bunx tsc -p trident/tsconfig.json --noEmit`,
then ran `bun test trident/build-run.test.ts --test-name-pattern <case>`.
Every row printed its changed source line, failed on the mutant, and passed after
restoration. Counts below are tests, not assertions.

| Guard / source line | Printed mutation | Target case | Mutant | Restored |
| --- | --- | --- | --- | --- |
| Pre-review publication, `trident/build-run.ts:478` | `if (local)` | fresh PR production observations | 4 fail | 4 pass |
| Candidate head, `:464` | `if (false \|\| snapshot.diff !== candidate.diff` | published head drift | 1 fail | 1 pass |
| Candidate diff, `:464` | `if (snapshot.head !== candidate.head \|\| false` | published diff drift | 1 fail | 1 pass |
| Open PR, `:465` | replace state refusal with `snapshot.pr === null` | published closed drift | 1 fail | 1 pass |
| PR head, `:465` | replace PR-head comparison with `false` | published pr-head drift | 1 fail | 1 pass |
| Existing PR identity, `:466` | `\|\| false))) {` | publication keeps the existing PR identity | 1 fail | 1 pass |
| Merge identity, `:557` | replace `corroborates` with head/diff comparisons only | PR identity cannot change | 1 fail | 1 pass |
| Local publication checks, `:547` | `if (approved)` | local mode reaches merged | 1 fail | 1 pass |
| Approved-resume publication, `:547` | `if (local)` | G038 exact full resume | 1 fail | 1 pass |
| Admission control, `:211` | `if (false)` | existing PR refuses fresh admission | 1 fail | 1 pass |

Two instrumentation corrections are excluded from the evidence: an initial local
selector matched zero tests; it was replaced with the exact existing test name.
The first identity-mutant printer located an earlier `false` rather than the
replacement. That case was rerun with the line calculated from the original
matched expression; the actual mutation printed at line 466 and went red/green.

### Scope and decisions left unchanged

No product decision in SPEC changed: the locked design explicitly leaves internal
stage order open. Local CI semantics, cleanup/retry policy, PR draft status and
remote base atomicity were deliberately not redesigned. Unapproved PR visibility
is the cost of preserving PR-head CI. The existing merge gate remains required.
No changes were made in the prohibited directories; enumerate the delivered files
with `git diff --name-only HEAD^ HEAD` after the commit.

Whole-tree phrase check:
`rg --hidden -n 'Revision changed after review|Revision changed during publication preflight' . -g '!.git' -g '!node_modules'`
finds the new wording in `trident/build-run.ts:451` and its test at
`trident/build-run.test.ts:269`, plus this record quoting the old wording solely to document the search.
The two code/test hits are the positive control; this record is the only old-text
hit and remains as audit evidence. The historical completed item
`docs/spec-items/publish-only-resume-without-re-running-forge.md:23` describes the
old Forge pipeline and stays historical; its publish-only recovery requirement is
not changed by this ordering fix.


### Final validation

- `bun test trident/build-run.test.ts trident/project-build-host.test.ts trident/build-host.test.ts trident/production-host-effects.test.ts`: **313 pass, 0 fail, 1,271 assertions**, four explicitly named files (16.61 seconds).
- `bunx tsc -p trident/tsconfig.json --noEmit`: exit 0.
- `bunx eslint trident/build-run.ts trident/build-run.test.ts trident/project-build-host.test.ts trident/build-host.test.ts trident/production-host-effects.test.ts`: exit 0.
- `git diff --check`: clean. As-built heading count: exactly one `## ` heading.

The test run uses simulated CI transport and local Git repositories. It is not a
live remote CI dispatch. The full suite was not run. The record is staged under
`.trident/as-built/fix/1018-review-pr-order.md` as explicitly directed by this lane,
rather than the repository's default record directory.
