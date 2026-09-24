---
title: Wait for refreshed CI without rebuilding an approved revision
group: trident
status: open
priority: P0
cutover: true
---

# Refreshed CI at merge readiness

Issue: #1248. The approved build can finish its host publication suite while an
independent base merge refreshes the PR's checks. A one-shot `CI: in-progress`
refusal then ends that run and lets the outer retry repeat completed work.

The host must keep the approved run at merge readiness while checks settle,
using G053's existing 900000-ms elapsed budget and 30000-ms cadence. Missing,
running or unreadable CI never authorizes merge. Exhaustion or cancellation
returns a typed unknown/deferred result without buying another review round or
repeating the builder, reviewer, publication suite or publication. Existing outer
retry policy remains responsible after this bounded wait ends.

Every acquisition retains the same PR number and reviewed head. The host reads
the remote base OID before CI and after fresh pinned merge readiness. A base move
discards that acquisition and waits for fresh evidence within the original
deadline. Head movement, closure, conflicting mergeability, red checks and
configuration faults cannot merge. Overlapping or unreadable base drift retains
its existing refusal. A stable independently advanced base can proceed only
after fresh CI and drift assessment allow it.

This does not add an atomic remote base precondition: `gh pr merge` supports the
reviewed head pin, and the production merge effect already records that the base
can move after assessment. No new merge effect or bypass is introduced.

## Acceptance

- [ ] A refreshed pending observation followed by green merges the same approved
  PR with one builder, one review and one host publication suite; red blocks.
  Verify: `bun test trident/build-host.test.ts -t 'refreshed merge CI'`.
- [ ] Never-settling checks defer within the elapsed budget (exactly 30 waits of
  30000 ms in the zero-cost-observation clock fixture); cancellation,
  hung acquisition and late green never authorize merge or buy another round.
  Verify: `bun test trident/gates/merge-readiness.test.ts` and the host cases above.
- [ ] Moved head, changed PR, closure, conflict and overlapping/unreadable base
  drift refuse. A base movement during green acquisition forces a new observation;
  its stable-base sibling succeeds. Verify: `bun test trident/build-host.test.ts`.
- [ ] Semantic mutations demonstrate both refusal and legitimate continuation:
  terminalizing pending kills the successful retry case; allowing red kills the
  rejection case; accepting green across base movement kills the identity case.
- [ ] Run `open/__tests__/project-build-e2e.test.ts`, both root and Trident
  TypeScript checks, and the partitioned full suite before publication. The wider
  live deployed acceptance remains in `trident-build-efficiency.md`.
