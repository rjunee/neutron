## 2026-09-19 — Read-only Claude headless workers with bound session reuse

The locked provider split requires Claude headless work when the project REPL
belongs to another provider. Decomposition and synthesis remain Claude-only in
`trident/phase-models.ts:168` and `trident/phase-models.ts:271`. This slice supplies
the runner; it does not change those settings or claim the consuming project-build
composition is wired or its full acceptance dispatch has completed.

`runtime/workers/claude-headless.ts:193` constructs the bounded runner for plan,
review and synthesis. Authentication is selected from the explicitly supplied
environment, with no ambient environment fallback (`:33`). The CLI help and
selected authentication must pass admission (`:47`). Launches retain only read
tools, disable customizations and MCP, confine reads to the worktree and declared
directories, and deny permission prompts (`:268`). Grants are ceilings: a planner
request with write permission still receives this narrower read-only surface.

The host verifies the brief receipt and supplies its bytes on stdin. Only the
CLI's successful `structured_output`, with exact run, step, schema and session
identity plus a registered payload validator, can yield a result (`:98`). Ordinary
reply text is ignored. The reported model must equal the resolved requested model;
usage comes from CLI telemetry or remains unknown. The host writes the canonical
trailer atomically after recording the validated CLI receipt (`:284`).

Per-step reservations prohibit uncertain redispatch. Host bindings scope retained
sessions to run, cwd, model and selected credential. New processes pass either
`--session-id` or the exact `--resume` id. Thread locks prevent a second writer;
receipt recovery can reconstruct a missing canonical trailer without another
Claude call. A held publishing lock can be recovered only after observing its
host process is gone, with an exclusive recovery claim (`:68`). Unknown process
termination, malformed output and unavailable capabilities stay non-successful.

Verification used Claude Code 2.1.278 and the selected explicit login. The actual
runner completed a fresh plan and resumed synthesis on the exact same CLI session
with measured usage and an unchanged workspace marker. Separate CLI controls read
markers in cwd and an added directory; an attempted sibling read was denied. A
write/owner-question control reported the available tools as exactly `Glob`,
`Grep`, `Read`, `StructuredOutput`, with no MCP servers. Its observed tool sequence
included a successful `Read` and two attempted `Write` calls; both writes were
disabled, both workspace/state sentinels stayed unchanged, and `AskUserQuestion`
was unavailable. These measure the installed CLI tool boundary, not an operating
system sandbox against a malicious CLI binary.

`runtime/workers/claude-headless.test.ts:77` exercises real fixture processes and
durable files: credentials, placement, output authority, unknown telemetry, exact
resume binding, lost acknowledgement, recovery, live-host exclusion, brief/path
integrity, cancellation, large stdin briefs and bounded stdout. Inverting the
placement check made legal headless work fail; removing the step identity check
produced a completed stale result and failed its test. Both mutations were
restored. The focused runner, project-runner and trailer-slot suites passed
55 tests; root and trident TypeScript checks passed with private worktree
dependencies. Scoped file and commit-message leak preflights passed. Consuming project-build end-to-end verification remains the
integration change's responsibility.
