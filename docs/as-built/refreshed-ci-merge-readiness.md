## 2026-09-24 — Wait for refreshed CI in the approved build

Issue #1248 repairs merge admission after a base change refreshes CI. Previously,
`createBuildHost` mapped an in-progress CI observation directly to a terminal
block. The publication suite is already complete before the driver enters this
gate (`trident/build-run.ts:1043`, `trident/build-run.ts:1072`), so a later outer
retry could pay again for an approved build and suite.

The host now waits within that merge gate using the existing G053 constants:
900000 ms elapsed, 30000 ms between acquisitions. A wall watchdog also bounds a
hung observation, and cancellation and late observations remain unknown rather
than permission to merge (`trident/gates/merge-readiness.ts:17`). The production
host passes its run signal through the merge dependency without changing the
driver (`trident/build-host.ts:243`). This is an in-process wait, not a new
durable recovery protocol; existing outer retry limits still apply after it ends.

Each acquisition retains the PR and reviewed head and refreshes pinned merge
readiness. Remote base OIDs bracket CI and drift acquisition; a moved base
discards that result and waits within the same deadline. Red and configuration
faults stop, while pending, absent or unreadable CI cannot merge. The richer
readiness source preserves explicit conflict refusal
(`trident/build-host.ts:193`). Open's GitHub fake now supplies `baseRefOid` from
its real bare origin, matching the requested field
(`open/__tests__/project-build-e2e.test.ts:618`).

The driver-consuming regression proves green continuation, red refusal, bounded
exhaustion and abort, with exactly one plan/build/review and one host publication
suite (`trident/build-host.test.ts:634`). Head movement, closure, changed PR,
base overlap/unreadability and conflicts refuse. The paired base acquisition
case discards old green after movement, observes running replacement checks,
and only then allows a new green result; stable-base green succeeds immediately
(`trident/build-host.test.ts:724`).

Verification: 75 focused host/readiness tests, 38 spec-index checks and 43
project-host tests pass. Root and Trident TypeScript checks pass, as does the
complete 51-configuration matrix. Dependency-cruiser reports no new violations.
Four semantic mutations fail at the intended behavioral assertions: restoring
the terminal pending block rejects the legitimate green continuation; allowing
red merges the forbidden case; allowing green across base movement produces one
CI probe where three are required; accepting an exhausted wait returns allow
where typed unknown is required. The mutations were restored. The consuming
`open/__tests__/project-build-e2e.test.ts` passes 267/267 with local Unix sockets
enabled. Its restricted sandbox run passed 258 and failed nine broker fixtures
with `EPERM`; the unrestricted rerun passed all 267. The partitioned full suite
remains a required publication gate.

The local tree leak gate is not green. An archived base tree has 455 denylist
findings; the candidate worktree has the same class counts plus its untracked
Git worktree pointer. Required CI purity remains authoritative. The proposed PR
body passes the local message gate.

The existing remote base race remains explicit: the production merge effect
records that GitHub's CLI only enforces the head pin, not an atomic base
precondition (`trident/production-host-effects.ts:606`). This change does not
claim that a base cannot move after the final observation, nor does it claim
deployed acceptance or measured live time/token savings.
