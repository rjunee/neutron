## 2026-09-14 — Late shutdown spawns consult the survival decision (#674)

### Change and evidence

The late callback now captures the registry path before supervision resets, then calls
`claimShutdownSurvival` after the spawn resolves
(`runtime/adapters/claude-code/persistent/pool.ts:1245-1255`). Only `survive` releases
the wrapper; a kill verdict logs its reason and requests termination
(`runtime/adapters/claude-code/persistent/pool.ts:1256-1266`). Ordinary teardown uses
the same decision (`runtime/adapters/claude-code/persistent/pool.ts:1147-1155`).

Both survivor paths share wrapper retirement: stop watchers, detach, unregister the
sink and live-process handle, cancel the fence timer, and release the adoption claim
(`runtime/adapters/claude-code/persistent/pool.ts:1095-1112`). This preserves the
existing handover operation rather than adding a second implementation.

The read also needed correction: `withRegistryRead` delegates to `loadRegistry`
(`runtime/adapters/claude-code/persistent/repl-registry.ts:1025`), which collapses
read failures into an empty registry (`runtime/adapters/claude-code/persistent/repl-registry.ts:709-719`).
The shared survival reader now performs `readRegistryState` inside the locked callback,
including its dropped-target-row check
(`runtime/adapters/claude-code/persistent/gateway-shutdown-survival.ts:179-188`).
The inspected exemplar was the locked three-state read in
`runtime/adapters/claude-code/persistent/boot-adoption.ts:1239-1254`.

### Decisions and invariant maintenance

Use the existing `ShutdownSurvivalVerdict` vocabulary: `survive` or `kill` with a reason
(`runtime/adapters/claude-code/persistent/gateway-shutdown-survival.ts:53-59`).
Unreadable data reaches the existing read-failure kill; an unacquired lock also kills
(`runtime/adapters/claude-code/persistent/gateway-shutdown-survival.ts:230-249`).
There is no new outcome for a caller to classify. Exact pane and generation comparison
remains in `runtime/adapters/claude-code/persistent/gateway-shutdown-survival.ts:93-110`.

The decision depends on captured coordinates and disk, not the supervision map that
shutdown clears (`runtime/adapters/claude-code/persistent/pool.ts:1246,1307,1311`).
The flock orders the callback against registry writers and releases in `finally`
(`runtime/adapters/claude-code/persistent/registry-lock.ts:170-185`). Durable identity
survives the retiring gateway; the existing next-construction reconciliation and
registry-loss limitation remain scoped as described in
`runtime/adapters/claude-code/persistent/gateway-shutdown-survival.ts:19-46`.
This extends an existing invariant to the late decision, not a new background monitor.

### Tests and mutation evidence

The eight table entries are enumerated in
`runtime/adapters/claude-code/persistent/__tests__/gateway-shutdown-survival.test.ts:639-647`.
The deferred fixture writes the row after real shutdown returns, verifies supervision
was cleared, then resolves the spawn; the settled control publishes before shutdown
(`runtime/adapters/claude-code/persistent/__tests__/gateway-shutdown-survival.test.ts:660-696`).
Unreadable-file testing makes the registry itself a directory, so it exercises the
actual data read rather than merely failing lock acquisition (:662-664).

Every mutation below printed a unified patch and the exact landing line before the
focused test. Every effective mutation produced one failing test; restoring it produced
one passing test. Paths in the table are relative to
`runtime/adapters/claude-code/persistent/`.

| Guard or property | Mutation landing | Red → restored green |
|---|---|---|
| Matching late row survives | `pool.ts:1256`: survival condition becomes false | matching row survives |
| Missing row still kills | `pool.ts:1264`: replace kill with return | no row kills |
| Other pane still kills | `pool.ts:1264`: replace kill with return | different pane kills |
| Other generation still kills | `pool.ts:1264`: replace kill with return | different generation kills |
| Unreadable file still kills | `pool.ts:1264`: replace kill with return | unreadable file kills |
| Unreadable reason stays distinct | `gateway-shutdown-survival.ts:183`: remove unreadable throw | unreadable file kills |
| Dropped target row stays unknown | `gateway-shutdown-survival.ts:184`: condition becomes false | malformed row kills |
| Lock failure refuses survival | `gateway-shutdown-survival.ts:242`: condition becomes false | unacquired lock kills |
| Coordinates survive reset | `pool.ts:1251`: replace captured path with cleared-map lookup | matching row survives |
| Settled control stays ordinary | `pool.ts:1054,1233`: both fulfilled routes become false | settled positive control |

An initial mutation of only `pool.ts:1054` stayed green: the fulfilled promise still
reached ordinary teardown at `pool.ts:1233-1234`, so it could not reach the late branch.
Disabling both routes reached the intended branch and failed the control's log assertion
at `gateway-shutdown-survival.test.ts:691`. The fixture was not weakened.

Validation: all eight new cases pass. The complete touched test file ran with 29 passes
and one existing setup-hook failure at
`runtime/adapters/claude-code/persistent/__tests__/gateway-shutdown-survival.test.ts:454`:
the reply sink could not bind. An independent ephemeral local socket bind returned EPERM.
No test was skipped or relaxed; a full-file green run still requires a socket-capable lane.
`bash scripts/ci/typecheck-all.sh` passed all 51 discovered configs; `bash scripts/ci/lint.sh`
passed. The root package has no typecheck script (`package.json:57`), so the CI matrix
is the repository equivalent. `git diff --cached --check` passed. The final leak gate
returned exit 3 / INCOMPLETE: zero findings in the rules that ran, with the local PII
denylist unavailable. Purity is not claimed green.

### Scope and documentation

Updated the current requirements in
`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md:422` and
`docs/spec-items/a-deploy-must-not-kill-builds-in-flight.md:185`.
A whole-tree phrase sweep for `best-effort kill attached`, `late-spawn path terminates`,
and `still-spawning child whose row`, with `detached survival decision` as a positive
control after editing, found the remaining old description only in the immutable
`docs/as-built/a-deploy-must-not-kill-builds-in-flight.md:528`; it stays historical.

Deliberately did not add late death reporting, change shutdown budgets, change host
selection, add a background pane reaper, or alter the product decision in SPEC.md.
No live restart proof was attempted. This record uses the task-required staging path;
the lane stops at a local commit for orchestrator review.
