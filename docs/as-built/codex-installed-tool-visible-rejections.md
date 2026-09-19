## 2026-09-19 — Deliver installed-tool refusals through the observed error boundary

The full repository lint gate rejected the installed-tool background task because
its internal catch consumed operation failures before `fireAndForget` could
observe them. Touched-file ESLint alone had not exercised this pre-swallow gate.

`open/wiring/codex-owner-binding.ts:118` now passes the uncaught operation promise
to the wrapper and supplies an explicit error callback that delivers the same
generic native tool refusal. Both successful and refusal replies use the shared
observed reply task at `:109`, retaining the original writer/turn check and
fencing a still-current owner if reply delivery fails. MCP broker retirement and
approval behavior are unchanged.

Verification: the full `bash scripts/ci/lint.sh` gate passes, including
PRE-SWALLOW. All 231 tests pass across explicit Open project-build E2E, owner
binding and composer revocation tests, SDK broker and gateway suites. Both root
and Trident TypeScript checks pass, along with diff and as-built/message gates.
This is local validation, not deployed acceptance; the
previous full-tree leak-scan failure is not a clean purity claim.
