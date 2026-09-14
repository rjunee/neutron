---
title: Prefer the better-informed launcher death report
group: trident
status: done
priority: P1
cutover: false
---

Issue #648. Select launcher tombstones by information rather than arrival order.
Measured restart/deploy attribution outranks an explicit undetermined cause, which
outranks an unexplained death. The shutdown observer can establish attribution
directly; a later reader needs process identity to recover it, while a pid-only
absence cannot establish that cause. Equal reason kinds choose the lexically
smaller complete reason (JavaScript string ordering), independent of arrival.
The existing reason markers define kinds; unrecognised reasons rank lowest.

## Acceptance

- [x] Every pair of unequal ranks selects the better report in both arrival orders.
- [x] Equal-rank distinct reports select the same reason in both orders; exact duplicates
      decline replacement.
- [x] A declined report is observable through the existing boolean write-claim convention
      (false), and a structured store log; it is a successfully delivered death, not a
      retryable delivery failure.
- [x] Running rows and the saveIfActive stale-snapshot veto consume the selected reason.
- [x] Mutating promotion, downgrade refusal and equal-rank selection makes their
      respective tests fail; restore makes them pass.

Verify: bun test trident/launcher-crash-precedence.test.ts
