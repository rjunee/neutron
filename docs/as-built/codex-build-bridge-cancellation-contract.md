## 2026-09-19 — Codex build bridge cancellation contract

The build bridge now supplies the native submission with its combined caller and
deadline signal and the remaining budget after queue admission
(`runtime/workers/codex-acting-turn.ts:105`). The session contract requires native
parent completion and leaves exact-turn cancellation and uncertain-delivery
reconciliation with the host (`runtime/workers/codex-acting-turn.ts:17`). Parent
completion still precedes the independent child-trailer observation; a trailer
cannot clear the uncertain-dispatch fence
(`runtime/workers/codex-acting-turn.ts:108`, `:149`).

This is the runtime half of the boundary. The native owner binding must consume
the supplied signal and budget before this is an integrated cancellation fix.
No native-owner recovery or child-trailer settlement is inferred from the new
arguments alone.

Focused regressions cover cancellation and timeout while native completion stays
pending, retaining the writer fence, and a successful queued submission receiving
its remaining budget and a live signal
(`runtime/workers/codex-acting-turn.test.ts:234`, `:272`). Codex, Claude, and project
runner suites passed together: 131 tests. A disconnected-signal mutation failed
both cancellation tests; an already-aborted-signal mutation failed the healthy
queued-submission control. Both mutations were reverted.

Root `bunx tsc --noEmit` and Trident `bunx tsc --noEmit -p
trident/tsconfig.json` passed using the isolated worktree's frozen-lockfile
dependency installation.
