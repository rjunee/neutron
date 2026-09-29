## 2026-09-29 — Enforced native planner work boundary

The planning allowance did not authorize candidate acceptance validation, but the
native planner previously received the builder's unrestricted execution grant.
The new v5 request uses the existing `edit` grant with network disabled. Claude's
native Agent receives an exact registered role whose sole tool is
`mcp__neutron__planner_work`; neither generic execution/delegation nor raw filesystem
tools are exposed (`runtime/workers/planner-work.ts:8`,
`runtime/workers/claude-acting-turn.ts:281`). This implements the planning boundary
in `docs/spec-items/trident-build-efficiency.md:261`, not a new workflow or budget.

The authenticated existing tool bridge dispatches a random per-request capability
bound by the host to the admitted session, original request, worktree and deadline.
Scoped brief/list/read/write operations preserve useful preparation. Fixed JSON
parsing and single-file JavaScript/TypeScript syntax scanning do not load source,
plugins or repository configs. Git observes committed objects with external diff,
textconv, hooks and fsmonitor disabled; it never runs worktree status/diff, which
can execute clean filters. Raw preparation hashes remain explicitly uncommitted;
the builder receives them and retains every acceptance gate. Only the host measures,
validates and atomically publishes the result (`runtime/workers/planner-work.ts:48`).
Expiry revokes operations without declaring an unknown child stopped.

Bare legacy briefs cannot restore execution authority. Exact armed reservations
and the current host checkpoint, or already-validated settled retry bindings,
preserve original v2/v3/v4 request identities. Legacy planner calls can recover
an existing reservation but cannot dispatch a new unrestricted re-plan
(`open/wiring/project-build.ts:729`, `runtime/workers/project-runners.ts:145`).
The two paid-candidate recovery readers recognize v5 without weakening their
original request/policy comparisons. Native role identity survives boot adoption
only when the persisted profile digest and observed live process argv match the
exact profile (`runtime/adapters/claude-code/persistent/boot-adoption.ts:2497`).
No pending request capability is recreated during adoption.

Provider scope remains explicit. Native Codex cannot seal delegation in the
installed contract and refuses the new capability; it is not rerouted. Configured
different-provider Claude headless planning remains supported by its existing
read-only CLI whitelist, empty strict MCP configuration and host publication.
It reports typed blocked when preparation or a probe needs unavailable tools.
This preserves the configured placement in the locked pivot, lines 94–107; it
does not claim writable capability parity or introduce a fallback.

Author verification: 385 focused tests across nine files passed, including the
authenticated bridge, adoption, scoped concurrent-request controls and valid-program
semantic mutations. Replacing syntax scanning with source evaluation creates a
harmless marker and fails the same no-execution assertion; denying writes breaks
legitimate preparation. Focused consuming cases preserve builder mutation proof,
original legacy identities, fresh recurring headless success, explicit permission
blocks and missing/foreign reservation refusal with restored positive controls.
Root, Open and Trident TypeScript checks passed. The complete consuming file and
full host suite are intentionally consolidated in the integration gate, not claimed
as author passes; interrupted exploratory runs are not acceptance evidence.

The first frozen candidate's review found that legacy binding recovery assumed
the native Codex reservation identity for configured headless work. Recovery now
reuses the adapter's exact build/fix identity and its separate delegated review
identity (`runtime/workers/codex-headless.ts:137`,
`runtime/workers/codex-review.ts:38`). The original REPL provider must still match.
Authenticated unversioned pending plans retain the existing migrated-strategy
validator; bare old briefs remain insufficient. The corrective checks passed 114
adapter tests and 22 focused consuming recovery cases, including actual headless
reservations, missing/foreign refusal, restored recovery without replay, and old
schema/policy controls. Earlier red historical fixtures are not counted as passes.

The local full-tree privacy scan remained red. An independent immutable-tree
comparison found the same 451 findings at the base and first frozen candidate;
the linked worktree added one untracked administrative-pointer finding. The
complete first-candidate diff and commit messages had zero findings with the
canonical denylist. This distinguishes baseline findings from introduced ones;
it does not waive the full-tree result or claim the final integration gate passed.

An offline installed Claude 2.1.284 fixture observed the restricted child offering
only the planner tool while its sibling retained ordinary tools; all ten assertions
passed over nine scripted local requests, including real broker preparation,
diagnostic, execution refusal and publication. This is CLI compatibility evidence,
not live-provider acceptance, live admission/reboot proof, deployed savings or a
complete provider cutover. No acceptance gate or budget was removed.
