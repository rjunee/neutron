## 2026-09-30 — Preserve original Claude file-auth source evidence across gateway restart

For #1416, a surviving parent could retain its authenticated native dispatch
receipt but lose the in-memory auth observation, leaving capacity admission
unavailable. `runtime/adapters/claude-code/persistent/native-file-auth.ts:94`
now includes a versioned source descriptor in the existing signed launch
evidence. It contains source paths and settings selectors only; no environment
map, credential bytes or credential digest is persisted, and credential files
are not read. The existing settings snapshot still revokes changed sources.

`runtime/workers/claude-native-continuation.ts:144` checks the original PID,
kernel start ticks, boot and native session before reconstructing that source
observation. The original receipt authenticates the launch generation and exact
request/lease; `gateway/project-admission-store.ts:48` rechecks the current
durable authorization generation, open fence and exact live-child lease.
Continuation repeats source, process and authority checks before capacity and
submission. An existing but revoked in-memory observation cannot fall back to
restoration. Legacy/adopted parents without an original authenticated descriptor
remain UNKNOWN. Full host reboot does not preserve a survivor. The original
one-use claim still forbids input after an ambiguous postclaim restart.

Validation: the auth, continuation and durable admission tests pass 54/54.
The focused consuming continuation/capacity suite passed 34/34, including the new
restart positive; the subsequently added restart source-change refusal passed
with the restart controls (7/7). Root, Trident and Open TypeScript checks pass.
The consuming restart positive fails when restoration is disabled (blocked,
expected merged); the consuming changed-source refusal fails when its snapshot
check is bypassed (merged, expected blocked). Both mutants were reverted.

These fixtures establish local control flow and refusal, not served native tool
availability or cross-account 429 consumption. The separate native model-force
call-path question and live release evidence remain unresolved; this change does
not authorize live input, credential rotation or deployment.
