## 2026-09-30 — Preserve native release behavior through the CI lint gates

The published integration's lint check found cross-package relative imports,
silently swallowed cancellation rejections and an unexplained wall-clock bound.
The consuming Work Board test now imports the same client decoders through their
workspace names (`open/__tests__/work-board-recovery-refusal-live.test.ts:10-11`).
Native continuation cancellation and authorization-reader cleanup use the existing
named `fireAndForget` supervisor (`runtime/workers/claude-native-continuation.ts:81`,
`gateway/http/admin-respawn-surface.ts:62`). Rejections are logged and counted;
the independent one-second cancellation control and immediate reader lock release
remain intact. Cancellation failure grants no new input or lease refund.

The writer-queue expiry test retains its 4,800 ms assertion and explains the
allowed wall-clock exception (`open/__tests__/project-build-e2e.test.ts:9062-9069`).
Its real queue and host timers lack a shared injected timer clock, and the same
unknown outcome and retained lease could otherwise conceal doubled queue credit.
The lawful 1.5-second queue wait plus two-second execution allows 1.3 seconds of
scheduling margin; another 1.5 seconds of credit crosses the existing bound.
No guard or consuming assertion was weakened.

Validation: 69 affected continuation, operator-surface and live-board tests passed
with 278 assertions. The queued-expiry consuming case passed separately with ten
assertions. The complete lint gate passed, including the promise supervision and
wall-clock justification checks. Root and Trident TypeScript checks passed.
This is local repair evidence, not deployment
or real provider quota acceptance. The locked pivot's preserved gates remain at
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:271-274`, with unattended merge
acceptance at `:294-295`. Original signed authority and queued-child requirements
remain at `docs/spec-items/claude-same-agent-continuation.md:102-104` and `:139-144`.
