## 2026-09-14 — Disposable worktrees do not acquire heartbeat watchdogs

### Root cause and change

The Claude substrate factory derived the supervision home from each substrate cwd and armed the heartbeat during factory construction (`runtime/adapters/claude-code/index.ts:512-556`). Conflict resolution constructs a disposable substrate rooted in its throwaway worktree (`open/composer.ts:6063-6072`), but the disposable spawn path already removes registry and pending-respawn state because a one-turn session must never be watchdog-respawned or resumed (`runtime/adapters/claude-code/persistent/pool.ts:308-343`). Factory-time supervision was therefore inconsistent with the session lifecycle and left a timer writing after worktree removal.

The factory now excludes `ephemeral: true` before it derives, registers, or starts any supervision state (`runtime/adapters/claude-code/index.ts:509-556`). The test observes both maintained structures: a disposable construction creates neither a registration nor an active watchdog, while an otherwise identical warm construction creates both (`runtime/adapters/claude-code/__tests__/repl-home-normalization.test.ts:389-407`). This removes the race rather than classifying its eventual filesystem error.

I enumerated heartbeat acquisition with `rg -n "startHeartbeatWatchdog\\(|startReplWatchdog\\(|deriveReplSupervisionPaths\\(" --glob '*.ts' .`; its positive controls found the exported heartbeat starter and test calls, and the production chain is the factory call through `startReplWatchdog` (`runtime/adapters/claude-code/index.ts:556`, `runtime/adapters/claude-code/persistent/supervision.ts:717-742`).

### Decisions and existing vocabulary

I chose exclusion over changing watchdog error handling because disposable sessions are already outside the respawn/resume contract (`runtime/adapters/claude-code/persistent/pool.ts:308-316`). The continuous maintainer is the factory predicate on the already-mapped disposable option (`runtime/adapters/claude-code/index.ts:484-486`, `runtime/adapters/claude-code/index.ts:516`); it acts before the disposable worktree can disappear and does not depend on cleanup succeeding.

No new error, verdict, state, or refusal was introduced. Real write failures remain in the existing `onWriteError` vocabulary: the default reports `heartbeat_write_failed` (`runtime/adapters/claude-code/persistent/heartbeat-watchdog.ts:118-124`), and the first tick failure still invokes it (`runtime/adapters/claude-code/persistent/heartbeat-watchdog.ts:140-147`).

### Mutation evidence

| Guard | Mutation and printed landing line | Red | Restored green |
|---|---|---|---|
| Disposable exclusion | Removed `options.ephemeral !== true`; printed `runtime/adapters/claude-code/index.ts:516` as `if (home !== undefined)` | Disposable registration assertion failed at `runtime/adapters/claude-code/__tests__/repl-home-normalization.test.ts:396` | Both focused files: 23 pass, 0 fail |
| Existing write-failure report | Replaced `onWriteError(e)` with a suppression comment; printed the mutation at `runtime/adapters/claude-code/persistent/heartbeat-watchdog.ts:145` | Error-count assertion failed at `runtime/adapters/claude-code/persistent/__tests__/heartbeat-watchdog.test.ts:143` (expected 2, received 1) | Heartbeat file: 7 pass, 0 fail; both focused files: 23 pass, 0 fail |

### Verification

- `bun test runtime/adapters/claude-code/__tests__/repl-home-normalization.test.ts runtime/adapters/claude-code/persistent/__tests__/heartbeat-watchdog.test.ts` — 23 pass, 0 fail.
- `bash scripts/ci/typecheck-all.sh` — all 51 TypeScript configurations passed.
- `bash scripts/ci/lint.sh` — all reported lint gates passed.
- `git diff --check` — passed.

### Deliberately not changed

I did not teach the heartbeat writer to swallow ENOENT, change its severity, or merge a missing worktree with a genuine write failure. I did not alter warm-substrate supervision, the disposable spawn lifecycle, `SPEC.md`, or a spec item; the change implements the filed behavior without changing a product decision.
