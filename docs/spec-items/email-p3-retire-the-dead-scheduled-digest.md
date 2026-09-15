---
title: Retire the Core's dead scheduled digest onto the new poller
group: email-core
status: done
priority: P3
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**P3 — the Core's dead scheduled digest is retired; the scribe fan-out rides the
email pipeline poller.** Each newly persisted message invokes the optional
`on_message_processed` observer, and gateway wiring adapts that observer to the
existing scribe fan-out. The pipeline's durable email row supplies cross-poll
idempotency, so the old separate watermark and second inbox read are unnecessary.
The on-demand `email_triage` tool is a different thing and stays.

## Acceptance

- [x] The old `triage-scheduler.ts` is DELETED.
- [x] **AND email→memory extraction is still observably happening afterwards.** The scribe
      email→memory fan-out + watermark is the scheduler's only live output, so a change that
      deletes the scheduler without the poller taking it over makes ambient email→memory go
      dark — assert extraction after deletion, not merely that deletion succeeded.
- [x] The on-demand `email_triage` tool still works. It is a different thing and stays.
