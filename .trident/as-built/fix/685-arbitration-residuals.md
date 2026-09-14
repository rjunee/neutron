## 2026-09-14 — Arbitration residuals (#685), implementation awaiting dynamic validation

### Changes and evidence

Readiness failure now calls `unregisterIf(sessionId, session)` at
`runtime/adapters/claude-code/persistent/spawn.ts:550`, matching the sibling at
`:524`. The exemplar was checked against the required property:
`runtime/adapters/claude-code/persistent/pool-state.ts:491` compares the registered
session object before deleting either the id or its credential. The new readiness
cases inject a replacement below normal ordering, and test both removal of the
failed attempt and preservation of the replacement credential
(`runtime/adapters/claude-code/persistent/__tests__/spawn-failure-revokes-credential.test.ts:96`).
Exit cleanup is held until assertions finish at that file's `:122` and `:143`, so
it cannot make a missing readiness cleanup look correct.

The losing-adopter case now has direct and boot-gate variants
(`runtime/adapters/claude-code/persistent/__tests__/pane-handle-persistence.test.ts:1243`).
The boot variant holds inspection, starts a second caller, compares promise identity,
and checks that a subsequent undecided retry inspects again (`:1281`). Both variants
assert the ownership-conflict reason and preserve winner authorization and mirrors
(`:1296`). The fake's hold was inspected before use: it signals entry before awaiting
the release (`runtime/adapters/claude-code/persistent/__tests__/boot-adoption-host.ts:149`).

The shared PID namespace requirement is now beside the liveness probe
(`runtime/adapters/claude-code/persistent/signatures.ts:351`), including the foreign
numeric-pid collision and distinction between claimant identity and liveness evidence.

### Ordering scope and outcomes

The gate looks up a pass at `runtime/adapters/claude-code/persistent/boot-adoption.ts:436`,
returns its promise at `:437`, and stores a new handle at `:525`. Undecided results
remove the slot at `:521`. Shutdown sets the one-way latch at `:663`; reset keeps
unsettled handles at `:709`. These are inspection evidence, not a claim that the new
collision test passed. No ordering defect was established; dynamic verification is
still required before accepting item 4's safety argument.

Call sites were enumerated using
`rg -n 'reconcileOwnRepl\(|beginBootAdoption\(' runtime/adapters/claude-code/persistent --glob '*.ts' --glob '!**/__tests__/**'`.
The direct reconciliation call appears at `boot-adoption.ts:448`; gate callers appear
at `boot-adoption.ts:2876` and `spawn.ts:1282`, alongside both declarations. This
scope concerns the same registry-path string and session key, not arbitrary path aliases.

The change uses existing outcomes. The fence returns `undecided` at
`boot-adoption.ts:429`; `adoptionPermitsSpawn` explicitly refuses it at `:586`.
Readiness still throws its existing failure at `spawn.ts:573`, with the existing
channel-wedged branch at `:557`. No new outcome needs a default classification.

### Fence duration decision

Retain fencing until gateway restart, even when writes recover and the row still
names the old claimant. The rationale is the local capability teardown:
`boot-adoption.ts:1541` clears the local claim, `:1544` fences the session, and
`:1548`–`:1553` remove registration, detach and release its pool entry. A matching row
alone does not restore those capabilities. The explicit policy is beside the map
at `boot-adoption.ts:1404`, in `SPEC.md:290`, and referenced by the architecture body
at `SPEC.md:163`. The existing timer at `boot-adoption.ts:1447` and `:1482` operates
independently of renewal ticks; the turn path also checks the deadline at `:413`.
This retains the existing mechanism and its dependence on an operating event loop;
it does not claim protection from a stopped process executing no callbacks.

### Unguarded-site enumeration

`rg -n 'sink\.unregister\(' runtime/adapters/claude-code/persistent/spawn.ts runtime/adapters/claude-code/persistent/pool.ts`
returns exactly the three pool sites below. These matches are the positive control
for the same search finding none in spawn.ts.

| Site in persistent/pool.ts | Disposition |
| --- | --- |
| `:372` | Retain disposable-session cleanup. The ephemeral key is fresh at `:340`, and the call has no resume argument at `:349`. |
| `:1247` | Retain shutdown kill-loop cleanup after the child signal at `:1239`; the shutdown adoption latch is set in boot-adoption.ts:663. |
| `:1317` | Retain shutdown cleanup of disposable sessions, enumerated from ephemeralSessions at `:1313`. |

### Validation and mutation table

- `bash scripts/ci/typecheck-all.sh`: PASS, all 51 discovered configurations.
- `bunx tsc -p runtime/tsconfig.json --noEmit`: PASS after final test edits.
- `bash scripts/ci/lint.sh`: PASS.
- `git diff --check`: PASS.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, INCOMPLETE. Available rules
  found zero issues; the private denylist was unavailable.
- Both modified test files were run together: **0 pass, 32 fail**. Socket creation is
  denied by this build sandbox. An independent Python socket constructor raises
  `PermissionError: Operation not permitted`, before any bind. Sink startup therefore
  prevents the relevant fixtures from reaching their subjects. This is not green
  validation and must be rerun in a socket-capable runner.

| Guard | Mutation and printed landing | Mutant result | Restored result |
| --- | --- | --- | --- |
| Readiness identity guard | `spawn.ts:550`: replace unregisterIf with unregister; fixed-to-mutant diff printed | 3 tests fail before the host is reached; NOT mutation proof | Same fixture restriction; NOT green |
| Shared pass | `boot-adoption.ts:437`: bypass existing-pass return; patch diff and landing printed before execution | Both adopter variants fail at sink startup; NOT mutation proof | Both modified files fail at startup; NOT green |

Both production mutations were restored. The first readiness run printed its landing
before execution but its fixed-to-mutant diff afterwards; it is not credited as a
completed mutation check. Neither mutation could reach its target in this environment.
The readiness no-replacement case is the required honest cleanup direction; it must
also fail if cleanup is removed entirely. That additional mutation remains unverified.
Acceptance boxes in `docs/spec-items/a-gateway-restart-keeps-the-project-repls.md:508`
remain unchecked.

### Deliberately not done

No automatic unfencing or cross-container identity mechanism was added. The three
pool sites above were retained. No existing test assertion was loosened or skipped.
No whole-suite run, network access, push, PR creation, or merge was attempted.
The requested branch-named record is staged here under the build-lane instruction,
rather than duplicating it in the permanent record directory. Dynamic validation and
mutation proof remain outstanding for the orchestrator's runner.
