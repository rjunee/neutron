---
title: Re-raise forgotten ritual approvals at a bounded daily cadence
group: platform
status: done
priority: P2
cutover: false
---

Issue #586. The owner chose a 24-hour interval and at most three automatic
re-raises. A week would leave the gated work stale; a fourth identical reminder
would train the owner to ignore prompts. The policy applies to ritual content
and egress grants, independently of agent activity. Deployment grants retain
their existing policy.

An original grant keeps its identity. Each reminder gets a fresh actionable
prompt with the original grant token. Reminder history survives restart. At the
next daily boundary after the third reminder, an unanswered grant becomes
`expired`, retaining its row and reason. Unknown age or invalid history expires
immediately with a reason. Delivery attempts are reserved durably; a failed send
consumes its attempt so crashes cannot reset the noise bound.

## Acceptance

- [x] No reminder before 24 hours; exactly one at the boundary and at most one
  per subsequent 24 hours, including concurrent sweeps and restart.
  Verify: tools/approval.test.ts, daily boundary test.
- [x] Three reminders are allowed; the next due sweep expires the row with a
  reason, and future sweeps never emit it again.
  Verify: tools/approval.test.ts and reminders/ritual-registration.test.ts.
- [x] Approved and denied grants never re-raise, including answers between
  selection and delivery. Verify: answer race tests in both test files above.
- [x] Missing, unreadable, or impossible timestamps do not mean fresh.
  Verify: tools/approval.test.ts, unknown age and missing timestamp tests.
- [x] Re-raised prompts retain actionable tokens and separate egress approval;
  changed or unavailable original content expires rather than rendering a
  different approval under the old token.
  Verify: reminders/ritual-registration.test.ts, automatic sweep tests.
- [x] The production supervised sweep runs without an agent turn, defers during
  onboarding, and preserves expired state across boot.
  Verify: open/__tests__/open-bundled-ritual-enable-wiring.test.ts.
