## 2026-09-25 — Specify host test-suite efficiency

Promoted issue #1298's completed host suite audit into a repo-owned specification.
The audit measured a green 1,673-file run and identified early socket capability
diagnosis, Open build E2E fixture cost, and PGLite lane retry classification as
the three scoped opportunities. The specification binds each to positive and
negative checks while preserving G063, full discovered-file coverage, and the
locked Trident gates.

This record covers specification only. No runner or test behavior changed, and
the audit's process-duration totals are not implementation savings.
