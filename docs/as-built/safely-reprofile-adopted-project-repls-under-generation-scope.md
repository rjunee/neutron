## 2026-09-25 — Generation-scoped project admission and exact-generation replacement (#1237)

Issue #1237 names two defects. The only parent replacement,
`respawnReplSession`, resumes with an empty tool list. It also neither fences
the scope nor checks children or shells. Separately, `getOrSpawnSession` refuses
every adopted-parent refresh "until lifecycle reconciliation". This branch adds
that reconciliation in four ledger tasks. Nothing calls it yet.

**T1–T3 (admission, producers, census).** `gateway/project-admission.ts` sits
over the existing durable store. Chat, parent input and acting turns admit
through it. So do Work Board dispatch, hold drain, queued wakeups and every
bounded build step's native child. A fenced or unknown scope is refused before
anything is queued. Build leases are released when their run reaches a terminal
state, and are reconciled on restart. `gateway/project-liveness-census.ts`
reports whether the parent's turn, its native children and its shells are
busy, unknown or idle. Busy beats unknown, and unknown beats idle. A parent
spawn stamps the fence generation into the registry row
(`admission_generation`). A parent with no stamp is `legacy-unknown`: its
children held no leases, so they can never be proven finished.

**T4 (replacement, attestation, restart).**
`runtime/adapters/claude-code/persistent/generation-replacement.ts` replaces
exactly the pooled parent it is given. Before it changes anything, it checks
the key, entry, child generation, conversation, pid, process identity,
exited state, busy state, poison and the in-flight gate. If any check fails, it
refuses and leaves the parent alone. If they all pass, it terminates that
exact child and waits for it to exit. It then resumes the same session id
through the supervised options. That keeps the pool key, credential identity,
project and generation reader, and the spawn stamps the fence's generation. If
the old child does not exit, the result is `unknown` and nothing is spawned.

`gateway/project-generation-replacement.ts` does fencing, draining and
replacement. Its steps:
1. Fence the scope. It never takes over another owner's fence.
2. Drain until the census proves the parent idle. Busy is waited on within a
   bounded budget. Unknown is never treated as idle. Legacy, ambiguous and
   unidentified parents are protected.
3. After quiescence, census again. The parent must still be the exact child
   that was measured, and it must predate the fence.
4. Replace it.
5. Attest the replacement, then reopen admission.

Attestation reads what was actually spawned: the pooled session and its
registry row. It checks the same conversation, a new child, the fence
generation, and the tool profile the next dispatch expects, including `Agent`.
`requestedReplProfile` is shared with the reuse guard, so an attested
replacement is one the next turn keeps. If replacement or attestation fails,
the scope stays fenced, because the store allows no other way out of
`replacing` or `attesting`.

On restart, `resumeProjectMaintenance` releases a `draining` or `quiesced`
fence. It reopens a `replacing` or `attesting` fence only when the live parent
carries the fence's own generation and attests. Otherwise the fence is held.

Exposure: the composition field `project_maintenance`. `resume` runs once per
scope in `on_graph_ready`, after adoption. That is the only production call.
`replace` has no caller: no loop, watchdog, admin route or reminder uses it.
Source scans in `open-trident-prod-boot-wiring.test.ts` enforce this.

**Measured.** `gateway/project-generation-replacement.test.ts` has 36 tests.
`persistent/__tests__/generation-replacement.test.ts` has 22 tests. That
includes a real spawn replaced by a `--resume` that is stamped with the new
generation and whose registry row agrees. The composed
`open-project-admission-wiring.test.ts` has 3 added cases: a held `replacing`
fence answers chat as fenced, and a crashed `draining` fence is released. The
source scan has 3 cases. The `project-build-e2e` admission case adds three
checks: a busy run's leases block replacement; after the terminal chain,
replacement succeeds and the next dispatch is admitted under the new
generation; and a legacy parent is protected. Six semantic mutations were run.
Each one turns its guard red while the opposite control stays green:
- treating unknown as idle;
- replacing a legacy parent;
- reopening without attestation;
- skipping the exact-generation re-census;
- a boot resume that reopens `replacing` blind;
- spawning after an old child that has not exited.

**Not claimed.** Nothing triggers replacement, and nothing about it is
activated or deployed. #1237 stays open until deployed activation and live
proof. #1233's profile remains rolled back. The adopted-parent refusal in
`spawn.ts`, `respawnReplSession` and `project-workspaces.ts` are unchanged.
#1226 still owns credential handoff: a rotation that re-keys the parent is not
a replacement. A `replacing` or `attesting` fence that cannot attest stays
closed by design.
