---
title: Stop a deploy from killing the builds still in flight
group: deploy
status: open
priority: P0
cutover: true
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**A deploy must not kill the builds in flight — trident is presently its own worst enemy**
(owner-directed 2026-08-13, from the forensics on run `bb3c8c8e`). The inner workflow is not its own
process: it runs detached inside a WARM `claude` REPL the gateway owns (`cc-trident-fire-<owner>-<repo>`,
`open/wiring/substrates.ts`). Restarting the instance's service SIGTERMs that REPL and every workflow
inside it, and the wedge watchdog then reports `pid-dead → "pooled child exited"` — the detector
working, not
the fault. Three of five recorded `trident_launcher_crashes` land 18–28 s after a vendor checkout
(08-11 20:16:44→20:17:02, 08-12 19:37:55→19:38:13, 08-13 04:05:27→04:05:55). The 08-13 deploy rolled
`282f10b6`, *trident's own merge*: **a build that lands kills the builds still running**, at exactly the
rate the pipeline succeeds. Acceptance: a deploy either drains/defers while a run is in flight, or the
workflow survives its launcher's restart — and either way the owner is TOLD which happened, never handed
a bare "child crashed" for an event that was a deploy. (Two crashes — 08-10 23:30, 08-11 06:04 — have no
checkout near them and are NOT explained by this; a fix must not be credited with closing them.)
DISTINCT FROM the governance tracker's #514 (*a CRASHED trident run is never reaped*), which asks what
the row does AFTER a child dies and is now served by the `onChildCrash` sink. This asks why the child
dies at all, and answers: we killed it. Fixing one does not fix the other.

## Acceptance

- [ ] A deploy either drains/defers while a run is in flight, OR the workflow survives its
      launcher's restart. One of the two, chosen deliberately and pinned by a test.
- [ ] Either way the owner is TOLD which happened. A deploy-caused death is never reported
      as a bare "child crashed" / "pooled child exited" — assert the stored reason names
      the deploy.
- [ ] The two unexplained crashes (08-10 23:30, 08-11 06:04) have no checkout near them and
      are NOT closed by this fix. A change that claims them fails review.
- [ ] This does not subsume #514 (a CRASHED run is never reaped), which asks what the row
      does AFTER a child dies. Fixing one must not be credited with the other.
