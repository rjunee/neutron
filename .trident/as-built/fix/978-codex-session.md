## 2026-09-15 — Host Codex project sessions in herdr

### Built

Added a Codex project-session host at `runtime/adapters/codex-cli/persistent/project-session.ts:114`. It builds the interactive Codex TUI argv with multi-agent support at `runtime/adapters/codex-cli/persistent/project-session.ts:137`, records the herdr pane handle at `runtime/adapters/codex-cli/persistent/project-session.ts:175`, publishes that record atomically at `runtime/adapters/codex-cli/persistent/project-session.ts:180`, and exposes the public surface through `runtime/adapters/codex-cli/persistent/index.ts:1`.

One host coalesces concurrent opens for the same project at `runtime/adapters/codex-cli/persistent/project-session.ts:124`. One session serializes submissions through a promise tail at `runtime/adapters/codex-cli/persistent/project-session.ts:94`; each call awaits the terminal host's acknowledged `submitLine` at `runtime/adapters/codex-cli/persistent/project-session.ts:102`. The underlying herdr implementation acknowledges text and Enter as two ordered per-call round trips at `runtime/adapters/claude-code/persistent/herdr-host.ts:632`, matching herdr's one-request-per-connection transport recorded at `runtime/adapters/claude-code/persistent/herdr-client.ts:2`.

Gateway restart recovery reads the project-keyed registry at `runtime/adapters/codex-cli/persistent/project-session.ts:145`, asks the host whether the recorded pane is live, gone, or unavailable at `runtime/adapters/codex-cli/persistent/project-session.ts:151`, verifies both the observed and requested argv before attaching at `runtime/adapters/codex-cli/persistent/project-session.ts:155`, and reports a positive loss as `restarted-after-loss` at `runtime/adapters/codex-cli/persistent/project-session.ts:161`. The existing outcome vocabulary is `HandleInspection` (`live`, `gone`, `unavailable`) at `runtime/adapters/claude-code/persistent/pty-host.ts:422`. Its default for an unavailable observation is refusal, not loss or restart, at `runtime/adapters/codex-cli/persistent/project-session.ts:152`.

The project-binding invariant is maintained by the project-keyed in-memory promise map at `runtime/adapters/codex-cli/persistent/project-session.ts:117`, the durable project-to-pane registry entry at `runtime/adapters/codex-cli/persistent/project-session.ts:175`, and fresh host inspection before adoption at `runtime/adapters/codex-cli/persistent/project-session.ts:151`. Submission serialization is maintained by the session-owned promise tail at `runtime/adapters/codex-cli/persistent/project-session.ts:71`; it does not depend on Codex cooperating.

### Decisions

Used the existing `AdoptableHost` boundary rather than adding a second herdr client. That boundary already distinguishes positive absence from unavailable inspection at `runtime/adapters/claude-code/persistent/pty-host.ts:422`, and the production host already opens a fresh connection for each operation at `runtime/adapters/claude-code/persistent/herdr-host.ts:215`.

An unavailable recovery inspection refuses at `runtime/adapters/codex-cli/persistent/project-session.ts:152`; only the positive `gone` outcome starts a replacement at `runtime/adapters/codex-cli/persistent/project-session.ts:161`. A live pane with mismatched identity also refuses at `runtime/adapters/codex-cli/persistent/project-session.ts:156`. This keeps “could not determine” distinct from “not present.”

The registry uses the repository's crash-safe atomic write leaf at `runtime/adapters/codex-cli/persistent/project-session.ts:55`. A spawned child without a durable pane handle is terminated and refused at `runtime/adapters/codex-cli/persistent/project-session.ts:170`, because such a child cannot meet restart recovery.

### Verification

`bun test runtime/adapters/codex-cli/persistent/project-session.test.ts` passed 12 tests with 28 assertions. `bunx tsc -p runtime/tsconfig.json --noEmit` passed. `git diff --check` passed.

| Guard | Compiling mutation | Observed red | Restored green |
|---|---|---|---|
| submission serialization, line 99 | removed `await previous` | concurrent-submission test observed the second submission before release | focused suite passed |
| unavailable recovery, line 152 | made the unavailable condition false | recovery-refusal test resolved instead of rejecting | focused suite passed |
| launch identity, line 156 | removed requested-argv comparison | changed-launch test adopted instead of rejecting | focused suite passed |
| line framing, line 86 | made the terminator condition false | multi-line input resolved instead of rejecting | focused suite passed |
| acknowledged-submit capability, line 90 | returned success when `submitLine` was absent | acknowledgement test resolved instead of rejecting | focused suite passed |
| project identity, line 125 | made the empty-id condition false | empty-id test resolved instead of rejecting | focused suite passed |
| restart handle, line 171 | made the empty-handle condition false | non-durable-host test resolved instead of rejecting | focused suite passed |
| recovery classification, line 163 | returned `started` after positive loss | loss test received the wrong recovery outcome | focused suite passed |
| process liveness, line 101 | made the exited condition false | exited-session test resolved instead of rejecting | focused suite passed |
| one session per project, line 126 | bypassed the in-memory lookup | concurrent opens returned distinct sessions | focused suite passed |

Each mutation's landed line was printed with `nl -ba` before its focused test ran. After restoring all mutations, the complete focused suite and runtime typecheck passed.

### Citation corrections

The issue's cited `runtime/adapters/codex-cli/exec.ts:121` still constructs `exec --json`, and `runtime/adapters/codex-cli/exec.ts:151` still performs the spawn whose stdio declaration at `runtime/adapters/codex-cli/exec.ts:152` ignores stdin. The exemplar's lock remains at `runtime/adapters/claude-code/persistent/repl-session.ts:461`, and acknowledged submission remains at `runtime/adapters/claude-code/persistent/pty-host.ts:162`. No cited line required correction.

### Not built or not verified

This increment does not implement or modify the acting turn; no file under `runtime/workers/` changed. It does not modify Claude's pool or supervision, and it does not add a Claude fallback.

The live probe observed `codex-cli 0.154.0`, `herdr 0.8.2`, and a configured socket path, but the first protocol connection failed with `ENOENT` at `runtime/adapters/claude-code/persistent/herdr-client.ts:169`. Therefore no real Codex pane was started in this sandbox, no real submission acknowledgement was observed, and no claim is made that Codex acted on a submitted line. The focused tests establish the host's argv, recovery decisions, identity checks, serialization, and acknowledgement dependency through the `AdoptableHost` contract; they do not replace that unavailable live acceptance run.

No spec decision changed. No whole-directory or whole-repository test sweep was run.
