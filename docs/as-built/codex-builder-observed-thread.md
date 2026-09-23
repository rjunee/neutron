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
substitute for an outer protocol event. A request/credential-home-bound durable
receipt preserves the original thread, observation and trailer across runner restart;
an uncertain or failed call is never silently replayed. Recovery ignores transient
brief/result filenames within the same durable state directory and the caller's
remaining wait budget, while retaining the brief integrity and execution policy.
Moving the state directory itself is not supported by this transport. The existing
git-trailer corroboration still decides whether the build's claimed revision was produced.

Verification covers `trident/codex-build.test.ts`,
`runtime/workers/codex-headless.test.ts`, and
`runtime/workers/codex-build-observation.test.ts`, including observed first call,
exact follow-up, decoy rejection, malformed telemetry, genuine zero, mutable
role-slot replacement, corrupt receipt, changed credential home, and failed-process
recovery. Nine semantic mutations were killed: disable thread matching; reject a
matching thread; invent zero usage; veto missing telemetry; restore exec-only
resume flags; force resume on a fresh call; run the child outside the worktree;
overbind recovery to the wait budget; ignore changed brief integrity. Each was restored before the final
green run. Thread-match and telemetry mutations exercise
`runtime/workers/codex-build-observation.ts` through its adjacent test file;
fresh/resume argument mutations exercise `trident/codex-build.sh` through
`trident/codex-build.test.ts`. The resume test observes the actual child cwd;
the wrapper also explicitly enters the worktree at its child-spawn boundary.
Recovery-identity mutations exercise `runtime/workers/codex-headless.ts` through
the adjacent test's transport-filename/budget recovery case. The three focused
suites pass all 153 tests.
Both root and Trident TypeScript checks pass. The consuming
`open/__tests__/project-build-e2e.test.ts` suite passes all 125 tests.

The identity-env registry initially failed for both new broad thread-ID regexes:
its deliberately conservative detector also matches identity-variable names.
`tests/integration/identity-env-readers-registry.test.ts` now records those exact
files and behavior provenance. Neither reads the identity-home selectors; the
runner's added environment read is the credential-home selector used in receipt
identity. The detector and assertions are unchanged. The full registry suite was
observed red (19 passing, two failing) before registration and green (21 passing)
afterward.

Scope remains partial: durable project/role/model/credential ownership and writer
coordination belong to the consuming orchestration layer; this transport accepts
its explicit requested ID and verifies the provider's reply. Failed-attempt usage
accounting requires the separate outcome-accounting work. These fixture results
do not claim live provider recall, deployed efficiency improvement, or completion
of the P0 item.
