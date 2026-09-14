## Issue 591 — reap Codex broker descendants at the source

### What changed

Each Codex CLI invocation now starts as a detached process-group leader (`runtime/adapters/codex-cli/exec.ts:147`). Cleanup uses that leader PID to signal the whole group with SIGTERM (`runtime/adapters/codex-cli/exec.ts:59`), waits 250 ms (`runtime/adapters/codex-cli/exec.ts:68`), probes the group (`runtime/adapters/codex-cli/exec.ts:40`), and sends SIGKILL only when the probe positively reports a survivor (`runtime/adapters/codex-cli/exec.ts:69`). The generator awaits the same idempotent cleanup promise on every exit path (`runtime/adapters/codex-cli/exec.ts:175`, `runtime/adapters/codex-cli/exec.ts:338`).

The process-group state vocabulary is `alive | gone | unknown` (`runtime/adapters/codex-cli/exec.ts:36`). `gone` and `unknown` both stop escalation by default (`runtime/adapters/codex-cli/exec.ts:69`); only `alive` permits SIGKILL (`runtime/adapters/codex-cli/exec.ts:73`). An initial signalling error other than ESRCH is also unknown and stops cleanup (`runtime/adapters/codex-cli/exec.ts:61`). This avoids treating “could not inspect” as “safe to act.”

### Decisions

The fix is source cleanup, not a later sweep: descendants remain in the invocation-owned process group even after the CLI leader exits, and the adapter targets that group from its existing finalizer (`runtime/adapters/codex-cli/exec.ts:50`, `runtime/adapters/codex-cli/exec.ts:338`). No second cleanup path or feature flag was added.

The PID guard rejects missing IDs, process group zero, and init (`runtime/adapters/codex-cli/exec.ts:55`). The invariant is maintained continuously by creating the group at spawn (`runtime/adapters/codex-cli/exec.ts:150`) and by the adapter finalizer, which runs independently of a surviving CLI leader (`runtime/adapters/codex-cli/exec.ts:338`).

### Tests and mutations

The focused tests exercise normal completion, unknown probe results, unsafe IDs, and initial signal failure (`runtime/adapters/codex-cli/exec.test.ts:49`).

| Guard | Mutation | RED evidence | Restored GREEN |
|---|---|---|---|
| Detached invocation group (`runtime/adapters/codex-cli/exec.ts:153`) | Set `detached` false | `normal completion isolates...` failed at `runtime/adapters/codex-cli/exec.test.ts:75` | focused file: 5 pass |
| Whole-group TERM (`runtime/adapters/codex-cli/exec.ts:60`) | Removed the negative PID | both process-group signal assertions failed at `runtime/adapters/codex-cli/exec.test.ts:77` and `runtime/adapters/codex-cli/exec.test.ts:106` | focused file: 5 pass |
| Positive-survivor escalation (`runtime/adapters/codex-cli/exec.ts:73`) | Removed SIGKILL | `normal completion isolates...` failed at `runtime/adapters/codex-cli/exec.test.ts:77` | focused file: 5 pass |
| Unknown is distinct (`runtime/adapters/codex-cli/exec.ts:46`) | Collapsed unknown into alive | `unknown process-group probe...` failed at `runtime/adapters/codex-cli/exec.test.ts:106` | focused file: 5 pass |
| Unsafe PID refusal (`runtime/adapters/codex-cli/exec.ts:57`) | Allowed PID 1 | `unsafe or unavailable group id...` failed at `runtime/adapters/codex-cli/exec.test.ts:128` | focused file: 5 pass |
| Initial unknown signal refusal (`runtime/adapters/codex-cli/exec.ts:65`) | Continued after EACCES | `failed TERM is unknown...` failed at `runtime/adapters/codex-cli/exec.test.ts:150` | focused file: 5 pass |

The complete adapter test set was enumerated with `rg --files runtime/adapters/codex-cli` and all four discovered test files passed: 28 tests and 101 assertions. Scoped ESLint and `git diff --check` passed. The root TypeScript check is not green because it reports three diagnostics in unchanged files outside this lane: `gateway/transcription/__tests__/whisper-install.test.ts:186`, `logger/__tests__/fire-and-forget.test.ts:301`, and `onboarding/history-import/__tests__/zip-writer.ts:10`.

### Deliberately not done

No periodic sweep was added. No files outside the Codex CLI adapter, its tests, and this required record were changed. No error event was added: cleanup state is an internal three-way safety decision, so it does not join the substrate error taxonomy.
