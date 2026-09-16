---
title: Require observable pane adoption and bounded pane-loss recovery
group: platform
status: open
priority: P1
cutover: false
legacy_ref: "Issue #1095"
---

Decision: SPEC.md, 2026-09-16, Observable pane adoption and bounded pane-loss recovery.

## Acceptance

- An attached pane without a nonblank baseline is closed and its durable handle
  cleared before a session can be published. A readable baseline permits adoption.
  Baseline latches do not answer old prompts; a later clear screen rearms them.
  Verify: `bun test runtime/adapters/claude-code/persistent/__tests__/observable-adoption.test.ts`.
- Positive pane disappearance reaches the caller as `pane_vanished`, composition
  expiry as `compose_timeout`, and cancellation as `aborted`.
  Verify: `bun test runtime/adapters/claude-code/persistent/__tests__/pane-vanished-outcome.test.ts runtime/__tests__/o3-substrate-error-codes.test.ts reminders/__tests__/background-compose-in-flight.test.ts`.
- Wakeup retries early pane loss once with a fresh child and a bounded recovery
  budget; late loss and genuine cancellation do not retry immediately. Terminal
  failures retain typed counts, alongside inactivity and budget-ceiling counts.
  The original progressing turn keeps its separate absolute ceiling.
  Verify: `bun test gateway/proactive/__tests__/work-wakeup.test.ts`.

Full socket integration validation remains required in an environment that can
bind the reply sink. The isolated adoption suite stubs HTTP startup and credential
material only; it exercises reconciliation, durable registry and pool publication.
