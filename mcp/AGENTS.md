# AGENTS.md — mcp

This module owns MCP server scaffolding — one MCP server per instance, multiplexed across all topics for that instance per the locked `docs/engineering-plan.md § B.P1` decision (10× resource saving vs Nova's per-topic shape). Lift targets: OpenClaw `src/mcp/channel-bridge.ts` and Hermes `mcp_serve.py` 9-tool surface. Three-surface factoring: `neutron-tools / core-tools / channel-tools` (mirrors OpenClaw's `openclaw-tools / plugin-tools / channel-tools`).

It must NOT spawn one MCP server per topic (that was Nova's shape; replaced), expose cross-instance tools without an explicit Connect API (P1 deliverable with `origin_instance` quarantine tagging), or hardcode a tool registry (auto-discovery pattern lifted from Hermes `tools/registry.py`).

Cross-refs: `docs/engineering-plan.md § B.P1`, `docs/plans/P0-system-user-data-separation.md § 1.2 mcp/`.
