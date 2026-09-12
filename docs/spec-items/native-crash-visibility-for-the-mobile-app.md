---
title: Make a native process-start crash diagnosable without a cable
group: app
status: open
priority: P3
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**Native-crash visibility for the mobile app.** App remote diagnostics (2026-07-27) covers JS errors
only; a crash before the JS bundle runs produces nothing. Acceptance: a native process-start crash on
the owner's device is diagnosable without a USB cable.

## Acceptance

- [ ] A native process-start crash on the owner's device is diagnosable **without a USB
      cable** — the crash reaches the owner's own gateway, like the JS-error path
      (2026-07-27), with no third party in between.
- [ ] The criterion is bidirectional: a crash that happens BEFORE the JS bundle runs must
      still produce a report. A test that only exercises a post-bundle crash passes with
      the defect present and does not satisfy this.
