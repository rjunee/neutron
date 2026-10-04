## 2026-10-04 — Preserve native planner tools across project terminal wakes

Terminal build and deploy wakes constructed the older live-chat tool list even
when addressing a project REPL. Their production wiring sends that specification
through `composeActingTurn` (`open/composer.ts:3350`, `:4923`), which forwards its
tools directly (`gateway/wiring/build-live-agent-turn.ts:1269`). The normal chat
default at `gateway/wiring/build-live-agent-turn.ts:1827` therefore could not add
the project's native continuation tool. A subsequent planner correctly refused
the stale parent surface (`open/wiring/project-build.ts:128`).

Both wake producers now use the shared `PROJECT_REPL_TOOL_DEFS` for a non-null
conversation project. General retains its existing surface; a project literally
named `general` receives the project surface. Explicit chat restrictions,
including an empty tool list, remain authoritative. This follows the existing
planner and project-REPL contract without changing admission, relay authority,
executable compatibility, leases, or retry budgets.

Validation: 32 focused gateway tests and 16 focused consuming project-build E2E
cases passed; root and Trident TypeScript checks and scoped ESLint passed. The
seven production Open terminal-build wake composition tests passed after their
two project-surface expectations were corrected; the separate deploy wiring
test has no duplicated tool-surface expectation. The
consuming regression feeds each actual wake producer's requested tool surface
into the fixture's native parent, then reaches merged through the production
planner/build driver. It does not exercise physical process replacement.

Paired semantic mutations were applied and restored. Forcing both project wakes
back to the older surface made both consuming regressions fail at plan with
`Worker refused: capability-unsupported` and no child dispatch; the stale-tools
refusal sibling passed. Granting the project surface to every scope made both
General controls fail while four legitimate project siblings passed. Existing
tests also preserve explicit restricted chat surfaces.

The complete consuming `open/__tests__/project-build-e2e.test.ts` suite was
started and remains pending at this record's source freeze. The complete
partitioned repository suite was not rerun in this focused lane. This record
does not count the local whole-tree leak scan as a pass: it reported 452 findings,
including the worktree metadata pointer and existing tree content under the
local denylist. Publication still requires the canonical exported-tree gate. It
does not establish live deployment or resolve separately observed executable
compatibility and adopted-relay evidence failures.
