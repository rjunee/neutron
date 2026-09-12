---
title: Retire the Core's dead scheduled digest onto the new poller
group: email-core
status: open
priority: P3
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**P3 — retire the Core's dead scheduled digest; the scribe fan-out rides the
new poller.** The existing `triage-scheduler.ts` has never been deliverable
(`pushDispatcher: null` hardcoded at
`gateway/cores/mount-cores-scribe-fan-out.ts:302`; no `emailLlm` passed from
`open/wiring/memory.ts:354-358`, so it falls to a throwing stub; delivery gated
at `gateway/cores/email-managed-wiring.ts:149`). Its ONLY live output is the
scribe email→memory fan-out + watermark, **which the poller must take over or
ambient email→memory goes dark.** The on-demand `email_triage` tool is a
different thing and stays. _Acceptance: the old scheduler is deleted AND
email→memory extraction is still observably happening afterwards._

## Acceptance

- [ ] The old `triage-scheduler.ts` is DELETED.
- [ ] **AND email→memory extraction is still observably happening afterwards.** The scribe
      email→memory fan-out + watermark is the scheduler's only live output, so a change that
      deletes the scheduler without the poller taking it over makes ambient email→memory go
      dark — assert extraction after deletion, not merely that deletion succeeded.
- [ ] The on-demand `email_triage` tool still works. It is a different thing and stays.
