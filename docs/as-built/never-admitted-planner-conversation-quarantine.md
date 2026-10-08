## 2026-10-08 — Quarantine never-admitted planner conversations without claiming task completion

An expired planner submission could retain its native-child admission lease after
the host run failed, even when there was no authenticated child binding or result.
The existing restricted-profile retirement policy correctly refused that evidence.
This change adds the distinct policy specified by the 2026-10-08 conversation
quarantine decision, retaining the original restricted-profile and reboot policies.

`runtime/workers/never-admitted-planner-retirement.ts` authenticates independent
operator preparation and final authorization, the original signed relay
registration, and a capacity-owner proof of complete zero-admission history and
permanent conversation quarantine. `runtime/workers/claude-capacity-client.ts`
checks the current fence using a fresh signed challenge. Historical source custody
is explicitly operator evidence, not a claim that the capacity service measured
historical code. The public consumer requires the original executor's observed
exit and the operator's retained operation-closure evidence; current accepted
planner operations and constructors use the existing drain barrier.

`open/wiring/never-admitted-planner-retirement.ts` delivers a two-phase operation.
Before relay quarantine, authenticated preparation atomically holds project
admission, tombstones exact workflow authority and records the conversation fence
in migration 0169. The complete project lease set must match the terminal planner
lease plus any explicitly listed stale logical conversation admissions. A nonempty
list requires an independently signed owner reset of the canonical project topic,
a complete current census with no other live or unresolved conversation, and
reverified consumed old planner authorizations proving each admission producer
epoch closed. The old receipt does not assert that a separate historical chat turn
used its native parent. `conversation_admission_retirements` permanently fences
each exact logical work reference across producer epochs and admission generations.
Unlisted, current-epoch, changed, untrusted or ambiguous ownership refuses.
Consumption requires those exact preparation bytes, the independently signed
capacity proof, a fresh effective-fence response and completed host drains before
atomically releasing only the unchanged exact prepared leases. Unknown native outcome, failed run, original
request, journal and result artifacts remain unchanged. Partial recovery retains
fences and ownership; exact completed retry is idempotent.

Persistent Claude lifecycle guards refuse adoption, replay, continuation and
replacement using the quarantined identity. They preserve the original process,
pane and registry row, detach its host wrapper without killing it, and resolve
subsequent independent work to a fresh conversation with no resumed input. A
retained workspace may participate in preparation only when all occupied slots
positively belong to the exact original request. Detachment still requires those
slots to drain. Ordinary census excludes the quarantined history; the recovery
consumer can inspect only the exact original identity for its final workspace
drain. Unknown other parents remain refusal evidence. Only an already supervised exact
predecessor can transfer its registered owner options to a durable successor;
raw unregistered constructors retain their original shutdown behavior, covered
by the existing pane-handle persistence and exit-ownership controls.

Validation exercises the authenticated HTTP surface with real canonical SQLite
state and signed Unix capacity responses in
`open/wiring/__tests__/never-admitted-planner-retirement.test.ts`. It includes
actual queued planner operations, a real retained `ReplSession` workspace,
forgery and identity refusals, concurrent unrelated admission, failed drains,
idempotent restart fences, unchanged history and zero parent control calls. Logical
admission controls exercise signed closed-epoch evidence, canonical topics, complete
lease sets, concurrent admissions, explicit other live conversations, and permanent
work-reference replay refusal after restart. Closure-authentication and replay-guard
mutants are checked through their actual consumers, alongside the valid reset.
Semantic mutations remove authentication, dispatch identity, effective-quarantine
checks and drains, or disable authorized recovery; each produces the opposing
failure. Persistent lifecycle tests exercise both supported PTY containers, fresh
conversation routing, restart/adoption/replay refusal and exact-workspace slots.
Separate mutation controls remove successor routing, replay denial and exact
workspace matching, or replace detachment with termination. Existing planner
retirement and automatic unknown reconciliation remain regression controls.

The capacity owner's complete-history transaction, relay admission/forward drain
and durable registration quarantine are an independently delivered dependency.
No production receipt, quarantine or process operation is performed by these
checks. This policy retires scoped host authority; it makes no native exit, hook
cessation, successful task result or general side-effect containment claim.
