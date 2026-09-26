## 2026-09-26 — Explicit phases determine dashboard colors

The dashboard matched a concatenation of phase and action label, allowing
incidental words such as “Fixture,” “prefix,” and “suffix” to color recorded
build/test work as fixes. Recognized explicit categories now take precedence in
the existing renderer classifier (`trident/build-timeline-html.ts:15-30`). Both
interval bars and expanded detail dots consume that classifier. Unknown,
host-stage and legacy categories retain the existing inference fallback.

The category vocabulary follows the existing attempt labels
(`trident/build-timeline.ts:127-130`), phase routes
(`trident/inner-workflow.mjs:442-488`), native test importer
(`scripts/build-timeline-codex-import.ts:72-74`) and GitHub CI observations
(`scripts/build-timeline-sources.ts:316`). The dashboard spec clarifies the
observable precedence rule without adding colors or changing timing attribution.

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
Initial checks with borrowed
dependencies were discarded as validation evidence. The shared-host suite and
deployment verification remain outstanding; these synthetic checks do not prove
live source coverage or served behavior at a deployed revision.
