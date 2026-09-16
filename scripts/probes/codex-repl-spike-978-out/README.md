# Issue #978 live spike — transcripts

Measured 2026-09-16 against the REAL `codex` binary (`codex-cli 0.154.0`, ChatGPT
subscription slot, no `OPENAI_API_KEY` anywhere), through the code that exists:
`runtime/adapters/codex-cli/persistent/project-session.ts`. Spike criteria from
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:137-140`.

Paths are scrubbed (`$OWNER_ROOT`, `$PROJECT`, `$CODEX_HOME`, `$OUT`). The raw codex
rollout JSONL files are NOT committed — they are reproducible under `$CODEX_HOME/sessions`
and the transcripts quote the lines that matter. Thread ids are recorded so they can be
re-read there.

| file | what it is |
|---|---|
| `transcript-refuse.log` | `CodexProjectSessionHost.open()` on `BunTerminalHost`: refused, no pane handle |
| `transcript-turns-run1-submit-during-splash.log` | first attempt; submitted into the splash — instrument error, kept for honesty |
| `transcript-turns-run2-halfpainted-frame.log` | second attempt; readiness predicate passed on a half-painted frame |
| `transcript-turns-run3-enter-not-submitted.log` | third attempt; readiness fixed — and the production submit is seen to not submit |
| `transcript-turns.log` | (a) the real run: production submit measured, then 3 follow-ups + a mid-turn submit |
| `transcript-gap.log` | the submit defect isolated: `cr`/`lf` with no gap fail; 50/150/500 ms and bracketed paste succeed |
| `transcript-herdr.log` | (b) on the production host: spawn, process exit, adoption refused, direct attach, resume, pane closed |
| `transcript-approval.log` | (c) the approval round-trip, including the dialog codex renders and the escalated write |
| `approval-target.txt` | the file codex wrote OUTSIDE its sandbox after the approval was granted |
| `herdr-registry.json`, `*-thread-id.txt` | the registry row and codex thread ids the runs produced |

Reproduce (from the repo root):

    export CODEX_HOME=<a logged-in codex slot>
    bun scripts/probes/codex-repl-spike-978.ts turns    <a git project dir> <out-dir>
    bun scripts/probes/codex-repl-spike-978.ts approval <a git project dir> <out-dir> <a path outside the workspace and outside /tmp>
    bun scripts/probes/codex-repl-spike-978-gap.ts      <a git project dir> <out-dir> <gapMs> [cr|lf|paste]
    bun scripts/probes/codex-repl-spike-978-herdr.ts    <phase1|phase2|phase2b|close> <a git project dir> <out-dir>

The herdr probe creates ONE pane in the live herdr session and its `close` phase removes
it; `transcript-herdr.log` ends with `inspectHandle: {"kind":"gone"}`.
