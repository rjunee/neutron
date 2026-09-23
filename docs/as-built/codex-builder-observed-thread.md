## 2026-09-23 — Observe Codex builder threads and use the resume CLI contract

This is the low-level Codex transport slice of #1196, governed by
`docs/spec-items/trident-build-efficiency.md` and the reused-thread item. The
builder previously echoed the requested thread ID without observing a provider
event, returned fabricated zero usage, and passed exec-only sandbox/cwd flags
to `exec resume`.

The wrapper now requests JSON events, uses `exec resume <recorded-id>` with
`sandbox_mode` configuration and the process working directory, and probes the
resume JSON/config surface before a resumed turn. Fresh calls retain the exec
sandbox/cwd flags. An unsupported resume or invalid ID refuses explicitly.

The runner captures the provider's `thread.started` and completed-turn usage.
Missing usage and unreported model remain null. A missing, foreign, duplicate,
failed, or malformed turn cannot certify completion. Model message text cannot
substitute for an outer protocol event. A request/account-bound durable receipt
preserves the original thread, observation and trailer across runner restart;
an uncertain or failed call is never silently replayed. The existing git-trailer
corroboration still decides whether the build's claimed revision was produced.

Verification: 152 wrapper/runner/parser tests pass, including observed first call,
exact follow-up, decoy rejection, malformed telemetry, genuine zero, mutable
role-slot replacement, corrupt receipt, changed account home, and failed-process
recovery. Six semantic mutations were killed: disable thread matching; reject a
matching thread; invent zero usage; veto missing telemetry; restore exec-only
resume flags; force resume on a fresh call. Each was restored before the final
green run. Both root and Trident TypeScript checks pass. The consuming
`open/__tests__/project-build-e2e.test.ts` suite passes all 125 tests.

Scope remains partial: durable project/role/model/credential ownership and writer
coordination belong to the consuming orchestration layer; this transport accepts
its explicit requested ID and verifies the provider's reply. Failed-attempt usage
accounting requires the separate outcome-accounting work. These fixture results
do not claim live provider recall, deployed efficiency improvement, or completion
of the P0 item.
