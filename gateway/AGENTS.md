# AGENTS.md — gateway

This module owns the modular per-instance gateway: HTTP routes, Telegram webhook intake, channel-binding fan-out, button-callback dispatch, and the in-process orphan-adoption logic that ports Nova's `rediscoverLiveTopicPanes` per `docs/engineering-plan.md § B.P1`. Implementation lands in P1; P0 ships only the empty-but-correct skeleton.

It must NOT contain the substrate dispatcher (lives in `runtime/`), MCP server scaffolding (`mcp/`), reminder engine (`reminders/`), or any per-instance flat files at the gateway root — all per-instance state goes through the project database file. No `topic-map.json`, no `running-agents.jsonl`, no `pending-*.json` button queues at any global path.

## Naming — `gateway/cores/` is NOT the `cores/` workspace (READ THIS)

Two unrelated things share the `cores` token; do not conflate them:

- **`gateway/cores/`** (this package, a subdir) — the in-gateway **wiring / composition** layer that MOUNTS Cores into a running instance: bundled-Core install (`install-bundled.ts`), OAuth token/credential resolution (`oauth-token-manager.ts`, `core-credential-resolver.ts`), scribe fan-out, active-project context, chat-router glue. It is host-side plumbing, not a Core.
- **`cores/`** (the top-level `@neutronai/cores` workspace package) — the Core IMPLEMENTATIONS themselves (Email, Calendar, Research, Tasks, …), each an npm-shape package with a `"neutron"` manifest. See `cores/AGENTS.md`.

Rule of thumb: code that *decides how a Core is bound to an instance* lives in `gateway/cores/`; code that *is* a Core's behavior lives in `cores/`. A file under `gateway/cores/` must never be mistaken for a Core package, and vice-versa.

Cross-refs: `docs/engineering-plan.md § B.P1`, `cores/AGENTS.md`.
