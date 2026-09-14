## 2026-09-14 — the REPL PTY host is selectable once per process

### What changed

`NEUTRON_REPL_HOST` now selects `herdr` or `bun`, with omission defaulting to
herdr and any other value refusing startup. The setting is read once when
`configured-pty-host.ts` loads, and the same object is consumed by fresh spawn
and restart reconciliation (`runtime/adapters/claude-code/persistent/configured-pty-host.ts:11-25`,
`runtime/adapters/claude-code/persistent/spawn.ts:126`,
`runtime/adapters/claude-code/persistent/boot-adoption.ts:803`).

The choice is process-wide, not per session. This forbids changing a running
process from one host to the other: all session-keyed state continues to describe
children created under the process-start choice. The complete host-dependent
consumer enumeration used to make that decision was produced by searching
`ptyHost`, both concrete host names, `childByKey`, sink registration and
`registerLiveProcessSafe` across the persistent adapter. Fresh spawn installs the
child mirror and live-process handle at `spawn.ts:438-453`; adoption installs the
same mirror, handle and reply-sink registration only after its claim succeeds at
`boot-adoption.ts:2730-2761`; the process-wide singleton owners are declared at
`pool-state.ts:682` and `pool-state.ts:695`. None of those structures needs a host
dimension when one process has exactly one choice.

Cross-host restart remains supported. A handle-less Bun row is no longer treated
as absence without checking transcript owners: a positive or unavailable process
scan returns the existing `undecided` outcome, while only a verified empty scan
returns `no-handle` (`boot-adoption.ts:783-800`). `adoptionPermitsSpawn` already
maps `undecided` to refusal, so no new error taxonomy was added. The opposite
herdr-to-Bun direction retains the verified-pid fallback at
`boot-adoption.ts:803-838`.

The backend guarantee differences are executable assertions. Bun must return the
kernel status through `exited` and `onExit`; herdr must return `null` and classify
the loss as `closed-by-us` or `pane-vanished`
(`__tests__/configured-pty-host.test.ts:29-55`). The production-selection case
spies on both hosts and requires one call to the selected host and zero to the
other (`__tests__/persistent-repl-substrate.test.ts:1125-1143`).

### Decisions and why

Process scope keeps spawn, adoption and every process-wide session registry on a
single host contract. Per-session selection would require a durable host identity
in each registry row and a host dimension through supervision; no caller needs
that complexity. An environment change therefore takes effect only after restart.

The current SPEC decision and module guidance were updated because their
present-tense no-chooser claims became false. The previous as-built record remains
unchanged because it accurately records what that earlier change did at the time.

### Mutation evidence

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| selector distinguishes Bun | `case 'bun'` returned `herdrHost` at `configured-pty-host.ts:17`; the patch was diffed and the landing line printed before execution | selection test failed: expected `bunTerminalHost`, received herdr | 1 pass |
| handle-less row requires verified absence | condition at `boot-adoption.ts:793` was changed to `false && ...`; the patch was diffed and lines 785-802 printed before execution | 2 failures: both live-owner and unavailable-scan cases returned `no-handle` | 2 pass |

### Verification and deliberate exclusions

- `scripts/ci/lint.sh` passed all reported guards.
- The six selector/exit-contract cases that do not bind a socket passed; the two
  host-setting reconciliation cases passed.
- The repository typecheck command is `scripts/ci/typecheck-all.sh`; its first run
  found an invalid test-only option, which was removed before the final run.
- Full socket-using test files were attempted individually but the build sandbox
  refused loopback binds, surfaced by Bun as `port in use`. This is an environment
  restriction, not recorded as green.
- No third backend, runtime setting reload, per-session choice, backend deletion,
  or change to the historic as-built record was made.
