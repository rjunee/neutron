## 2026-10-04 — Specify remaining Open fixture drain slices

Investigated #1389 against freshly fetched `origin/main` at
`63afe3be3a83d08125999c3e95130c67cfc9ce08`. The issue records historical
closed-database CI noise without attributing the first log line to one fixture.
This change specifies three bounded slices; it does not implement or claim to
have repaired the fixture teardown paths.

The observed consumers call async-capable cleanups without awaiting them:
`tests/integration/claim-redirect-once.open.test.ts:95-103` before outer DB close
at line 158; `tests/integration/import-watch-rearm-on-reconnect.open.test.ts:220-224`;
`open/__tests__/activity-inspector-served.test.ts:149-156`; and
`open/__tests__/open-app-ws-durable-chatlog.test.ts:168-172`. The existing
production drain already awaits in forward order and continues after rejection
(`gateway/index.ts:264-273`), and external loop stop awaits the active tick
(`loop/index.ts:353-373`). The real-composer positive control at
`open/__tests__/reflect-loop-arming.test.ts:120-137` checks active-to-inactive
cleanup; it does not exercise those four fixtures' DB-close boundary.

The integration spec orders controlled real-composer harness work, migration of
both consumers, then consuming regression and mutation evidence. The activity
and durable-chatlog specs own disjoint test files and local support, so those
cards can proceed concurrently. Each entire spec is its card's full saved
plan. Acceptance requires an actually registered DB-using loop tick, explicit
barriers, rejection/empty controls, and mutations at each consumer. No runtime
cleanup alternative or forced planner mode is specified.

These scopes follow the project-REPL and autonomous completion requirements
(`docs/spec-items/the-orchestrator-owns-the-build-loop.md:36-43,101-103`;
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:85-107,271-295`). Existing
review/CI and post-approval mutation gates remain requirements, as inventoried
in `docs/trident-gates-inventory.md:129-139,211-213`. This specification earns
no live-build completion claim and leaves #1389 open.

The three new paths were checked with `git ls-tree -r --name-only origin/main`
on the fetched ref, with `CONTRIBUTING.md` as the known-present control. The
content search for `drainRealmodeCleanups|realmode_cleanups` over
`docs/spec-items` and `gateway/index.ts` found the production owner and no
existing spec using those spellings; this is a bounded duplicate check, not
a claim that all cleanup work elsewhere is absent. The spec index was
regenerated using its maintained renderer.

Independent source/spec review found no blockers. Its instrumentation caveat
was incorporated: observe teardown progress and ordered events, and assert a
successful DB write rather than only tick completion, because the upload
sweeper catches write failures (`gateway/upload/chunked-upload-sweeper.ts:163-166`).
The focused spec-index suite passed 38 tests with 466 assertions after offline
dependency installation and process-isolated execution. No fixture behavior
suite or mutation experiment was run for this documentation-only change.
`bash scripts/ci/lint.sh` and `git diff --check` also passed.

The local full-tree leak gate returned 452 findings: one untracked worktree
metadata path and 451 denylist findings in existing files. This is a local
baseline/configuration discrepancy, not a passing purity result. No gate,
allowlist, or denylist was changed; required CI remains the merge gate.
