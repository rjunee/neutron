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

The descendant walker also preserves unknown reads beneath exempt own services:
an unreadable task list or children file cannot license replacement. Only an
absent process task directory proves a listed service exited; a vanished thread
alone does not. The additional seven walker-to-replacement cases cover both
permission failures, a vanished thread, a known shell, and the legitimate empty,
exited, and reaped-during-read controls.
Suppressing the unknown descendant flag fails all three refusal cases while the
four controls pass. Treating affirmative process absence as unknown fails both
exit controls while the other five cases pass. Both mutations were reverted.

**Combined host verification.** The integrated revision
`a3a36ca628cd785781078c26acd35705135ccdc3`, rebased on merged main
`d371923b397ee7b798550b4900924a81e4819b62`, passed
`bash scripts/check-shared-host.sh`: 51 TypeScript projects checked, and all
1,685 declared, Bun-discovered, assigned and executed test files passed across
18 bounded-memory lanes with zero failed lanes. The complete consuming
`open/__tests__/project-build-e2e.test.ts` also passed separately: 316 tests,
3,718 assertions. The host run reported 23 skipped tests; file coverage does
not turn those into live acceptance. Additional exact-revision semantic review
detected 22 guard mutations and six filtered consuming-E2E ownership mutations,
each with passing restored controls. Some pool, model and spawn probes were
disposable review fixtures, not tests added to this commit. The independent
integration review found the safety patch unchanged by the rebase. This is
local verification of the pre-publication revision; hosted CI, deployment and
live adopted-REPL acceptance are not claimed here.

The later scope-order correction at
`d7e06df58a904ddac9cd53fca2230db262c4dcca` also passed the complete
`bash scripts/check-shared-host.sh` gate with local listener access: 51
TypeScript projects and all 1,685 declared, discovered, assigned and executed
files across 18 lanes, zero failed lanes. This is the code revision to use for
the next PR head; the earlier `a3a36ca6` receipt is pre-correction evidence.
Fresh CI, deployment and live adopted-REPL acceptance remain outstanding.

**Not claimed.** Nothing triggers replacement, and nothing about it is
activated or deployed. #1237 stays open until deployed activation and live
proof. #1233's profile remains rolled back. The adopted-parent refusal in
`spawn.ts` and `project-workspaces.ts` are unchanged. `respawnReplSession` was
modified to preserve native-child supervision; see
[`native-child-supervision-respawn.md`](native-child-supervision-respawn.md).
#1226 still owns credential handoff: a rotation that re-keys the parent is not
a replacement. A `replacing` or `attesting` fence that cannot attest stays
closed by design.
