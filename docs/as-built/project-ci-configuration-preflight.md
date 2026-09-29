## 2026-09-29 — Refuse missing project CI setup before PR build preparation

An omitted project repository declaration resolves the existing `code` workspace
without a CI workflow (`contracts/project-repos.ts:54`). That compatibility
behavior is useful for local builds, but a PR build previously discovered the
missing binding only after doing implementation work. Both review and merge
already refused it (`trident/project-observation-sources.ts:32`,
`trident/production-host-effects.ts:477`). The configuration must be supplied
explicitly; this change neither chooses a workflow nor repairs existing project
configuration.

PR preparation now resolves the selected repository and validates its declared
workflow before worktree preparation, dependency installation or worker setup
(`open/wiring/project-build.ts:345`). Its diagnostic names `project-repos.json`
and the missing selected-repository binding. The existing declaration parser
continues to reject malformed values. Local builds still accept omitted remote
CI setup, and the downstream readiness and merge guards remain in force.

The wiring controls reject missing declarations, missing or malformed workflow
values, and a declaration for a different repository path before host commands or
worker construction; each accepts a corrected explicit workflow
(`open/__tests__/project-build-wiring.test.ts:131`). The consuming E2E refuses
missing setup with zero worker attempts, then completes the same run after an
explicit declaration (`open/__tests__/project-build-e2e.test.ts:1510`). Its sibling
cases retain refusal for red checks, moved CI identity and malformed required
check configuration (`open/__tests__/project-build-e2e.test.ts:1528`). Settled red
retains the existing review/fix path; unknown configuration or moved identity
cannot dispatch reviewers. The local-mode E2E removes the declaration and still
merges without a GitHub call.

The governing requirements remain “Keep the gates” in the harness pivot and
the configuration-fault refusal in `refreshed-ci-merge-readiness.md`. This is an
earlier setup diagnostic, not evidence that live acceptance has completed.

Validation: the complete project build wiring and E2E files passed together
(496 tests, 6,329 assertions), and the existing project repository, project build
host and production host effects files passed (217 tests, 1,101 assertions).
Both root and Trident TypeScript checks and lint on the three changed TypeScript
files passed. Process tests ran inside their required private PID/mount boundary;
the initial sandbox denied that boundary and a wiring fixture socket, so those
environment refusals were followed by the complete isolated run above.

Semantic mutations of the preflight were detected in both directions: removing
the workflow refusal failed the two missing-configuration controls; refusing
every workflow failed all four corrected-declaration controls; requiring remote
CI for local builds failed the local control. After restoring the production
source, all five focused controls passed. The partitioned repository suite and
publication gates remain the responsibility of the final publication batch.
