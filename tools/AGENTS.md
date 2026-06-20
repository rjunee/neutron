# AGENTS.md — tools

This module owns the tool registry and per-instance approval gates lifted from OpenClaw `bash-tools.exec-approval-{request,followup}.ts` (4-runtime-seam shape) plus the auto-discovery pattern lifted from Hermes `tools/registry.py` (zero-config registration). Implementation lands in P1; P0 sets the directory and these rules.

It must NOT bypass approval gates for cross-instance or cross-Core calls — every tool invocation crossing an instance or Core boundary goes through the explicit approval surface. The 3-mode gate (on / auto / off) maps onto Neutron's `regular` / `private` privacy modes per `docs/engineering-plan.md § B.P1`.

Cross-refs: `docs/engineering-plan.md § B.P1`, `docs/plans/P0-system-user-data-separation.md § 3` (lift comparison).
