## 2026-09-26 — Explicit phases determine dashboard colors

The dashboard matched a concatenation of phase and action label, allowing
incidental words such as “Fixture,” “prefix,” and “suffix” to color recorded
build/test work as fixes. Recognized explicit categories now take precedence in
the existing renderer classifier (`trident/build-timeline-html.ts:15-30`). Both
interval bars and expanded detail dots consume that classifier. Unknown,
host-stage and legacy categories retain the existing inference fallback.

The recognized subset draws on existing attempt-role labels
(`trident/build-timeline.ts:127-130`), selected phase routes
(`trident/inner-workflow.mjs:442-488`), native test observations
(`scripts/build-timeline-codex-import.ts:72-74`) and GitHub CI observations
(`scripts/build-timeline-sources.ts:316`). Role-label keys are not evidence of all
persisted phase keys. This correction does not establish a complete canonical
phase taxonomy: known route keys such as decomposition and bookkeeping retain
the unchanged inference fallback. The dashboard spec clarifies the observable
precedence rule without adding colors or changing timing attribution.

Consuming tests (`trident/build-timeline-html.test.ts:15-50`) exercise conflicting
labels across existing categories, genuine fix phases, legacy/unknown inference,
rendered bar and detail colors, and concurrent build/review/CI controls. Restoring
label-first behavior produced two failures; misclassifying genuine fixes as build
produced one failure; restoring the implementation passed all seven renderer
tests with 274 assertions.

After this worktree's own frozen dependency installation and successful workspace
dependency verifier, the five focused timeline renderer, projection, server,
source and importer files passed 49 tests with 560 assertions. Root and Trident
TypeScript checks, focused ESLint and the full local `scripts/ci/lint.sh` gate
passed. The strict as-built write guard passed against the freshly fetched base.
The commit-message privacy gate passed with zero findings. The full tree privacy
gate failed with 452 findings, including the worktree metadata pointer and
existing-file denylist hits; this is not a clean full-tree privacy result.
All added text across this PR's four files also passed the same privacy gate as
an explicit PR-body input with zero findings. A private positive control using
an existing prohibited denylist term returned the expected failure without
displaying the term. This establishes added-text coverage, not full-tree purity.
Initial checks with borrowed
dependencies were discarded as validation evidence.

The canonical `bash scripts/check-shared-host.sh` completed with exit 0 on tested
revision `236fabd6bc4720d7ab22a3eeacb301ea1fd02bac`, tree
`cd025049ba7e9854c7d701a2d0bd0f5c8d8316cb`. All 51 project-owned TypeScript
configurations passed. The partitioned suite declared, discovered, assigned and
executed all 1,698 files: 1,464 general, 22 PGLite, 43 device and 169 real-HTTP.
All 18 bounded-memory lanes passed with zero failed lanes: 25,894 tests passed,
23 skipped, zero failed and 118,055 assertions. PGLite passed on its first attempt.
The retained local log has SHA-256
`2e21dbc39d091b1f0fc84d7b2a2ace4e3fb555696158c6cb75a4b677ad66c889`.
The receipt-only commit changes this unmerged record; every other tracked blob
remains identical to the tested revision. This records local proof on that
revision, not exact-head CI on the receipt commit. CI and deployment verification
remain pending. These local checks do not prove external browser behavior, live
authentication, inclusive live sources or served behavior at a deployed revision.
