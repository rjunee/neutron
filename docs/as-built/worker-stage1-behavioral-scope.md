## 2026-09-28 — Bound host-suite worker Stage 1 within large consuming files

This is a bounded follow-on to #1196. Its authority is the existing
`docs/spec-items/trident-build-efficiency.md`: “Preserve both and extend the
existing owners” (:76–79); “A valid subset receipt cannot become full-suite
evidence” (:191–199); explicit configured host execution and consuming retry
checks (:219–226); and “Efficiency cannot reset budgets or bypass a gate”
(:228–239). The same item requires the consuming
`open/__tests__/project-build-e2e.test.ts` and both root and Trident typechecks
(:266–269). The locked pivot says “Keep the gates”
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:265–274`).

The existing Stage 1 file cap permits incomplete fail-fast coverage, but still
instructs a file-scoped invocation (`trident/test-strategy.ts:745–781`). A large
consumer file can therefore dominate that check even within the file cap.
Host-suite workers now receive advice to select affected behavioral cases within
such files, including positive and negative controls, keeping required consuming
files explicit. They must observe a nonzero executed test count and report the
commands, cases, counts, failures and deferred coverage. Zero matches,
skipped-only output and absent summaries cannot establish a green Stage 1.
Explicit typecheck, consuming-surface and whole-file requirements remain binding
(`trident/test-strategy.ts:785–802`). No broader typecheck or lint waiver was
introduced.

The advice travels through the existing BUILD/FIX host-context selection
(`trident/project-build-host.ts:128–147`). The immutable builder brief still
directs those roles to the context (`open/wiring/project-build.ts:704–708,
736–740`); the brief version, legacy reconstruction and stored worker bindings
are unchanged. Host Stage 2 still requires its identity-bound full-suite receipt,
and wave members still receive the configured full-suite strategy. This change
adds neither receipt reuse nor a new gate.

The new consuming case observes both actual BUILD and FIX requests, briefs and
written context at the worker seam, then completes the governed flow
(`open/__tests__/project-build-e2e.test.ts:1813–1840`). Its assertions prove that
the instructions arrive; they do not prove that an LLM follows them. Existing
wave coverage preserves the worker full-suite obligation (:2033–2043).
Existing admission controls retain the green sibling and unknown, red and moved
identity refusals (:4885–4967); receipt reconstruction controls require fresh
proof for changed inputs and subset receipts (:3292 onward).

Validation on the candidate based on `efca5839548ce44986d7576295987b4beb8481a2`:

- `bun test open/__tests__/project-build-e2e.test.ts -t 'host-suite BUILD and FIX|wave member retains worker full suite|terminal (single|task-sequence) runs one host suite|same-round cached nonzero host receipt|prepared host suite receipt survives|consuming host admission overlaps'`:
  22 passed, 408 filtered out, zero failures. This is explicitly subset evidence.
- `bun test trident/test-strategy.test.ts`: 86 passed, zero failures.
- `bunx --no-install tsc -p tsconfig.json --noEmit` and
  `bunx --no-install tsc -p trident/tsconfig.json --noEmit`: both exited zero.
- `bash scripts/ci/lint.sh`: exited zero.
- `bash scripts/ci/leak-gate.sh --tree .`: failed with 452 findings under the
  installed local denylist. Baseline equivalence was not established; this is
  unresolved purity evidence, not a clean gate or an attribution to this diff.
- Delivery mutation: temporarily routing host-suite context to the configured
  full strategy instead of `renderHostSuiteWorkerStrategy` caused the new
  consuming case to fail (zero passes, one failure). Restoring the route restored
  the passing consuming case. This is a delivery mutation, not a claim that
  instruction assertions measure model compliance.

The isolated E2E invocation required execution outside the filesystem sandbox
because its mandatory PID namespace launcher was refused inside it. Isolation
remained enabled. Full matrix and full partitioned-suite publication checks are
reserved for the coordinated publication run; no full-suite completion is claimed
by this focused receipt. No deployment or live worker measurement was performed,
so this record claims no time or token saving and does not close #1196.
