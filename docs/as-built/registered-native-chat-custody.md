## 2026-10-03 — Preserve registered native chat identity without local account selection

Implements the existing host-custody contract in
`docs/spec-items/claude-same-agent-continuation.md:18`: the registered native CLI
uses the protected route, and the host owns account selection. Ordinary chat
previously selected an Open credential before reaching native relay preparation;
a parked local pool could therefore refuse a turn before any native request.

`gateway/wiring/build-llm-call-substrate.ts:177` validates the canonical route
before direct-auth resolution. Registered turns preserve a live or recorded
conversation key without reading local provider secrets, refreshing OAuth, or
changing local credential accounting. A first conversation uses the canonical
route fingerprint as its key. Unregistered self-hosts retain credential selection
and cooldown handling. Composition distinguishes an unavailable registration from
absence so an unrelated provider remains usable; selected Claude still refuses
locally (`open/wiring/substrates.ts:181`).

`runtime/adapters/claude-code/index.ts:440` discovers durable identity through the
canonical registry location and validates exact instance, owner, project, key and
recorded conversation scope. This includes a formerly live parent whose process
died without a sleep marker, and the historical credential-less key. Unreadable,
dropped or contradictory matching records refuse; multiple candidates cannot
authorize a new conversation. Registered boot discovery uses these keys while
the existing startup fingerprint, transcript, profile and cap checks remain in
force (`gateway/wiring/build-llm-call-substrate.ts:1141`). Discovery does not grant
native-child continuation authority or rearm a cap.

Validation used synthetic provider credentials and native processes. The real
scope lifecycle, persistent spawn, Unix relay registration and signed responses
preserved the original session and key for asleep, dead and credential-less
records; the dead-record control retained its cap
(`open/__tests__/project-scope-sleep.test.ts:310`). Registered first-chat tests
cover absent, empty and throwing local pool sources. A real startup-recovery
consumer still rejects a stale fingerprint without reading a local pool
(`gateway/wiring/__tests__/registered-native-chat-auth.test.ts:114`). Exact durable
discovery is exclusive when no live owner exists: a newer foreign instance/user
sleep record cannot override the original key, and a proven empty exact scope
uses the route key. The consuming foreign-record control verifies that the legacy
sleep lookup really selects the foreign record while native resume retains the
original session and cap.

The first affected six-file run failed: 129 passed and 16 failed. One provider
fixture and fifteen startup-recovery cases had implicitly inherited the host's
registered route while asserting synthetic self-host credentials. Explicit
self-host pin/route fixtures repaired those boundaries; the subsequent four-file
consumer run passed 145 tests. The final focused registry/custody suite passed
22 tests; root and Trident TypeScript checks passed. Semantic mutations forcing direct authentication on registered routes,
bypassing direct authentication on unregistered routes, and treating an unreadable
registry as empty each failed its intended control; original source hashes were
restored. Restoring the broader sleep-pin precedence also failed by producing a
different native session ID. After the exact-identity fix, all 21 selected
custody/lifecycle controls passed. The repository-wide acceptance run and live provider proof remain
separate evidence; these offline results do not complete issue #1416.

Root subsequently ran the complete shared-host gate on frozen source revision
`e9b1c13aacafcedc54874b71360e5d93378f8968`:
`bash scripts/check-shared-host.sh` executed all 51 TypeScript projects and all
1,778 discovered test files, including `open/__tests__/project-build-e2e.test.ts`.
The coverage audit assigned and executed every discovered file. All nineteen
logical lanes passed: 27,676 tests passed, 24 were skipped, zero failed, and
130,957 assertions ran. The gate exited zero and preserved measured suite-input
identity `59fdad6ade75537057e37a7b2cc95c7e28e27228dfca7f817cfd1b2e300406ac`.
Log SHA-256: `9afa1d3d5d5533861a49545a8bf3db175e4d8101b1a115cf88a33c7e3342d32a`.

Independent Astra and bounded Claude Opus reviews approved the frozen production
changes. The final test-only non-null assertion changed its reviewed source hash
but produced identical JavaScript; a separate changed-output control detected a
runtime change. The receipt is recorded after its measured source revision;
this documentation does not relabel that revision or substitute for exact-head
publication CI, served-code verification or live unattended merge acceptance.

Exact-head publication CI exposed a timer boundary in the consuming
`open/__tests__/project-build-e2e.test.ts:9212` queue fixture: the planner merged,
but its measured queue interval was 1,199 ms after a requested 1,200 ms sleep.
The actor records both endpoints with `Date.now()`
(`runtime/workers/claude-acting-turn.ts:196,269,276`), and the dispatch budget
credits that measured interval once
(`runtime/workers/claude-dispatch-budget.ts:12,17-21`). The fixture now rechecks
the same clock before releasing the held writer. The 1,200 ms minimum assertion,
2,000 ms execution allowance, real queue and production deadline guards remain
intact (`open/__tests__/project-build-e2e.test.ts:9190,9215-9224`).

The eight focused queue, expiry, cancellation and planner controls passed with
61 assertions; ten sequential repetitions of the repaired consuming planner
case also passed. Root and Trident TypeScript checks passed. Removing queue
credit made that planner control fail with an unknown plan instead of merging.
Doubling credit made the existing queued execution-expiry control fail at
5,042 ms against its unchanged 4,800 ms bound
(`open/__tests__/project-build-e2e.test.ts:9153`). Both mutations were restored
to the original production source hash. This bounded test repair does not
relabel the earlier complete-suite receipt; publication CI on the repaired head
remains separate evidence.
