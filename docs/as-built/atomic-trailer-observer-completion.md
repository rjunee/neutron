## 2026-09-24 — Wait for the trailer observer to finish copying

Issue #1245. The concurrent-reader test could report an empty trailer after the
observer shell created its redirected output but before `cat` wrote any bytes.
The production publisher still writes a complete temporary file and renames it
(`trident/codex-build.sh:849-863`). The observer now emits a separate completion
receipt after a successful copy; the test waits for that receipt before comparing
the exact bytes and checking the six-line trailer.

A second case holds the observer after opening its output. It proves the output
exists and is empty, the receipt is absent, and the completion waiter remains
pending before releasing the copy. This makes the observer race reproducible
without requiring machine contention. The normal concurrent reader remains in
place to reject partial publication.

Provenance: the keep-the-gates requirement in
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:265-274` and the gate-preservation
and bidirectional-mutation acceptance in
`docs/spec-items/trident-build-efficiency.md:190-201`. This is a test-instrument
repair; G063 and the production publisher are unchanged.

Evidence: the unchanged exact case passed 220 repetitions on the fetched main
base and 100 on the worker base, illustrating why repeated green runs alone do
not disprove this race. A stopped shell copy exposed an empty output beside a
complete source; resuming that same copy produced the complete bytes. The final
five-case atomic-publication group passed 50 cases across ten repetitions.
Changing the waiter back to output existence failed all 20 paused-copy repeats
before release, while all 20 ordinary copies passed. Replacing atomic publication
with a first-line write followed by delayed remaining bytes failed all ten
ordinary-reader repeats on exact-byte mismatch, while all ten held copies passed.
Both semantic mutations were restored.

The complete `trident/codex-build.test.ts` file passed all 121 tests. The consuming
`open/__tests__/project-build-e2e.test.ts` passed all 267 tests with local socket
binding permitted. Root and Trident typechecks passed after installing dependencies
in the isolated worktree; `bash scripts/ci/typecheck-all.sh` then passed all 51
project configurations.
