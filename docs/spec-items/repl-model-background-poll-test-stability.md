---
title: Synchronize the REPL model background-poll race test
group: app
status: open
priority: P0
cutover: true
---

# REPL model background-poll test stability

Work state: GitHub issue #1320. This item governs the test-only repair for the host device-lane failure in `app/__tests__/repl-model-control.test.tsx`. The production poll is scheduled every 5 seconds (`app/components/ReplModelControl.tsx:50-69`); a 5.1-second sleep did not prove that the second GET had begun under shared-host load. Waiting for the mock's second GET was also insufficient: it signaled request start, before response parsing and the React render, and counted requests through a process-global fetch stub.

`SPEC.md:712` names the "first concrete pass-through: in-place model switch" with a mobile current/list/switch affordance. The test must keep that behavior observable. The host-suite contract says "a completed host receipt with exit zero proves the suite passed" and an evidenced `failed-preexisting` claim "remains an advisory for independent panel verification" (`docs/spec-items/host-test-suite-efficiency.md:116-125`). A local focused pass is evidence for this test repair, not a substitute for the required host receipt.

## Required behavior

Capture the component's 5-second poll callback and fire it under test control. For owner discovery, keep its GET pending and verify the owner control is absent, then release it and await the rendered model and native controls. For the switch race, keep the stale background response pending until after the switch acknowledgement, then release it. Preserve a positive fresh-read case in which a new focus/session GET updates the displayed model. Do not change the production poll interval or suppress GET responses as a way to make the race test green.

## Acceptance

- [ ] Owner discovery and the background-switch race fire the captured 5-second poll without sleeping for it. Owner discovery proves the native controls are absent while the GET is pending and present with the new model after it resolves. Verify: `bun test app/__tests__/repl-model-control.test.tsx`.
- [ ] A stale background GET completing after an acknowledged switch cannot repaint the old model. Removing the generation guard must make this case fail; with the guard intact, it passes. Verify the focused race case and the reverse mutation.
- [ ] A fresh focus/session GET still replaces the prior snapshot after it completes. A change that discards every GET must fail the positive case. Verify: `bun test app/__tests__/repl-model-control.test.tsx -t 'replaces a successful POST snapshot only when the next focus GET completes'`.
- [ ] The changed-file diff contains only test, governing spec, generated spec index, and as-built record files. Root, app and Trident TypeScript checks pass; the as-built record distinguishes focused local evidence from host-suite and served-product receipts.
