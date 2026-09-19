## 2026-09-19 — Validate cold Codex build paths before opening

The preceding preflight correction covered invalid build paths against a warm
owner but missed the cold case. Through the real project runners and in-REPL
worker, a wrong cwd or writable root opened an owner before validation. The
result became `unknown`, correctly triggered the opening-attempt fence, and
incorrectly made subsequent valid owner chat unavailable. Both newly added cold
tests failed against that implementation.

`open/wiring/codex-owner-binding.ts:166` now passes the resolved canonical project
to its pre-opening callback. The build consumer validates cwd and roots before
recording or attempting an opening, then repeats the validation after the
asynchronous resolution and for warm owners (`:355`). It does not relax unknown
opening or native-delivery fences. This preserves the shared long-lived owner
contract at `docs/plans/harness-orchestrator-pivot-2026-09-11.md:87-111` without
creating a second session or changing the helper/runtime implementation.

The cold consuming controls establish zero openings, zero native writes, no work
marker, and a successful subsequent first chat. Warm path controls remain.
Fifty focused binding/durable tests pass, including failed and late-returning
openings, actual uncertain native submission across chat/restart, and the valid
shared chat/build continuity control. Four restored semantic mutations fail:
removing cold path validation, removing post-resolution validation, omitting
failed/delayed opening evidence, and treating actual native writes as read-only.
The consuming project-build E2E suite passes all 88 tests; root/runtime TypeScript,
focused lint, diff checks and scoped added-content/commit-message privacy checks
pass. The as-built guard preserves all prior records.

No native lifecycle implementation changed; this correction does not extend
the prior idle-restart smoke into a pending-approval recovery claim. No push,
PR, merge or deployment was performed.
