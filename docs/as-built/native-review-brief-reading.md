## 2026-09-29 — Guide native review workers to read brief instructions first

Native Claude review and synthesis dispatches now ask the worker to select JSON
instruction, result-file, verdict-schema, round, repair and panel metadata fields
first, then consume the complete measured diff and every supplied seat verdict
once. The prompt explicitly discourages an initial whole JSON dump followed by
rereading fields merely to find instructions. Other brief formats remain readable
as supplied (`runtime/workers/claude-in-repl.ts:56`). This is prompt guidance,
not machine enforcement of the worker's reads. No token or latency saving has
been measured for this change.

The canonical review brief serializes the snapshot before its instructions
(`trident/project-review-source.ts:114`), and its serialized bytes participate in
receipt identity (`trident/project-review-source.ts:120`). The change therefore
adds guidance only at native dispatch construction. Request serialization and
reservation identity still use the same request (`runtime/workers/claude-in-repl.ts:41`);
the focused tests compare the exact Request (data) line, native model and tool
arguments, limits, metering context and result-file instructions
(`runtime/workers/claude-in-repl.test.ts:105`). All eight other worker roles retain
the original prompt (`runtime/workers/claude-in-repl.test.ts:134`). Serialized
review and synthesis requests recover their armed trailer without another
dispatch (`runtime/workers/claude-in-repl.test.ts:380`), alongside the existing
lost-acknowledgement controls (`runtime/workers/claude-native-dispatch-evidence.test.ts:64`).

Validation on this change used local dependencies installed with
`bun install --frozen-lockfile --ignore-scripts --no-progress` (exit 0), including
TypeScript 5.9.3. Root and Trident `tsc --noEmit` checks passed (exit 0).
`bun test runtime/workers/claude-in-repl.test.ts runtime/workers/trailer-slot.test.ts runtime/workers/claude-native-dispatch-evidence.test.ts runtime/workers/claude-native-dispatch-receipt.test.ts runtime/workers/claude-native-dispatch-retry.test.ts`
passed 69 tests across five files with 263 assertions and zero failures (exit 0).
Removing the guidance failed both review/synthesis prompt tests (two failures,
exit 1); applying it to build failed the unchanged-build-prompt control (one
failure, exit 1). Both mutants were restored before the passing focused run.
The combined publication change owns the consuming build E2E and repository-wide
validation; this bounded branch does not claim either result.
