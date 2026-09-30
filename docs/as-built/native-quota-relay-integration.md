## 2026-09-30 — Route native Claude quota recovery through authenticated host observations

This change replaces the branch's launch-time file-auth and alias reconstruction
with the registered native Unix request relay. The governing decision is
SPEC.md's 2026-09-30 native quota relay entry; the still-open acceptance item is
`docs/spec-items/claude-same-agent-continuation.md` (#1416).

`runtime/adapters/claude-code/persistent/native-request-relay.ts:11` prepares a
random parent scope and the native OAuth environment transport without carrying
an account credential. `spawn.ts:627` awaits the exact PID/start/boot/session
registration before recording launch evidence or allowing first chat. Present
invalid host configuration throws a local `repl_unreconciled` error at
`runtime/workers/claude-capacity-client.ts:58`; only an absent registration retains
the self-host native authentication contract. The route fingerprint at line 43
is stable across host account changes and changes with host/instance/socket/key.

`claude-capacity-client.ts:147` binds the authenticated original child, request,
lease and receipt-signature digest, then verifies the host's signed actual native
request model and root child identity. Fresh capacity is separate from historical
native quota evidence. Alias guesses and worker prompt text are not inputs to
this join. The original signed relay scope survives a gateway restart only for
the exact original live parent (`claude-native-continuation.ts:187`).

`claude-native-continuation.ts:95` waits under the original deadline and signal,
harvesting the original result every second while probing capacity at a bounded
cadence informed by its retry hint. The idle wait releases the parent input slot.
Open records scoped child-binding and waiting/resumed/ended stage events at
`open/wiring/project-build.ts:720` for the Work Board projection. Unknown evidence,
cancellation and expiry never spend a continuation or release the original child.
The pre-Enter durable claim and original result validators remain unchanged.

The native tool's observed presentation fields are recognized at
`claude-native-continuation.ts:277`: exact full `to` and `message` remain authority;
only its consistent `type`, `recipient` and exact pinned ASCII preview are accepted.
Conflicting, partial or unknown decorations refuse reconciliation. This proves
invocation only; it does not assert successful message delivery or completion.

Local verification: 90 focused tests across the capacity client, continuation,
native relay launch, original launch evidence and auth fingerprint suites passed.
Thirty-three focused consuming project-build cases passed (207 assertions),
including restart, all-full to capacity to merge, original result during waiting
with zero continuation input, deadline, cancellation and signed-evidence refusals.
Temporary allow-all and deny-all launch mutations each failed
the corresponding consuming refusal/success control; both were restored. Root,
Trident and Open typechecks passed. The complete project-build file is deferred
to the coordinated integrated check, not represented by these focused results.
The local whole-tree leak check is not green: the frozen base export already
reports 451 findings. This change does not waive that gate or claim CI acceptance.

This is the core relay and first-continuation slice, not full cutover acceptance.
The current permanent claim still allows one continuation per original lease;
repeated quota episodes need authenticated native continuation lineage and a
separate permanent per-episode ledger. The Work Board presentation is integrated
separately from these durable producer events. Real renewable provider account
acceptance and live account-rotation progress remain UNKNOWN. No real credential,
live provider, deployment, reboot or publication was used for these local checks.
